/**
 * Workspace content search / replace for the sidebar Search pane.
 * Sandboxed under workspaceRoot; skips VCS/build/deps folders by default.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { resolveWorkspacePath } from '#features/agent/files.mjs';
import { writeWorkspaceFile } from '#features/explorer/file.mjs';

export const MAX_CONTENT_HITS = 500;
export const MAX_CONTENT_FILE_BYTES = 512 * 1024;
export const MAX_REPLACE_FILES = 100;

const SKIP_DIRS = new Set([
  '.git',
  '.build',
  'dist',
  'node_modules',
  '.venv',
  'venv',
  '.kusa',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
]);

function skipName(name) {
  return SKIP_DIRS.has(name);
}

/** Escape a literal string for use inside a RegExp source. */
function escapeLiteral(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One include/exclude glob → regex. Supports *, **, and ? */
function globToRegex(pattern) {
  let out = '';
  const p = String(pattern || '');
  for (let i = 0; i < p.length; i += 1) {
    const ch = p[i];
    if (ch === '*') {
      if (p[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\.^$+{}()|[]'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

/**
 * @param {string} spec comma-separated globs
 * @returns {RegExp[] | null}
 */
export function compileGlobList(spec) {
  const parts = String(spec || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 24);
  if (!parts.length) return null;
  return parts.map(globToRegex);
}

function pathMatchesGlobs(relPath, globs) {
  if (!globs?.length) return true;
  const base = relPath.split('/').pop() || relPath;
  return globs.some((re) => re.test(relPath) || re.test(base));
}

/**
 * Build the line matcher from the search UI flags.
 * @returns {{ ok: true, re: RegExp } | { ok: false, error: string }}
 */
export function buildContentMatcher({
  query = '',
  regex = false,
  matchCase = false,
  wholeWord = false,
} = {}) {
  const q = String(query || '');
  if (!q) return { ok: false, error: 'query is required' };
  const flags = matchCase ? 'g' : 'gi';
  try {
    let source = regex ? q : escapeLiteral(q);
    if (wholeWord) source = `\\b(?:${source})\\b`;
    return { ok: true, re: new RegExp(source, flags) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Search file contents under the workspace.
 * @returns {{
 *   ok: boolean,
 *   query: string,
 *   truncated?: boolean,
 *   scanned?: number,
 *   matchCount?: number,
 *   fileCount?: number,
 *   files?: { path: string, matches: { line: number, text: string, col: number }[] }[],
 *   error?: string,
 * }}
 */
export function searchWorkspaceContent(workspaceRoot = process.cwd(), opts = {}) {
  const {
    query = '',
    path: scopePath = '',
    regex = false,
    matchCase = false,
    wholeWord = false,
    include = '',
    exclude = '',
    maxHits = MAX_CONTENT_HITS,
  } = opts;

  const matcher = buildContentMatcher({ query, regex, matchCase, wholeWord });
  if (!matcher.ok) {
    return { ok: false, query: String(query || ''), error: matcher.error };
  }

  let start;
  try {
    start = resolveWorkspacePath(workspaceRoot, scopePath || '.');
  } catch (err) {
    return { ok: false, query: String(query || ''), error: err?.message || String(err) };
  }

  const includeGlobs = compileGlobList(include);
  const excludeGlobs = compileGlobList(exclude);
  const limit = Math.max(1, Math.min(Number(maxHits) || MAX_CONTENT_HITS, MAX_CONTENT_HITS));

  /** @type {Map<string, { path: string, matches: { line: number, col: number, text: string }[] }>} */
  const byFile = new Map();
  let matchCount = 0;
  let scanned = 0;
  let truncated = false;

  const pushHit = (fileRel, line, col, text) => {
    if (matchCount >= limit) {
      truncated = true;
      return;
    }
    let row = byFile.get(fileRel);
    if (!row) {
      row = { path: fileRel, matches: [] };
      byFile.set(fileRel, row);
    }
    row.matches.push({ line, col, text: text.slice(0, 240) });
    matchCount += 1;
  };

  const visitFile = (fileAbs, fileRel) => {
    if (matchCount >= limit) {
      truncated = true;
      return;
    }
    if (includeGlobs && !pathMatchesGlobs(fileRel, includeGlobs)) return;
    if (excludeGlobs && pathMatchesGlobs(fileRel, excludeGlobs)) return;
    let st;
    try {
      st = statSync(fileAbs);
    } catch {
      return;
    }
    if (!st.isFile() || st.size > MAX_CONTENT_FILE_BYTES) return;
    let text;
    try {
      text = readFileSync(fileAbs, 'utf8');
    } catch {
      return;
    }
    if (text.includes('\0')) return;
    scanned += 1;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (matchCount >= limit) {
        truncated = true;
        break;
      }
      matcher.re.lastIndex = 0;
      const m = matcher.re.exec(lines[i]);
      if (!m) continue;
      pushHit(fileRel, i + 1, (m.index || 0) + 1, lines[i].trimEnd());
    }
  };

  const walk = (dirAbs, dirRel) => {
    if (matchCount >= limit) {
      truncated = true;
      return;
    }
    let names;
    try {
      names = readdirSync(dirAbs);
    } catch {
      return;
    }
    names.sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      if (matchCount >= limit) {
        truncated = true;
        break;
      }
      if (skipName(name)) continue;
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

  if (!existsSync(start.abs)) {
    return { ok: false, query: String(query || ''), error: `path not found: ${start.rel}` };
  }
  const st = statSync(start.abs);
  if (st.isFile()) {
    const rel = start.rel === '.' ? relative(resolve(workspaceRoot), start.abs).split(sep).join('/') : start.rel;
    visitFile(start.abs, rel || start.rel);
  } else if (st.isDirectory()) {
    walk(start.abs, start.rel === '.' ? '.' : start.rel);
  } else {
    return { ok: false, query: String(query || ''), error: `not a file or folder: ${start.rel}` };
  }

  return {
    ok: true,
    query: String(query || ''),
    truncated,
    scanned,
    matchCount,
    fileCount: byFile.size,
    files: [...byFile.values()],
  };
}

/**
 * Replace matches across the workspace (or a path list).
 * When dryRun is true, no files are written — counts only.
 */
export function replaceWorkspaceContent(workspaceRoot = process.cwd(), opts = {}) {
  const {
    query = '',
    replacement = '',
    regex = false,
    matchCase = false,
    wholeWord = false,
    include = '',
    exclude = '',
    dryRun = false,
    /** @type {string[] | null} */
    paths = null,
  } = opts;

  const matcher = buildContentMatcher({ query, regex, matchCase, wholeWord });
  if (!matcher.ok) {
    return { ok: false, error: matcher.error, changedFiles: 0, replacements: 0, files: [] };
  }

  const search = paths?.length
    ? null
    : searchWorkspaceContent(workspaceRoot, {
      query,
      regex,
      matchCase,
      wholeWord,
      include,
      exclude,
      maxHits: MAX_CONTENT_HITS,
    });

  if (search && !search.ok) {
    return { ok: false, error: search.error, changedFiles: 0, replacements: 0, files: [] };
  }

  const targetPaths = paths?.length
    ? [...new Set(paths.map((p) => String(p || '').trim()).filter(Boolean))].slice(0, MAX_REPLACE_FILES)
    : (search.files || []).map((f) => f.path).slice(0, MAX_REPLACE_FILES);

  const includeGlobs = compileGlobList(include);
  const excludeGlobs = compileGlobList(exclude);
  const repl = replacement == null ? '' : String(replacement);

  /** @type {{ path: string, replacements: number }[]} */
  const changed = [];

  for (const rel of targetPaths) {
    if (includeGlobs && !pathMatchesGlobs(rel, includeGlobs)) continue;
    if (excludeGlobs && pathMatchesGlobs(rel, excludeGlobs)) continue;

    let target;
    try {
      target = resolveWorkspacePath(workspaceRoot, rel);
    } catch {
      continue;
    }
    if (!existsSync(target.abs) || !statSync(target.abs).isFile()) continue;

    let text;
    try {
      const st = statSync(target.abs);
      if (st.size > MAX_CONTENT_FILE_BYTES) continue;
      text = readFileSync(target.abs, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;

    let fileCount = 0;
    matcher.re.lastIndex = 0;
    const next = text.replace(matcher.re, () => {
      fileCount += 1;
      return repl;
    });
    if (!fileCount || next === text) continue;

    if (!dryRun) {
      const written = writeWorkspaceFile(workspaceRoot, target.rel, next);
      if (!written.ok) continue;
    }
    changed.push({ path: target.rel, replacements: fileCount });
  }

  return {
    ok: true,
    dryRun: Boolean(dryRun),
    changedFiles: changed.length,
    replacements: changed.reduce((sum, row) => sum + row.replacements, 0),
    files: changed,
    truncated: Boolean(search?.truncated) || (search?.files?.length || 0) > MAX_REPLACE_FILES,
  };
}
