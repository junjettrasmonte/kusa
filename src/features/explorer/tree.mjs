/**
 * Workspace file tree for the sidebar Explorer view.
 *
 * One bounded walk of the workspace root, returned as a nested tree the UI can
 * render directly. VCS and build output are skipped; `.kusa` and `node_modules`
 * are deliberately NOT skipped — both are workspace state the user browses like
 * any other folder. Instead of hiding big folders, folders over LAZY_THRESHOLD
 * entries are returned as a counted stub: the parent row is present (so the UI
 * can offer it) and its children load on demand via `path`. That keeps one
 * huge folder — a dependency install, a data dump — from flooding the tree or
 * spending the entry budget before the source tree is reached.
 */
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const MAX_ENTRIES = 2_000;
export const MAX_DEPTH = 12;
export const MAX_NAME = 200;

/** Entry count above which a folder's children are left out of the walk. The
 * folder itself is still emitted, with `childCount`, so the UI can show it and
 * fetch its children when the user opens it (`GET /files?path=<path>`). */
const LAZY_THRESHOLD = 50;

/** Directories that are never part of the source tree. */
export const SKIP_DIRS = new Set(['.git', '.build', 'dist']);

/** Real entry count of a folder: one readdir, no descent. Counts directory
 * entries rather than filesystem kinds, so a rare socket or fifo is counted
 * even though the walk will not render it. */
export function countEntries(dirAbs) {
  let names;
  try {
    names = readdirSync(dirAbs);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    n += 1;
  }
  return n;
}

/** Workspace-relative folder path from a query value, or null when it escapes
 * the root. '' means the root itself. */
export function normaliseRel(input) {
  const parts = String(input || '').replace(/\\/g, '/').split('/').filter(Boolean);
  for (const part of parts) {
    if (part === '..') return null;
  }
  return parts.join('/');
}

/** Extension → file-type id. The UI maps these ids to icons and tones. */
const FILE_TYPES = [
  { id: 'code', exts: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'py', 'go', 'rs', 'rb', 'php', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'lua', 'dart', 'ex', 'exs', 'clj', 'hs', 'ml', 'nim', 'zig', 'sol', 'tpl'] },
  { id: 'style', exts: ['css', 'scss', 'sass', 'less', 'styl'] },
  { id: 'markup', exts: ['html', 'htm', 'xhtml', 'xml', 'svg', 'rss', 'atom'] },
  { id: 'data', exts: ['json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'conf', 'lock', 'edn', 'proto', 'graphql', 'sql'] },
  { id: 'doc', exts: ['md', 'mdx', 'markdown', 'txt', 'rst', 'adoc', 'text', 'log'] },
  { id: 'image', exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'tif', 'tiff', 'bmp', 'avif'] },
  { id: 'script', exts: ['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'pl', 'awk', 'sed'] },
  { id: 'binary', exts: ['wasm', 'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'tar', 'so', 'dll', 'exe', 'bin', 'dat', 'parquet', 'woff', 'woff2', 'ttf', 'eot'] },
];

export function fileTypeOf(name) {
  const base = String(name || '').split('/').pop();
  if (base.startsWith('.') && !base.slice(1).includes('.')) return 'config'; // .env, .gitignore
  if (/^(package|config|setup|makefile|dockerfile|readme|license|changelog|contributing|todo|notes)$/i.test(base)) return 'config';
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (!ext) return 'config';
  if (ext === 'env' || ext === 'properties') return 'config';
  for (const { id, exts } of FILE_TYPES) {
    if (exts.includes(ext)) return id;
  }
  return 'file';
}

export function compareNames(a, b) {
  const na = String(a).toLowerCase();
  const nb = String(b).toLowerCase();
  if (na !== nb) return na < nb ? -1 : 1;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/**
 * Walk the workspace and return a nested tree.
 * @param {string} [workspaceRoot] folder to walk (defaults to the process cwd)
 * @param {object} [{maxEntries}] entry cap across the whole walk
 * @param {object} [{maxDepth}] how deep to descend below the start folder
 * @param {object} [{path}] workspace-relative folder to start at — the UI uses
 * this to load one lazy folder's children on demand
 * @returns {{ ok: boolean, root: string, generatedAt: number, truncated: boolean, counts: { files: number, dirs: number }, error: string, tree: { name: string, path: string, kind: string, type: string, size: null, childCount: number, children: object[] } }}
 * `counts` covers only what is in the payload: a folder left as a lazy stub
 * counts itself, not its unseen descendants. Every dir node carries `childCount`,
 * its real entry count, so the UI can tell `children.length < childCount` —
 * children are waiting behind a click. `lazy` counts those stubs in this payload.
 */
export function collectWorkspaceTree(workspaceRoot = process.cwd(), { maxEntries = MAX_ENTRIES, maxDepth = MAX_DEPTH, path = '' } = {}) {
  const root = resolve(workspaceRoot || process.cwd());
  const budget = { left: Math.max(1, Number(maxEntries) || MAX_ENTRIES) };
  const depthCap = Math.max(1, Number(maxDepth) || MAX_DEPTH);
  const startRel = normaliseRel(path);
  const startAbs = startRel ? join(root, startRel) : root;
  let files = 0;
  let dirs = 0;
  let lazy = 0; // folders left as stubs, their children waiting behind a click
  let truncated = false;

  const walk = (dirAbs, dirRel, depth, cap = depthCap) => {
    const children = [];
    if (budget.left <= 0) {
      truncated = true;
      return children;
    }
    let names;
    try {
      names = readdirSync(dirAbs);
    } catch {
      return children;
    }
    names.sort(compareNames);
    for (const name of names) {
      if (budget.left <= 0) {
        truncated = true;
        break;
      }
      if (SKIP_DIRS.has(name)) continue;
      const childAbs = join(dirAbs, name);
      const childRel = dirRel ? `${dirRel}/${name}` : name;
      let isDir = false;
      let isFile = false;
      let size = null;
      try {
        const st = lstatSync(childAbs);
        if (st.isSymbolicLink()) {
          // Show links as leaves: following them can loop back into the root.
          isFile = true;
        } else if (st.isDirectory()) {
          isDir = true;
        } else if (st.isFile()) {
          isFile = true;
          size = Number(st.size);
        }
      } catch {
        continue;
      }
      if (!isDir && !isFile) continue;
      budget.left -= 1;
      if (isDir) {
        dirs += 1;
        // Count the folder first, then decide whether to list it: over LAZY_THRESHOLD
        // entries (or past the depth cap) the row stays but the children do not,
        // and `childCount` is what the UI shows behind the chevron to load on click.
        const entryCount = countEntries(childAbs);
        const descend = depth + 1 <= cap && entryCount <= LAZY_THRESHOLD;
        if (!descend && entryCount > LAZY_THRESHOLD) lazy += 1;
        children.push({
          name: name.slice(0, MAX_NAME),
          path: childRel,
          kind: 'dir',
          type: 'folder',
          size: null,
          childCount: entryCount,
          children: descend ? walk(childAbs, childRel, depth + 1, cap) : [],
        });
        continue;
      }
      files += 1;
      children.push({
        name: name.slice(0, MAX_NAME),
        path: childRel,
        kind: 'file',
        type: fileTypeOf(childRel),
        size,
      });
    }
    // Directories first so the tree reads like a file browser, not a flat list.
    children.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'dir' ? -1 : 1) || compareNames(a.name, b.name));
    return children;
  };

  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return {
      ok: false,
      root,
      generatedAt: Date.now(),
      truncated: false,
      lazy: 0,
      counts: { files: 0, dirs: 0 },
      error: `not a workspace folder: ${root}`,
      tree: { name: '', path: '', kind: 'dir', type: 'folder', size: null, childCount: 0, children: [] },
    };
  }
  if (startRel === null) {
    return {
      ok: false,
      root,
      generatedAt: Date.now(),
      truncated: false,
      lazy: 0,
      counts: { files: 0, dirs: 0 },
      error: 'path escapes the workspace',
      tree: { name: '', path: '', kind: 'dir', type: 'folder', size: null, childCount: 0, children: [] },
    };
  }
  if (startRel && (!existsSync(startAbs) || !statSync(startAbs).isDirectory())) {
    return {
      ok: false,
      root,
      generatedAt: Date.now(),
      truncated: false,
      lazy: 0,
      counts: { files: 0, dirs: 0 },
      error: `not a workspace folder: ${startRel}`,
      tree: { name: startRel.split('/').pop(), path: startRel, kind: 'dir', type: 'folder', size: null, childCount: 0, children: [] },
    };
  }

  // Walk BEFORE reporting: counts and `truncated` are filled by the walk, so
  // reading them in the same object literal as `children: walk(...)` would
  // report zeros (property order evaluates `counts` first).
  const children = walk(startAbs, startRel, 0);
  return {
    ok: true,
    root,
    generatedAt: Date.now(),
    truncated,
    lazy,
    counts: { files, dirs },
    tree: {
      name: startRel ? startRel.split('/').pop() : root.split(sep).pop() || root,
      path: startRel,
      kind: 'dir',
      type: 'folder',
      size: null,
      childCount: countEntries(startAbs),
      children,
    },
  };
}
