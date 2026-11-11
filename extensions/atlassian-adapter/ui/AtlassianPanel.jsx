/**
 * Atlassian Adapter — discover project members, browse tickets in SVAR views,
 * view / transition / comment.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LucideIcon } from '#ui/shared/LucideIcons.jsx';
import { HARNESS_NAMES, sessionLabel, sessionProviderHarness } from '#ui/shared/lib/format.js';
import { openGate } from '#ui/features/monitor/SessionIndicator.jsx';
import { AtlassianSettingsPanel } from './AtlassianSettingsPanel.jsx';
import { AtlassianViews } from './AtlassianViews.jsx';
import { IssueContextMenu } from './IssueContextMenu.jsx';
import { IssueDetailModal } from './IssueDetailModal.jsx';
import { MultiSelectDropdown, SelectDropdown } from './MenuDropdown.jsx';
import { ATLASSIAN_GROUP_BY, ATLASSIAN_VIEWS, groupIssues, mergeLabelCatalog } from './issueViewData.js';
import {
  buildJiraIssueAttachment,
  persistJiraTicketToSession,
  TICKET_FIRST_WORKFLOW_ID,
} from './jiraAttachment.js';
import {
  getAtlassianTicketCache,
  getCachedIssues,
  getCachedSprintIssues,
  issuesCacheKey,
  setAtlassianTicketCache,
  setCachedIssues,
  setCachedSprintIssues,
  sprintCacheKey,
} from './ticket-cache.js';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

function initialTicketCache() {
  return getAtlassianTicketCache();
}

export function AtlassianPanel({ canPersist = false }) {
  const cached = initialTicketCache();
  const [settings, setSettings] = useState(() => cached?.settings ?? null);
  const [issues, setIssues] = useState(() => cached?.issues ?? []);
  const [sprintIssues, setSprintIssues] = useState(() => cached?.sprintIssues ?? []);
  const [sprints, setSprints] = useState(() => cached?.sprints ?? []);
  const [selectedSprintId, setSelectedSprintId] = useState(() => cached?.selectedSprintId ?? null);
  const [selectedSprintBoardId, setSelectedSprintBoardId] = useState(
    () => cached?.selectedSprintBoardId ?? null,
  );
  const [view, setView] = useState(() => cached?.view || 'kanban');
  const [groupBy, setGroupBy] = useState(() => cached?.groupBy || 'none');
  const [groupsExpanded, setGroupsExpanded] = useState(() => cached?.groupsExpanded ?? true);
  const [members, setMembers] = useState(() => cached?.members ?? []);
  const [selectedMemberIds, setSelectedMemberIds] = useState(() => cached?.selectedMemberIds ?? []);
  const [scope, setScope] = useState(() => cached?.scope || 'me'); // 'me' | 'members'
  const [selectedKey, setSelectedKey] = useState(null);
  const [detail, setDetail] = useState(null);
  const [transitions, setTransitions] = useState([]);
  const [comments, setComments] = useState([]);
  const [projectOverride, setProjectOverride] = useState(() => cached?.projectOverride || '');
  const [projects, setProjects] = useState(() => cached?.projects ?? []);
  const [busy, setBusy] = useState(false);
  const [membersBusy, setMembersBusy] = useState(false);
  const [sprintBusy, setSprintBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(() => cached?.note || '');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statuses, setStatuses] = useState(() => cached?.statuses ?? []);
  const [siteLabels, setSiteLabels] = useState(() => cached?.siteLabels ?? []);
  const [chatSessions, setChatSessions] = useState([]);
  const [contextMenu, setContextMenu] = useState(null);
  const [contextTransitions, setContextTransitions] = useState([]);
  const [contextTransitionsLoading, setContextTransitionsLoading] = useState(false);

  const projectKey = (projectOverride || settings?.projectKey || '').trim().toUpperCase();
  const visibleIssues = view === 'sprint' ? sprintIssues : issues;
  const labelOptions = useMemo(
    () => mergeLabelCatalog(siteLabels, [...issues, ...sprintIssues, detail].filter(Boolean)),
    [siteLabels, issues, sprintIssues, detail],
  );

  const boardGroups = useMemo(
    () => groupIssues(visibleIssues, view === 'kanban' || view === 'list' ? groupBy : 'none'),
    [visibleIssues, view, groupBy],
  );

  // Move work item always targets status swimlanes — never the active group-by
  // buckets (assignee / label / epic), which are filters, not columns.
  const contextLanes = useMemo(
    () => (statuses || []).map((st) => ({
      id: `status:${st.name}`,
      label: st.name,
      hint: st.category || undefined,
    })),
    [statuses],
  );

  const contextSessionOptions = useMemo(
    () => (chatSessions || [])
      .filter((s) => s?.key && !s?.parentId && !s?.options?.parentId && s?.archived !== true)
      .map((s) => {
        const harness = sessionProviderHarness(s);
        const orchestrated = String(s?.kind || s?.options?.kind || '').toLowerCase() === 'orchestrated'
          || Boolean(s?.options?.workflowId || s?.workflowId);
        const needsAttention = Boolean(openGate(s?.live?.parts));
        return {
          id: s.key,
          label: sessionLabel(s),
          hint: orchestrated
            ? 'Orchestrated'
            : (HARNESS_NAMES[harness] || s.provider || harness || undefined),
          harness,
          orchestrated,
          provider: s.provider || harness,
          status: s.status,
          archived: s.archived === true,
          needsAttention,
        };
      }),
    [chatSessions],
  );

  const contextStatusOptions = useMemo(
    () => (contextTransitions || []).map((t) => ({
      id: t.id,
      label: t.to || t.name,
      hint: t.to && t.name && t.to !== t.name ? t.name : undefined,
    })),
    [contextTransitions],
  );

  const loadSettings = useCallback(async () => {
    if (!canPersist) return null;
    const next = await api('/adapters/atlassian/settings');
    setSettings(next);
    setAtlassianTicketCache({ settings: next });
    if (!projectOverride && next.projectKey) {
      setProjectOverride(next.projectKey);
      setAtlassianTicketCache({ projectOverride: next.projectKey });
    }
    return next;
  }, [canPersist, projectOverride]);

  const loadProjects = useCallback(async () => {
    if (!canPersist) return [];
    try {
      const listed = await api('/adapters/atlassian/projects');
      const next = listed.projects || [];
      setProjects(next);
      setAtlassianTicketCache({ projects: next });
      return next;
    } catch (err) {
      if (!getAtlassianTicketCache()?.projects?.length) setProjects([]);
      setError(err?.message || String(err));
      return [];
    }
  }, [canPersist]);

  const loadMembers = useCallback(async (key = projectKey, { quiet = true } = {}) => {
    if (!canPersist || !key) return [];
    setMembersBusy(true);
    if (!quiet) setError(null);
    try {
      const listed = await api(`/adapters/atlassian/members?project=${encodeURIComponent(key)}`);
      const next = listed.members || [];
      setMembers(next);
      setSelectedMemberIds((prev) => {
        // Keep current picks when still valid; otherwise select everyone.
        const ids = next.map((m) => m.accountId).filter(Boolean);
        const kept = prev.filter((id) => ids.includes(id));
        return kept.length ? kept : ids;
      });
      setAtlassianTicketCache({ members: next });
      return next;
    } catch (err) {
      if (!quiet) setError(err?.message || String(err));
      return [];
    } finally {
      setMembersBusy(false);
    }
  }, [canPersist, projectKey]);

  const loadProjectMeta = useCallback(async (key = projectKey) => {
    if (!canPersist || !key) {
      setStatuses([]);
      return { statuses: [], labels: [] };
    }
    try {
      const [statusRes, labelRes] = await Promise.all([
        api(`/adapters/atlassian/statuses?project=${encodeURIComponent(key)}`),
        api('/adapters/atlassian/labels?maxResults=200'),
      ]);
      const nextStatuses = statusRes.statuses || [];
      const nextLabels = labelRes.labels || [];
      setStatuses(nextStatuses);
      setSiteLabels(nextLabels);
      setAtlassianTicketCache({ statuses: nextStatuses, siteLabels: nextLabels });
      return { statuses: nextStatuses, labels: nextLabels };
    } catch {
      // Meta is best-effort — boards still fall back to statuses on loaded issues.
      return { statuses: [], labels: [] };
    }
  }, [canPersist, projectKey]);

  const loadIssues = useCallback(async ({
    key = projectKey,
    nextScope = scope,
    memberIds = selectedMemberIds,
  } = {}) => {
    if (!canPersist || !key) return;
    const cacheKey = issuesCacheKey({ project: key, scope: nextScope, memberIds });
    const cachedEntry = getCachedIssues(cacheKey);
    // Stale-while-revalidate: paint any warm tickets before the network round-trip.
    if (cachedEntry) {
      setIssues(cachedEntry.issues || []);
      if (cachedEntry.note) setNote(cachedEntry.note);
    }
    setBusy(true);
    setError(null);
    try {
      // maxResults is per assignee on the server for members scope.
      const params = new URLSearchParams({ project: key, maxResults: '50' });
      if (nextScope === 'members') {
        if (!memberIds.length) {
          setIssues([]);
          setNote('Select at least one project member from Assignees.');
          setCachedIssues(cacheKey, { issues: [], note: 'Select at least one project member from Assignees.' });
          return;
        }
        params.set('assignees', memberIds.join(','));
      } else {
        params.set('assignees', 'me');
      }
      const listed = await api(`/adapters/atlassian/issues?${params}`);
      const nextIssues = listed.issues || [];
      const who = listed.assigneeMode === 'me'
        ? 'you'
        : `${listed.assignees?.length || memberIds.length} member${(listed.assignees?.length || memberIds.length) === 1 ? '' : 's'}`;
      const nextNote =
        `${listed.total ?? nextIssues.length} issue${(listed.total ?? 0) === 1 ? '' : 's'} for ${who} in ${listed.projectKey || key}`
          + (listed.truncated ? ' (capped; more remain in Jira)' : '');
      setIssues(nextIssues);
      setNote(nextNote);
      setCachedIssues(cacheKey, { issues: nextIssues, note: nextNote });
      setAtlassianTicketCache({
        issues: nextIssues,
        issuesKey: cacheKey,
        note: nextNote,
        scope: nextScope,
        projectOverride: key,
        selectedMemberIds: nextScope === 'members' ? [...memberIds] : selectedMemberIds,
      });
    } catch (err) {
      // Keep stale tickets visible when the revalidate fails.
      if (!cachedEntry?.issues?.length) setIssues([]);
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }, [canPersist, projectKey, scope, selectedMemberIds]);

  const loadSprintIssues = useCallback(async ({
    sprintId,
    boardId = selectedSprintBoardId,
    quiet = false,
  } = {}) => {
    if (!canPersist || !sprintId) return;
    const cacheKey = sprintCacheKey({ sprintId, boardId });
    const cachedEntry = getCachedSprintIssues(cacheKey);
    if (cachedEntry) {
      setSprintIssues(cachedEntry.issues || []);
      if (cachedEntry.note) setNote(cachedEntry.note);
    }
    if (!quiet) setSprintBusy(true);
    else if (!cachedEntry) setSprintBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ maxResults: '100' });
      if (boardId) params.set('boardId', String(boardId));
      const listed = await api(
        `/adapters/atlassian/sprints/${encodeURIComponent(sprintId)}/issues?${params}`,
      );
      const nextIssues = listed.issues || [];
      const nextNote =
        `${listed.total ?? nextIssues.length} issue${(listed.total ?? 0) === 1 ? '' : 's'} in sprint`;
      setSprintIssues(nextIssues);
      setSelectedSprintId(Number(listed.sprintId) || Number(sprintId));
      if (listed.boardId) setSelectedSprintBoardId(listed.boardId);
      setNote(nextNote);
      setCachedSprintIssues(cacheKey, { issues: nextIssues, note: nextNote });
      setAtlassianTicketCache({
        sprintIssues: nextIssues,
        sprintKey: cacheKey,
        selectedSprintId: Number(listed.sprintId) || Number(sprintId),
        selectedSprintBoardId: listed.boardId || boardId || null,
        note: nextNote,
      });
    } catch (err) {
      if (!cachedEntry?.issues?.length) setSprintIssues([]);
      setError(err?.message || String(err));
    } finally {
      setSprintBusy(false);
    }
  }, [canPersist, selectedSprintBoardId]);

  const loadSprints = useCallback(async (key = projectKey, { selectId = null, quiet = false } = {}) => {
    if (!canPersist || !key) return [];
    if (!quiet) setSprintBusy(true);
    setError(null);
    try {
      const listed = await api(`/adapters/atlassian/sprints?project=${encodeURIComponent(key)}`);
      const next = listed.sprints || [];
      setSprints(next);
      setAtlassianTicketCache({ sprints: next });
      if (listed.note) setNote(listed.note);
      const preferred = (selectId != null && next.find((s) => String(s.id) === String(selectId)))
        || next.find((s) => String(s.id) === String(listed.activeSprintId))
        || next[0]
        || null;
      if (preferred) {
        setSelectedSprintId(preferred.id);
        setSelectedSprintBoardId(preferred.boardId || null);
        await loadSprintIssues({
          sprintId: preferred.id,
          boardId: preferred.boardId,
          quiet: true,
        });
      } else {
        setSelectedSprintId(null);
        setSelectedSprintBoardId(null);
        setSprintIssues([]);
      }
      return next;
    } catch (err) {
      if (!getAtlassianTicketCache()?.sprints?.length) {
        setSprints([]);
        setSelectedSprintId(null);
        setSelectedSprintBoardId(null);
        setSprintIssues([]);
      }
      setError(err?.message || String(err));
      return [];
    } finally {
      setSprintBusy(false);
    }
  }, [canPersist, projectKey, loadSprintIssues]);

  const openIssue = useCallback(async (key) => {
    if (!canPersist || !key) return;
    setSelectedKey(key);
    setDetail(null);
    setTransitions([]);
    setComments([]);
    setActionBusy(true);
    setError(null);
    try {
      const [issueRes, transRes, commentsRes] = await Promise.all([
        api(`/adapters/atlassian/issues/${encodeURIComponent(key)}`),
        api(`/adapters/atlassian/issues/${encodeURIComponent(key)}/transitions`),
        api(`/adapters/atlassian/issues/${encodeURIComponent(key)}/comments`),
      ]);
      setDetail(issueRes.issue || null);
      setTransitions(transRes.transitions || []);
      setComments(commentsRes.comments || []);
    } catch (err) {
      setDetail(null);
      setTransitions([]);
      setComments([]);
      setError(err?.message || String(err));
    } finally {
      setActionBusy(false);
    }
  }, [canPersist]);

  const closeIssue = useCallback(() => {
    setSelectedKey(null);
    setDetail(null);
    setTransitions([]);
    setComments([]);
  }, []);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);

  // Keep chrome (view / scope / project) warm across remounts.
  useEffect(() => {
    setAtlassianTicketCache({
      view,
      groupBy,
      groupsExpanded,
      scope,
      projectOverride,
      selectedMemberIds,
      selectedSprintId,
      selectedSprintBoardId,
    });
  }, [
    view,
    groupBy,
    groupsExpanded,
    scope,
    projectOverride,
    selectedMemberIds,
    selectedSprintId,
    selectedSprintBoardId,
  ]);

  useEffect(() => {
    if (!canPersist) return undefined;
    let cancelled = false;
    const warm = getAtlassianTicketCache();
    const warmScope = warm?.scope || 'me';
    const warmMembers = warm?.selectedMemberIds || [];
    (async () => {
      try {
        const s = await loadSettings();
        if (cancelled) return;
        if (!s?.configured) {
          setSettingsOpen(true);
          return;
        }
        await loadProjects();
        if (cancelled) return;
        const key = (projectOverride || s.projectKey || '').trim().toUpperCase();
        if (!key) return;
        // Members + project statuses/labels load behind the scenes.
        void loadMembers(key, { quiet: true });
        void loadProjectMeta(key);
        if (warm?.view === 'sprint') {
          await loadSprints(key, {
            selectId: warm.selectedSprintId,
            quiet: Boolean(warm.sprintIssues?.length || warm.sprints?.length),
          });
          return;
        }
        // Remount with cached tickets → show them while revalidating.
        await loadIssues({
          key,
          nextScope: warmScope,
          memberIds: warmScope === 'members' ? warmMembers : [],
        });
      } catch (err) {
        if (!cancelled) setError(err?.message || String(err));
      }
    })();
    return () => { cancelled = true; };
    // Intentionally once on mount / canPersist flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPersist]);

  async function onConnectionSaved(next) {
    setSettings(next);
    if (!next?.configured) return;
    if (!projectOverride && next.projectKey) setProjectOverride(next.projectKey);
    try {
      await loadProjects();
      const key = (projectOverride || next.projectKey || '').trim().toUpperCase();
      if (!key) return;
      void loadMembers(key, { quiet: true });
      void loadProjectMeta(key);
      if (view !== 'sprint') await loadIssues({ key, nextScope: scope });
    } catch (err) {
      setError(err?.message || String(err));
    }
  }

  async function onRefresh() {
    if (view === 'sprint') {
      if (selectedSprintId) {
        await loadSprintIssues({ sprintId: selectedSprintId, boardId: selectedSprintBoardId });
      } else {
        await loadSprints(projectKey);
      }
      return;
    }
    // Refresh members quietly in the background too.
    if (projectKey) void loadMembers(projectKey, { quiet: true });
    await loadIssues();
  }

  function onViewChange(next) {
    setView(next);
    if (next === 'sprint') {
      if (!sprints.length) void loadSprints(projectKey);
      else if (selectedSprintId && !sprintIssues.length) {
        void loadSprintIssues({ sprintId: selectedSprintId, boardId: selectedSprintBoardId });
      }
      return;
    }
    if (!issues.length) void loadIssues();
  }

  function onSelectSprint(sprint) {
    if (!sprint?.id) return;
    setSelectedSprintId(sprint.id);
    setSelectedSprintBoardId(sprint.boardId || null);
    void loadSprintIssues({ sprintId: sprint.id, boardId: sprint.boardId });
  }

  async function onSelectProject(key) {
    const nextKey = String(key || '').trim().toUpperCase();
    if (!nextKey || nextKey === projectKey) return;
    setProjectOverride(nextKey);
    setSelectedKey(null);
    setDetail(null);
    // Paint cached tickets for the new project immediately when we have them.
    const nextIssuesKey = issuesCacheKey({
      project: nextKey,
      scope,
      memberIds: selectedMemberIds,
    });
    const warmIssues = getCachedIssues(nextIssuesKey);
    if (warmIssues?.issues) {
      setIssues(warmIssues.issues);
      if (warmIssues.note) setNote(warmIssues.note);
    } else {
      setIssues([]);
    }
    setSprints([]);
    setSprintIssues([]);
    setSelectedSprintId(null);
    setSelectedSprintBoardId(null);
    setAtlassianTicketCache({ projectOverride: nextKey });
    try {
      const saved = await api('/adapters/atlassian/settings', {
        method: 'PUT',
        body: { projectKey: nextKey },
      });
      setSettings((prev) => ({ ...prev, ...saved }));
      setAtlassianTicketCache({ settings: { ...settings, ...saved } });
    } catch (err) {
      setError(err?.message || String(err));
    }
    void loadMembers(nextKey, { quiet: true });
    void loadProjectMeta(nextKey);
    if (view === 'sprint') await loadSprints(nextKey);
    else await loadIssues({ key: nextKey });
  }

  const loadChatSessions = useCallback(async () => {
    if (!canPersist) return;
    try {
      const res = await fetch('/kusa/agents', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const body = await res.json().catch(() => ({}));
      setChatSessions(Array.isArray(body?.sessions) ? body.sessions : []);
    } catch {
      setChatSessions([]);
    }
  }, [canPersist]);

  useEffect(() => {
    void loadChatSessions();
  }, [loadChatSessions]);

  async function applyTransitionTo(issueKey, transitionId) {
    const key = String(issueKey || '').trim();
    if (!key || !transitionId) return null;
    setActionBusy(true);
    setError(null);
    try {
      const result = await api(
        `/adapters/atlassian/issues/${encodeURIComponent(key)}/transition`,
        { method: 'POST', body: { transitionId } },
      );
      if (selectedKey === key) {
        setDetail(result.issue || null);
        const transRes = await api(`/adapters/atlassian/issues/${encodeURIComponent(key)}/transitions`);
        setTransitions(transRes.transitions || []);
      }
      if (view === 'sprint') await onRefresh();
      else await loadIssues();
      setNote(`Updated ${key} → ${result.issue?.status || 'new status'}`);
      return result.issue || null;
    } catch (err) {
      setError(err?.message || String(err));
      throw err;
    } finally {
      setActionBusy(false);
    }
  }

  async function applyTransition(transitionId) {
    return applyTransitionTo(selectedKey, transitionId);
  }

  async function saveIssuePatch(issueKey, patch) {
    const key = String(issueKey || '').trim();
    if (!key || !patch) return null;
    setActionBusy(true);
    setError(null);
    try {
      const result = await api(
        `/adapters/atlassian/issues/${encodeURIComponent(key)}`,
        { method: 'PUT', body: patch },
      );
      if (selectedKey === key) setDetail(result.issue || null);
      if (view === 'sprint') await onRefresh();
      else await loadIssues();
      setNote(`Saved ${key}`);
      return result.issue || null;
    } catch (err) {
      setError(err?.message || String(err));
      throw err;
    } finally {
      setActionBusy(false);
    }
  }

  async function saveIssue(patch) {
    return saveIssuePatch(selectedKey, patch);
  }

  function issueBrowseUrl(issue) {
    const key = String(issue?.key || '').trim();
    if (!key) return '';
    if (issue?.url) return String(issue.url);
    const host = String(settings?.host || '').replace(/\/+$/, '');
    return host ? `${host}/browse/${key}` : key;
  }

  async function copyText(text, okNote) {
    const value = String(text || '');
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setNote(okNote);
    } catch {
      setError('Could not copy to clipboard');
    }
  }

  const contextTransitionsKeyRef = useRef('');
  const contextTransitionsInflightRef = useRef('');
  const requestContextTransitions = useCallback(async (issueKey) => {
    const key = String(issueKey || contextMenu?.issue?.key || contextMenu?.issueKey || '')
      .replace(/^:/, '')
      .trim();
    if (!key) return;
    // Already fetched this ticket (even when the list is empty) — never refetch
    // while the menu is open; that loading toggle blinked the submenu.
    if (contextTransitionsKeyRef.current === key) return;
    if (contextTransitionsInflightRef.current === key) return;
    contextTransitionsInflightRef.current = key;
    setContextTransitionsLoading(true);
    try {
      const listed = await api(`/adapters/atlassian/issues/${encodeURIComponent(key)}/transitions`);
      contextTransitionsKeyRef.current = key;
      setContextTransitions(listed.transitions || []);
    } catch (err) {
      contextTransitionsKeyRef.current = '';
      setContextTransitions([]);
      setError(err?.message || String(err));
    } finally {
      if (contextTransitionsInflightRef.current === key) {
        contextTransitionsInflightRef.current = '';
      }
      setContextTransitionsLoading(false);
    }
  }, [contextMenu?.issue?.key, contextMenu?.issueKey]);

  // Prefetch transitions as soon as the menu opens so Change status isn't empty.
  useEffect(() => {
    const key = String(contextMenu?.issue?.key || contextMenu?.issueKey || '')
      .replace(/^:/, '')
      .trim();
    if (!key) return;
    void requestContextTransitions(key);
  }, [contextMenu?.issue?.key, contextMenu?.issueKey, requestContextTransitions]);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  async function transitionByStatusName(issueKey, statusName) {
    const want = String(statusName || '').trim().toLowerCase();
    if (!want) return;
    const listed = await api(`/adapters/atlassian/issues/${encodeURIComponent(issueKey)}/transitions`);
    const list = listed.transitions || [];
    const hit = list.find((t) => String(t.to || '').trim().toLowerCase() === want)
      || list.find((t) => String(t.name || '').trim().toLowerCase() === want);
    if (!hit?.id) {
      setError(`No transition to “${statusName}” for ${issueKey}`);
      return;
    }
    await applyTransitionTo(issueKey, hit.id);
  }

  async function handleContextAction(action) {
    const issue = action.issue || {};
    const key = String(action.issueKey || issue.key || '').trim();
    if (!key) return;

    if (action.type === 'copy-key') {
      await copyText(key, `Copied ${key}`);
      return;
    }
    if (action.type === 'copy-link') {
      await copyText(issueBrowseUrl(issue), `Copied link for ${key}`);
      return;
    }
    if (action.type === 'change-status') {
      await applyTransitionTo(key, action.statusId);
      return;
    }
    if (action.type === 'attach-chat-new') {
      const attachment = buildJiraIssueAttachment(
        { ...issue, key },
        issueBrowseUrl(issue),
      );
      window.dispatchEvent(new CustomEvent('kusa:create-agent', {
        detail: {
          provider: 'kusa',
          kind: 'orchestrated',
          workflowId: TICKET_FIRST_WORKFLOW_ID,
          name: key,
          attachments: [attachment],
        },
      }));
      setNote(`Opening orchestrated session with ${key}`);
      return;
    }
    if (action.type === 'attach-chat') {
      const sessionKey = String(action.sessionKey || '').trim();
      if (!sessionKey) return;
      const attachment = await persistJiraTicketToSession(
        sessionKey,
        { ...issue, key, url: issueBrowseUrl(issue) },
      ) || buildJiraIssueAttachment({ ...issue, key }, issueBrowseUrl(issue));
      try {
        sessionStorage.setItem(
          `kusa:composer-attachments:${sessionKey}`,
          JSON.stringify([attachment]),
        );
      } catch { /* ignore */ }
      window.dispatchEvent(new CustomEvent('kusa:open-agent', {
        detail: { sessionKey },
      }));
      window.dispatchEvent(new CustomEvent('kusa:composer-attach', {
        detail: { sessionKey, attachments: [attachment] },
      }));
      setNote(`Attached ${key} to chat`);
      return;
    }
    if (action.type === 'move-lane') {
      const laneId = String(action.laneId || '');
      if (!laneId) return;
      const statusName = laneId.startsWith('status:')
        ? laneId.slice('status:'.length)
        : (contextLanes.find((l) => l.id === laneId)?.label || '');
      if (!statusName) {
        setError(`Don’t know how to move ${key} to that lane yet`);
        return;
      }
      await transitionByStatusName(key, statusName);
    }
  }

  async function submitComment(text) {
    const body = String(text || '').trim();
    if (!selectedKey || !body) return;
    setActionBusy(true);
    setError(null);
    try {
      const result = await api(
        `/adapters/atlassian/issues/${encodeURIComponent(selectedKey)}/comments`,
        { method: 'POST', body: { body } },
      );
      setComments(result.comments || []);
      setNote(`Comment added on ${selectedKey}`);
    } catch (err) {
      setError(err?.message || String(err));
      throw err;
    } finally {
      setActionBusy(false);
    }
  }

  const memberOptions = useMemo(
    () => members.map((member) => ({
      id: member.accountId,
      label: member.displayName || member.accountId,
      hint: member.emailAddress || undefined,
    })),
    [members],
  );

  const membersSummary = scope === 'me'
    ? 'Assigned to me'
    : (!members.length
      ? (membersBusy ? 'Loading…' : 'Select members')
      : (selectedMemberIds.length === members.length
        ? `All ${members.length} members`
        : `${selectedMemberIds.length} of ${members.length} members`));

  const projectOptions = useMemo(() => {
    const opts = projects.map((p) => ({
      id: p.key,
      label: p.key,
      hint: p.name && p.name !== p.key ? p.name : undefined,
      icon: 'package',
    }));
    if (projectKey && !opts.some((o) => o.id === projectKey)) {
      opts.unshift({ id: projectKey, label: projectKey, icon: 'package' });
    }
    return opts;
  }, [projects, projectKey]);

  function onMembersChange(ids) {
    setSelectedMemberIds(ids);
    if (scope !== 'members') setScope('members');
  }

  function onMembersOpen() {
    if (!members.length && projectKey) void loadMembers(projectKey, { quiet: true });
  }

  function onMembersClose() {
    if (scope === 'members' && selectedMemberIds.length && view !== 'sprint') {
      void loadIssues({ nextScope: 'members', memberIds: selectedMemberIds });
    }
  }

  function chooseAssignedToMe() {
    setScope('me');
    if (view !== 'sprint') void loadIssues({ nextScope: 'me' });
  }

  const groupingActive = (view === 'kanban' || view === 'list') && groupBy !== 'none';
  const refreshDisabled = busy
    || sprintBusy
    || !projectKey
    || (view !== 'sprint' && scope === 'members' && !selectedMemberIds.length);

  function onGroupByChange(next) {
    setGroupBy(next);
    setGroupsExpanded(true);
  }

  if (!canPersist) {
    return (
      <p className="text-sm text-gray-500">
        Atlassian Adapter needs a writable workspace monitor directory.
      </p>
    );
  }

  const configured = Boolean(settings?.configured);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3">
      <header className="shrink-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {configured ? (
            <>
              <SelectDropdown
                label="Project"
                value={projectKey}
                options={projectOptions}
                onSelect={(id) => void onSelectProject(id)}
                disabled={!projectOptions.length}
              />
              <SelectDropdown
                label="View"
                value={view}
                options={ATLASSIAN_VIEWS.map((entry) => ({
                  id: entry.id,
                  label: entry.label,
                  icon: entry.icon,
                }))}
                onSelect={onViewChange}
              />
              {view === 'kanban' || view === 'list' ? (
                <SelectDropdown
                  label="Grouped by"
                  value={groupBy}
                  options={ATLASSIAN_GROUP_BY.map((entry) => ({
                    id: entry.id,
                    label: entry.label,
                    icon: entry.icon,
                  }))}
                  onSelect={onGroupByChange}
                />
              ) : null}
              <MultiSelectDropdown
                label="Assignees"
                summary={membersSummary}
                options={memberOptions}
                selectedIds={scope === 'members' ? selectedMemberIds : []}
                onChange={onMembersChange}
                onOpen={onMembersOpen}
                onClose={onMembersClose}
                disabled={!projectKey || view === 'sprint'}
                emptyText={membersBusy ? 'Loading members…' : 'No assignable members in this project.'}
                leading={(closeMenu) => (
                  <div className="border-b border-gray-800 pb-1">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={scope === 'me'}
                      onClick={() => {
                        chooseAssignedToMe();
                        closeMenu();
                      }}
                      className={`flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-xs ${
                        scope === 'me'
                          ? 'bg-emerald-500/10 text-emerald-300'
                          : 'text-gray-200 hover:bg-gray-900'
                      }`}
                    >
                      <span className={`mt-0.5 w-3 shrink-0 text-[10px] ${scope === 'me' ? 'text-emerald-400' : 'text-transparent'}`}>
                        ✓
                      </span>
                      <span className="min-w-0">
                        <span className="block font-medium">Assigned to me</span>
                        <span className="block text-[10px] text-gray-500">Only tickets assigned to you</span>
                      </span>
                    </button>
                  </div>
                )}
              />
            </>
          ) : (
            <h2 className="text-base font-semibold text-gray-100">Jira tickets</h2>
          )}
          <div className="ml-auto flex items-center gap-1">
            {configured && groupingActive ? (
              <button
                type="button"
                onClick={() => setGroupsExpanded((v) => !v)}
                title={groupsExpanded ? 'Collapse all groups' : 'Expand all groups'}
                aria-label={groupsExpanded ? 'Collapse all groups' : 'Expand all groups'}
                aria-pressed={groupsExpanded}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-900 hover:text-gray-100"
              >
                <LucideIcon
                  name={groupsExpanded ? 'chevrons-down-up' : 'chevrons-up-down'}
                  className="h-[18px] w-[18px]"
                />
              </button>
            ) : null}
            {configured ? (
              <button
                type="button"
                disabled={refreshDisabled}
                onClick={() => void onRefresh()}
                title={busy || sprintBusy ? 'Refreshing…' : 'Refresh tickets'}
                aria-label={busy || sprintBusy ? 'Refreshing tickets' : 'Refresh tickets'}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-900 hover:text-gray-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <LucideIcon
                  name="refresh-cw"
                  className={`h-[18px] w-[18px] ${busy || sprintBusy ? 'animate-spin' : ''}`}
                />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              title="Connection settings"
              aria-label="Connection settings"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-900 hover:text-gray-100"
            >
              <LucideIcon name="cog" className="h-[18px] w-[18px]" />
            </button>
          </div>
        </div>

        {note ? <p className="text-[11px] text-gray-500">{note}</p> : null}
        {error ? <p className="text-xs text-rose-400">{error}</p> : null}
      </header>

      {configured ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <AtlassianViews
            issues={visibleIssues}
            selectedKey={selectedKey}
            onSelect={(key) => void openIssue(key)}
            onTicketContextMenu={(payload) => {
              const issueKey = String(payload?.issueKey || payload?.issue?.key || '')
                .replace(/^:/, '')
                .trim();
              void loadChatSessions();
              if (contextTransitionsKeyRef.current !== issueKey) {
                contextTransitionsKeyRef.current = '';
                contextTransitionsInflightRef.current = '';
                setContextTransitions([]);
                setContextTransitionsLoading(false);
              }
              setContextMenu({
                ...payload,
                issueKey,
                issue: { ...(payload?.issue || {}), key: issueKey },
              });
            }}
            view={view}
            onViewChange={onViewChange}
            groupBy={groupBy}
            groupsExpanded={groupsExpanded}
            onGroupsExpandedChange={setGroupsExpanded}
            sprints={sprints}
            selectedSprintId={selectedSprintId}
            onSelectSprint={onSelectSprint}
            sprintBusy={sprintBusy}
            statuses={statuses}
            emptyMessage={
              view === 'sprint'
                ? 'Pick a sprint to load its board.'
                : 'No issues for the current scope.'
            }
          />
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-gray-800 px-4 py-10 text-center text-sm text-gray-400">
          Open connection settings to save host, email, and API token.
        </p>
      )}

      <AtlassianSettingsPanel
        open={settingsOpen}
        onClose={closeSettings}
        canPersist={canPersist}
        onSaved={(next) => void onConnectionSaved(next)}
      />

      <IssueContextMenu
        open={Boolean(contextMenu)}
        x={contextMenu?.x || 0}
        y={contextMenu?.y || 0}
        issue={contextMenu?.issue || null}
        lanes={contextLanes}
        statuses={contextStatusOptions}
        sessions={contextSessionOptions}
        statusesLoading={contextTransitionsLoading}
        onRequestStatuses={requestContextTransitions}
        onClose={closeContextMenu}
        onAction={(action) => { void handleContextAction(action); }}
      />

      <IssueDetailModal
        open={Boolean(selectedKey)}
        issueKey={selectedKey}
        detail={detail}
        transitions={transitions}
        comments={comments}
        members={members}
        labelOptions={labelOptions}
        loading={actionBusy && !detail}
        busy={actionBusy}
        error={error}
        onClose={closeIssue}
        onTransition={applyTransition}
        onSave={saveIssue}
        onComment={submitComment}
      />
    </div>
  );
}
