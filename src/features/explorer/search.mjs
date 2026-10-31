/**
 * Workspace file search for the sidebar File names pane.
 *
 * Same skip rules as the Explorer tree (src/features/explorer/tree.mjs): VCS and
 * build output are never searched, `.kusa` and `node_modules` are. Unlike the
 * tree, this walk DESCENDS into folders the tree left as counted stubs — a name
 * search has to see every name in the workspace to answer at all — so it runs on
 * its own entry budget and stops at the first `maxResults` matches. `truncated`
 * says one of those limits stopped the walk, so the UI labels the list partial
 * instead of implying the whole workspace was searched.
 *
 * Matching is a case-insensitive substring of the entry NAME, or of the
 * workspace-relative PATH when the query spans folders (`ui/App`, `serve.mjs`).
 * Name matches rank above path matches, workspace source above `node_modules`
 * (still searchable — just not first), shallow above deep, so the file the user
 * was reaching for comes back first. Content search is not this backend — there
 * is no content pane in the sidebar; the agent answers it with its own kusa_grep
 * tool over the same workspace, and a content pane would need its own id and
 * backend, not this one.
 */
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  compareNames,
  countEntries,
  fileTypeOf,
  MAX_DEPTH,
  MAX_NAME,
  normaliseRel,
  SKIP_DIRS,
} from './tree.mjs';

/** Match cap: rows the UI can scroll through, not a wall of hits. */
const MAX_RESULTS = 200;
/** Names inspected per search. Larger than the tree's budget on purpose: one
 * readdir of a name list is far cheaper than building a node for every entry,
 * and a search that stops at 2,000 names would never reach a deep source tree. */
const SEARCH_MAX_ENTRIES = 20_000;
/** Collect this many times the cap before ranking, so the rows shown are the
 * best matches rather than the first ones the walk happened to reach. */
const COLLECT_FACTOR = 4;

/** True when a path sits inside a dependency install: still a hit, never first. */
function dependencyRank(childRel) {
  return /(^|\/)node_modules(\/|$)/.test(childRel) ? 1 : 0;
}

/** Rank of one hit: 0 name-prefix, 1 name-contains, 2 path-contains, -1 miss. */
function rankOf(name, childRel, query) {
  const lower = name.toLowerCase();
  if (lower.startsWith(query)) return 0;
  if (lower.includes(query)) return 1;
  return childRel.toLowerCase().includes(query) ? 2 : -1;
}

/**
 * Search workspace file and folder NAMES.
 * @param {string} [workspaceRoot] folder to search (defaults to the process cwd)
 * @param {object} [{query}] required substring, case-insensitive
 * @param {object} [{path}] workspace-relative folder to scope the search to
 * @param {object} [{maxResults}] match cap (default 200)
 * @param {object} [{maxEntries}] name budget across the walk
 * @param {object} [{maxDepth}] how deep to descend below the start folder
 * @returns {{ ok: boolean, root: string, generatedAt: number, query: string, path: string, truncated: boolean, scanned: number, matched: number, counts: { files: number, dirs: number }, error: string, matches: { name: string, path: string, dir: string, kind: string, type: string, size: null, childCount: number, match: string }[] }}
 * `matched` is every hit collected (capped at maxResults × COLLECT_FACTOR);
 * `matches` is the ranked top `maxResults` of those. `dir` is the folder the hit
 * sits in — '' for the workspace root — so the UI can group rows by folder
 * without re-splitting the path. `match` says whether the query hit the name or
 * only the path above it, which is what the UI highlights. `childCount` is the
 * real entry count of a matched folder, matching the Explorer row for it.
 */
export function searchWorkspaceFiles(workspaceRoot = process.cwd(), { query = '', path = '', maxResults = MAX_RESULTS, maxEntries = SEARCH_MAX_ENTRIES, maxDepth = MAX_DEPTH } = {}) {
  const root = resolve(workspaceRoot || process.cwd());
  const q = String(query || '').trim().slice(0, MAX_NAME).toLowerCase();
  const startRel = normaliseRel(path);
  const startAbs = startRel ? join(root, startRel) : root;
  const cap = Math.max(1, Number(maxDepth) || MAX_DEPTH);
  const limit = Math.max(1, Number(maxResults) || MAX_RESULTS);
  const collectCap = limit * COLLECT_FACTOR;
  const budget = { left: Math.max(1, Number(maxEntries) || SEARCH_MAX_ENTRIES) };

  const fail = (error) => ({
    ok: false,
    root,
    generatedAt: Date.now(),
    query: q,
    path: startRel ?? '',
    truncated: false,
    scanned: 0,
    matched: 0,
    counts: { files: 0, dirs: 0 },
    error,
    matches: [],
  });

  if (!q) return fail('no query');
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return fail(`not a workspace folder: ${root}`);
  }
  if (startRel === null) return fail('path escapes the workspace');
  if (startRel && (!existsSync(startAbs) || !statSync(startAbs).isDirectory())) {
    return fail(`not a workspace folder: ${startRel}`);
  }

  const hits = [];
  let scanned = 0;
  let truncated = false;

  const walk = (dirAbs, dirRel, depth) => {
    if (budget.left <= 0) {
      truncated = true;
      return;
    }
    let names;
    try {
      names = readdirSync(dirAbs);
    } catch {
      return;
    }
    names.sort(compareNames);
    for (const name of names) {
      if (hits.length >= collectCap) {
        truncated = true;
        return;
      }
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
      scanned += 1;
      const rank = rankOf(name, childRel, q);
      if (rank >= 0) {
        hits.push({
          name: name.slice(0, MAX_NAME),
          path: childRel,
          dir: dirRel,
          kind: isDir ? 'dir' : 'file',
          type: isDir ? 'folder' : fileTypeOf(childRel),
          size,
          childCount: isDir ? countEntries(childAbs) : null,
          rank,
          dep: dependencyRank(childRel),
          depth: depth + 1,
        });
      }
      if (!isDir) continue;
      if (depth + 1 <= cap) {
        walk(childAbs, childRel, depth + 1);
      } else {
        // Names below the cap were never looked at: the answer is partial.
        truncated = true;
      }
    }
  };

  walk(startAbs, startRel, 0);

  // Best matches first: name-prefix beats name-contains beats path-only, then
  // workspace source above a dependency install, then the shallower path, then
  // the name itself — the same reading order as the Explorer tree.
  const ranked = hits.sort((a, b) => a.rank - b.rank || a.dep - b.dep || a.depth - b.depth || compareNames(a.path, b.path));
  const shown = ranked.slice(0, limit);
  return {
    ok: true,
    root,
    generatedAt: Date.now(),
    query: q,
    path: startRel,
    truncated,
    scanned,
    matched: hits.length,
    counts: {
      files: shown.filter((m) => m.kind === 'file').length,
      dirs: shown.filter((m) => m.kind === 'dir').length,
    },
    matches: shown.map(({ name, path: rel, dir, kind, type, size, childCount, rank }) => ({
      name,
      path: rel,
      dir,
      kind,
      type,
      size,
      childCount,
      match: rank === 2 ? 'path' : 'name',
    })),
  };
}
