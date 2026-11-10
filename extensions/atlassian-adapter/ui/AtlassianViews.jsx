/**
 * SVAR-powered Atlassian issue views: Kanban, Sprint, List, Calendar, Gantt,
 * Timeline, Backlog, Workload.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Kanban, Willow as KanbanWillow, WillowDark as KanbanWillowDark } from '@svar-ui/react-kanban';
import { Grid, Willow as GridWillow, WillowDark as GridWillowDark } from '@svar-ui/react-grid';
import { Gantt, Willow as GanttWillow, WillowDark as GanttWillowDark } from '@svar-ui/react-gantt';
import { Calendar, Willow as CalWillow, WillowDark as CalWillowDark } from '@svar-ui/react-calendar';
import '@svar-ui/react-kanban/all.css';
import '@svar-ui/react-grid/all.css';
import '@svar-ui/react-gantt/all.css';
import '@svar-ui/react-calendar/all.css';
import { LucideIcon } from '#ui/shared/LucideIcons.jsx';
import { SelectDropdown } from './MenuDropdown.jsx';
import {
  GANTT_SCALES,
  GRID_COLUMNS,
  TIMELINE_SCALES,
  formatSprintWindow,
  groupIssues,
  toBacklogModel,
  toCalendarEvents,
  toGanttTasks,
  toGridRows,
  toKanbanModel,
  toWorkloadRows,
} from './issueViewData.js';

function useKusaTheme() {
  const [theme, setTheme] = useState(
    () => (typeof document !== 'undefined' && document.documentElement.dataset.theme) || 'dark',
  );
  useEffect(() => {
    const el = document.documentElement;
    const sync = () => setTheme(el.dataset.theme || 'dark');
    const obs = new MutationObserver(sync);
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return theme === 'light' ? 'light' : 'dark';
}

function Theme({ children, dark }) {
  // Each SVAR package ships its own Willow — wrap with the dark/light pair for
  // the active widget family. Nested wrappers are fine; variables cascade.
  const K = dark ? KanbanWillowDark : KanbanWillow;
  const G = dark ? GridWillowDark : GridWillow;
  const Gt = dark ? GanttWillowDark : GanttWillow;
  const C = dark ? CalWillowDark : CalWillow;
  return (
    <K fonts={false}>
      <G fonts={false}>
        <Gt fonts={false}>
          <C fonts={false}>{children}</C>
        </Gt>
      </G>
    </K>
  );
}

function WorkloadBars({ rows }) {
  const max = Math.max(1, ...rows.map((r) => r.total));
  if (!rows.length) {
    return <p className="py-10 text-center text-xs text-gray-500">No assignees in this result set.</p>;
  }
  return (
    <ul className="space-y-3 p-3">
      {rows.map((row) => (
        <li key={row.assignee} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="truncate font-medium text-gray-200">{row.assignee}</span>
            <span className="shrink-0 text-gray-500">
              {row.total} · {row.todo} todo · {row.progress} doing · {row.done} done
            </span>
          </div>
          <div className="flex h-2 overflow-hidden rounded-full bg-gray-800">
            <span
              className="bg-amber-500/80"
              style={{ width: `${(row.todo / max) * 100}%` }}
              title="To do"
            />
            <span
              className="bg-sky-500/80"
              style={{ width: `${(row.progress / max) * 100}%` }}
              title="In progress"
            />
            <span
              className="bg-emerald-500/80"
              style={{ width: `${(row.done / max) * 100}%` }}
              title="Done"
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function SprintToolbar({
  sprints = [],
  selectedSprintId = null,
  onSelectSprint,
  sprintBusy = false,
}) {
  const selected = sprints.find((s) => String(s.id) === String(selectedSprintId)) || null;
  const window = formatSprintWindow(selected);
  return (
    <>
      <SelectDropdown
        label="Sprint"
        value={selectedSprintId != null ? String(selectedSprintId) : ''}
        disabled={sprintBusy || !sprints.length}
        options={sprints.map((sprint) => ({
          id: String(sprint.id),
          label: sprint.name,
          hint: [sprint.state, formatSprintWindow(sprint)].filter(Boolean).join(' · '),
        }))}
        onSelect={(id) => {
          const sprint = sprints.find((s) => String(s.id) === String(id)) || null;
          onSelectSprint?.(sprint);
        }}
      />
      {selected ? (
        <span className="text-[11px] text-gray-500">
          {window || selected.state || 'sprint'}
          {selected.goal ? ` · ${selected.goal}` : ''}
        </span>
      ) : null}
    </>
  );
}

/** SVAR Kanban sets `readonly` → select-card never fires; open via card DOM instead. */
function issueKeyFromTarget(target, selector) {
  const el = target?.closest?.(selector);
  // SVAR lib-dom setID prefixes string ids with ":" in data-id.
  const id = String(el?.getAttribute?.('data-id') || '').replace(/^:/, '').trim();
  return id || null;
}

function assigneeInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ''}${parts[parts.length - 1][0] || ''}`.toUpperCase();
}

function formatEta(iso) {
  if (!iso) return '';
  try {
    const value = String(iso).length === 10 ? `${iso}T12:00:00` : iso;
    return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return String(iso);
  }
}

function typeFallbackTone(issuetype) {
  const t = String(issuetype || '').toLowerCase();
  if (t.includes('bug')) return 'bg-rose-500/20 text-rose-300';
  if (t.includes('story')) return 'bg-emerald-500/20 text-emerald-300';
  if (t.includes('epic')) return 'bg-violet-500/20 text-violet-300';
  if (t.includes('sub')) return 'bg-sky-500/20 text-sky-300';
  return 'bg-gray-700/80 text-gray-300';
}

function priorityTone(priority) {
  const p = String(priority || '').toLowerCase();
  if (p.includes('highest') || p === 'blocker' || p.includes('critical')) return 'text-rose-400';
  if (p.includes('high')) return 'text-orange-400';
  if (p.includes('low') || p.includes('lowest') || p.includes('trivial')) return 'text-sky-400';
  return 'text-amber-400';
}

/** Jira-style card: summary, labels, parent, then type/key/ETA/priority/assignee. */
function IssueCardContent({ card, onSelect }) {
  const issue = card?.issue || {};
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  const parentKey = issue.epicKey || '';
  const parentLabel = issue.epicSummary && issue.epicSummary !== parentKey
    ? `${parentKey} ${issue.epicSummary}`
    : parentKey;
  const eta = formatEta(issue.duedate);
  const initials = assigneeInitials(issue.assignee);

  return (
    <div className="flex flex-col gap-2 p-0.5 text-left">
      <p className="line-clamp-3 text-[13px] font-medium leading-snug text-gray-100">
        {issue.summary || card.label || issue.key}
      </p>

      {labels.length ? (
        <div className="flex flex-wrap gap-1">
          {labels.slice(0, 4).map((label) => (
            <span
              key={label}
              className="rounded-full bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-300"
            >
              {label}
            </span>
          ))}
          {labels.length > 4 ? (
            <span className="rounded-full bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-500">
              +{labels.length - 4}
            </span>
          ) : null}
        </div>
      ) : null}

      {parentKey ? (
        <button
          type="button"
          data-issue-key={parentKey}
          title={`Open ${parentKey}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onSelect?.(parentKey);
          }}
          className="atlassian-parent-chip inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md border border-emerald-500/55 bg-emerald-500/15 px-1.5 py-0.5 text-left text-[11px] text-emerald-300"
        >
          <span className="pointer-events-none h-2 w-2 shrink-0 rounded-sm bg-emerald-400" aria-hidden />
          <span className="pointer-events-none min-w-0 truncate underline-offset-2">{parentLabel}</span>
        </button>
      ) : null}

      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-400">
        {issue.issuetypeIconUrl ? (
          <img
            src={issue.issuetypeIconUrl}
            alt={issue.issuetype || 'Type'}
            title={issue.issuetype || 'Type'}
            className="h-3.5 w-3.5 shrink-0"
          />
        ) : (
          <span
            className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm text-[8px] font-bold ${typeFallbackTone(issue.issuetype)}`}
            title={issue.issuetype || 'Type'}
          >
            {(issue.issuetype || '?').slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="shrink-0 font-mono text-gray-300">{issue.key}</span>
        {eta ? (
          <span className="truncate text-gray-500" title={`Due ${issue.duedate}`}>
            · {eta}
          </span>
        ) : null}
        <span className="ml-auto flex min-w-0 items-center gap-1.5">
          {issue.priority || issue.priorityIconUrl ? (
            issue.priorityIconUrl ? (
              <img
                src={issue.priorityIconUrl}
                alt={issue.priority || 'Priority'}
                title={issue.priority || 'Priority'}
                className="h-3.5 w-3.5 shrink-0"
              />
            ) : (
              <span
                className={`truncate text-[10px] font-medium ${priorityTone(issue.priority)}`}
                title={issue.priority}
              >
                {issue.priority}
              </span>
            )
          ) : null}
          {issue.assignee ? (
            issue.assigneeAvatarUrl ? (
              <img
                src={issue.assigneeAvatarUrl}
                alt={issue.assignee}
                title={issue.assignee}
                className="h-5 w-5 shrink-0 rounded-full bg-gray-800 object-cover"
              />
            ) : (
              <span
                title={issue.assignee}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-600 text-[9px] font-semibold text-white"
              >
                {initials}
              </span>
            )
          ) : (
            <span
              title="Unassigned"
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-dashed border-gray-700 text-[9px] text-gray-600"
            >
              —
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

function StatusBoard({ model, onSelect, className = 'h-full w-full overflow-auto p-2', style }) {
  // Keep cardContent identity stable — a new function each render remounts every card
  // (SVAR treats it as a new component type), which flickers parent-chip hover.
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const CardContent = useMemo(
    () => function AtlassianCardContent({ card }) {
      return (
        <IssueCardContent
          card={card}
          onSelect={(key) => selectRef.current?.(key)}
        />
      );
    },
    [],
  );

  function handleActivate(event) {
    const nested = event.target.closest?.('[data-issue-key]');
    if (nested) {
      const nestedKey = String(nested.getAttribute('data-issue-key') || '').replace(/^:/, '').trim();
      if (nestedKey) onSelect?.(nestedKey);
      return;
    }
    const key = issueKeyFromTarget(event.target, 'article.wx-card[data-id]');
    if (key) onSelect?.(key);
  }

  return (
    <div
      className={`${className} atlassian-ticket-board`}
      style={style}
      onClick={handleActivate}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const nested = event.target.closest?.('[data-issue-key]');
        if (nested) {
          const nestedKey = String(nested.getAttribute('data-issue-key') || '').replace(/^:/, '').trim();
          if (!nestedKey) return;
          event.preventDefault();
          onSelect?.(nestedKey);
          return;
        }
        const key = issueKeyFromTarget(event.target, 'article.wx-card[data-id]');
        if (!key) return;
        event.preventDefault();
        onSelect?.(key);
      }}
    >
      <Kanban
        cards={model.cards}
        columns={model.columns}
        readonly
        cardContent={CardContent}
      />
    </div>
  );
}

function ListGrid({ issues, onSelect, className = 'box-border h-full w-full max-w-full min-w-0 overflow-hidden p-2', style }) {
  const rows = useMemo(() => toGridRows(issues), [issues]);

  function handleActivate(event) {
    const key = issueKeyFromTarget(event.target, '.wx-row[data-id], [role="row"][data-id]');
    if (key) onSelect?.(key);
  }

  return (
    <div
      className={`${className} atlassian-ticket-list`}
      style={style}
      onClick={handleActivate}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const key = issueKeyFromTarget(event.target, '.wx-row[data-id], [role="row"][data-id]');
        if (!key) return;
        event.preventDefault();
        onSelect?.(key);
      }}
    >
      <div className="h-full w-full max-w-full min-w-0 overflow-hidden [contain:inline-size]">
        <Grid
          data={rows}
          columns={GRID_COLUMNS}
          onSelectRow={({ id }) => {
            if (id != null) onSelect?.(String(id));
          }}
        />
      </div>
    </div>
  );
}

const GROUP_BOARD_MIN_H = 180;
const GROUP_BOARD_MAX_H = 720;
const GROUP_BOARD_DEFAULT_H = 360;
const VIEWPORT_BOTTOM_PAD = 16;

function clampBoardHeight(px, min = GROUP_BOARD_MIN_H, max = GROUP_BOARD_MAX_H) {
  return Math.min(max, Math.max(min, Math.round(px)));
}

/**
 * Height available for the board frame:
 * 1) Prefer the flex parent's content box (locked pane height).
 * 2) Fall back to remaining viewport below the node's top.
 */
function useViewportFillHeight(ref, bottomPad = VIEWPORT_BOTTOM_PAD) {
  const [height, setHeight] = useState(GROUP_BOARD_DEFAULT_H);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof window === 'undefined') return undefined;

    const measure = () => {
      const parent = node.parentElement;
      let next = 0;
      if (parent) {
        const parentStyle = getComputedStyle(parent);
        const padY = (Number.parseFloat(parentStyle.paddingTop) || 0)
          + (Number.parseFloat(parentStyle.paddingBottom) || 0);
        const gap = Number.parseFloat(parentStyle.rowGap || parentStyle.gap) || 0;
        // Subtract siblings above the frame inside the flex column.
        let used = 0;
        for (const child of parent.children) {
          if (child === node) break;
          used += child.getBoundingClientRect().height;
          used += gap;
        }
        next = Math.floor(parent.clientHeight - padY - used);
      }
      if (next < GROUP_BOARD_MIN_H) {
        const top = node.getBoundingClientRect().top;
        next = Math.floor(window.innerHeight - top - bottomPad);
      }
      next = Math.max(GROUP_BOARD_MIN_H, next);
      setHeight((prev) => (prev === next ? prev : next));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.documentElement);
    if (node.parentElement) ro.observe(node.parentElement);
    window.addEventListener('resize', measure);
    // Remeasure after fonts/layout settle.
    const raf = requestAnimationFrame(measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      cancelAnimationFrame(raf);
    };
  }, [ref, bottomPad]);

  return height;
}

/** Edge-mounted resize grip — overlays the bottom border, adds no layout height. */
function HeightResizeHandle({
  height,
  onChange,
  min = GROUP_BOARD_MIN_H,
  max = GROUP_BOARD_MAX_H,
}) {
  const drag = useRef(null);
  const [dragging, setDragging] = useState(false);

  function onPointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startY: event.clientY, startH: height };
    setDragging(true);
  }

  function onPointerMove(event) {
    if (!drag.current) return;
    const next = clampBoardHeight(
      drag.current.startH + (event.clientY - drag.current.startY),
      min,
      max,
    );
    onChange(next);
  }

  function onPointerUp(event) {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={height}
      aria-label="Resize board height"
      title="Drag to resize height"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          onChange(clampBoardHeight(height - 24, min, max));
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          onChange(clampBoardHeight(height + 24, min, max));
        }
      }}
      className={`absolute inset-x-0 bottom-0 z-10 flex h-3 cursor-ns-resize items-center justify-center select-none focus-visible:outline-none ${
        dragging ? 'text-sky-300' : 'text-gray-500 hover:text-sky-400'
      }`}
    >
      <span className="block h-[3px] w-10 rounded-full bg-current" aria-hidden />
    </div>
  );
}

function GroupedBoard({
  mode, // 'kanban' | 'list'
  groups,
  onSelect,
  openIds,
  onToggle,
  statuses = null,
  /** Remaining viewport px for the ungrouped board (fills screen, no main scroll). */
  fillHeight = GROUP_BOARD_DEFAULT_H,
  /** Controlled ungrouped height override from parent frame. */
  soloHeight = null,
  onSoloHeightChange,
}) {
  const grouped = groups.length > 1 || (groups[0] && groups[0].id !== 'all');
  /** Per-group board heights — resizing one card must not resize the others. */
  const [boardHeights, setBoardHeights] = useState(() => ({}));

  function heightFor(groupId) {
    const stored = boardHeights[groupId];
    return Number.isFinite(stored) ? stored : GROUP_BOARD_DEFAULT_H;
  }

  function setHeightFor(groupId, next) {
    setBoardHeights((prev) => (prev[groupId] === next ? prev : { ...prev, [groupId]: next }));
  }

  if (!grouped) {
    const issues = groups[0]?.issues || [];
    const height = soloHeight ?? fillHeight;
    const soloMax = Math.max(
      GROUP_BOARD_MAX_H,
      fillHeight,
      typeof window !== 'undefined' ? window.innerHeight - 48 : fillHeight,
    );
    return (
      <div className="relative h-full min-h-0 w-full">
        {mode === 'list' ? (
          <ListGrid
            issues={issues}
            onSelect={onSelect}
            className="box-border h-full w-full max-w-full min-w-0 overflow-hidden p-2"
            style={{ height: '100%' }}
          />
        ) : (
          <StatusBoard
            model={toKanbanModel(issues, { statuses })}
            onSelect={onSelect}
            className="h-full w-full overflow-auto p-2"
            style={{ height: '100%' }}
          />
        )}
        <HeightResizeHandle
          height={height}
          min={GROUP_BOARD_MIN_H}
          max={soloMax}
          onChange={(next) => onSoloHeightChange?.(next)}
        />
      </div>
    );
  }

  // Flat root-level sections — no nested parent cards around each group board.
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto overflow-x-hidden p-2 pb-3">
      {groups.map((group) => {
        const open = openIds.has(group.id);
        const boardHeight = heightFor(group.id);
        return (
          <section key={group.id} className="relative flex flex-col gap-1">
            <button
              type="button"
              onClick={() => onToggle(group.id)}
              aria-expanded={open}
              className="flex w-full items-center gap-2 px-1 py-1 text-left hover:text-gray-100"
            >
              <LucideIcon
                name={open ? 'chevron-down' : 'chevron-right'}
                className="h-3.5 w-3.5 shrink-0 text-gray-500"
              />
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-200">
                {group.label}
              </span>
              <span className="shrink-0 rounded-md bg-gray-900 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-gray-300">
                {group.issues.length}
              </span>
            </button>
            {open ? (
              <div className="relative">
                {mode === 'list' ? (
                  <ListGrid
                    issues={group.issues}
                    onSelect={onSelect}
                    className="box-border w-full max-w-full min-w-0 overflow-hidden p-1"
                    style={{ height: boardHeight }}
                  />
                ) : (
                  <StatusBoard
                    model={toKanbanModel(group.issues, { statuses })}
                    onSelect={onSelect}
                    className="w-full overflow-auto p-1"
                    style={{ height: boardHeight }}
                  />
                )}
                <HeightResizeHandle
                  height={boardHeight}
                  onChange={(next) => setHeightFor(group.id, next)}
                />
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

export function AtlassianViews({
  issues = [],
  // Reserved for per-view selection chrome (kanban/grid highlight).
  selectedKey = null,
  onSelect,
  view: controlledView,
  onViewChange,
  groupBy = 'none',
  groupsExpanded = true,
  onGroupsExpandedChange,
  sprints = [],
  selectedSprintId = null,
  onSelectSprint,
  sprintBusy = false,
  statuses = null,
  emptyMessage = 'No issues for the current scope.',
}) {
  void selectedKey;
  void onViewChange;
  const theme = useKusaTheme();
  const dark = theme === 'dark';
  const active = controlledView || 'kanban';

  const backlog = useMemo(
    () => toBacklogModel(issues, { statuses }),
    [issues, statuses],
  );
  const sprintBoard = useMemo(
    () => toKanbanModel(issues, { byStatus: true, statuses }),
    [issues, statuses],
  );
  const ganttTasks = useMemo(() => toGanttTasks(issues), [issues]);
  const calendarEvents = useMemo(() => toCalendarEvents(issues), [issues]);
  const workload = useMemo(() => toWorkloadRows(issues), [issues]);

  const supportsGroupBy = active === 'kanban' || active === 'list';
  const effectiveGroupBy = supportsGroupBy ? groupBy : 'none';
  const isGrouped = effectiveGroupBy !== 'none';
  const groups = useMemo(
    () => groupIssues(issues, effectiveGroupBy),
    [issues, effectiveGroupBy],
  );
  const groupIdsKey = useMemo(() => groups.map((g) => g.id).join('\0'), [groups]);

  // Expand/collapse all is driven by the toolbar; per-card toggles stay local.
  const [collapsed, setCollapsed] = useState(() => new Set());
  useEffect(() => {
    if (!isGrouped) {
      setCollapsed(new Set());
      return;
    }
    if (groupsExpanded) setCollapsed(new Set());
    else setCollapsed(new Set(groups.map((g) => g.id)));
    // groupIdsKey stands in for groups identity without re-expanding on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveGroupBy, active, groupsExpanded, groupIdsKey, isGrouped]);

  const openIds = useMemo(() => {
    const open = new Set(groups.map((g) => g.id));
    for (const id of collapsed) open.delete(id);
    return open;
  }, [groups, collapsed]);

  function toggleGroup(id) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      const allExpanded = groups.every((g) => !next.has(g.id));
      onGroupsExpandedChange?.(allExpanded);
      return next;
    });
  }

  const showEmpty = !issues.length && active !== 'sprint';
  const showSprintEmpty = active === 'sprint' && !issues.length;

  const frameRef = useRef(null);
  const fillHeight = useViewportFillHeight(frameRef);
  const [soloBoardHeight, setSoloBoardHeight] = useState(null);

  useEffect(() => {
    setSoloBoardHeight(null);
  }, [active, groupBy]);

  const ungroupedBoard = (active === 'kanban' || active === 'list') && !isGrouped;
  // Lock frame to measured remaining pane height so the kanban h-scrollbar
  // stays on-screen. User drag overrides via soloBoardHeight.
  const frameStyle = {
    height: ungroupedBoard && soloBoardHeight != null ? soloBoardHeight : fillHeight,
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-2">
      <style>{`
        .atlassian-ticket-board,
        .atlassian-ticket-board .wx-kanban,
        .atlassian-ticket-board .wx-board {
          background: transparent !important;
          --wx-kanban-bg: transparent;
        }
        .atlassian-ticket-board article.wx-card {
          cursor: pointer;
          transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
          border: 1px solid transparent;
          padding: 10px 10px 8px;
        }
        .atlassian-ticket-board article.wx-card:hover,
        .atlassian-ticket-board article.wx-card:focus-visible {
          background: color-mix(in srgb, var(--wx-kanban-card-bg, #1f2937) 72%, #38bdf8 28%) !important;
          border-color: #38bdf8 !important;
          box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.55), 0 6px 16px rgba(0, 0, 0, 0.35);
          outline: none;
        }
        .atlassian-ticket-board .atlassian-parent-chip {
          cursor: pointer;
          position: relative;
          z-index: 1;
          /* Color-only hover — no transform/shadow growth (those flicker under the cursor). */
          transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
        }
        .atlassian-ticket-board .atlassian-parent-chip:hover,
        .atlassian-ticket-board .atlassian-parent-chip:focus-visible {
          cursor: pointer;
          color: #ecfdf5 !important;
          background: #059669 !important;
          border-color: #6ee7b7 !important;
          outline: none;
          text-decoration: underline;
          text-underline-offset: 2px;
        }
        .atlassian-ticket-list .wx-row {
          cursor: pointer;
          transition: background-color 120ms ease, box-shadow 120ms ease;
        }
        .atlassian-ticket-list .wx-row:hover,
        .atlassian-ticket-list .wx-row:focus-within {
          background: color-mix(in srgb, transparent 55%, #38bdf8 45%) !important;
          box-shadow: inset 3px 0 0 #38bdf8;
        }
      `}</style>
      {active === 'sprint' ? (
        <div className="flex flex-wrap items-center gap-2">
          <SprintToolbar
            sprints={sprints}
            selectedSprintId={selectedSprintId}
            onSelectSprint={onSelectSprint}
            sprintBusy={sprintBusy}
          />
        </div>
      ) : null}

      <div
        ref={frameRef}
        className={`relative min-h-0 flex-1 border border-gray-800 bg-gray-950/40 ${
          isGrouped ? 'overflow-x-hidden overflow-y-auto' : 'overflow-hidden'
        }`}
        style={frameStyle}
      >
        {showEmpty ? (
          <p className="py-16 text-center text-xs text-gray-500">{emptyMessage}</p>
        ) : (
          <Theme dark={dark}>
            <div className="h-full min-h-0">
            {active === 'kanban' ? (
              <GroupedBoard
                mode="kanban"
                groups={groups}
                onSelect={onSelect}
                openIds={openIds}
                onToggle={toggleGroup}
                statuses={statuses}
                fillHeight={fillHeight}
                soloHeight={soloBoardHeight}
                onSoloHeightChange={setSoloBoardHeight}
              />
            ) : null}

            {active === 'backlog' ? (
              <div className="relative h-full min-h-0">
                <StatusBoard
                  model={backlog}
                  onSelect={onSelect}
                  className="h-full w-full overflow-auto p-2"
                />
              </div>
            ) : null}

            {active === 'sprint' ? (
              showSprintEmpty ? (
                <p className="py-16 text-center text-xs text-gray-500">
                  {sprintBusy
                    ? 'Loading sprint…'
                    : (sprints.length
                      ? 'No issues in this sprint.'
                      : 'No Scrum sprints found for this project.')}
                </p>
              ) : (
                <div className="relative h-full min-h-0">
                  <StatusBoard
                    model={sprintBoard}
                    onSelect={onSelect}
                    className="h-full w-full overflow-auto p-2"
                  />
                </div>
              )
            ) : null}

            {active === 'list' ? (
              <GroupedBoard
                mode="list"
                groups={groups}
                onSelect={onSelect}
                openIds={openIds}
                onToggle={toggleGroup}
                statuses={statuses}
                fillHeight={fillHeight}
                soloHeight={soloBoardHeight}
                onSoloHeightChange={setSoloBoardHeight}
              />
            ) : null}

            {active === 'calendar' ? (
              <div className="h-full w-full overflow-auto p-2">
                <Calendar
                  events={calendarEvents}
                  view="month"
                  views={['month', 'week', 'day']}
                  readonly
                  onSelectEvent={({ id }) => {
                    if (id != null) onSelect?.(String(id));
                  }}
                />
              </div>
            ) : null}

            {active === 'gantt' || active === 'timeline' ? (
              <div className="h-full w-full overflow-auto p-2">
                <Gantt
                  tasks={ganttTasks}
                  links={[]}
                  scales={active === 'timeline' ? TIMELINE_SCALES : GANTT_SCALES}
                  readonly
                  onSelectTask={({ id }) => {
                    if (id != null) onSelect?.(String(id));
                  }}
                />
              </div>
            ) : null}

            {active === 'workload' ? (
              <div className="h-full w-full overflow-auto">
                <WorkloadBars rows={workload} />
              </div>
            ) : null}
            </div>
          </Theme>
        )}
      </div>
    </div>
  );
}
