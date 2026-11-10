/**
 * Map Jira issue rows into SVAR widget shapes (Kanban / Grid / Gantt / Calendar).
 */

/** Lucide icon names — see `#ui/shared/LucideIcons.jsx`. */
export const ATLASSIAN_VIEWS = [
  { id: 'kanban', label: 'Kanban', icon: 'square-kanban' },
  { id: 'sprint', label: 'Sprint', icon: 'flag' },
  { id: 'list', label: 'List', icon: 'layout-list' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'gantt', label: 'Gantt', icon: 'chart-gantt' },
  { id: 'timeline', label: 'Timeline', icon: 'chart-no-axes-gantt' },
  { id: 'backlog', label: 'Backlog', icon: 'list-todo' },
  { id: 'workload', label: 'Workload', icon: 'users' },
];

/** Group-by options for Kanban / List views. */
export const ATLASSIAN_GROUP_BY = [
  { id: 'none', label: 'None' },
  { id: 'assignee', label: 'Assignee', icon: 'users' },
  { id: 'epic', label: 'Epic', icon: 'layers' },
  { id: 'label', label: 'Label', icon: 'tag' },
  { id: 'parent', label: 'Parent', icon: 'git-branch' },
];

/**
 * Partition issues into collapsible groups for Kanban / List.
 * @param {object[]} issues
 * @param {'none' | 'assignee' | 'epic' | 'label' | 'parent'} groupBy
 * @returns {{ id: string, label: string, hint?: string, issues: object[] }[]}
 */
export function groupIssues(issues = [], groupBy = 'none') {
  if (!groupBy || groupBy === 'none') {
    return [{ id: 'all', label: 'All issues', issues: [...issues] }];
  }

  /** @type {Map<string, { id: string, label: string, hint?: string, issues: object[] }>} */
  const groups = new Map();

  function ensure(id, label, hint) {
    if (!groups.has(id)) groups.set(id, { id, label, hint, issues: [] });
    return groups.get(id);
  }

  for (const issue of issues) {
    if (groupBy === 'assignee') {
      const id = issue.assigneeAccountId || (issue.assignee ? `name:${issue.assignee}` : 'unassigned');
      const label = issue.assignee || 'Unassigned';
      ensure(id, label).issues.push(issue);
      continue;
    }
    if (groupBy === 'epic' || groupBy === 'parent') {
      const id = issue.epicKey || (groupBy === 'parent' ? 'no-parent' : 'no-epic');
      const label = issue.epicKey
        ? `${issue.epicKey}${issue.epicSummary ? ` · ${issue.epicSummary}` : ''}`
        : (groupBy === 'parent' ? 'No parent' : 'No epic');
      const hint = issue.epicKey && issue.epicSummary ? issue.epicSummary : undefined;
      ensure(id, label, hint).issues.push(issue);
      continue;
    }
    if (groupBy === 'label') {
      const labels = Array.isArray(issue.labels)
        ? issue.labels.map((l) => String(l || '').trim()).filter(Boolean)
        : [];
      if (!labels.length) {
        ensure('no-label', 'No label').issues.push(issue);
        continue;
      }
      // Multi-label tickets appear in each matching group.
      for (const name of labels) {
        ensure(`label:${name}`, name).issues.push(issue);
      }
    }
  }

  return [...groups.values()].sort((a, b) => {
    // Keep empty buckets at the end.
    const aTail = a.id === 'unassigned' || a.id === 'no-epic' || a.id === 'no-parent' || a.id === 'no-label';
    const bTail = b.id === 'unassigned' || b.id === 'no-epic' || b.id === 'no-parent' || b.id === 'no-label';
    if (aTail !== bTail) return aTail ? 1 : -1;
    return a.label.localeCompare(b.label) || b.issues.length - a.issues.length;
  });
}

/** Format sprint dates for the picker / header. */
export function formatSprintWindow(sprint) {
  if (!sprint) return '';
  const start = sprint.startDate ? String(sprint.startDate).slice(0, 10) : '';
  const end = sprint.endDate ? String(sprint.endDate).slice(0, 10) : '';
  if (start && end) return `${start} → ${end}`;
  return start || end || '';
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** Stable slug for arbitrary Jira status names (Kanban columns). */
export function statusColumnId(status) {
  const raw = String(status || 'Unknown').trim() || 'Unknown';
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

function toKanbanCard(issue, column) {
  return {
    id: issue.key,
    label: issue.summary || issue.key,
    column,
    issue,
  };
}

/**
 * Build Kanban columns from Jira project statuses when available.
 * Falls back to statuses present on the loaded issues (never invents To do / Done enums).
 * @param {object[]} issues
 * @param {{
 *   byStatus?: boolean,
 *   statuses?: { id?: string, name: string, category?: string }[] | null,
 *   includeDone?: boolean,
 * }} [opts]
 */
export function toKanbanModel(issues = [], {
  byStatus = true,
  statuses = null,
  includeDone = true,
} = {}) {
  const visible = includeDone
    ? issues
    : issues.filter((issue) => issue.statusCategory !== 'done');

  /** @type {Map<string, { id: string, label: string, category?: string }>} */
  const columns = new Map();

  function addColumn(name, category = '') {
    const label = String(name || '').trim() || 'Unknown';
    const id = statusColumnId(label);
    if (!columns.has(id)) {
      // cardLimit: true → SVAR shows ticket count on the column header (no cap).
      columns.set(id, { id, label, category: category || undefined, cardLimit: true });
    }
    return id;
  }

  if (Array.isArray(statuses) && statuses.length) {
    for (const st of statuses) {
      const category = String(st?.category || '').toLowerCase();
      if (!includeDone && category === 'done') continue;
      if (st?.name) addColumn(st.name, category);
    }
  }

  for (const issue of visible) {
    const category = String(issue.statusCategory || '').toLowerCase();
    if (!includeDone && category === 'done') continue;
    addColumn(issue.status || 'Unknown', category);
  }

  if (!columns.size) {
    // No project metadata and no issues yet — leave an empty board.
    return { columns: [], cards: [] };
  }

  // Prefer project status order; otherwise keep discovery order (new→done when from API).
  const columnList = [...columns.values()];
  if (byStatus === false && Array.isArray(statuses) && statuses.length) {
    // Backlog: keep API order but already filtered above.
  }

  const cards = visible.map((issue) => toKanbanCard(issue, statusColumnId(issue.status || 'Unknown')));
  return { columns: columnList, cards };
}

export function toBacklogModel(issues = [], { statuses = null } = {}) {
  return toKanbanModel(issues, { byStatus: true, statuses, includeDone: false });
}

/** Merge Jira site labels with labels already on loaded issues. */
export function mergeLabelCatalog(siteLabels = [], issues = []) {
  const set = new Set();
  for (const label of siteLabels) {
    const v = String(label || '').trim();
    if (v) set.add(v);
  }
  for (const issue of issues) {
    for (const label of issue?.labels || []) {
      const v = String(label || '').trim();
      if (v) set.add(v);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function toGridRows(issues = []) {
  return issues.map((issue) => ({
    id: issue.key,
    key: issue.key,
    summary: issue.summary,
    status: issue.status,
    assignee: issue.assignee || '—',
    priority: issue.priority || '—',
    type: issue.issuetype || '—',
    updated: issue.updated ? new Date(issue.updated).toLocaleString() : '—',
    issue,
  }));
}

// Fixed widths only — SVAR flexgrow uses `width:auto` and feedback-loops
// against long nowrap summaries, so the Summary column keeps growing.
export const GRID_COLUMNS = [
  { id: 'key', header: 'Key', width: 110 },
  { id: 'summary', header: 'Summary', width: 320 },
  { id: 'status', header: 'Status', width: 120 },
  { id: 'assignee', header: 'Assignee', width: 140 },
  { id: 'priority', header: 'Priority', width: 90 },
  { id: 'type', header: 'Type', width: 100 },
  { id: 'updated', header: 'Updated', width: 150 },
];

export function toGanttTasks(issues = []) {
  return issues.map((issue) => {
    const created = parseDate(issue.created) || new Date();
    const due = parseDate(issue.duedate);
    const updated = parseDate(issue.updated) || created;
    const start = startOfDay(created);
    const end = startOfDay(due && due > start ? due : addDays(updated > start ? updated : start, 1));
    const durationMs = Math.max(end - start, 24 * 60 * 60 * 1000);
    const duration = Math.max(1, Math.round(durationMs / (24 * 60 * 60 * 1000)));
    const progress = issue.statusCategory === 'done' ? 100
      : (issue.statusCategory === 'indeterminate' ? 40 : 0);
    return {
      id: issue.key,
      text: `${issue.key} · ${issue.summary}`,
      start,
      end,
      duration,
      progress,
      type: 'task',
      lazy: false,
      issue,
    };
  });
}

export const GANTT_SCALES = [
  { unit: 'month', step: 1, format: '%F %Y' },
  { unit: 'day', step: 1, format: '%j' },
];

export const TIMELINE_SCALES = [
  { unit: 'week', step: 1, format: '%W' },
  { unit: 'day', step: 1, format: '%D' },
];

export function toCalendarEvents(issues = []) {
  return issues.map((issue) => {
    const start = parseDate(issue.duedate)
      || parseDate(issue.updated)
      || parseDate(issue.created)
      || new Date();
    const end = addDays(start, 1);
    return {
      id: issue.key,
      text: `${issue.key} · ${issue.summary}`,
      start,
      end,
      allDay: true,
      details: [issue.status, issue.assignee].filter(Boolean).join(' · '),
      issue,
    };
  });
}

export function toWorkloadRows(issues = []) {
  /** @type {Map<string, { assignee: string, total: number, todo: number, progress: number, done: number }>} */
  const byAssignee = new Map();
  for (const issue of issues) {
    const name = issue.assignee || 'Unassigned';
    if (!byAssignee.has(name)) {
      byAssignee.set(name, {
        assignee: name,
        total: 0,
        todo: 0,
        progress: 0,
        done: 0,
      });
    }
    const row = byAssignee.get(name);
    row.total += 1;
    if (issue.statusCategory === 'done') row.done += 1;
    else if (issue.statusCategory === 'indeterminate') row.progress += 1;
    else row.todo += 1;
  }
  return [...byAssignee.values()]
    .sort((a, b) => b.total - a.total || a.assignee.localeCompare(b.assignee));
}
