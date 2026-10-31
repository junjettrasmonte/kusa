/**
 * Sidebar › Explorer — the workspace source tree.
 *
 * The tree comes from GET /files (collectWorkspaceTree in
 * src/features/explorer/tree.mjs): one bounded walk of the workspace with VCS
 * and build output already skipped server-side. `.kusa` and `node_modules` are
 * both shown — a folder over 50 entries is not hidden, it arrives as a counted
 * stub whose children load on demand (GET /files?path=…) the moment the user
 * opens it, so the parent row is always in the payload and can offer the click.
 * Every folder is a toggle — clicking a row collapses or expands its subtree, and
 * the collapsed set is kept in browser-local storage so reopening the view keeps
 * the shape the user asked for. Without the console server (file://) there is no
 * walk to fetch, so the panel says so instead of rendering an empty tree.
 */
import { useEffect, useState } from 'react';

import { FILE_ICONS } from '#ui/shared/FileIcons.jsx';
import { readJsonSet, writeJsonSet } from '#ui/shared/lib/storage.js';

const COLLAPSED_KEY = 'monitor.explorerCollapsed';
const EXPANDED_KEY = 'monitor.explorerExpanded';
const MAX_RENDER_DEPTH = 6;

/** Icon tones per file-type id (keys match FILE_ICONS). Shared with the
 * sidebar Search view, which shows the same rows the Explorer would. */
export const TONES = {
  folder: 'text-amber-300',
  code: 'text-sky-300',
  doc: 'text-gray-300',
  data: 'text-violet-300',
  image: 'text-emerald-300',
  script: 'text-teal-300',
  binary: 'text-rose-300',
  config: 'text-orange-300',
  file: 'text-gray-400',
};

function Chevron({ open = false, className = 'h-2.5 w-2.5' }) {
  return (
    <svg
      className={`relative inline-flex ${className} transition-transform ${open ? 'rotate-90' : ''}`.trim()}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4z" />
    </svg>
  );
}

/** Item count for a folder whose children are not in the tree yet — either the
 * walk left it as a lazy stub (click to load) or it sits past the render depth.
 * It trails the label: an ml-auto here would sit before the icon and absorb the
 * row's free space, pushing the whole row to the right. */
function ChildCountBadge({ count }) {
  return (
    <span className="shrink-0 rounded-full bg-gray-800 px-1.5 text-[10px] tabular-nums text-gray-400">
      {count}
    </span>
  );
}

/** One row of the tree, plus its children when the folder is expanded. */
function TreeRow({ node, depth, collapsedSet, expandedSet, loaded, onToggle }) {
  const isDir = node.kind === 'dir';
  // Children come from the walk, or from an on-demand fetch keyed by folder path
  // (`true` while that fetch is in flight). A folder over the server's lazy
  // threshold arrives as a stub: the row is here, the children are not.
  const fetched = loaded ? loaded[node.path] : undefined;
  const children = node.children?.length ? node.children : (Array.isArray(fetched) ? fetched : []);
  const childCount = Number(node.childCount ?? children.length);
  const withheld = isDir && childCount > children.length;
  const loading = isDir && fetched === true;
  // Nothing to show until a fetch lands: such a folder starts closed, and the
  // first click on it is what loads the children behind its count badge.
  const stub = isDir && childCount > 0 && !children.length && fetched !== true;
  // Every folder is collapsible, empty ones included: expanding an empty folder
  // simply yields nothing. Only the render depth stops a folder from expanding.
  const expandable = isDir && depth < MAX_RENDER_DEPTH;
  const open = isDir ? (stub ? expandedSet.has(node.path) : !collapsedSet.has(node.path)) : false;
  const tone = TONES[node.type] || TONES[isDir ? 'folder' : 'file'];
  const icon = FILE_ICONS[node.type] || FILE_ICONS[isDir ? 'folder' : 'file'];

  return (
    <div className="relative flex w-full shrink-0 flex-col">
      <button
        type="button"
        title={isDir ? `${node.path} · ${childCount} item${childCount === 1 ? '' : 's'}` : node.path}
        className={`flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left rounded ${
          isDir ? 'hover:bg-gray-800/70 font-medium text-gray-200' : 'hover:bg-gray-800/50 text-gray-300'
        } ${expandable ? '' : 'cursor-default'}`}
        onClick={expandable ? () => onToggle(node) : undefined}
      >
        {expandable ? <Chevron open={open} /> : null}
        <span className={`h-3.5 w-3.5 shrink-0 ${tone}`}>{icon}</span>
        <span className="truncate">{node.name}</span>
        {isDir && withheld ? ChildCountBadge({ count: childCount }) : null}
      </button>
      {isDir && open && expandable ? (
        <div className="ml-3">
          {loading && !children.length ? (
            <p className="text-[10px] text-gray-500">loading {childCount} items…</p>
          ) : null}
          {children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              collapsedSet={collapsedSet}
              expandedSet={expandedSet}
              loaded={loaded}
              onToggle={onToggle}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ExplorerPanel() {
  const canServe = typeof location !== 'undefined' && location.protocol !== 'file:';
  const [payload, setPayload] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [collapsedDirs, setCollapsedDirs] = useState(() => readJsonSet(COLLAPSED_KEY));
  // Folders the user explicitly opened. A folder whose children were left out of
  // the walk starts closed — its count badge is the offer — so remembering this
  // set is what keeps those subtrees open across reloads and triggers their
  // reload below.
  const [expandedDirs, setExpandedDirs] = useState(() => readJsonSet(EXPANDED_KEY));
  // Children of folders the walk left out (over the lazy threshold), keyed by
  // folder path: `true` while a fetch is in flight, an array once it lands.
  const [loaded, setLoaded] = useState({});

  async function load() {
    if (!canServe || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/files', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!body || !body.tree) throw new Error('no workspace tree in response');
      setPayload(body);
      setLoaded({}); // a fresh walk starts fresh subtrees
      setLoadError(null);
      // Re-open what the user had left open last time: any of those that are
      // lazy stubs in this walk reload on demand. Bounded so a long remembered
      // list can never fire a burst of fetches on load.
      for (const path of [...expandedDirs].slice(0, 8)) void loadChildren(path);
    } catch (err) {
      setLoadError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  /** Load one folder's children — the click on its counted row is the trigger. */
  async function loadChildren(path) {
    // No `busy` guard: the full walk and a subtree fetch are independent, and a
    // subtree that lands mid-walk is simply overwritten by the fresh walk.
    if (!canServe || !path || loaded?.[path] !== undefined) return;
    // Mark in flight through the state itself so a second click cannot fire a
    // second fetch for the same folder.
    setLoaded((current) => current?.[path] !== undefined ? current : { ...current, [path]: true });
    try {
      const res = await fetch(`/files?path=${encodeURIComponent(path)}&depth=1`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!body || !body.tree) throw new Error('no folder contents in response');
      setLoaded((current) => ({ ...current, [path]: body.tree.children || [] }));
    } catch (err) {
      // Drop the marker so the next click retries; the row still shows its count.
      setLoaded((current) => {
        const next = { ...current };
        delete next[path];
        return next;
      });
    }
  }

  useEffect(() => {
    if (!canServe) return undefined;
    load();
    return undefined;
  }, [canServe]);

  function toggleDir(node) {
    const path = node.path;
    const listed = (node.children || []).length
      || (Array.isArray(loaded?.[path]) ? loaded[path].length : 0);
    // A folder with nothing loaded yet is closed until clicked; any other folder
    // is open until clicked.
    const stub = Number(node.childCount ?? listed) > listed && listed === 0;
    const isOpen = stub ? expandedDirs.has(path) : !collapsedDirs.has(path);
    const nextCollapsed = new Set(collapsedDirs);
    const nextExpanded = new Set(expandedDirs);
    if (isOpen) {
      nextCollapsed.add(path);
      nextExpanded.delete(path);
    } else {
      nextCollapsed.delete(path);
      nextExpanded.add(path);
      if (stub) void loadChildren(path); // the click is the trigger for the fetch
    }
    setCollapsedDirs(nextCollapsed);
    writeJsonSet(COLLAPSED_KEY, nextCollapsed);
    setExpandedDirs(nextExpanded);
    writeJsonSet(EXPANDED_KEY, nextExpanded);
  }

  const tree = payload?.tree;
  const counts = payload?.counts;
  const rootName = tree?.name || '';

  return (
    <nav
      id="sidebar-panel-explorer"
      role="tabpanel"
      aria-labelledby="sidebar-view-explorer"
      className="flex-1 overflow-y-auto py-1 text-sm"
      aria-label="Workspace files"
    >
      <div className="flex h-8 shrink-0 items-center gap-1 px-3 pb-1">
        <span className="truncate text-[10px] tabular-nums text-gray-500">
          {payload
            ? `${counts?.files ?? 0} files · ${counts?.dirs ?? 0} folders${payload.truncated ? ' · capped' : ''}${payload.lazy ? ` · ${payload.lazy} not loaded` : ''}`
            : canServe
              ? 'Reading workspace…'
              : 'No workspace walk without kusa serve'}
        </span>
        <button
          type="button"
          title="Re-read workspace files"
          aria-label="Re-read workspace files"
          disabled={!canServe || busy}
          className={`shrink-0 ml-auto rounded p-1 text-gray-400 disabled:cursor-not-allowed disabled:opacity-40 hover:bg-gray-800 hover:text-emerald-400 ${busy ? 'opacity-50' : ''}`}
          onClick={() => load()}
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 8a5 5 0 1 1-1.5-3.5M13 3v3.5H9.5" />
          </svg>
        </button>
      </div>

      {canServe && tree ? (
        <div className="flex items-center gap-1 px-3 py-1 border-b border-gray-800/70 text-xs text-gray-500">
          <span className="h-3.5 w-3.5 shrink-0 text-amber-300">{FILE_ICONS.folder}</span>
          <span className="truncate font-mono">{rootName || 'workspace'}</span>
        </div>
      ) : null}

      {canServe && tree ? (
        <div className="px-3">
          {(tree.children || []).map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={0}
              collapsedSet={collapsedDirs}
              expandedSet={expandedDirs}
              loaded={loaded}
              onToggle={toggleDir}
            />
          ))}
        </div>
      ) : null}

      {canServe && !payload ? (
        <p className="px-3 text-[11px] text-gray-500">
          {loadError ? `Could not read the workspace: ${loadError}` : 'Walking the workspace tree…'}
        </p>
      ) : null}

      {!canServe ? (
        <p className="px-3 text-[11px] text-gray-500">
          Open the dashboard over HTTP (
          <code className="text-sky-300">kusa serve</code>) to browse workspace files.
        </p>
      ) : null}
    </nav>
  );
}
