/**
 * Atlassian Adapter — discover project members, browse tickets in SVAR views,
 * view / transition / comment.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LucideIcon } from '#ui/shared/LucideIcons.jsx';
import { AtlassianSettingsPanel } from './AtlassianSettingsPanel.jsx';
import { AtlassianViews } from './AtlassianViews.jsx';
import { IssueDetailModal } from './IssueDetailModal.jsx';
import { MultiSelectDropdown, SelectDropdown } from './MenuDropdown.jsx';
import { ATLASSIAN_GROUP_BY, ATLASSIAN_VIEWS, mergeLabelCatalog } from './issueViewData.js';

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

export function AtlassianPanel({ canPersist = false }) {
  const [settings, setSettings] = useState(null);
  const [issues, setIssues] = useState([]);
  const [sprintIssues, setSprintIssues] = useState([]);
  const [sprints, setSprints] = useState([]);
  const [selectedSprintId, setSelectedSprintId] = useState(null);
  const [selectedSprintBoardId, setSelectedSprintBoardId] = useState(null);
  const [view, setView] = useState('kanban');
  const [groupBy, setGroupBy] = useState('none');
  const [groupsExpanded, setGroupsExpanded] = useState(true);
  const [members, setMembers] = useState([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState([]);
  const [scope, setScope] = useState('me'); // 'me' | 'members'
  const [selectedKey, setSelectedKey] = useState(null);
  const [detail, setDetail] = useState(null);
  const [transitions, setTransitions] = useState([]);
  const [comments, setComments] = useState([]);
  const [projectOverride, setProjectOverride] = useState('');
  const [projects, setProjects] = useState([]);
  const [busy, setBusy] = useState(false);
  const [membersBusy, setMembersBusy] = useState(false);
  const [sprintBusy, setSprintBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statuses, setStatuses] = useState([]);
  const [siteLabels, setSiteLabels] = useState([]);

  const projectKey = (projectOverride || settings?.projectKey || '').trim().toUpperCase();
  const visibleIssues = view === 'sprint' ? sprintIssues : issues;
  const labelOptions = useMemo(
    () => mergeLabelCatalog(siteLabels, [...issues, ...sprintIssues, detail].filter(Boolean)),
    [siteLabels, issues, sprintIssues, detail],
  );

  const loadSettings = useCallback(async () => {
    if (!canPersist) return null;
    const next = await api('/adapters/atlassian/settings');
    setSettings(next);
    if (!projectOverride && next.projectKey) setProjectOverride(next.projectKey);
    return next;
  }, [canPersist, projectOverride]);

  const loadProjects = useCallback(async () => {
    if (!canPersist) return [];
    try {
      const listed = await api('/adapters/atlassian/projects');
      const next = listed.projects || [];
      setProjects(next);
      return next;
    } catch (err) {
      setProjects([]);
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
      return next;
    } catch (err) {
      setMembers([]);
      setSelectedMemberIds([]);
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
      return { statuses: nextStatuses, labels: nextLabels };
    } catch {
      // Meta is best-effort — boards still fall back to statuses on loaded issues.
      setStatuses([]);
      return { statuses: [], labels: [] };
    }
  }, [canPersist, projectKey]);

  const loadIssues = useCallback(async ({
    key = projectKey,
    nextScope = scope,
    memberIds = selectedMemberIds,
  } = {}) => {
    if (!canPersist || !key) return;
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ project: key, maxResults: '50' });
      if (nextScope === 'members') {
        if (!memberIds.length) {
          setIssues([]);
          setNote('Select at least one project member from Assignees.');
          return;
        }
        params.set('assignees', memberIds.join(','));
      } else {
        params.set('assignees', 'me');
      }
      const listed = await api(`/adapters/atlassian/issues?${params}`);
      setIssues(listed.issues || []);
      const who = listed.assigneeMode === 'me'
        ? 'you'
        : `${listed.assignees?.length || memberIds.length} member${(listed.assignees?.length || memberIds.length) === 1 ? '' : 's'}`;
      setNote(`${listed.total ?? (listed.issues || []).length} issue${(listed.total ?? 0) === 1 ? '' : 's'} for ${who} in ${listed.projectKey || key}`);
    } catch (err) {
      setIssues([]);
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
    if (!quiet) setSprintBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ maxResults: '100' });
      if (boardId) params.set('boardId', String(boardId));
      const listed = await api(
        `/adapters/atlassian/sprints/${encodeURIComponent(sprintId)}/issues?${params}`,
      );
      setSprintIssues(listed.issues || []);
      setSelectedSprintId(Number(listed.sprintId) || Number(sprintId));
      if (listed.boardId) setSelectedSprintBoardId(listed.boardId);
      setNote(
        `${listed.total ?? (listed.issues || []).length} issue${(listed.total ?? 0) === 1 ? '' : 's'} in sprint`,
      );
    } catch (err) {
      setSprintIssues([]);
      setError(err?.message || String(err));
    } finally {
      if (!quiet) setSprintBusy(false);
    }
  }, [canPersist, selectedSprintBoardId]);

  const loadSprints = useCallback(async (key = projectKey, { selectId = null } = {}) => {
    if (!canPersist || !key) return [];
    setSprintBusy(true);
    setError(null);
    try {
      const listed = await api(`/adapters/atlassian/sprints?project=${encodeURIComponent(key)}`);
      const next = listed.sprints || [];
      setSprints(next);
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
      setSprints([]);
      setSelectedSprintId(null);
      setSelectedSprintBoardId(null);
      setSprintIssues([]);
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

  useEffect(() => {
    if (!canPersist) return undefined;
    let cancelled = false;
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
        await loadIssues({ key, nextScope: 'me' });
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
    setSprints([]);
    setSprintIssues([]);
    setSelectedSprintId(null);
    setSelectedSprintBoardId(null);
    try {
      const saved = await api('/adapters/atlassian/settings', {
        method: 'PUT',
        body: { projectKey: nextKey },
      });
      setSettings((prev) => ({ ...prev, ...saved }));
    } catch (err) {
      setError(err?.message || String(err));
    }
    void loadMembers(nextKey, { quiet: true });
    void loadProjectMeta(nextKey);
    if (view === 'sprint') await loadSprints(nextKey);
    else await loadIssues({ key: nextKey });
  }

  async function applyTransition(transitionId) {
    if (!selectedKey || !transitionId) return;
    setActionBusy(true);
    setError(null);
    try {
      const result = await api(
        `/adapters/atlassian/issues/${encodeURIComponent(selectedKey)}/transition`,
        { method: 'POST', body: { transitionId } },
      );
      setDetail(result.issue || null);
      const [transRes] = await Promise.all([
        api(`/adapters/atlassian/issues/${encodeURIComponent(selectedKey)}/transitions`),
        view === 'sprint' ? onRefresh() : loadIssues(),
      ]);
      setTransitions(transRes.transitions || []);
      setNote(`Updated ${selectedKey} → ${result.issue?.status || 'new status'}`);
    } catch (err) {
      setError(err?.message || String(err));
      throw err;
    } finally {
      setActionBusy(false);
    }
  }

  async function saveIssue(patch) {
    if (!selectedKey || !patch) return;
    setActionBusy(true);
    setError(null);
    try {
      const result = await api(
        `/adapters/atlassian/issues/${encodeURIComponent(selectedKey)}`,
        { method: 'PUT', body: patch },
      );
      setDetail(result.issue || null);
      if (view === 'sprint') await onRefresh();
      else await loadIssues();
      setNote(`Saved ${selectedKey}`);
    } catch (err) {
      setError(err?.message || String(err));
      throw err;
    } finally {
      setActionBusy(false);
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
