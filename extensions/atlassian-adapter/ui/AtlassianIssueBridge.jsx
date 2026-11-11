/**
 * App-level bridge: listens for `kusa:open-jira-issue` and opens the shared
 * IssueDetailModal. Mounted from App only when the Atlassian extension is
 * installed, so chat attachment chips work even when the board panel is not
 * on screen.
 */
import { useCallback, useEffect, useState } from 'react';
import { IssueDetailModal } from './IssueDetailModal.jsx';

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

/**
 * @param {{ canPersist?: boolean }} props
 */
export function AtlassianIssueBridge({ canPersist = false }) {
  const [selectedKey, setSelectedKey] = useState(null);
  const [detail, setDetail] = useState(null);
  const [transitions, setTransitions] = useState([]);
  const [comments, setComments] = useState([]);
  const [members, setMembers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const closeIssue = useCallback(() => {
    setSelectedKey(null);
    setDetail(null);
    setTransitions([]);
    setComments([]);
    setError(null);
  }, []);

  const openIssue = useCallback(async (rawKey) => {
    const key = String(rawKey || '').replace(/^:/, '').trim();
    if (!canPersist || !key) return;
    setSelectedKey(key);
    setDetail(null);
    setTransitions([]);
    setComments([]);
    setBusy(true);
    setError(null);
    try {
      const [issueRes, transRes, commentsRes] = await Promise.all([
        api(`/adapters/atlassian/issues/${encodeURIComponent(key)}`),
        api(`/adapters/atlassian/issues/${encodeURIComponent(key)}/transitions`),
        api(`/adapters/atlassian/issues/${encodeURIComponent(key)}/comments`),
      ]);
      const issue = issueRes.issue || null;
      setDetail(issue);
      setTransitions(transRes.transitions || []);
      setComments(commentsRes.comments || []);
      const project = String(issue?.projectKey || '').trim().toUpperCase();
      if (project) {
        try {
          const listed = await api(`/adapters/atlassian/members?project=${encodeURIComponent(project)}`);
          setMembers(listed.members || []);
        } catch {
          setMembers([]);
        }
      }
    } catch (err) {
      setDetail(null);
      setTransitions([]);
      setComments([]);
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }, [canPersist]);

  useEffect(() => {
    function onOpen(event) {
      const key = String(event?.detail?.issueKey || '').replace(/^:/, '').trim();
      if (key) void openIssue(key);
    }
    window.addEventListener('kusa:open-jira-issue', onOpen);
    return () => window.removeEventListener('kusa:open-jira-issue', onOpen);
  }, [openIssue]);

  async function applyTransition(transitionId) {
    if (!selectedKey || !transitionId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api(
        `/adapters/atlassian/issues/${encodeURIComponent(selectedKey)}/transition`,
        { method: 'POST', body: { transitionId } },
      );
      setDetail(result.issue || null);
      const transRes = await api(
        `/adapters/atlassian/issues/${encodeURIComponent(selectedKey)}/transitions`,
      );
      setTransitions(transRes.transitions || []);
    } catch (err) {
      setError(err?.message || String(err));
      throw err;
    } finally {
      setBusy(false);
    }
  }

  async function saveIssue(patch) {
    if (!selectedKey || !patch) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api(
        `/adapters/atlassian/issues/${encodeURIComponent(selectedKey)}`,
        { method: 'PUT', body: patch },
      );
      setDetail(result.issue || null);
    } catch (err) {
      setError(err?.message || String(err));
      throw err;
    } finally {
      setBusy(false);
    }
  }

  async function submitComment(text) {
    const body = String(text || '').trim();
    if (!selectedKey || !body) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api(
        `/adapters/atlassian/issues/${encodeURIComponent(selectedKey)}/comments`,
        { method: 'POST', body: { body } },
      );
      setComments(result.comments || []);
    } catch (err) {
      setError(err?.message || String(err));
      throw err;
    } finally {
      setBusy(false);
    }
  }

  return (
    <IssueDetailModal
      open={Boolean(selectedKey)}
      issueKey={selectedKey}
      detail={detail}
      transitions={transitions}
      comments={comments}
      members={members}
      labelOptions={Array.isArray(detail?.labels) ? detail.labels : []}
      loading={busy && !detail}
      busy={busy}
      error={error}
      onClose={closeIssue}
      onTransition={applyTransition}
      onSave={saveIssue}
      onComment={submitComment}
    />
  );
}
