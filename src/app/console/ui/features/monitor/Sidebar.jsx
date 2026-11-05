import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CHAT_PROVIDER_GROUPS,
  HARNESS_NAMES,
  SIDEBAR_VIEW_IDS,
  SIDEBAR_VIEW_LABELS,
  SIDEBAR_VIEW_MIGRATED,
  shortId,
  sessionLabel,
  sessionRankAt,
  sessionTitle,
  STATUS_TEXT,
} from '#ui/shared/lib/format.js';
import { readLocal, writeLocal } from '#ui/shared/lib/storage.js';
import { KUSA_VERSION } from '#ui/shared/lib/version.js';
import { PlusIcon } from '#ui/shared/IconButton.jsx';
import { HarnessLogo } from '#ui/shared/HarnessLogo.jsx';
import { KusaLogo } from '#ui/shared/KusaLogo.jsx';
import { LucideIcon } from '#ui/shared/LucideIcons.jsx';
import { ExplorerPanel } from '#ui/features/explorer/ExplorerPanel.jsx';
import { SearchPanel } from '#ui/features/explorer/SearchPanel.jsx';
import { ExtensionsPanel } from '#ui/features/extensions/ExtensionsPanel.jsx';
import { SessionIndicator, openGate } from './SessionIndicator.jsx';

/** Provider / multi-agent mark tinted by session status (left of the row label). */
const PROVIDER_COLOR = {
  busy: 'text-emerald-400',
  thinking: 'text-amber-400',
  idle: 'text-sky-400',
  ended: 'text-gray-500',
  archived: 'text-gray-600',
};

const PROVIDER_ICON_SIZE = 'h-[18px] w-[18px]';

function isSubagentSession(session) {
  return Boolean(session?.parentId || session?.options?.parentId);
}

/** Top-level orchestrated parents only — Subagents keep their own provider mark. */
function isOrchestratedSession(session) {
  if (isSubagentSession(session)) return false;
  const kind = String(session?.kind || session?.options?.kind || '').toLowerCase();
  return kind === 'orchestrated' || Boolean(session?.options?.workflowId || session?.workflowId);
}

/** Empty = no restriction on that dimension (show all). */
export const EMPTY_SESSION_FILTER = Object.freeze({
  providers: Object.freeze([]),
  kinds: Object.freeze([]),
  statuses: Object.freeze([]),
});

const PROVIDER_FILTER_OPTIONS = [
  { id: 'copilot', label: 'GitHub Copilot' },
  { id: 'kusa', label: 'Kusă' },
  { id: 'cursor', label: 'Cursor' },
];

const KIND_FILTER_OPTIONS = [
  { id: 'standard', label: 'Standard' },
  { id: 'orchestrated', label: 'Orchestrated' },
];

const STATUS_FILTER_OPTIONS = [
  { id: 'active', label: 'Active' },
  { id: 'completed', label: 'Completed' },
  { id: 'attention', label: 'Needs Attention' },
  { id: 'archived', label: 'Archived' },
];

const FILTER_SECTIONS = [
  { key: 'providers', label: 'Provider', options: PROVIDER_FILTER_OPTIONS },
  { key: 'kinds', label: 'Session type', options: KIND_FILTER_OPTIONS },
  { key: 'statuses', label: 'Status', options: STATUS_FILTER_OPTIONS },
];

const PROVIDER_FILTER_IDS = new Set(PROVIDER_FILTER_OPTIONS.map((o) => o.id));
const KIND_FILTER_IDS = new Set(KIND_FILTER_OPTIONS.map((o) => o.id));
const STATUS_FILTER_IDS = new Set(STATUS_FILTER_OPTIONS.map((o) => o.id));

/** Normalize persisted / legacy filter values into the multi-select shape. */
export function normalizeSessionFilter(raw) {
  if (!raw || raw === 'all') return { providers: [], kinds: [], statuses: [] };
  // Legacy single-status radios from before multi-select filters.
  if (raw === 'active') return { providers: [], kinds: [], statuses: ['active'] };
  if (raw === 'closed') return { providers: [], kinds: [], statuses: ['completed'] };
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return { providers: [], kinds: [], statuses: [] }; }
  }
  if (!parsed || typeof parsed !== 'object') return { providers: [], kinds: [], statuses: [] };
  const pick = (list, allowed) => (
    Array.isArray(list) ? list.map(String).filter((id) => allowed.has(id)) : []
  );
  return {
    providers: pick(parsed.providers, PROVIDER_FILTER_IDS),
    kinds: pick(parsed.kinds, KIND_FILTER_IDS),
    statuses: pick(parsed.statuses, STATUS_FILTER_IDS),
  };
}

export function isSessionFilterActive(filter) {
  const f = filter || EMPTY_SESSION_FILTER;
  return Boolean(f.providers?.length || f.kinds?.length || f.statuses?.length);
}

function sessionProviderFilterId(session) {
  const provider = String(session?.provider || '').toLowerCase();
  if (provider === 'copilot' || provider === 'github-copilot') return 'copilot';
  if (provider === 'cursor') return 'cursor';
  if (provider === 'kusa') return 'kusa';
  const harness = session?.harness
    || (typeof session?.key === 'string' && session.key.includes(':')
      ? session.key.slice(0, session.key.indexOf(':'))
      : 'kusa');
  if (harness === 'github-copilot') return 'copilot';
  if (harness === 'cursor') return 'cursor';
  return 'kusa';
}

function sessionNeedsAttention(session) {
  return Boolean(openGate(session?.live?.parts));
}

/** Exclusive status bucket so Active / Completed / Needs Attention / Archived don't overlap. */
function sessionStatusBucket(session) {
  if (session?.archived === true || session?.status === 'archived') return 'archived';
  if (sessionNeedsAttention(session)) return 'attention';
  if (session?.status === 'ended') return 'completed';
  return 'active';
}

function toggleFilterId(filter, key, id) {
  const list = Array.isArray(filter?.[key]) ? filter[key] : [];
  const next = list.includes(id) ? list.filter((other) => other !== id) : [...list, id];
  return { ...filter, [key]: next };
}

function filterSummaryLabel(filter) {
  if (!isSessionFilterActive(filter)) return 'All';
  const labels = [];
  for (const section of FILTER_SECTIONS) {
    const selected = new Set(filter[section.key] || []);
    for (const option of section.options) {
      if (selected.has(option.id)) labels.push(option.label);
    }
  }
  return labels.join(', ') || 'All';
}

/**
 * IDE-owned sessions (Cursor UI hooks, and any adapter with externalOwned)
 * that Kusă only observes — not promptable here.
 * Prefer the server-stamped `external` flag; fall back for monitor-only rows.
 */
const EXTERNAL_OWNED_HARNESS_FALLBACK = new Set(['cursor']);

function isExternalSession(session) {
  if (session?.parentId || session?.options?.parentId) return false;
  if (session?.external === true) return true;
  if (session?.external === false) return false;
  const harness = session?.harness
    || (typeof session?.key === 'string' && session.key.includes(':')
      ? session.key.slice(0, session.key.indexOf(':'))
      : '');
  if (!EXTERNAL_OWNED_HARNESS_FALLBACK.has(harness)) return false;
  // Monitor-only IDE row (no chat ownership record from createChatSession).
  if (session?.provider || Array.isArray(session?.messages)) return false;
  return true;
}

/** Map session provider id → harness used by HarnessLogo (icon follows Agent picker). */
function sessionProviderHarness(session) {
  const providerId = String(
    session?.provider
    || session?.options?.provider
    || '',
  ).trim().toLowerCase();
  if (providerId) {
    const group = CHAT_PROVIDER_GROUPS.find((g) => (
      g.id === providerId
      || g.harness === providerId
      || (providerId === 'github-copilot' && g.id === 'copilot')
    ));
    if (group) return group.harness;
  }
  if (typeof session?.harness === 'string' && session.harness.trim()) {
    return session.harness.trim();
  }
  if (typeof session?.key === 'string' && session.key.includes(':')) {
    return session.key.slice(0, session.key.indexOf(':'));
  }
  return 'kusa';
}

function SessionProviderIcon({ session, className = '' }) {
  const statusKey = session?.archived ? 'archived' : session?.status;
  const color = `${PROVIDER_COLOR[statusKey] || PROVIDER_COLOR.idle}${className ? ` ${className}` : ''}`;
  const external = isExternalSession(session);
  const orchestrated = isOrchestratedSession(session);
  // Prefer provider (Agent picker) over key/harness so a kusa-keyed session
  // switched to Cursor/Copilot shows that mark without remounting the lane.
  const harness = sessionProviderHarness(session);
  const baseTitle = orchestrated
    ? 'Orchestrated · chat group'
    : (HARNESS_NAMES[harness] || harness);
  const title = external ? `${baseTitle} · external (Cursor UI)` : baseTitle;
  const mark = orchestrated ? (
    <LucideIcon
      name="messages-square"
      className={`${PROVIDER_ICON_SIZE} ${color}`}
      title={external ? null : title}
    />
  ) : (
    <HarnessLogo
      harness={harness}
      size={PROVIDER_ICON_SIZE}
      className={color}
      title={external ? null : title}
    />
  );
  if (!external) return mark;
  // Composite: provider mark + corner external badge (Cursor UI–owned).
  return (
    <span
      className={`relative inline-flex shrink-0 ${PROVIDER_ICON_SIZE}`}
      title={title}
    >
      {mark}
      <span
        className="pointer-events-none absolute -bottom-0.5 -right-0.5 flex h-2.5 w-2.5 items-center justify-center rounded-[2px] bg-gray-950 text-amber-400 ring-1 ring-gray-950"
        aria-hidden="true"
      >
        <LucideIcon name="external-link" className="h-2 w-2" />
      </span>
    </span>
  );
}

/** Compact stroke icons — same visual language as RightRail.jsx. All view glyphs
 *  render in an 18×18 box. The Agents tab is lucide's `bot` and the Extensions tab
 *  lucide's `blocks`, both kept on lucide's own 24×24 grid; the rest are house-drawn
 *  on 16×16.
 */
const VIEW_ICONS = {
  // lucide `bot` (icons/bot.svg), paths verbatim from upstream. 18×18 box on
  // lucide’s 24×24 grid at stroke 2 → 1.5px ink, matching the neighbouring view icons.
  agents: (
    <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </svg>
  ),
  explorer: <LucideIcon name="folders" className="h-[18px] w-[18px]" />,
  search: <LucideIcon name="search" className="h-[18px] w-[18px]" />,
  // Placeholder — Terminal pane not implemented yet (reminder in the top bar).
  terminal: <LucideIcon name="terminal" className="h-[18px] w-[18px]" />,
  // lucide `blocks` (icons/blocks.svg), paths verbatim from upstream. 18×18 box
  // on lucide’s 24×24 grid at stroke 2 → 1.5px ink (same as ExtensionIcon).
  extensions: (
    <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2" />
      <rect x="14" y="2" width="8" height="8" rx="1" />
    </svg>
  ),
};

function matchesFilter(session, filter) {
  const f = filter && typeof filter === 'object' ? filter : EMPTY_SESSION_FILTER;
  const bucket = sessionStatusBucket(session);
  // Within a dimension: OR. Across dimensions: AND. Empty dimension = no restriction
  // — except archived, which stays hidden until Status › Archived is selected.
  if (f.providers?.length) {
    if (!f.providers.includes(sessionProviderFilterId(session))) return false;
  }
  if (f.kinds?.length) {
    // Subagents stay off the sidebar (merged into the parent transcript). Treat
    // them as orchestrated for filter math so they still contribute to parent
    // busy/activity lookups when Orchestrated is selected.
    const kind = (isOrchestratedSession(session) || isSubagentSession(session))
      ? 'orchestrated'
      : 'standard';
    if (!f.kinds.includes(kind)) return false;
  }
  if (f.statuses?.length) {
    if (!f.statuses.includes(bucket)) return false;
  } else if (bucket === 'archived') {
    return false;
  }
  return true;
}

function TrashIcon({ className = 'h-3.5 w-3.5' }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 4.5h9M6 4.5V3.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5 4.5l.5 8h5l.5-8" />
    </svg>
  );
}

/** Compact archive box — same stroke language as TrashIcon. */
function ArchiveIcon({ className = 'h-3.5 w-3.5' }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.5 3.5h11v2.5h-11zM3.5 6v6.5h9V6M6 8.5h4" />
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
  const saved = readLocal('monitor.sidebarView', 'agents');
  const current = SIDEBAR_VIEW_MIGRATED[saved] ?? saved;
  return SIDEBAR_VIEW_IDS.includes(current) ? current : 'agents';
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
  onSelectLane,
  onNewSession,
  chatSessions = [],
  /** True until the first /kusa/agents hydrate finishes — hide the list so harness-only rows do not flash ungrouped. */
  agentsLoading = false,
  sessionFilter = EMPTY_SESSION_FILTER,
  onSessionFilterChange,
  selectMode = false,
  onSelectModeChange,
  checkedKeys,
  onToggleChecked,
  onClearChecked,
  onDeleteKeys,
  onArchiveSession = null,
  canDelete = true,
  // True while the delete confirmation dialog is open: the request is already
  // stated there, so a second click cannot add to it.
  deleteGate = false,
  statusLine = null,
  statusLane = null,
  statusChatSession = null,
  canPersistExtensions = false,
  activeExtensionId = null,
  onSelectExtension = null,
  /** Open a workspace file in the main-pane editor (Explorer / Search). */
  onOpenFile = null,
}) {
  const harnesses = data?.harnesses || [];
  const [view, setView] = useState(initialSidebarView);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef(null);
  const filterActive = isSessionFilterActive(sessionFilter);
  const filterLabel = filterSummaryLabel(sessionFilter);
  const sessionsView = view === 'agents';

  function selectView(next) {
    if (!SIDEBAR_VIEW_IDS.includes(next) || next === view) return;
    setView(next);
    writeLocal('monitor.sidebarView', next);
    setFilterOpen(false);
    if (next !== 'agents' && selectMode) {
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

  // Agents list: every chat + monitor-only agent, newest rank first.
  // Dedup by id (and key) so a kusa hook shadow of a cursor/copilot
  // chat cannot appear twice after we stopped grouping by provider.
  // Subagents (parentId set) stay off the list entirely — their work
  // surfaces inside the parent's merged transcript, not as sidebar rows.
  const filteredSessions = useMemo(() => {
    const byId = new Map();
    const seenKeys = new Set();
    const take = (session) => {
      if (!session?.key || seenKeys.has(session.key)) return;
      const id = session.id || session.key;
      if (byId.has(id)) return;
      seenKeys.add(session.key);
      byId.set(id, session);
    };
    for (const session of chatSessions || []) take(session);
    for (const group of harnesses || []) {
      for (const session of group.sessions || []) take(session);
    }
    return [...byId.values()]
      .filter((s) => matchesFilter(s, sessionFilter))
      .sort((a, b) => sessionRankAt(b) - sessionRankAt(a));
  }, [harnesses, chatSessions, sessionFilter]);

  // Child busy/thinking/live bubbles up so the single orchestrated row still pulses.
  const childActivityByParent = useMemo(() => {
    const map = new Map();
    for (const s of chatSessions || []) {
      if (!isSubagentSession(s)) continue;
      const parentId = s.parentId || s.options?.parentId;
      if (!parentId) continue;
      const status = s.status;
      const live = Boolean(s.live);
      const rank = status === 'busy' || live ? 3
        : status === 'thinking' ? 2
          : sessionNeedsAttention(s) ? 1
            : 0;
      const prev = map.get(parentId);
      if (!prev || rank > prev.rank) {
        map.set(parentId, {
          rank,
          status: live && status !== 'busy' && status !== 'thinking' ? 'busy' : status,
          live: s.live || prev?.live || null,
          parts: s.live?.parts || prev?.parts || null,
        });
      }
    }
    return map;
  }, [chatSessions]);

  // Open rows split Standard / Orchestrated (same hr + label pattern as Archived).
  // Archived rows sit in their own block under an hr when the filter includes them.
  const openSessions = useMemo(
    () => filteredSessions.filter((s) => sessionStatusBucket(s) !== 'archived' && !isSubagentSession(s)),
    [filteredSessions],
  );
  const standardSessions = useMemo(
    () => openSessions.filter((s) => !isOrchestratedSession(s)),
    [openSessions],
  );
  const orchestratedSessions = useMemo(
    () => openSessions.filter((s) => isOrchestratedSession(s)),
    [openSessions],
  );
  const archivedSessions = useMemo(
    () => filteredSessions.filter((s) => sessionStatusBucket(s) === 'archived' && !isSubagentSession(s)),
    [filteredSessions],
  );

  // Select-all / bulk delete only cover top-level Agents — Subagents go with their parent.
  const visibleKeys = useMemo(
    () => filteredSessions.filter((s) => !isSubagentSession(s)).map((s) => s.key),
    [filteredSessions],
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

  const statusAgentBit = statusChatSession
    ? `${HARNESS_NAMES[statusChatSession.harness] || statusChatSession.provider || 'Chat'} › ${shortId(statusChatSession.id)} · ${STATUS_TEXT[statusChatSession.status] || statusChatSession.status}`
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

  function renderSessionRow(s) {
    const isChatRow = Boolean(
      s.messages
      || s.provider
      || s.kind
      || (typeof s.key === 'string' && chatSessions.some((c) => c.key === s.key)),
    );
    const active = s.key === selected;
    const checked = checkedKeys?.has(s.key);
    const label = sessionLabel(s);
    const titled = Boolean(sessionTitle(s));

    const external = isExternalSession(s);
    const canRemove = (isChatRow || canDelete) && !deleteGate;
    const childActivity = childActivityByParent.get(s.id);
    const rowStatus = (() => {
      if (!childActivity || childActivity.rank < 2) return s.status;
      if (s.status === 'busy' || s.status === 'thinking') return s.status;
      return childActivity.status === 'thinking' ? 'thinking' : 'busy';
    })();
    const rowParts = s.live?.parts || childActivity?.parts || null;
    const rowTitle = external
      ? (titled ? `${label} · external (Cursor UI)` : 'External agent · Cursor UI')
      : (titled ? `Agent ${shortId(s.id)}` : 'unknown');

    if (collapsed) {
      return (
        <button
          key={s.key}
          type="button"
          title={external ? `${label} · external (Cursor UI)` : label}
          aria-label={external ? `${label} (external agent)` : label}
          aria-current={active ? 'true' : undefined}
          className={`flex w-full items-center justify-center px-0 py-2 hover:bg-gray-800 ${active ? 'bg-gray-800' : ''}`}
          onClick={() => {
            onSelectLane(s.key);
            onToggleCollapsed?.();
          }}
        >
          <SessionProviderIcon session={{ ...s, status: rowStatus }} />
        </button>
      );
    }

    return (
      <div
        key={s.key}
        className={`group tree-session flex w-full items-center px-2 py-1 text-left hover:bg-gray-800 ${active ? 'bg-gray-800 text-gray-100' : 'text-gray-400'}`}
      >
        {selectMode ? (
          <input
            type="checkbox"
            className="mr-1 h-3.5 w-3.5 shrink-0 rounded border-gray-600 bg-gray-800 accent-emerald-500"
            checked={!!checked}
            aria-label={`Select ${label}`}
            onChange={() => onToggleChecked?.([s.key])}
          />
        ) : (
          <span className="mr-0.5 inline-block h-5 w-5 shrink-0" aria-hidden="true" />
        )}
        <button
          type="button"
          title={rowTitle}
          className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left"
          onClick={() => onSelectLane(s.key)}
        >
          <SessionProviderIcon session={{ ...s, status: rowStatus }} />
          <span className={`min-w-0 flex-1 truncate text-xs ${titled ? 'text-gray-200' : 'font-mono text-gray-400'}`}>{label}</span>
          {!isExternalSession(s) ? (
            <span className="shrink-0">
              <SessionIndicator status={rowStatus} parts={rowParts} />
            </span>
          ) : null}
        </button>
        {!selectMode && (
          <>
            {isChatRow ? (
              <button
                type="button"
                className="max-w-0 shrink-0 overflow-hidden rounded p-0 text-gray-600 opacity-0 transition-[max-width,padding,opacity] hover:bg-gray-700 hover:text-amber-300 group-hover:max-w-8 group-hover:p-1 group-hover:opacity-100 focus:max-w-8 focus:p-1 focus:opacity-100 disabled:cursor-not-allowed disabled:group-hover:opacity-30 disabled:focus:opacity-30"
                title={
                  !canDelete
                    ? 'Start the local console server (npm run kusa:serve) to archive sessions'
                    : s.archived
                      ? 'Unarchive session'
                      : 'Archive session'
                }
                aria-label={s.archived ? `Unarchive ${label}` : `Archive ${label}`}
                disabled={!canDelete || !onArchiveSession}
                onClick={(event) => {
                  event.stopPropagation();
                  onArchiveSession?.(s.key, !s.archived);
                }}
              >
                <ArchiveIcon />
              </button>
            ) : null}
            <button
              type="button"
              className="max-w-0 shrink-0 overflow-hidden rounded p-0 text-gray-600 opacity-0 transition-[max-width,padding,opacity] hover:bg-gray-700 hover:text-rose-300 group-hover:max-w-8 group-hover:p-1 group-hover:opacity-100 focus:max-w-8 focus:p-1 focus:opacity-100 disabled:cursor-not-allowed disabled:group-hover:opacity-30 disabled:focus:opacity-30"
              title={
                deleteGate
                  ? 'A delete confirmation is open — answer it first'
                  : isChatRow || canDelete
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
          </>
        )}
      </div>
    );
  }

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
                <svg className="h-[18px] w-[18px]" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 6.5 8 10.5 12 6.5" />
                </svg>
              </button>
            </nav>
            <div className="absolute right-2 top-1/2 -translate-y-1/2">
              <ToolIconButton label="Collapse sidebar" onClick={onToggleCollapsed}>
                <svg className="h-[18px] w-[18px]" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
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
              label="New agent"
              onClick={() => {
                setFilterOpen(false);
                onNewSession?.({ provider: 'kusa', kind: 'standard' });
              }}
            >
              <PlusIcon className="h-3.5 w-3.5" />
            </ToolIconButton>
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
                onClick={() => {
                  setFilterOpen((open) => !open);
                }}
              >
                <FilterIcon className="h-3.5 w-3.5" />
              </ToolIconButton>
              {filterOpen && (
                <div
                  role="menu"
                  aria-label="Filter agents"
                  className="absolute right-0 top-full z-20 mt-1 min-w-[11.5rem] rounded-md border border-gray-700 bg-gray-900 py-1 shadow-lg"
                >
                  {FILTER_SECTIONS.map((section, sectionIndex) => {
                    const selected = new Set(sessionFilter?.[section.key] || []);
                    return (
                      <div
                        key={section.key}
                        className={sectionIndex > 0 ? 'mt-1 border-t border-gray-800 pt-1' : ''}
                      >
                        <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                          {section.label}
                        </p>
                        {section.options.map((option) => {
                          const on = selected.has(option.id);
                          return (
                            <button
                              key={option.id}
                              type="button"
                              role="menuitemcheckbox"
                              aria-checked={on}
                              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] font-medium ${
                                on
                                  ? 'bg-gray-800/70 text-gray-100'
                                  : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                              }`}
                              onClick={() => {
                                onSessionFilterChange?.(
                                  toggleFilterId(sessionFilter, section.key, option.id),
                                );
                              }}
                            >
                              <span
                                className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                                  on
                                    ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300'
                                    : 'border-gray-600 bg-gray-950 text-transparent'
                                }`}
                                aria-hidden="true"
                              >
                                <svg className="h-2.5 w-2.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="m3.5 8.5 3 3 6-6.5" />
                                </svg>
                              </span>
                              {option.label}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                  {filterActive ? (
                    <div className="mt-1 border-t border-gray-800 pt-1">
                      <button
                        type="button"
                        role="menuitem"
                        className="flex w-full items-center px-3 py-1.5 text-left text-[11px] font-medium text-gray-500 hover:bg-gray-800 hover:text-gray-200"
                        onClick={() => {
                          onSessionFilterChange?.({ providers: [], kinds: [], statuses: [] });
                        }}
                      >
                        Clear filters
                      </button>
                    </div>
                  ) : null}
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
            disabled={!canDelete || deleteGate || checkedVisible.length === 0}
            title={
              deleteGate
                ? 'A delete confirmation is open — answer it first'
                : canDelete
                  ? 'Delete selected sessions'
                  : 'Start the local console server (npm run kusa:serve) to delete sessions'
            }
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
          aria-label="Agents"
        >
          {agentsLoading ? (
            collapsed ? null : (
              <div
                className="flex items-center gap-2 px-3 py-3 text-[11px] text-gray-500 sidebar-label"
                role="status"
                aria-live="polite"
              >
                <LucideIcon name="loader-circle" className="h-3.5 w-3.5 animate-spin text-gray-500" />
                Loading agents…
              </div>
            )
          ) : !filteredSessions.length ? (
            collapsed ? null : (
              <p className="px-3 py-2 text-[11px] text-gray-600 sidebar-label">
                No agents yet. Use + to start one.
              </p>
            )
          ) : (
            <>
              {standardSessions.map((s) => renderSessionRow(s))}
              {orchestratedSessions.length ? (
                <>
                  {!collapsed && standardSessions.length ? (
                    <hr className="mx-2 my-2 border-0 border-t border-gray-800" />
                  ) : null}
                  {!collapsed ? (
                    <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-600 sidebar-label">
                      Orchestrated
                    </p>
                  ) : null}
                  {orchestratedSessions.map((s) => renderSessionRow(s))}
                </>
              ) : null}
              {archivedSessions.length ? (
                <>
                  {!collapsed && openSessions.length ? (
                    <hr className="mx-2 my-2 border-0 border-t border-gray-800" />
                  ) : null}
                  {!collapsed ? (
                    <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-600 sidebar-label">
                      Archived
                    </p>
                  ) : null}
                  {archivedSessions.map((s) => renderSessionRow(s))}
                </>
              ) : null}
            </>
          )}
        </nav>
      ) : (
        <>
          {/* Explorer / Search own their section headers (label + refresh). */}
          {!collapsed && view !== 'explorer' && view !== 'search' ? (
            <div className="flex h-9 shrink-0 items-center border-b border-gray-800 px-2 sidebar-label">
              <span className="truncate pl-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                {SIDEBAR_VIEW_LABELS[view]}
              </span>
            </div>
          ) : null}
          {view === 'explorer' ? (
            <ExplorerPanel onOpenFile={onOpenFile} collapsed={collapsed} />
          ) : view === 'search' ? (
            <SearchPanel onOpenFile={onOpenFile} collapsed={collapsed} />
          ) : view === 'extensions' ? (
            <ExtensionsPanel
              canPersist={canPersistExtensions}
              selectedId={activeExtensionId}
              onSelect={onSelectExtension}
              collapsed={collapsed}
            />
          ) : (
            <div
              id={`sidebar-panel-${view}`}
              role="tabpanel"
              aria-labelledby={`sidebar-view-${view}`}
              className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-3 sidebar-label"
            >
              <p className="text-[11px] leading-relaxed text-gray-600">
                {view === 'terminal'
                  ? 'Terminal — not implemented yet.'
                  : 'Coming soon.'}
              </p>
            </div>
          )}
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
