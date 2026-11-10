/**
 * jira.js Version3 + Agile helpers for the Atlassian Adapter.
 */
import { AgileClient, Version3Client } from 'jira.js';
import { normalizeAtlassianSettings } from './settings.mjs';

const ISSUE_SUMMARY_FIELDS = [
  'summary', 'status', 'issuetype', 'priority', 'updated', 'created',
  'duedate', 'assignee', 'project', 'parent', 'labels',
];

/** Normalize Jira issue keys; strip SVAR data-id ":" prefix if present. */
function normalizeIssueKey(issueKey) {
  return String(issueKey || '').trim().replace(/^:/, '').toUpperCase();
}

function authConfig(settings) {
  const s = normalizeAtlassianSettings(settings);
  if (!s.host) throw Object.assign(new Error('Atlassian host is not configured'), { code: 'ECONFIG' });
  if (!s.email) throw Object.assign(new Error('Atlassian email is not configured'), { code: 'ECONFIG' });
  if (!s.apiToken) throw Object.assign(new Error('Atlassian API token is not configured'), { code: 'ECONFIG' });
  return {
    host: s.host,
    authentication: {
      basic: {
        email: s.email,
        apiToken: s.apiToken,
      },
    },
  };
}

/**
 * @param {object} settings atlassian block (memory form with plaintext apiToken)
 * @returns {Version3Client}
 */
export function createJiraClient(settings) {
  return new Version3Client(authConfig(settings));
}

/**
 * @param {object} settings
 * @returns {AgileClient}
 */
export function createAgileClient(settings) {
  return new AgileClient(authConfig(settings));
}

/** Plain text → Atlassian Document Format paragraph. */
export function textToAdf(text) {
  const value = String(text ?? '');
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: value
          ? [{ type: 'text', text: value }]
          : [],
      },
    ],
  };
}

/** Best-effort plain text from ADF or a string. */
export function adfToText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return String(node);
  if (typeof node.text === 'string') return node.text;
  const parts = [];
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      const chunk = adfToText(child);
      if (chunk) parts.push(chunk);
    }
  }
  return parts.join(node.type === 'paragraph' || node.type === 'heading' ? '\n' : '');
}

function mapEpicFields(fields = {}) {
  // Team-managed + modern company-managed: parent points at the epic.
  const parent = fields.parent;
  if (parent?.key) {
    return {
      epicKey: String(parent.key),
      epicSummary: String(parent.fields?.summary || parent.key),
    };
  }
  // Some payloads expose a dedicated epic object.
  const epic = fields.epic;
  if (epic && typeof epic === 'object' && epic.key) {
    return {
      epicKey: String(epic.key),
      epicSummary: String(epic.summary || epic.name || epic.key),
    };
  }
  if (typeof epic === 'string' && epic.trim()) {
    return { epicKey: epic.trim(), epicSummary: epic.trim() };
  }
  return { epicKey: '', epicSummary: '' };
}

function avatarFromAssignee(assignee) {
  if (!assignee || typeof assignee !== 'object') return '';
  const urls = assignee.avatarUrls || {};
  return String(urls['24x24'] || urls['32x32'] || urls['48x48'] || urls['16x16'] || '');
}

function mapIssueSummary(issue) {
  const fields = issue?.fields || {};
  const epic = mapEpicFields(fields);
  return {
    key: String(issue?.key || ''),
    id: String(issue?.id || ''),
    summary: String(fields.summary || ''),
    status: fields.status?.name ? String(fields.status.name) : '',
    statusId: fields.status?.id ? String(fields.status.id) : '',
    statusCategory: fields.status?.statusCategory?.key
      ? String(fields.status.statusCategory.key)
      : '',
    issuetype: fields.issuetype?.name ? String(fields.issuetype.name) : '',
    issuetypeIconUrl: fields.issuetype?.iconUrl ? String(fields.issuetype.iconUrl) : '',
    priority: fields.priority?.name ? String(fields.priority.name) : '',
    priorityIconUrl: fields.priority?.iconUrl ? String(fields.priority.iconUrl) : '',
    updated: fields.updated ? String(fields.updated) : '',
    created: fields.created ? String(fields.created) : '',
    duedate: fields.duedate ? String(fields.duedate) : '',
    assignee: fields.assignee?.displayName
      ? String(fields.assignee.displayName)
      : (fields.assignee?.emailAddress ? String(fields.assignee.emailAddress) : ''),
    assigneeAccountId: fields.assignee?.accountId ? String(fields.assignee.accountId) : '',
    assigneeAvatarUrl: avatarFromAssignee(fields.assignee),
    projectKey: fields.project?.key ? String(fields.project.key) : '',
    labels: Array.isArray(fields.labels) ? fields.labels.map(String).filter(Boolean) : [],
    epicKey: epic.epicKey,
    epicSummary: epic.epicSummary,
  };
}

function mapIssueDetail(issue) {
  const base = mapIssueSummary(issue);
  const fields = issue?.fields || {};
  return {
    ...base,
    description: adfToText(fields.description),
    labels: Array.isArray(fields.labels)
      ? fields.labels.map(String)
      : (base.labels || []),
    reporter: fields.reporter?.displayName
      ? String(fields.reporter.displayName)
      : '',
    url: '', // filled by caller with host
  };
}

/**
 * List Jira projects visible to the authenticated user.
 * @param {object} settings
 * @param {{ maxResults?: number }} [opts]
 */
export async function listProjects(settings, opts = {}) {
  const s = normalizeAtlassianSettings(settings);
  const maxResults = Math.min(100, Math.max(1, Number(opts.maxResults) || 50));
  const client = createJiraClient(s);
  const result = await client.projects.searchProjects({
    maxResults,
    orderBy: 'key',
    action: 'view',
  });
  const projects = (Array.isArray(result?.values) ? result.values : [])
    .map((p) => ({
      key: String(p?.key || '').toUpperCase(),
      name: String(p?.name || ''),
      id: String(p?.id || ''),
    }))
    .filter((p) => p.key)
    .sort((a, b) => a.key.localeCompare(b.key));

  // Keep the configured project visible even if it fell outside this page.
  const configured = String(s.projectKey || '').trim().toUpperCase();
  if (configured && !projects.some((p) => p.key === configured)) {
    projects.unshift({ key: configured, name: configured, id: '' });
  }

  return { ok: true, projects, total: typeof result?.total === 'number' ? result.total : projects.length };
}

/**
 * Probe credentials + optionally confirm the configured project exists.
 * @param {object} settings
 */
export async function probeAtlassian(settings) {
  const s = normalizeAtlassianSettings(settings);
  const client = createJiraClient(s);
  const me = await client.myself.getCurrentUser();
  let project = null;
  if (s.projectKey) {
    try {
      const p = await client.projects.getProject({ projectIdOrKey: s.projectKey });
      project = {
        key: String(p.key || s.projectKey),
        name: String(p.name || ''),
        id: String(p.id || ''),
      };
    } catch (err) {
      return {
        ok: false,
        configured: true,
        error: err?.message || `Project ${s.projectKey} not found`,
        me: {
          accountId: me?.accountId || '',
          displayName: me?.displayName || '',
          emailAddress: me?.emailAddress || '',
        },
        project: null,
      };
    }
  }
  return {
    ok: true,
    configured: true,
    me: {
      accountId: me?.accountId || '',
      displayName: me?.displayName || '',
      emailAddress: me?.emailAddress || '',
    },
    project,
  };
}

function escapeJqlProject(projectKey) {
  return String(projectKey || '').replace(/"/g, '');
}

function quoteJqlAccountId(accountId) {
  return `"${String(accountId || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function mapMember(user, roles = []) {
  return {
    accountId: String(user?.accountId || ''),
    displayName: String(user?.displayName || user?.emailAddress || user?.accountId || ''),
    emailAddress: user?.emailAddress ? String(user.emailAddress) : '',
    active: user?.active !== false,
    roles: Array.isArray(roles) ? roles.filter(Boolean) : [],
  };
}

/**
 * Statuses configured for a project (union across issue types).
 * @param {object} settings
 * @param {{ projectKey?: string }} [opts]
 */
export async function listProjectStatuses(settings, opts = {}) {
  const s = normalizeAtlassianSettings(settings);
  const projectKey = String(opts.projectKey || s.projectKey || '').trim().toUpperCase();
  if (!projectKey) {
    throw Object.assign(new Error('Set a Jira project key first'), { code: 'ECONFIG' });
  }
  const client = createJiraClient(s);
  const groups = await client.projects.getAllStatuses({ projectIdOrKey: projectKey });
  /** @type {Map<string, { id: string, name: string, category: string, categoryName: string, iconUrl: string }>} */
  const byId = new Map();
  for (const issueType of Array.isArray(groups) ? groups : []) {
    for (const st of issueType?.statuses || []) {
      const id = String(st?.id || '');
      if (!id || byId.has(id)) continue;
      byId.set(id, {
        id,
        name: String(st?.name || ''),
        category: st?.statusCategory?.key ? String(st.statusCategory.key) : '',
        categoryName: st?.statusCategory?.name ? String(st.statusCategory.name) : '',
        iconUrl: st?.iconUrl ? String(st.iconUrl) : '',
      });
    }
  }
  const categoryRank = { new: 0, indeterminate: 1, done: 2 };
  const statuses = [...byId.values()]
    .filter((st) => st.name)
    .sort((a, b) => {
      const ca = categoryRank[a.category] ?? 9;
      const cb = categoryRank[b.category] ?? 9;
      if (ca !== cb) return ca - cb;
      return a.name.localeCompare(b.name);
    });
  return { ok: true, projectKey, statuses };
}

/**
 * Site-wide Jira labels (paginated). Prefer these over inventing local tags.
 * @param {object} settings
 * @param {{ maxResults?: number, startAt?: number }} [opts]
 */
export async function listLabels(settings, opts = {}) {
  const s = normalizeAtlassianSettings(settings);
  const maxResults = Math.min(1000, Math.max(1, Number(opts.maxResults) || 200));
  const startAt = Math.max(0, Number(opts.startAt) || 0);
  const client = createJiraClient(s);
  const result = await client.labels.getAllLabels({ startAt, maxResults });
  const labels = (Array.isArray(result?.values) ? result.values : [])
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  return {
    ok: true,
    labels,
    total: typeof result?.total === 'number' ? result.total : labels.length,
    startAt,
    maxResults,
    isLast: result?.isLast !== false && labels.length < maxResults,
  };
}

/**
 * Discover people who can be assigned issues in the project.
 * Uses assignable-user search (works without project-admin). Project-role
 * actors need Administer Projects and are used only as a secondary source.
 *
 * @param {object} settings
 * @param {{ projectKey?: string, maxResults?: number }} [opts]
 */
export async function listProjectMembers(settings, opts = {}) {
  const s = normalizeAtlassianSettings(settings);
  const projectKey = String(opts.projectKey || s.projectKey || '').trim().toUpperCase();
  if (!projectKey) {
    throw Object.assign(new Error('Set a Jira project key first'), { code: 'ECONFIG' });
  }
  const maxResults = Math.min(200, Math.max(1, Number(opts.maxResults) || 100));
  const client = createJiraClient(s);
  /** @type {Map<string, ReturnType<typeof mapMember>>} */
  const byId = new Map();
  let source = 'assignable';

  // Empty query returns the assignable pool for the project (verified on Cloud).
  let startAt = 0;
  while (byId.size < maxResults) {
    const pageSize = Math.min(50, maxResults - byId.size);
    const page = await client.userSearch.findAssignableUsers({
      project: projectKey,
      query: '',
      startAt,
      maxResults: pageSize,
    });
    const users = Array.isArray(page) ? page : [];
    if (!users.length) break;
    for (const user of users) {
      const member = mapMember(user);
      if (!member.accountId || byId.has(member.accountId)) continue;
      byId.set(member.accountId, member);
      if (byId.size >= maxResults) break;
    }
    if (users.length < pageSize) break;
    startAt += users.length;
  }

  // Best-effort: enrich with role names when the token can read project roles.
  try {
    const roles = await client.projectRoles.getProjectRoles(projectKey);
    const roleEntries = Object.entries(roles || {});
    for (const [roleName, url] of roleEntries) {
      const id = Number(String(url).split('/').pop());
      if (!Number.isFinite(id)) continue;
      const role = await client.projectRoles.getProjectRole({
        projectIdOrKey: projectKey,
        id,
        excludeInactiveUsers: true,
      });
      for (const actor of role?.actors || []) {
        const accountId = actor?.actorUser?.accountId;
        if (!accountId) continue;
        const existing = byId.get(accountId);
        if (existing) {
          if (!existing.roles.includes(roleName)) existing.roles.push(roleName);
        } else if (byId.size < maxResults) {
          byId.set(accountId, mapMember({
            accountId,
            displayName: actor.displayName,
            active: true,
          }, [roleName]));
          source = byId.size ? 'assignable+roles' : 'roles';
        }
      }
    }
    if (source === 'assignable' && roleEntries.length) source = 'assignable+roles';
  } catch {
    // Non-admin tokens get 401 on roles — assignable list alone is enough.
  }

  const members = [...byId.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
  );
  return {
    ok: true,
    projectKey,
    source,
    total: members.length,
    members,
  };
}

/**
 * List issues assigned to the current user and/or selected project members.
 * @param {object} settings
 * @param {{
 *   projectKey?: string,
 *   maxResults?: number,
 *   assignees?: 'me' | 'all' | string[],
 * }} [opts]
 */
export async function listAssignedIssues(settings, opts = {}) {
  const s = normalizeAtlassianSettings(settings);
  const projectKey = String(opts.projectKey || s.projectKey || '').trim().toUpperCase();
  if (!projectKey) {
    throw Object.assign(new Error('Set a Jira project key first'), { code: 'ECONFIG' });
  }
  const maxResults = Math.min(100, Math.max(1, Number(opts.maxResults) || 50));
  const client = createJiraClient(s);

  let assigneeClause = 'assignee = currentUser()';
  let assigneeMode = 'me';
  /** @type {string[]} */
  let resolvedAccountIds = [];

  const rawAssignees = opts.assignees;
  if (rawAssignees === 'all') {
    const discovered = await listProjectMembers(s, { projectKey, maxResults: 100 });
    resolvedAccountIds = discovered.members.map((m) => m.accountId).filter(Boolean);
    if (!resolvedAccountIds.length) {
      return {
        ok: true,
        jql: '',
        projectKey,
        assigneeMode: 'all',
        assignees: [],
        total: 0,
        nextPageToken: null,
        issues: [],
        note: 'No assignable members found in this project',
      };
    }
    assigneeClause = `assignee in (${resolvedAccountIds.map(quoteJqlAccountId).join(', ')})`;
    assigneeMode = 'all';
  } else if (Array.isArray(rawAssignees) && rawAssignees.length) {
    resolvedAccountIds = [...new Set(rawAssignees.map((id) => String(id || '').trim()).filter(Boolean))];
    if (!resolvedAccountIds.length) {
      throw Object.assign(new Error('No valid assignee account ids'), { code: 'EVALIDATION' });
    }
    assigneeClause = `assignee in (${resolvedAccountIds.map(quoteJqlAccountId).join(', ')})`;
    assigneeMode = 'selected';
  }

  // Classic /rest/api/3/search is gone (410). Use the enhanced search endpoint.
  const jql = `${assigneeClause} AND project = "${escapeJqlProject(projectKey)}" ORDER BY updated DESC`;
  const result = await client.issueSearch.searchForIssuesUsingJqlEnhancedSearchPost({
    jql,
    maxResults,
    fields: ISSUE_SUMMARY_FIELDS,
  });
  const issues = Array.isArray(result?.issues) ? result.issues.map(mapIssueSummary) : [];
  return {
    ok: true,
    jql,
    projectKey,
    assigneeMode,
    assignees: resolvedAccountIds,
    total: issues.length,
    nextPageToken: result?.nextPageToken || null,
    issues,
  };
}

function mapSprint(sprint, boardId = null) {
  return {
    id: Number(sprint?.id) || 0,
    name: String(sprint?.name || `Sprint ${sprint?.id || ''}`),
    state: String(sprint?.state || ''),
    startDate: sprint?.startDate ? String(sprint.startDate) : '',
    endDate: sprint?.endDate ? String(sprint.endDate) : '',
    completeDate: sprint?.completeDate ? String(sprint.completeDate) : '',
    goal: sprint?.goal ? String(sprint.goal) : '',
    boardId: Number(sprint?.originBoardId || boardId) || null,
  };
}

function mapBoard(board) {
  return {
    id: Number(board?.id) || 0,
    name: String(board?.name || `Board ${board?.id || ''}`),
    type: String(board?.type || ''),
  };
}

/**
 * Discover Scrum boards + active/future/(recent closed) sprints for a project.
 * @param {object} settings
 * @param {{ projectKey?: string, includeClosed?: boolean, maxResults?: number }} [opts]
 */
export async function listProjectSprints(settings, opts = {}) {
  const s = normalizeAtlassianSettings(settings);
  const projectKey = String(opts.projectKey || s.projectKey || '').trim().toUpperCase();
  if (!projectKey) {
    throw Object.assign(new Error('Set a Jira project key first'), { code: 'ECONFIG' });
  }
  const includeClosed = opts.includeClosed !== false;
  const maxResults = Math.min(50, Math.max(1, Number(opts.maxResults) || 50));
  const agile = createAgileClient(s);

  let boardPage;
  try {
    boardPage = await agile.board.getAllBoards({
      projectKeyOrId: projectKey,
      type: 'scrum',
      maxResults: 50,
      orderBy: 'name',
    });
  } catch (err) {
    // Some sites hide board type filter; retry unfiltered.
    boardPage = await agile.board.getAllBoards({
      projectKeyOrId: projectKey,
      maxResults: 50,
      orderBy: 'name',
    });
    void err;
  }

  const boards = (Array.isArray(boardPage?.values) ? boardPage.values : [])
    .map(mapBoard)
    .filter((b) => b.id && (!b.type || b.type === 'scrum' || b.type === 'simple'));

  if (!boards.length) {
    return {
      ok: true,
      projectKey,
      boards: [],
      sprints: [],
      activeSprintId: null,
      note: 'No Scrum boards found for this project',
    };
  }

  const state = includeClosed ? 'active,future,closed' : 'active,future';
  /** @type {Map<number, ReturnType<typeof mapSprint>>} */
  const byId = new Map();
  for (const board of boards.slice(0, 8)) {
    try {
      const page = await agile.board.getAllSprints({
        boardId: board.id,
        state,
        maxResults,
      });
      for (const raw of Array.isArray(page?.values) ? page.values : []) {
        const mapped = mapSprint(raw, board.id);
        if (!mapped.id) continue;
        const prev = byId.get(mapped.id);
        if (!prev || (!prev.boardId && mapped.boardId)) byId.set(mapped.id, mapped);
      }
    } catch {
      // Board may not support sprints (kanban) — skip.
    }
  }

  const rank = (stateName) => {
    if (stateName === 'active') return 0;
    if (stateName === 'future') return 1;
    return 2;
  };
  const sprints = [...byId.values()].sort((a, b) => {
    const rs = rank(a.state) - rank(b.state);
    if (rs) return rs;
    const ae = a.endDate || a.startDate || '';
    const be = b.endDate || b.startDate || '';
    return be.localeCompare(ae) || a.name.localeCompare(b.name);
  });

  // Prefer active; otherwise soonest future; otherwise most recent closed.
  const active = sprints.find((sp) => sp.state === 'active')
    || sprints.find((sp) => sp.state === 'future')
    || sprints[0]
    || null;

  return {
    ok: true,
    projectKey,
    boards,
    sprints,
    activeSprintId: active?.id || null,
    note: sprints.length ? undefined : 'No sprints on the project Scrum boards',
  };
}

/**
 * Issues committed to a sprint (full board — not assignee-scoped).
 * @param {object} settings
 * @param {{
 *   sprintId: number | string,
 *   boardId?: number | string | null,
 *   maxResults?: number,
 * }} opts
 */
export async function listSprintIssues(settings, opts = {}) {
  const sprintId = Number(opts.sprintId);
  if (!Number.isFinite(sprintId) || sprintId <= 0) {
    throw Object.assign(new Error('sprintId required'), { code: 'EVALIDATION' });
  }
  const boardId = opts.boardId != null && opts.boardId !== '' ? Number(opts.boardId) : null;
  const maxResults = Math.min(200, Math.max(1, Number(opts.maxResults) || 100));
  const agile = createAgileClient(settings);

  const params = {
    sprintId,
    maxResults,
    fields: ISSUE_SUMMARY_FIELDS,
  };

  let result;
  if (Number.isFinite(boardId) && boardId > 0) {
    result = await agile.board.getBoardIssuesForSprint({
      ...params,
      boardId,
    });
  } else {
    result = await agile.sprint.getIssuesForSprint(params);
  }

  const issues = Array.isArray(result?.issues) ? result.issues.map(mapIssueSummary) : [];
  return {
    ok: true,
    sprintId,
    boardId: Number.isFinite(boardId) && boardId > 0 ? boardId : null,
    total: typeof result?.total === 'number' ? result.total : issues.length,
    issues,
  };
}

/** @deprecated Prefer listAssignedIssues({ assignees: 'me' }). */
export async function listMyIssues(settings, opts = {}) {
  return listAssignedIssues(settings, { ...opts, assignees: 'me' });
}

/**
 * @param {object} settings
 * @param {string} issueKey
 */
export async function getIssue(settings, issueKey) {
  const key = normalizeIssueKey(issueKey);
  if (!key) throw Object.assign(new Error('issue key required'), { code: 'EVALIDATION' });
  const s = normalizeAtlassianSettings(settings);
  const client = createJiraClient(s);
  const issue = await client.issues.getIssue({
    issueIdOrKey: key,
    fields: [
      'summary', 'status', 'issuetype', 'priority', 'updated', 'created',
      'duedate', 'assignee', 'reporter', 'project', 'description', 'labels', 'parent',
    ],
  });
  const detail = mapIssueDetail(issue);
  if (s.host && detail.key) {
    detail.url = `${s.host.replace(/\/+$/, '')}/browse/${detail.key}`;
  }
  return { ok: true, issue: detail };
}

/**
 * Patch editable issue fields (summary, description, duedate, assignee, labels).
 * @param {object} settings
 * @param {string} issueKey
 * @param {{
 *   summary?: string,
 *   description?: string,
 *   duedate?: string | null,
 *   assigneeAccountId?: string | null,
 *   labels?: string[],
 * }} patch
 */
export async function updateIssue(settings, issueKey, patch = {}) {
  const key = normalizeIssueKey(issueKey);
  if (!key) throw Object.assign(new Error('issue key required'), { code: 'EVALIDATION' });
  if (!patch || typeof patch !== 'object') {
    throw Object.assign(new Error('patch object required'), { code: 'EVALIDATION' });
  }

  /** @type {Record<string, unknown>} */
  const fields = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'summary')) {
    const summary = String(patch.summary ?? '').trim();
    if (!summary) throw Object.assign(new Error('summary cannot be empty'), { code: 'EVALIDATION' });
    fields.summary = summary;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'description')) {
    fields.description = textToAdf(String(patch.description ?? ''));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'duedate')) {
    const raw = patch.duedate == null ? '' : String(patch.duedate).trim();
    fields.duedate = raw || null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'assigneeAccountId')) {
    const accountId = patch.assigneeAccountId == null ? '' : String(patch.assigneeAccountId).trim();
    fields.assignee = accountId ? { accountId } : null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'labels')) {
    fields.labels = Array.isArray(patch.labels)
      ? patch.labels.map((l) => String(l || '').trim()).filter(Boolean)
      : [];
  }

  if (!Object.keys(fields).length) {
    throw Object.assign(new Error('no editable fields in patch'), { code: 'EVALIDATION' });
  }

  const client = createJiraClient(settings);
  await client.issues.editIssue({
    issueIdOrKey: key,
    fields,
    notifyUsers: false,
  });
  return getIssue(settings, key);
}

/**
 * @param {object} settings
 * @param {string} issueKey
 */
export async function listTransitions(settings, issueKey) {
  const key = normalizeIssueKey(issueKey);
  if (!key) throw Object.assign(new Error('issue key required'), { code: 'EVALIDATION' });
  const client = createJiraClient(settings);
  const result = await client.issues.getTransitions({ issueIdOrKey: key });
  const transitions = (Array.isArray(result?.transitions) ? result.transitions : []).map((t) => ({
    id: String(t.id || ''),
    name: String(t.name || ''),
    to: t.to?.name ? String(t.to.name) : '',
    toId: t.to?.id ? String(t.to.id) : '',
  })).filter((t) => t.id);
  return { ok: true, issueKey: key, transitions };
}

/**
 * @param {object} settings
 * @param {string} issueKey
 * @param {string} transitionId
 */
export async function transitionIssue(settings, issueKey, transitionId) {
  const key = normalizeIssueKey(issueKey);
  const id = String(transitionId || '').trim();
  if (!key) throw Object.assign(new Error('issue key required'), { code: 'EVALIDATION' });
  if (!id) throw Object.assign(new Error('transition id required'), { code: 'EVALIDATION' });
  const client = createJiraClient(settings);
  await client.issues.doTransition({
    issueIdOrKey: key,
    transition: { id },
  });
  return getIssue(settings, key);
}

/**
 * @param {object} settings
 * @param {string} issueKey
 */
export async function listComments(settings, issueKey) {
  const key = normalizeIssueKey(issueKey);
  if (!key) throw Object.assign(new Error('issue key required'), { code: 'EVALIDATION' });
  const client = createJiraClient(settings);
  const result = await client.issueComments.getComments({
    issueIdOrKey: key,
    orderBy: '-created',
    maxResults: 50,
  });
  const comments = (Array.isArray(result?.comments) ? result.comments : []).map((c) => ({
    id: String(c.id || ''),
    author: c.author?.displayName
      ? String(c.author.displayName)
      : (c.author?.emailAddress ? String(c.author.emailAddress) : ''),
    created: c.created ? String(c.created) : '',
    updated: c.updated ? String(c.updated) : '',
    body: adfToText(c.body),
  }));
  return { ok: true, issueKey: key, comments };
}

/**
 * @param {object} settings
 * @param {string} issueKey
 * @param {string} bodyText
 */
export async function addComment(settings, issueKey, bodyText) {
  const key = normalizeIssueKey(issueKey);
  const text = String(bodyText ?? '').trim();
  if (!key) throw Object.assign(new Error('issue key required'), { code: 'EVALIDATION' });
  if (!text) throw Object.assign(new Error('comment body required'), { code: 'EVALIDATION' });
  const client = createJiraClient(settings);
  // jira.js accepts a plain string here and wraps it as ADF.
  await client.issueComments.addComment({
    issueIdOrKey: key,
    comment: text,
  });
  return listComments(settings, key);
}
