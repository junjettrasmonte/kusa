/**
 * Sidebar › Explorer — the workspace source tree.
 *
 * The tree comes from GET /files (collectWorkspaceTree in
 * src/features/explorer/tree.mjs): one bounded walk of the workspace with VCS
 * and build output already skipped server-side. `.kusa` and `node_modules` are
 * both shown — a folder over 50 entries is not hidden, it arrives as a counted
 * stub whose children load on demand (GET /files?path=…) the moment the user
 * opens it, so the parent row is always in the payload and can offer the click.
 *
 * Session cache (tree-cache.js) keeps the last walk across view remounts.
 * Manual refresh busts the cache. GET /files/rev is polled while this panel is
 * open; create/delete (editor, agent tools) bumps that rev and triggers a soft
 * refetch without clearing the tree first.
 */
import { useEffect, useRef, useState } from 'react';

import { FILE_ICON_TONES as TONES, FileTypeIcon } from '#ui/shared/FileIcons.jsx';
import { LucideIcon } from '#ui/shared/LucideIcons.jsx';
import { readJsonSet, writeJsonSet } from '#ui/shared/lib/storage.js';
import {
  getExplorerCache,
  invalidateExplorerCache,
  setExplorerCache,
  setExplorerLoadedCache,
  subscribeExplorerCache,
} from '#ui/features/explorer/tree-cache.js';

const COLLAPSED_KEY = 'monitor.explorerCollapsed';
const EXPANDED_KEY = 'monitor.explorerExpanded';
const MAX_RENDER_DEPTH = 6;
/** How often to ask /files/rev while Explorer is visible. */
const REV_POLL_MS = 4000;

function ChildCountBadge({ count }) {
  return (
    <span className="shrink-0 rounded-full bg-gray-800 px-1.5 text-[10px] tabular-nums text-gray-400">
      {count}
    </span>
  );
}

function TreeRow({ node, depth, collapsedSet, expandedSet, loaded, onToggle, onOpenFile }) {
  const isDir = node.kind === 'dir';
  const fetched = loaded ? loaded[node.path] : undefined;
  const children = node.children?.length ? node.children : (Array.isArray(fetched) ? fetched : []);
  const childCount = Number(node.childCount ?? children.length);
  const withheld = isDir && childCount > children.length;
  const loading = isDir && fetched === true;
  const stub = isDir && childCount > 0 && !children.length && fetched !== true;
  const expandable = isDir && depth < MAX_RENDER_DEPTH;
  const open = isDir ? (stub ? expandedSet.has(node.path) : !collapsedSet.has(node.path)) : false;
  const type = node.type || (isDir ? 'folder' : 'file');
  const tone = TONES[type] || TONES[isDir ? 'folder' : 'file'];
  const canOpen = !isDir && typeof onOpenFile === 'function';

  function handleClick() {
    if (isDir) {
      if (expandable) onToggle(node);
      return;
    }
    if (canOpen) onOpenFile(node.path);
  }

  return (
    <div className="relative flex w-full shrink-0 flex-col">
      <button
        type="button"
        data-kusa-file={canOpen ? node.path : undefined}
        title={isDir ? `${node.path} · ${childCount} item${childCount === 1 ? '' : 's'}` : node.path}
        className={`flex min-w-0 flex-1 items-center gap-1 rounded px-0.5 py-0.5 text-left ${
          isDir ? 'font-medium text-gray-200 hover:bg-gray-800/70' : 'text-gray-300 hover:bg-gray-800/50'
        } ${expandable || canOpen ? 'cursor-pointer' : 'cursor-default'}`}
        onClick={expandable || canOpen ? handleClick : undefined}
      >
        {expandable ? (
          <LucideIcon
            name="chevron-right"
            className={`h-3 w-3 shrink-0 text-gray-500 transition-transform ${open ? 'rotate-90' : ''}`}
          />
        ) : (
          <span className="inline-flex h-3 w-3 shrink-0" aria-hidden="true" />
        )}
        <span className={`shrink-0 ${tone}`}>
          <FileTypeIcon type={type} open={isDir && open} />
        </span>
        <span className="min-w-0 truncate text-xs">{node.name}</span>
        {isDir && withheld ? <ChildCountBadge count={childCount} /> : null}
        {loading ? (
          <LucideIcon name="loader-circle" className="ml-0.5 h-3 w-3 shrink-0 animate-spin text-gray-500" />
        ) : null}
      </button>
      {isDir && open && expandable ? (
        <div className="ml-3 border-l border-gray-800/60 pl-1">
          {loading && !children.length ? (
            <p className="px-1 py-0.5 text-[10px] text-gray-500 sidebar-label">
              loading {childCount} items…
            </p>
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
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function initialPayload() {
  return getExplorerCache()?.payload ?? null;
}

function initialLoaded() {
  const loaded = getExplorerCache()?.loaded;
  return loaded && typeof loaded === 'object' ? { ...loaded } : {};
}

export function ExplorerPanel({ onOpenFile = null, collapsed = false } = {}) {
  const canServe = typeof location !== 'undefined' && location.protocol !== 'file:';
  const [payload, setPayload] = useState(initialPayload);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [collapsedDirs, setCollapsedDirs] = useState(() => readJsonSet(COLLAPSED_KEY));
  const [expandedDirs, setExpandedDirs] = useState(() => readJsonSet(EXPANDED_KEY));
  const [loaded, setLoaded] = useState(initialLoaded);
  const expandedDirsRef = useRef(expandedDirs);
  expandedDirsRef.current = expandedDirs;
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const revRef = useRef(getExplorerCache()?.rev ?? null);
  const fetchGen = useRef(0);
  const inFlight = useRef(false);

  async function fetchRev() {
    try {
      const res = await fetch('/files/rev', { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const body = await res.json();
      const rev = Number(body?.rev);
      return Number.isFinite(rev) ? rev : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {{ force?: boolean, quiet?: boolean }} [opts]
   * force — bust cache and show the refresh spinner (manual button).
   * quiet — soft revalidate; keep showing the current tree.
   */
  async function load(opts = {}) {
    const force = Boolean(opts.force);
    const quiet = Boolean(opts.quiet) && !force;
    if (!canServe) return;
    if (inFlight.current && !force) return;
    inFlight.current = true;
    const gen = ++fetchGen.current;
    if (!quiet) setBusy(true);
    try {
      if (force) invalidateExplorerCache('manual', { clear: true });
      const res = await fetch('/files', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (gen !== fetchGen.current) return;
      if (!body || !body.tree) throw new Error('no workspace tree in response');
      const rev = Number.isFinite(Number(body.rev)) ? Number(body.rev) : await fetchRev();
      revRef.current = rev;
      setPayload(body);
      setLoaded({});
      setLoadError(null);
      setExplorerCache({ payload: body, loaded: {}, rev });
      for (const path of [...expandedDirsRef.current].slice(0, 8)) {
        void loadChildren(path, { force: true });
      }
    } catch (err) {
      if (gen !== fetchGen.current) return;
      setLoadError(err?.message || String(err));
    } finally {
      if (gen === fetchGen.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }

  async function loadChildren(path, opts = {}) {
    if (!canServe || !path) return;
    if (!opts.force && loadedRef.current?.[path] !== undefined) return;
    setLoaded((current) => {
      if (!opts.force && current?.[path] !== undefined) return current;
      return { ...current, [path]: true };
    });
    try {
      const res = await fetch(`/files?path=${encodeURIComponent(path)}&depth=1`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!body || !body.tree) throw new Error('no folder contents in response');
      const children = body.tree.children || [];
      setLoaded((current) => {
        const next = { ...current, [path]: children };
        setExplorerLoadedCache(next);
        return next;
      });
    } catch {
      setLoaded((current) => {
        const next = { ...current };
        delete next[path];
        setExplorerLoadedCache(next);
        return next;
      });
    }
  }

  // Hydrate from session cache; fetch only when missing or already stale.
  useEffect(() => {
    if (!canServe) return undefined;
    const cached = getExplorerCache();
    if (cached?.payload) {
      setPayload(cached.payload);
      setLoaded(cached.loaded && typeof cached.loaded === 'object' ? { ...cached.loaded } : {});
      revRef.current = cached.rev;
      if (cached.stale) void load({ quiet: true });
    } else {
      void load();
    }
    return undefined;
  }, [canServe]);

  // Soft-refetch when another surface invalidates the cache (e.g. new file save).
  useEffect(() => {
    if (!canServe) return undefined;
    return subscribeExplorerCache((event) => {
      if (event.type !== 'invalidate') return;
      void load({ quiet: true });
    });
  }, [canServe]);

  // Poll /files/rev while visible — cheap, catches agent create/delete.
  useEffect(() => {
    if (!canServe) return undefined;
    let timer = null;
    let stopped = false;

    async function tick() {
      if (stopped || document.visibilityState === 'hidden') return;
      const rev = await fetchRev();
      if (stopped || rev == null) return;
      if (revRef.current == null) {
        revRef.current = rev;
        return;
      }
      if (rev !== revRef.current) {
        revRef.current = rev;
        void load({ quiet: true });
      }
    }

    void tick();
    timer = setInterval(() => void tick(), REV_POLL_MS);
    function onVis() {
      if (document.visibilityState === 'visible') void tick();
    }
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [canServe]);

  function toggleDir(node) {
    const path = node.path;
    const listed = (node.children || []).length
      || (Array.isArray(loaded?.[path]) ? loaded[path].length : 0);
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
      if (stub) void loadChildren(path);
    }
    setCollapsedDirs(nextCollapsed);
    writeJsonSet(COLLAPSED_KEY, nextCollapsed);
    setExpandedDirs(nextExpanded);
    writeJsonSet(EXPANDED_KEY, nextExpanded);
  }

  const tree = payload?.tree;
  const rootName = tree?.name || '';

  return (
    <nav
      id="sidebar-panel-explorer"
      role="tabpanel"
      aria-labelledby="sidebar-view-explorer"
      className="flex min-h-0 flex-1 flex-col overflow-hidden text-sm"
      aria-label="Workspace files"
    >
      {!collapsed ? (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-gray-800 px-2 sidebar-label">
          <span className="truncate pl-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            Explorer
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            <button
              type="button"
              title="Re-read workspace files"
              aria-label="Re-read workspace files"
              disabled={!canServe || busy}
              className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                busy
                  ? 'text-emerald-400'
                  : 'text-gray-500 hover:bg-gray-800 hover:text-gray-200'
              }`}
              onClick={() => void load({ force: true })}
            >
              <LucideIcon
                name="refresh-cw"
                className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`}
              />
            </button>
          </div>
        </div>
      ) : null}

      {canServe && tree && !collapsed ? (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-gray-800/70 px-3 py-1.5 sidebar-label">
          <span className="shrink-0 text-amber-300">
            <FileTypeIcon type="folder" open />
          </span>
          <span className="truncate font-mono text-xs text-gray-400">{rootName || 'workspace'}</span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {canServe && tree ? (
          (tree.children || []).map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={0}
              collapsedSet={collapsedDirs}
              expandedSet={expandedDirs}
              loaded={loaded}
              onToggle={toggleDir}
              onOpenFile={onOpenFile}
            />
          ))
        ) : null}

        {canServe && !payload ? (
          <p className="px-1 text-[11px] text-gray-500 sidebar-label">
            {loadError ? `Could not read the workspace: ${loadError}` : 'Walking the workspace tree…'}
          </p>
        ) : null}

        {!canServe ? (
          <p className="px-1 text-[11px] text-gray-500 sidebar-label">
            Open the dashboard over HTTP (
            <code className="text-sky-300">kusa serve</code>) to browse workspace files.
          </p>
        ) : null}
      </div>
    </nav>
  );
}
