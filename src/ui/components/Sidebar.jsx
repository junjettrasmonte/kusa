import { useEffect, useMemo, useRef, useState } from 'react';
import {
  HARNESS_NAMES,
  KUSA_HARNESS,
  SIDEBAR_VIEW_IDS,
  SIDEBAR_VIEW_LABELS,
  shortId,
  sessionLabel,
  sessionTitle,
  STATUS_TEXT,
} from '../lib/format.js';
import { readLocal, writeLocal } from '../lib/storage.js';
import { KUSA_VERSION } from '../lib/version.js';
import { PlusIcon } from './IconButton.jsx';
import { HarnessLogo } from './HarnessLogo.jsx';
import { KusaLogo } from './KusaLogo.jsx';
import { StatusDot } from './StatusDot.jsx';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'closed', label: 'Closed' },
];

/** Compact 16×16 stroke icons — same visual language as RightRail.jsx. */
const VIEW_ICONS = {
  sessions: (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 5.5h8v6h-8z" />
      <path strokeLinecap="round" d="M8 3v2.5M6 8v1.5M10 8v1.5M6.5 11.5h3" />
    </svg>
  ),
  explorer: (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.5 4h3.5l1.5 1.5h6v7h-11z" />
    </svg>
  ),
  search: (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="7" cy="7" r="3.5" />
      <path strokeLinecap="round" d="M10 10.5 13.5 14" />
    </svg>
  ),
  extensions: (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h3.5v3.5H3zM3 9.5h3.5V13H3zM9.5 4H13v3.5H9.5z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.5 10.2 11 11.7 13.2 9" />
    </svg>
  ),
};

const PLACEHOLDER = {
  explorer: {
    title: 'Explorer',
    body: 'Browse workspace files here. File tree coming soon.',
  },
  search: {
    title: 'Search',
    body: 'Search across the workspace. Results coming soon.',
  },
  extensions: {
    title: 'Extensions',
    body: 'Manage harness extensions and integrations. Coming soon.',
  },
};

function matchesFilter(session, filter) {
  if (filter === 'active') return session.status !== 'ended';
  if (filter === 'closed') return session.status === 'ended';
  return true;
}

function TrashIcon({ className = 'h-3.5 w-3.5' }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 4.5h9M6 4.5V3.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5 4.5l.5 8h5l.5-8" />
    </svg>
  );
}

function FilterIcon({ className = 'h-4 w-4' }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.5 3.5h11L9.5 8.5v3.5L6.5 13.5V8.5L2.5 3.5z" />
    </svg>
  );
}

function initialSidebarView() {
  const saved = readLocal('monitor.sidebarView', 'sessions');
  return SIDEBAR_VIEW_IDS.includes(saved) ? saved : 'sessions';
}

function ViewButton({ id, on, onSelect }) {
  return (
    <button
      type="button"
      role="tab"
      id={`sidebar-view-${id}`}
      aria-controls={`sidebar-panel-${id}`}
      aria-selected={on}
      title={SIDEBAR_VIEW_LABELS[id]}
      aria-label={SIDEBAR_VIEW_LABELS[id]}
      className={`relative flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
        on
          ? 'bg-gray-800 text-gray-100'
          : 'text-gray-500 hover:bg-gray-800/70 hover:text-gray-200'
      }`}
      onClick={() => onSelect(id)}
    >
      {VIEW_ICONS[id]}
      {on ? (
        <span className="absolute inset-x-1.5 -bottom-0.5 h-0.5 rounded-full bg-emerald-500" aria-hidden="true" />
      ) : null}
    </button>
  );
}

function ToolIconButton({ label, pressed = false, active = false, onClick, children, ...props }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed || undefined}
      className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
        pressed || active
          ? 'bg-gray-800 text-emerald-400'
          : 'text-gray-500 hover:bg-gray-800 hover:text-gray-200'
      }`}
      onClick={onClick}
      {...props}
    >
      {children}
    </button>
  );
}

export function Sidebar({
  data,
  selected,
  collapsed,
  onToggleCollapsed,
  collapsedHarnesses,
  onToggleHarness,
  onSelectLane,
  onNewKusaSession,
  kusaSessions = [],
  sessionFilter = 'all',
  onSessionFilterChange,
  selectMode = false,
  onSelectModeChange,
  checkedKeys,
  onToggleChecked,
  onClearChecked,
  onDeleteKeys,
  canDelete = true,
  statusLine = null,
  statusLane = null,
  statusKusaSession = null,
}) {
  const harnesses = data?.harnesses || [];
  const [view, setView] = useState(initialSidebarView);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef(null);
  const filterActive = sessionFilter !== 'all';
  const filterLabel = FILTERS.find((f) => f.id === sessionFilter)?.label || 'All';
  const sessionsView = view === 'sessions';

  function selectView(next) {
    if (!SIDEBAR_VIEW_IDS.includes(next) || next === view) return;
    setView(next);
    writeLocal('monitor.sidebarView', next);
    setFilterOpen(false);
    if (next !== 'sessions' && selectMode) {
      onSelectModeChange?.(false);
      onClearChecked?.();
    }
  }

  useEffect(() => {
    if (!filterOpen) return undefined;
    function onPointerDown(event) {
      if (filterRef.current && !filterRef.current.contains(event.target)) {
        setFilterOpen(false);
      }
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') setFilterOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [filterOpen]);

  useEffect(() => {
    if (collapsed) setFilterOpen(false);
  }, [collapsed]);

  const filteredHarnesses = useMemo(() => {
    const monitorHarnesses = harnesses.filter((h) => h.harness !== KUSA_HARNESS);
    const kusaGroup = {
      harness: KUSA_HARNESS,
      label: HARNESS_NAMES[KUSA_HARNESS],
      sessions: kusaSessions,
    };
    return [kusaGroup, ...monitorHarnesses]
      .map((h) => ({
        ...h,
        sessions: (h.sessions || []).filter((s) => matchesFilter(s, sessionFilter)),
      }))
      // Kusă stays visible even with zero sessions so New session remains reachable.
      .filter((h) => h.harness === KUSA_HARNESS || h.sessions.length > 0 || sessionFilter === 'all');
  }, [harnesses, kusaSessions, sessionFilter]);

  const visibleKeys = useMemo(
    () => filteredHarnesses.flatMap((h) => h.sessions.map((s) => s.key)),
    [filteredHarnesses],
  );

  const checkedVisible = useMemo(
    () => visibleKeys.filter((key) => checkedKeys?.has(key)),
    [visibleKeys, checkedKeys],
  );

  const allVisibleChecked = visibleKeys.length > 0 && checkedVisible.length === visibleKeys.length;

  function toggleSelectAll() {
    if (allVisibleChecked) onClearChecked?.();
    else onToggleChecked?.(visibleKeys, true);
  }

  const placeholder = PLACEHOLDER[view];

  const statusAgentBit = statusKusaSession
    ? `Kusă › ${shortId(statusKusaSession.id)} · ${STATUS_TEXT[statusKusaSession.status] || statusKusaSession.status}`
    : statusLane
      ? `${statusLane.label} › ${shortId(statusLane.session?.id)} · ${STATUS_TEXT[statusLane.status] || statusLane.status}${
          statusLane.key === data?.focus ? '' : ' · pinned'
        }`
      : 'No agent';
  const versionBit = KUSA_VERSION ? `v${KUSA_VERSION}` : '';
  const statusFooterLine = statusLine
    ? [statusLine.short || statusLine.text, statusAgentBit, versionBit].filter(Boolean).join(' · ')
    : '';
  const statusFooterTitle = statusLine
    ? [statusLine.text, statusAgentBit, versionBit ? `Kusă ${versionBit}` : ''].filter(Boolean).join('\n')
    : '';

  return (
    <aside
      id="sidebar"
      data-collapsed={collapsed ? 'true' : 'false'}
      className="flex w-72 shrink-0 flex-col border-r border-gray-800 bg-gray-900 transition-[width] duration-200 data-[collapsed=true]:w-12"
    >
      <div className="relative flex h-12 shrink-0 items-center border-b border-gray-800 px-2">
        {collapsed ? (
          <button
            type="button"
            title="Expand sidebar"
            aria-label="Expand sidebar"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-100 hover:bg-gray-800"
            onClick={onToggleCollapsed}
          >
            <KusaLogo className="h-5 w-5" title="" />
          </button>
        ) : (
          <>
            <div className="absolute left-2 top-1/2 -translate-y-1/2">
              <KusaLogo className="h-6 w-6 text-gray-200" />
            </div>
            <nav
              role="tablist"
              aria-label="Sidebar views"
              aria-orientation="horizontal"
              className="mx-auto flex items-center gap-0.5 rounded-lg border border-gray-800 bg-gray-950/60 p-0.5"
            >
              {SIDEBAR_VIEW_IDS.map((id) => (
                <ViewButton key={id} id={id} on={id === view} onSelect={selectView} />
              ))}
              <button
                type="button"
                title="More views"
                aria-label="More views"
                disabled
                className="flex h-7 w-7 items-center justify-center rounded-md text-gray-600"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 6.5 8 10.5 12 6.5" />
                </svg>
              </button>
            </nav>
            <div className="absolute right-2 top-1/2 -translate-y-1/2">
              <ToolIconButton label="Collapse sidebar" onClick={onToggleCollapsed}>
                <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.5 3.5h11v9h-11zM6.5 3.5v9" />
                </svg>
              </ToolIconButton>
            </div>
          </>
        )}
      </div>

      {sessionsView && !collapsed && (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-gray-800 px-2 sidebar-label">
          <span className="truncate pl-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            Agents
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            <ToolIconButton
              label={selectMode ? 'Done selecting' : 'Select agents'}
              pressed={selectMode}
              onClick={() => {
                const next = !selectMode;
                onSelectModeChange?.(next);
                if (!next) onClearChecked?.();
              }}
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 3.5h9v9h-9z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.5 8.2 7.2 9.9 10.5 6.1" />
              </svg>
            </ToolIconButton>
            <div className="relative" ref={filterRef}>
              <ToolIconButton
                label={filterActive ? `Filter: ${filterLabel}` : 'Filter agents'}
                active={filterActive || filterOpen}
                aria-haspopup="menu"
                aria-expanded={filterOpen}
                onClick={() => setFilterOpen((open) => !open)}
              >
                <FilterIcon className="h-3.5 w-3.5" />
              </ToolIconButton>
              {filterOpen && (
                <div
                  role="menu"
                  aria-label="Filter agents"
                  className="absolute right-0 top-full z-20 mt-1 min-w-[8rem] rounded-md border border-gray-700 bg-gray-900 py-1 shadow-lg"
                >
                  {FILTERS.map((f) => {
                    const on = sessionFilter === f.id;
                    return (
                      <button
                        key={f.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={on}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] font-medium ${
                          on ? 'bg-gray-800 text-gray-100' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                        }`}
                        onClick={() => {
                          onSessionFilterChange?.(f.id);
                          setFilterOpen(false);
                        }}
                      >
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${on ? 'bg-emerald-400' : 'bg-transparent'}`} />
                        {f.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {sessionsView && !collapsed && selectMode && (
        <div className="flex items-center gap-1 border-b border-gray-800 px-2 py-1.5 sidebar-label">
          <button
            type="button"
            className="rounded px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-800 hover:text-gray-300"
            onClick={toggleSelectAll}
            disabled={!visibleKeys.length}
          >
            {allVisibleChecked ? 'Clear' : 'All'}
          </button>
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-rose-300 hover:bg-rose-950/40 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!canDelete || checkedVisible.length === 0}
            title={canDelete ? 'Delete selected sessions' : 'Start the local console server (npm run kusa:serve) to delete sessions'}
            onClick={() => onDeleteKeys?.(checkedVisible)}
          >
            <TrashIcon />
            Delete{checkedVisible.length ? ` ${checkedVisible.length}` : ''}
          </button>
        </div>
      )}

      {sessionsView ? (
        <nav
          id="sidebar-panel-sessions"
          role="tabpanel"
          aria-labelledby="sidebar-view-sessions"
          className="flex-1 overflow-y-auto py-2 text-sm"
          aria-label="Harnesses and agents"
        >
          {filteredHarnesses.map((h) => {
            const isKusa = h.harness === KUSA_HARNESS;
            const folded = collapsedHarnesses.has(h.harness);
            const live = h.sessions.filter((s) => s.status === 'busy' || s.status === 'thinking').length;
            const headStatus = h.sessions.some((s) => s.status === 'busy')
              ? 'busy'
              : h.sessions.some((s) => s.status === 'thinking')
                ? 'thinking'
                : h.sessions.some((s) => s.status === 'idle')
                  ? 'idle'
                  : isKusa
                    ? 'idle'
                    : 'ended';
            const title = `${h.label || HARNESS_NAMES[h.harness] || h.harness} · ${h.sessions.length} session${h.sessions.length === 1 ? '' : 's'}${live ? `, ${live} live` : ''}${h.sessions.length ? ` · ${STATUS_TEXT[headStatus] || headStatus}` : ''}`;

            return (
              <div key={h.harness}>
                <div
                  className={`tree-harness group/harness flex w-full items-center gap-1 font-medium text-gray-200 ${collapsed ? 'justify-center px-0 py-2' : 'px-2'}`}
                >
                  <button
                    type="button"
                    title={title}
                    className={`flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left hover:bg-gray-800 ${collapsed ? 'justify-center rounded px-0' : 'rounded-md px-1'}`}
                    onClick={() => onToggleHarness(h.harness)}
                  >
                    {collapsed ? (
                      <span className="relative inline-flex">
                        <HarnessLogo harness={h.harness} size="h-5 w-5" />
                        <StatusDot
                          status={headStatus}
                          className={`absolute -bottom-0.5 -right-0.5 ring-2 ring-gray-900 ${headStatus === 'ended' ? 'bg-gray-900' : ''}`}
                        />
                      </span>
                    ) : (
                      <>
                        <svg
                          className={`h-3 w-3 shrink-0 text-gray-500 transition-transform ${folded ? '' : 'rotate-90'}`}
                          viewBox="0 0 16 16"
                          fill="currentColor"
                        >
                          <path d="M6 4l4 4-4 4z" />
                        </svg>
                        <HarnessLogo harness={h.harness} />
                        <StatusDot status={headStatus} />
                        <span className="truncate">{h.label || HARNESS_NAMES[h.harness] || h.harness}</span>
                        <span className="ml-auto rounded-full bg-gray-800 px-1.5 text-[10px] text-gray-400">
                          {h.sessions.length}{live ? ` · ${live} live` : ''}
                        </span>
                      </>
                    )}
                  </button>
                  {isKusa && !collapsed && (
                    <button
                      type="button"
                      title="New session"
                      aria-label="New Kusă session"
                      className="shrink-0 rounded p-1.5 text-gray-400 hover:bg-gray-800 hover:text-emerald-400"
                      onClick={(event) => {
                        event.stopPropagation();
                        onNewKusaSession?.();
                      }}
                    >
                      <PlusIcon className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {!folded && !collapsed && !h.sessions.length && isKusa ? (
                  <p className="px-3 pb-2 pl-9 text-[11px] text-gray-600 sidebar-label">
                    No chats yet. Start a new session.
                  </p>
                ) : null}
                {!folded && !collapsed && h.sessions.map((s) => {
                  const active = s.key === selected;
                  const latest = !isKusa && s.key === data?.focus;
                  const checked = checkedKeys?.has(s.key);
                  const canRemove = isKusa || canDelete;
                  const label = sessionLabel(s);
                  const titled = Boolean(sessionTitle(s));
                  return (
                    <div
                      key={s.key}
                      className={`group tree-session flex w-full items-center gap-1 py-1 pl-7 pr-2 text-left hover:bg-gray-800 ${active ? 'bg-gray-800 text-gray-100' : 'text-gray-400'}`}
                    >
                      {selectMode ? (
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 shrink-0 rounded border-gray-600 bg-gray-800 accent-emerald-500"
                          checked={!!checked}
                          aria-label={`Select ${label}`}
                          onChange={() => onToggleChecked?.([s.key])}
                        />
                      ) : null}
                      <button
                        type="button"
                        title={titled ? `Session ${shortId(s.id)}` : 'unknown'}
                        className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left"
                        onClick={() => onSelectLane(s.key)}
                      >
                        <StatusDot status={s.status} />
                        <span className={`truncate text-xs ${titled ? 'text-gray-200' : 'font-mono text-gray-400'}`}>{label}</span>
                        {latest ? <span className="ml-auto text-[10px] uppercase tracking-wide text-emerald-500">latest</span> : null}
                        {!isKusa ? (
                          <span className={`${latest ? '' : 'ml-auto '}tabular-nums text-[10px] text-gray-500`}>{s.attempts}</span>
                        ) : null}
                      </button>
                      {!selectMode && (
                        <button
                          type="button"
                          className="shrink-0 rounded p-1 text-gray-600 opacity-0 hover:bg-gray-700 hover:text-rose-300 group-hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
                          title={
                            isKusa
                              ? 'Delete session'
                              : canDelete
                                ? 'Delete session'
                                : 'Start the local console server (npm run kusa:serve) to delete sessions'
                          }
                          aria-label={`Delete ${label}`}
                          disabled={!canRemove}
                          onClick={(event) => {
                            event.stopPropagation();
                            onDeleteKeys?.([s.key]);
                          }}
                        >
                          <TrashIcon />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </nav>
      ) : (
        <>
          {!collapsed && (
            <div className="flex h-9 shrink-0 items-center border-b border-gray-800 px-2 sidebar-label">
              <span className="truncate pl-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                {placeholder?.title || SIDEBAR_VIEW_LABELS[view]}
              </span>
            </div>
          )}
          <div
            id={`sidebar-panel-${view}`}
            role="tabpanel"
            aria-labelledby={`sidebar-view-${view}`}
            className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-3 sidebar-label"
          >
            <p className="text-[11px] leading-relaxed text-gray-600">
              {placeholder?.body || 'Coming soon.'}
            </p>
          </div>
        </>
      )}

      {sessionsView && !collapsed && statusLine && (
        <footer className="mt-auto shrink-0 border-t border-gray-800 px-2.5 py-1.5 sidebar-label">
          <p
            className={`truncate whitespace-nowrap text-[10px] leading-none ${statusLine.className || 'text-gray-500'}`}
            title={statusFooterTitle}
          >
            {statusFooterLine}
          </p>
        </footer>
      )}

    </aside>
  );
}
