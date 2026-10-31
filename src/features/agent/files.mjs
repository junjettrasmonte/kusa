/**
 * Workspace-sandboxed file tools for the Kusă agent harness.
 * Paths stay under workspaceRoot; symlink escape and absolute jumps are rejected.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { applyEdits, diffLineCounts } from './patch.mjs';

const MAX_READ_BYTES = 512 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_LIST = 500;
const MAX_GREP_HITS = 80;
const MAX_GREP_FILE_BYTES = 256 * 1024;
const MAX_PATCH_EDITS = 50;

export const FILE_TOOL_DEFS = [
  {
    name: 'kusa_read_file',
    description:
      'Read a UTF-8 text file from the workspace. Path is relative to the project root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path' },
        offset: { type: 'integer', description: '1-based start line (optional)' },
        limit: { type: 'integer', description: 'Max lines to return (optional)' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_write_file',
    description:
      'Create or overwrite a UTF-8 text file under the workspace. Creates parent directories.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path' },
        contents: { type: 'string', description: 'Full file contents' },
      },
      required: ['path', 'contents'],
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_patch_file',
    description:
      'Apply targeted search/replace edits to a workspace file without rewriting it (efficient for large files). '
      + 'Each oldText must match the file exactly once unless replaceAll=true; edits are applied in order and the '
      + 'write is atomic — if any edit fails, nothing is written and the error explains which edit and why.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path (must already exist)' },
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_PATCH_EDITS,
          description: 'Ordered search/replace edits',
          items: {
            type: 'object',
            properties: {
              oldText: {
                type: 'string',
                description:
                  'Exact text to find (copy it verbatim from kusa_read_file; include enough context to be unique)',
              },
              newText: { type: 'string', description: 'Replacement text' },
              replaceAll: {
                type: 'boolean',
                description: 'Replace every occurrence instead of requiring a unique match',
              },
            },
            required: ['oldText', 'newText'],
            additionalProperties: false,
          },
        },
        dryRun: {
          type: 'boolean',
          description: 'Validate and preview the patch without writing the file',
        },
      },
      required: ['path', 'edits'],
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_list_dir',
    description: 'List files and directories under a workspace path (non-recursive by default).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative directory path (default ".")' },
        recursive: { type: 'boolean', description: 'Walk nested directories (capped)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_grep',
    description: 'Search file contents under the workspace for a literal or regex pattern.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern' },
        path: { type: 'string', description: 'Relative start path (default ".")' },
        regex: { type: 'boolean', description: 'Treat pattern as JavaScript regex' },
        caseInsensitive: { type: 'boolean', description: 'Case-insensitive match' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_delete_file',
    description:
      'Delete a file under the workspace (sandboxed). For directories, set recursive=true. Cannot delete the workspace root, .git, or .kusa.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file or directory path' },
        recursive: {
          type: 'boolean',
          description: 'Required to delete a non-empty directory (or any directory)',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

/**
 * @param {string} workspaceRoot
 * @param {string} inputPath
 */
export function resolveWorkspacePath(workspaceRoot, inputPath) {
  const root = resolve(workspaceRoot);
  const rootReal = existsSync(root) ? realpathSync(root) : root;
  const raw = String(inputPath || '').trim() || '.';
  if (raw.includes('\0')) {
    const err = new Error('invalid path');
    err.code = 'EINVAL';
    throw err;
  }
  const abs = resolve(root, raw);
  const rel = relative(root, abs);
  if (rel.startsWith(`..${sep}`) || rel === '..') {
    const err = new Error(`path escapes workspace: ${raw}`);
    err.code = 'EPERM';
    throw err;
  }
  if (existsSync(abs)) {
    const real = realpathSync(abs);
    const realRel = relative(rootReal, real);
    if (realRel.startsWith('..') || realRel === '..') {
      const err = new Error(`path escapes workspace (symlink): ${raw}`);
      err.code = 'EPERM';
      throw err;
    }
    return { abs: real, rel: realRel.split(sep).join('/') || '.' };
  }
  // Parent must stay inside the workspace for writes to new paths.
  const parent = dirname(abs);
  if (existsSync(parent)) {
    const parentReal = realpathSync(parent);
    const parentRel = relative(rootReal, parentReal);
    if (parentRel.startsWith('..') || parentRel === '..') {
      const err = new Error(`path escapes workspace: ${raw}`);
      err.code = 'EPERM';
      throw err;
    }
  } else {
    const climb = relative(root, parent);
    if (climb.startsWith('..')) {
      const err = new Error(`path escapes workspace: ${raw}`);
      err.code = 'EPERM';
      throw err;
    }
  }
  return { abs, rel: rel.split(sep).join('/') || '.' };
}

function skipName(name) {
  return name === 'node_modules' || name === '.git' || name === '.kusa' || name === 'dist';
}

/** Refuse deleting the workspace root or protected top-level dirs. */
function assertDeletablePath(rel) {
  const norm = String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || '.';
  if (norm === '.' || norm === '') {
    const err = new Error('refusing to delete workspace root');
    err.code = 'EPERM';
    throw err;
  }
  const top = norm.split('/')[0];
  if (top === '.git' || top === '.kusa') {
    const err = new Error(`refusing to delete protected path: ${norm}`);
    err.code = 'EPERM';
    throw err;
  }
  return norm;
}

/**
 * System prompt for the native agent loop — derived from FILE_TOOL_DEFS so the
 * tool list and the prompt can never drift apart.
 * @param {string} [trailAddon] optional Trail policy lines from trailSystemPromptAddon
 * @returns {string}
 */
export function agentSystemPrompt(trailAddon = '') {
  const names = FILE_TOOL_DEFS.map((t) => t.name).join(', ');
  const base = [
    'You are the Kusă coding agent. Use the kusa_* file tools to inspect and edit workspace files:',
    `${names}, plus kusa_trail_ask / kusa_trail_map for the context graph.`,
    'To edit an existing file prefer kusa_patch_file with { "path": "…", "edits": [{ "oldText": "…", "newText": "…" }] }',
    '— it rewrites only the matched spans, so it is far cheaper than resending a whole file with kusa_write_file.',
    'Copy oldText verbatim from kusa_read_file and include enough surrounding lines to match exactly once (set replaceAll=true only for intentional bulk renames).',
    'To remove a file call kusa_delete_file with { "path": "…" }; use recursive=true for directories. Stay inside the project. Prefer concise answers.',
  ].join(' ');
  const extra = typeof trailAddon === 'string' ? trailAddon.trim() : '';
  return extra ? `${base} ${extra}` : base;
}

/**
 * @param {string} workspaceRoot
 */
export function createFileTools(workspaceRoot) {
  const root = resolve(workspaceRoot);

  function readFile(args = {}) {
    const { abs, rel } = resolveWorkspacePath(root, args.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      return { ok: false, error: `not a file: ${rel}` };
    }
    const st = statSync(abs);
    if (st.size > MAX_READ_BYTES) {
      return { ok: false, error: `file too large (${st.size} bytes; max ${MAX_READ_BYTES})` };
    }
    const text = readFileSync(abs, 'utf8');
    const lines = text.split('\n');
    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = args.limit != null ? Math.max(1, Number(args.limit) || 1) : lines.length;
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    return {
      ok: true,
      path: rel,
      offset,
      lineCount: lines.length,
      content: slice.join('\n'),
    };
  }

  function writeFile(args = {}) {
    const contents = args.contents == null ? '' : String(args.contents);
    if (Buffer.byteLength(contents, 'utf8') > MAX_WRITE_BYTES) {
      return { ok: false, error: `contents too large (max ${MAX_WRITE_BYTES} bytes)` };
    }
    const { abs, rel } = resolveWorkspacePath(root, args.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, 'utf8');
    return { ok: true, path: rel, bytes: Buffer.byteLength(contents, 'utf8') };
  }

  function patchFile(args = {}) {
    const { abs, rel } = resolveWorkspacePath(root, args.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      return { ok: false, error: `not a file: ${rel} (use kusa_write_file to create it)` };
    }
    const st = statSync(abs);
    if (st.size > MAX_READ_BYTES) {
      return { ok: false, error: `file too large (${st.size} bytes; max ${MAX_READ_BYTES})` };
    }
    const rawEdits = Array.isArray(args.edits)
      ? args.edits
      : args.edit != null
        ? [args.edit]
        : [];
    if (!rawEdits.length) {
      return {
        ok: false,
        error: 'edits is required: [{ "oldText": "…", "newText": "…" }]',
      };
    }
    if (rawEdits.length > MAX_PATCH_EDITS) {
      return { ok: false, error: `too many edits (max ${MAX_PATCH_EDITS} per call)` };
    }
    const text = readFileSync(abs, 'utf8');
    const patched = applyEdits(text, rawEdits);
    if (patched.error) {
      return { ok: false, path: rel, error: patched.error, editsTotal: rawEdits.length };
    }
    const bytesBefore = Buffer.byteLength(text, 'utf8');
    const bytesAfter = Buffer.byteLength(patched.text, 'utf8');
    if (bytesAfter > MAX_WRITE_BYTES) {
      return { ok: false, error: `patched contents too large (max ${MAX_WRITE_BYTES} bytes)` };
    }
    const unchanged = patched.text === text;
    const dryRun = Boolean(args.dryRun);
    if (!dryRun && !unchanged) writeFileSync(abs, patched.text, 'utf8');
    return {
      ok: true,
      path: rel,
      dryRun,
      applied: patched.applied,
      matches: patched.matches,
      unchanged,
      bytesBefore,
      bytesAfter: unchanged ? bytesBefore : bytesAfter,
      lines: diffLineCounts(text, patched.text),
    };
  }

  function listDir(args = {}) {
    const start = String(args.path || '.').trim() || '.';
    const { abs, rel } = resolveWorkspacePath(root, start);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      return { ok: false, error: `not a directory: ${rel}` };
    }
    const recursive = Boolean(args.recursive);
    /** @type {string[]} */
    const entries = [];
    const walk = (dirAbs, dirRel) => {
      if (entries.length >= MAX_LIST) return;
      let names;
      try {
        names = readdirSync(dirAbs);
      } catch {
        return;
      }
      names.sort();
      for (const name of names) {
        if (skipName(name)) continue;
        if (entries.length >= MAX_LIST) break;
        const childAbs = join(dirAbs, name);
        const childRel = dirRel === '.' ? name : `${dirRel}/${name}`;
        let isDir = false;
        try {
          isDir = statSync(childAbs).isDirectory();
        } catch {
          continue;
        }
        entries.push(isDir ? `${childRel}/` : childRel);
        if (recursive && isDir) walk(childAbs, childRel);
      }
    };
    walk(abs, rel === '.' ? '.' : rel);
    return {
      ok: true,
      path: rel,
      truncated: entries.length >= MAX_LIST,
      entries,
    };
  }

  function deleteFile(args = {}) {
    const rawPath = String(args.path || '').trim();
    if (!rawPath || rawPath === '.' || rawPath === './') {
      return { ok: false, error: 'path is required (cannot delete workspace root)' };
    }
    const { abs, rel } = resolveWorkspacePath(root, rawPath);
    try {
      assertDeletablePath(rel);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (!existsSync(abs)) {
      return { ok: false, error: `path not found: ${rel}` };
    }
    const st = statSync(abs);
    const recursive = Boolean(args.recursive);
    if (st.isDirectory()) {
      if (!recursive) {
        return {
          ok: false,
          error: `path is a directory; pass recursive=true to delete: ${rel}`,
        };
      }
      rmSync(abs, { recursive: true, force: false });
      return { ok: true, path: rel, kind: 'directory', recursive: true };
    }
    if (!st.isFile() && !st.isSymbolicLink()) {
      return { ok: false, error: `not a file or directory: ${rel}` };
    }
    unlinkSync(abs);
    return { ok: true, path: rel, kind: 'file' };
  }

  function grep(args = {}) {
    const pattern = String(args.pattern || '');
    if (!pattern) return { ok: false, error: 'pattern is required' };
    const start = String(args.path || '.').trim() || '.';
    const { abs, rel } = resolveWorkspacePath(root, start);
    let matcher;
    try {
      if (args.regex) {
        matcher = new RegExp(pattern, args.caseInsensitive ? 'i' : '');
      } else {
        const lit = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        matcher = new RegExp(lit, args.caseInsensitive ? 'i' : '');
      }
    } catch (err) {
      return { ok: false, error: `invalid pattern: ${err.message}` };
    }

    /** @type {{ path: string, line: number, text: string }[]} */
    const hits = [];
    const visitFile = (fileAbs, fileRel) => {
      if (hits.length >= MAX_GREP_HITS) return;
      let st;
      try {
        st = statSync(fileAbs);
      } catch {
        return;
      }
      if (!st.isFile() || st.size > MAX_GREP_FILE_BYTES) return;
      let text;
      try {
        text = readFileSync(fileAbs, 'utf8');
      } catch {
        return;
      }
      if (text.includes('\0')) return;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= MAX_GREP_HITS) break;
        if (matcher.test(lines[i])) {
          hits.push({ path: fileRel, line: i + 1, text: lines[i].slice(0, 240) });
        }
      }
    };

    const walk = (dirAbs, dirRel) => {
      if (hits.length >= MAX_GREP_HITS) return;
      let names;
      try {
        names = readdirSync(dirAbs);
      } catch {
        return;
      }
      for (const name of names) {
        if (skipName(name)) continue;
        if (hits.length >= MAX_GREP_HITS) break;
        const childAbs = join(dirAbs, name);
        const childRel = dirRel === '.' ? name : `${dirRel}/${name}`;
        let isDir = false;
        try {
          isDir = statSync(childAbs).isDirectory();
        } catch {
          continue;
        }
        if (isDir) walk(childAbs, childRel);
        else visitFile(childAbs, childRel);
      }
    };

    if (existsSync(abs) && statSync(abs).isFile()) {
      visitFile(abs, rel);
    } else if (existsSync(abs) && statSync(abs).isDirectory()) {
      walk(abs, rel === '.' ? '.' : rel);
    } else {
      return { ok: false, error: `path not found: ${rel}` };
    }

    return {
      ok: true,
      path: rel,
      truncated: hits.length >= MAX_GREP_HITS,
      hits,
    };
  }

  async function call(name, args = {}) {
    switch (name) {
      case 'kusa_read_file':
      case 'read':
      case 'read_file':
        return readFile(args);
      case 'kusa_write_file':
      case 'write':
      case 'write_file':
        return writeFile(args);
      case 'kusa_patch_file':
      case 'patch':
      case 'patch_file':
      case 'str_replace':
        return patchFile(args);
      case 'kusa_list_dir':
      case 'list':
      case 'list_dir':
        return listDir(args);
      case 'kusa_grep':
      case 'grep':
        return grep(args);
      case 'kusa_delete_file':
      case 'delete':
      case 'delete_file':
      case 'rm':
        return deleteFile(args);
      default:
        return { ok: false, error: `unknown file tool: ${name}` };
    }
  }

  return {
    root,
    defs: FILE_TOOL_DEFS,
    readFile,
    writeFile,
    patchFile,
    listDir,
    grep,
    deleteFile,
    call,
  };
}

/** OpenAI/Chat Completions tool schema list. */
export function openaiToolSchemas() {
  return FILE_TOOL_DEFS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
