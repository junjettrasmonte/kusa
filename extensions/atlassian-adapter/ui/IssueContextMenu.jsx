/**
 * Right-click / overflow context menu for Jira tickets on Kanban / List.
 * Nested items: Move work item, Change status, Attach to Chat.
 *
 * Submenu helpers live at module scope so their React type identity is stable —
 * defining them inside IssueContextMenu remounted the scroll pane on every
 * parent re-render and bounced scrollTop back to 0.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LucideIcon } from '#ui/shared/LucideIcons.jsx';
import { HarnessLogo } from '#ui/shared/HarnessLogo.jsx';

const MENU_W = 200;
const SUB_W = 260;
const SUB_GAP = 3;

const itemClass = 'flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-xs text-gray-200 hover:bg-gray-800 hover:text-white';
const itemActiveClass = 'flex w-full cursor-pointer items-center gap-2 bg-gray-800 px-2.5 py-1.5 text-left text-xs text-white';
const itemDisabledClass = 'flex w-full cursor-not-allowed items-start gap-2 px-2.5 py-1.5 text-left text-xs text-gray-600';

const EMPTY_ATTACH_FILTER = Object.freeze({
  providers: Object.freeze([]),
  kinds: Object.freeze([]),
  statuses: Object.freeze([]),
});

const ATTACH_FILTER_SECTIONS = [
  {
    key: 'providers',
    label: 'Provider',
    options: [
      { id: 'kusa', label: 'Kusă' },
      { id: 'cursor', label: 'Cursor' },
      { id: 'copilot', label: 'GitHub Copilot' },
    ],
  },
  {
    key: 'kinds',
    label: 'Session type',
    options: [
      { id: 'orchestrated', label: 'Orchestrated' },
      { id: 'standard', label: 'Standard' },
    ],
  },
  {
    key: 'statuses',
    label: 'Status',
    options: [
      { id: 'active', label: 'Active' },
      { id: 'completed', label: 'Completed' },
      { id: 'attention', label: 'Needs Attention' },
    ],
  },
];

function attachProviderId(session) {
  const provider = String(session?.provider || '').toLowerCase();
  if (provider === 'copilot' || provider === 'github-copilot') return 'copilot';
  if (provider === 'cursor') return 'cursor';
  if (provider === 'kusa') return 'kusa';
  const harness = String(session?.harness || '').toLowerCase();
  if (harness === 'github-copilot') return 'copilot';
  if (harness === 'cursor') return 'cursor';
  return 'kusa';
}

function attachStatusBucket(session) {
  if (session?.archived === true || session?.status === 'archived') return 'archived';
  if (session?.needsAttention) return 'attention';
  if (session?.status === 'ended') return 'completed';
  return 'active';
}

function isAttachFilterActive(filter) {
  const f = filter || EMPTY_ATTACH_FILTER;
  return Boolean(f.providers?.length || f.kinds?.length || f.statuses?.length);
}

function toggleAttachFilterId(filter, key, id) {
  const list = Array.isArray(filter?.[key]) ? filter[key] : [];
  const next = list.includes(id) ? list.filter((other) => other !== id) : [...list, id];
  return { ...filter, [key]: next };
}

function matchesAttachSession(session, filter, query) {
  const q = String(query || '').trim().toLowerCase();
  if (q) {
    const hay = `${session?.label || ''} ${session?.hint || ''} ${session?.id || ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  const f = filter || EMPTY_ATTACH_FILTER;
  const bucket = attachStatusBucket(session);
  if (f.providers?.length && !f.providers.includes(attachProviderId(session))) return false;
  if (f.kinds?.length) {
    const kind = session?.orchestrated ? 'orchestrated' : 'standard';
    if (!f.kinds.includes(kind)) return false;
  }
  if (f.statuses?.length) {
    if (!f.statuses.includes(bucket)) return false;
  } else if (bucket === 'archived') {
    return false;
  }
  return true;
}

function SubList({ empty, loading, items, onPick }) {
  if (loading && !items.length) {
    return <p className="px-2.5 py-2 text-[11px] text-gray-500">Loading…</p>;
  }
  if (!items.length) {
    return <p className="px-2.5 py-2 text-[11px] text-gray-500">{empty}</p>;
  }
  return items.map((item) => (
    <button
      key={item.id}
      type="button"
      role="menuitem"
      disabled={item.disabled}
      onClick={() => {
        if (!item.disabled) onPick(item);
      }}
      className={item.disabled ? itemDisabledClass : `${itemClass} items-start`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{item.label}</span>
        {item.hint ? (
          <span className="block truncate text-[10px] text-gray-500">{item.hint}</span>
        ) : null}
      </span>
    </button>
  ));
}

function ParentRow({ id, label, icon, open: isOpen, onOpen }) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={isOpen}
      onMouseEnter={() => onOpen?.(id)}
      onClick={() => onOpen?.(id)}
      className={isOpen ? itemActiveClass : itemClass}
    >
      {icon ? (
        <LucideIcon
          name={icon}
          className={`h-3.5 w-3.5 shrink-0 ${isOpen ? 'text-gray-300' : 'text-gray-500'}`}
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      <LucideIcon
        name="chevron-right"
        className={`h-3.5 w-3.5 shrink-0 ${isOpen ? 'text-gray-300' : 'text-gray-500'}`}
      />
    </button>
  );
}

function ActionRow({ label, icon, onClick, onHover }) {
  return (
    <button
      type="button"
      role="menuitem"
      onMouseEnter={() => onHover?.()}
      onClick={onClick}
      className={itemClass}
    >
      {icon ? (
        <LucideIcon name={icon} className="h-3.5 w-3.5 shrink-0 text-gray-500" />
      ) : null}
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
    </button>
  );
}

function SubmenuPanel({ label, header = null, children, width = SUB_W }) {
  return (
    <div
      role="menu"
      aria-label={label}
      className="absolute top-0 flex"
      style={{ left: '100%', minHeight: '100%' }}
    >
      {/* Hit-target bridge across the 3px gap — margin alone is not hoverable. */}
      <div style={{ width: SUB_GAP }} aria-hidden className="shrink-0" />
      <div
        className="flex max-h-[min(24rem,60vh)] flex-col overflow-hidden rounded-lg border border-gray-700 bg-gray-950 shadow-xl"
        style={{ width }}
      >
        {header}
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1"
          onWheel={(event) => {
            event.stopPropagation();
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function SessionMark({ session }) {
  if (session?.orchestrated) {
    return (
      <LucideIcon
        name="messages-square"
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400"
        title="Orchestrated"
      />
    );
  }
  return (
    <HarnessLogo
      harness={session?.harness || 'kusa'}
      size="h-3.5 w-3.5"
      className="mt-0.5 text-gray-300"
    />
  );
}

function SessionPickRow({ session, onPick }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => onPick?.(session)}
      className={`${itemClass} items-start`}
    >
      <SessionMark session={session} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{session.label}</span>
        {session.hint ? (
          <span className="block truncate text-[10px] text-gray-500">{session.hint}</span>
        ) : null}
      </span>
    </button>
  );
}

function AttachSubmenu({ sessions = [], onNew, onPick }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState(() => ({ providers: [], kinds: [], statuses: [] }));
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterPos, setFilterPos] = useState({ top: 0, left: 0 });
  const filterBtnRef = useRef(null);
  const filterMenuRef = useRef(null);
  const searchRef = useRef(null);
  const filterActive = isAttachFilterActive(filter);

  useEffect(() => {
    searchRef.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    if (!filterOpen || !filterBtnRef.current) return;
    const rect = filterBtnRef.current.getBoundingClientRect();
    const menuW = 184;
    const pad = 8;
    const left = Math.min(
      Math.max(pad, rect.right - menuW),
      window.innerWidth - menuW - pad,
    );
    const top = Math.min(rect.bottom + 4, window.innerHeight - pad);
    setFilterPos({ top, left });
  }, [filterOpen]);

  useEffect(() => {
    if (!filterOpen) return undefined;
    function onPointerDown(event) {
      const t = event.target;
      if (filterBtnRef.current?.contains(t) || filterMenuRef.current?.contains(t)) return;
      setFilterOpen(false);
    }
    function onKey(event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setFilterOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [filterOpen]);

  const filtered = useMemo(
    () => (sessions || []).filter((session) => matchesAttachSession(session, filter, query)),
    [sessions, filter, query],
  );
  const orchestrated = useMemo(
    () => filtered.filter((session) => session.orchestrated),
    [filtered],
  );
  const standard = useMemo(
    () => filtered.filter((session) => !session.orchestrated),
    [filtered],
  );

  const filterMenu = filterOpen && typeof document !== 'undefined'
    ? createPortal(
      <div
        ref={filterMenuRef}
        role="menu"
        aria-label="Filter agents"
        data-kusa-menu-portal=""
        className="fixed z-[90] max-h-[min(24rem,70vh)] min-w-[11.5rem] overflow-y-auto rounded-md border border-gray-700 bg-gray-900 py-1 shadow-lg"
        style={{ top: filterPos.top, left: filterPos.left }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {ATTACH_FILTER_SECTIONS.map((section, sectionIndex) => {
          const selectedIds = new Set(filter?.[section.key] || []);
          return (
            <div
              key={section.key}
              className={sectionIndex > 0 ? 'mt-1 border-t border-gray-800 pt-1' : ''}
            >
              <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                {section.label}
              </p>
              {section.options.map((option) => {
                const on = selectedIds.has(option.id);
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
                      setFilter((prev) => toggleAttachFilterId(prev, section.key, option.id));
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
              onClick={() => setFilter({ providers: [], kinds: [], statuses: [] })}
            >
              Clear filters
            </button>
          </div>
        ) : null}
      </div>,
      document.body,
    )
    : null;

  const header = (
    <div className="flex shrink-0 items-center gap-1 border-b border-gray-800 px-1.5 py-1.5">
      <div className="relative min-w-0 flex-1">
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder="Search agents…"
          aria-label="Search agents"
          className="w-full rounded-md border border-gray-700 bg-gray-900 py-1 pl-2 pr-6 text-[11px] text-gray-200 placeholder:text-gray-600 focus:border-gray-500 focus:outline-none"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.preventDefault();
              event.stopPropagation();
              setQuery('');
            }
          }}
          onMouseDown={(event) => event.stopPropagation()}
        />
        <LucideIcon
          name="search"
          className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-500"
        />
      </div>
      <div className="relative shrink-0">
        <button
          ref={filterBtnRef}
          type="button"
          aria-label={filterActive ? 'Filter agents (active)' : 'Filter agents'}
          aria-haspopup="menu"
          aria-expanded={filterOpen}
          title={filterActive ? 'Filter agents (active)' : 'Filter agents'}
          className={`inline-flex h-7 w-7 items-center justify-center rounded-md border ${
            filterActive || filterOpen
              ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
              : 'border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-600 hover:text-gray-200'
          }`}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => setFilterOpen((open) => !open)}
        >
          <LucideIcon name="filter" className="h-3.5 w-3.5" />
        </button>
        {filterMenu}
      </div>
    </div>
  );

  return (
    <SubmenuPanel label="Attach to Chat" header={header}>
      <button
        type="button"
        role="menuitem"
        onClick={() => onNew?.()}
        className={`${itemClass} items-start`}
      >
        <LucideIcon
          name="messages-square"
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">New Session</span>
          <span className="block truncate text-[10px] text-gray-500">Orchestrated</span>
        </span>
      </button>

      {orchestrated.map((session) => (
        <SessionPickRow key={session.id} session={session} onPick={onPick} />
      ))}

      {standard.length ? (
        <>
          <div className="my-1 border-t border-gray-800" role="separator" />
          <p className="px-2.5 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-gray-600">
            Agents
          </p>
          {standard.map((session) => (
            <SessionPickRow key={session.id} session={session} onPick={onPick} />
          ))}
        </>
      ) : null}

      {!orchestrated.length && !standard.length ? (
        <p className="px-2.5 py-2 text-[11px] text-gray-500">
          {sessions.length ? 'No agents match' : 'No existing chat sessions'}
        </p>
      ) : null}
    </SubmenuPanel>
  );
}

/**
 * @param {{
 *   open: boolean,
 *   x: number,
 *   y: number,
 *   issue: object | null,
 *   lanes?: Array<{ id: string, label: string, hint?: string }>,
 *   statuses?: Array<{ id: string, label: string, hint?: string, disabled?: boolean }>,
 *   sessions?: Array<{
 *     id: string,
 *     label: string,
 *     hint?: string,
 *     harness?: string,
 *     orchestrated?: boolean,
 *     provider?: string,
 *     status?: string,
 *     archived?: boolean,
 *     needsAttention?: boolean,
 *   }>,
 *   statusesLoading?: boolean,
 *   onRequestStatuses?: () => void,
 *   onClose: () => void,
 *   onAction: (action: {
 *     type: 'move-lane' | 'change-status' | 'copy-link' | 'copy-key' | 'attach-chat' | 'attach-chat-new',
 *     issueKey: string,
 *     issue?: object,
 *     laneId?: string,
 *     statusId?: string,
 *     sessionKey?: string,
 *   }) => void,
 * }} props
 */
export function IssueContextMenu({
  open,
  x = 0,
  y = 0,
  issue = null,
  lanes = [],
  statuses = [],
  sessions = [],
  statusesLoading = false,
  onRequestStatuses,
  onClose,
  onAction,
}) {
  const rootRef = useRef(null);
  const requestStatusesRef = useRef(onRequestStatuses);
  requestStatusesRef.current = onRequestStatuses;
  const [submenu, setSubmenu] = useState(/** @type {null | 'move' | 'status' | 'attach'} */ (null));
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    if (!open) {
      setSubmenu(null);
      return undefined;
    }
    function onPointerDown(event) {
      // Portaled filter popovers sit outside this root but belong to the menu.
      if (event.target?.closest?.('[data-kusa-menu-portal]')) return;
      if (!rootRef.current?.contains(event.target)) onClose?.();
    }
    function onKey(event) {
      if (event.key === 'Escape') onClose?.();
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  // Position once when opened — not when submenu/data changes.
  useLayoutEffect(() => {
    if (!open) return;
    const pad = 8;
    const width = MENU_W + SUB_GAP + SUB_W;
    const height = Math.max(rootRef.current?.offsetHeight || 200, 280);
    const left = Math.min(Math.max(pad, x), window.innerWidth - width - pad);
    const top = Math.min(Math.max(pad, y), window.innerHeight - height - pad);
    setPos({ left, top });
  }, [open, x, y]);

  useEffect(() => {
    if (!open) return;
    rootRef.current?.focus({ preventScroll: true });
  }, [open]);

  // Panel already prefetches; only ask again if submenu opens with no rows yet.
  useEffect(() => {
    if (!open || submenu !== 'status') return;
    if (statuses.length) return;
    if (statusesLoading) return;
    requestStatusesRef.current?.();
  }, [open, submenu, statuses.length, statusesLoading]);

  if (!open || !issue?.key || typeof document === 'undefined') return null;

  const issueKey = String(issue.key).replace(/^:/, '').trim();

  function run(partial) {
    onAction?.({ ...partial, issueKey, issue: { ...issue, key: issueKey } });
    onClose?.();
  }

  function openSubmenu(id) {
    setSubmenu((prev) => (prev === id ? prev : id));
  }

  return createPortal(
    <div
      ref={rootRef}
      role="menu"
      tabIndex={-1}
      aria-label={`Actions for ${issueKey}`}
      className="fixed z-[80] outline-none"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(event) => event.preventDefault()}
      onMouseDown={(event) => {
        // Keep focus inside the menu, but allow search/filter inputs to take focus.
        if (event.target?.closest?.('input, textarea, [contenteditable="true"]')) return;
        event.preventDefault();
      }}
    >
      <div className="relative inline-block w-[200px]">
        <div className="w-full overflow-hidden rounded-lg border border-gray-700 bg-gray-950 py-1 shadow-xl">
          <ActionRow
            label="Copy link"
            icon="link"
            onHover={() => setSubmenu(null)}
            onClick={() => run({ type: 'copy-link' })}
          />
          <ActionRow
            label="Copy key"
            icon="copy"
            onHover={() => setSubmenu(null)}
            onClick={() => run({ type: 'copy-key' })}
          />

          <div className="my-1 border-t border-gray-800" role="separator" />

          <ParentRow
            id="move"
            label="Move work item"
            icon="square-kanban"
            open={submenu === 'move'}
            onOpen={openSubmenu}
          />
          <ParentRow
            id="status"
            label="Change status"
            icon="circle-dot"
            open={submenu === 'status'}
            onOpen={openSubmenu}
          />
          <ParentRow
            id="attach"
            label="Attach to Chat"
            icon="paperclip"
            open={submenu === 'attach'}
            onOpen={openSubmenu}
          />
        </div>

        {submenu === 'move' ? (
          <SubmenuPanel label="Move work item">
            <SubList
              empty="No lanes on this board"
              items={lanes}
              onPick={(item) => run({ type: 'move-lane', laneId: item.id })}
            />
          </SubmenuPanel>
        ) : null}

        {submenu === 'status' ? (
          <SubmenuPanel label="Change status">
            <SubList
              empty="No transitions available"
              loading={statusesLoading}
              items={statuses}
              onPick={(item) => run({ type: 'change-status', statusId: item.id })}
            />
          </SubmenuPanel>
        ) : null}

        {submenu === 'attach' ? (
          <AttachSubmenu
            sessions={sessions}
            onNew={() => run({ type: 'attach-chat-new' })}
            onPick={(session) => run({ type: 'attach-chat', sessionKey: session.id })}
          />
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
