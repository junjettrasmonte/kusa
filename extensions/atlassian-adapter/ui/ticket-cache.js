/**
 * Session cache for Atlassian ticket boards.
 *
 * Survives Dev Tools remounts (leave Jira → come back). Hydrate the panel from
 * the snapshot immediately, then soft-revalidate against the API without
 * clearing the previous tickets first. Per-query maps keep prior project /
 * sprint boards warm when switching scope.
 */

/** @typedef {{
 *   issues: object[],
 *   note: string,
 *   fetchedAt: number,
 * }} IssuesCacheEntry */

/** @typedef {{
 *   settings: object | null,
 *   projectOverride: string,
 *   projects: object[],
 *   issues: object[],
 *   issuesKey: string,
 *   note: string,
 *   sprintIssues: object[],
 *   sprintKey: string,
 *   sprints: object[],
 *   selectedSprintId: number | null,
 *   selectedSprintBoardId: number | null,
 *   members: object[],
 *   selectedMemberIds: string[],
 *   scope: 'me' | 'members',
 *   statuses: object[],
 *   siteLabels: string[],
 *   view: string,
 *   groupBy: string,
 *   groupsExpanded: boolean,
 *   fetchedAt: number,
 * }} AtlassianTicketCacheSnapshot */

/** @type {AtlassianTicketCacheSnapshot | null} */
let snapshot = null;

/** @type {Map<string, IssuesCacheEntry>} */
const issuesByKey = new Map();

/** @type {Map<string, IssuesCacheEntry>} */
const sprintIssuesByKey = new Map();

/**
 * Stable key for a non-sprint issues query.
 * @param {{ project?: string, scope?: string, memberIds?: string[] }} opts
 */
export function issuesCacheKey({ project = '', scope = 'me', memberIds = [] } = {}) {
  const proj = String(project || '').trim().toUpperCase();
  if (scope === 'members') {
    const ids = [...memberIds].map(String).filter(Boolean).sort().join(',');
    return `${proj}|members|${ids}`;
  }
  return `${proj}|me`;
}

/**
 * Stable key for a sprint board query.
 * @param {{ sprintId?: number|string|null, boardId?: number|string|null }} opts
 */
export function sprintCacheKey({ sprintId = null, boardId = null } = {}) {
  if (sprintId == null || sprintId === '') return '';
  return `sprint:${sprintId}:${boardId || ''}`;
}

/** @returns {AtlassianTicketCacheSnapshot | null} */
export function getAtlassianTicketCache() {
  return snapshot;
}

/** @param {string} key @returns {IssuesCacheEntry | null} */
export function getCachedIssues(key) {
  if (!key) return null;
  return issuesByKey.get(key) || null;
}

/** @param {string} key @returns {IssuesCacheEntry | null} */
export function getCachedSprintIssues(key) {
  if (!key) return null;
  return sprintIssuesByKey.get(key) || null;
}

/**
 * @param {string} key
 * @param {{ issues?: object[], note?: string }} entry
 */
export function setCachedIssues(key, entry) {
  if (!key) return;
  const next = {
    issues: Array.isArray(entry?.issues) ? entry.issues : [],
    note: typeof entry?.note === 'string' ? entry.note : '',
    fetchedAt: Date.now(),
  };
  issuesByKey.set(key, next);
  if (snapshot) {
    snapshot = {
      ...snapshot,
      issues: next.issues,
      issuesKey: key,
      note: next.note || snapshot.note,
      fetchedAt: next.fetchedAt,
    };
  }
}

/**
 * @param {string} key
 * @param {{ issues?: object[], note?: string }} entry
 */
export function setCachedSprintIssues(key, entry) {
  if (!key) return;
  const next = {
    issues: Array.isArray(entry?.issues) ? entry.issues : [],
    note: typeof entry?.note === 'string' ? entry.note : '',
    fetchedAt: Date.now(),
  };
  sprintIssuesByKey.set(key, next);
  if (snapshot) {
    snapshot = {
      ...snapshot,
      sprintIssues: next.issues,
      sprintKey: key,
      note: next.note || snapshot.note,
      fetchedAt: next.fetchedAt,
    };
  }
}

/**
 * Merge into the session snapshot (successful fetch or chrome change).
 * @param {Partial<AtlassianTicketCacheSnapshot>} next
 */
export function setAtlassianTicketCache(next) {
  if (!next || typeof next !== 'object') return;
  snapshot = {
    settings: snapshot?.settings ?? null,
    projectOverride: snapshot?.projectOverride ?? '',
    projects: snapshot?.projects ?? [],
    issues: snapshot?.issues ?? [],
    issuesKey: snapshot?.issuesKey ?? '',
    note: snapshot?.note ?? '',
    sprintIssues: snapshot?.sprintIssues ?? [],
    sprintKey: snapshot?.sprintKey ?? '',
    sprints: snapshot?.sprints ?? [],
    selectedSprintId: snapshot?.selectedSprintId ?? null,
    selectedSprintBoardId: snapshot?.selectedSprintBoardId ?? null,
    members: snapshot?.members ?? [],
    selectedMemberIds: snapshot?.selectedMemberIds ?? [],
    scope: snapshot?.scope ?? 'me',
    statuses: snapshot?.statuses ?? [],
    siteLabels: snapshot?.siteLabels ?? [],
    view: snapshot?.view ?? 'kanban',
    groupBy: snapshot?.groupBy ?? 'none',
    groupsExpanded: snapshot?.groupsExpanded ?? true,
    ...next,
    fetchedAt: Date.now(),
  };
  if (snapshot.issuesKey && Array.isArray(snapshot.issues)) {
    issuesByKey.set(snapshot.issuesKey, {
      issues: snapshot.issues,
      note: snapshot.note || '',
      fetchedAt: snapshot.fetchedAt,
    });
  }
  if (snapshot.sprintKey && Array.isArray(snapshot.sprintIssues)) {
    sprintIssuesByKey.set(snapshot.sprintKey, {
      issues: snapshot.sprintIssues,
      note: snapshot.note || '',
      fetchedAt: snapshot.fetchedAt,
    });
  }
}

/** Test helper. */
export function resetAtlassianTicketCache() {
  snapshot = null;
  issuesByKey.clear();
  sprintIssuesByKey.clear();
}
