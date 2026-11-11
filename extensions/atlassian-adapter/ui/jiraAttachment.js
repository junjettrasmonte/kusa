/**
 * Composer attachment record for a Jira issue — clickable chip opens the
 * shared Atlassian ticket popup via `kusa:open-jira-issue`. Disk truth for a
 * session is `attachments/ticket.json` (PUT/GET …/sessions/:key/ticket).
 */

/** Matches extensions/atlassian-adapter/workflow.mjs — keep in sync. */
export const TICKET_FIRST_WORKFLOW_ID = 'ticket-first';

export function ticketFirstKickoffStorageKey(sessionKey) {
  return `kusa:ticket-first-kickoff:${String(sessionKey || '').trim()}`;
}

/**
 * @param {object} issue
 * @param {string} [browseUrl]
 */
export function buildJiraIssueAttachment(issue, browseUrl = '') {
  const key = String(issue?.key || '').replace(/^:/, '').trim();
  const summary = String(issue?.summary || '').trim();
  const url = String(browseUrl || issue?.url || '').trim();
  const text = [`[${key}]${summary ? ` ${summary}` : ''}`, url].filter(Boolean).join('\n');
  return {
    name: key || 'Jira issue',
    kind: 'jira',
    size: Math.max(1, text.length),
    mime: 'application/x-kusa-jira-issue',
    issueKey: key,
    summary,
    url,
    text,
    note: 'Jira issue',
  };
}

/** @param {string} issueKey */
export function openJiraIssuePopup(issueKey) {
  const key = String(issueKey || '').replace(/^:/, '').trim();
  if (!key || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('kusa:open-jira-issue', {
    detail: { issueKey: key },
  }));
}

/**
 * Persist a Jira issue into the session's attachments/ticket.json (server).
 * Fetches full issue detail when credentials allow.
 * @param {string} sessionKey
 * @param {object} issue
 * @returns {Promise<object|null>} composer attachment record, or null on failure
 */
export async function persistJiraTicketToSession(sessionKey, issue) {
  const key = String(sessionKey || '').trim();
  const issueKey = String(issue?.key || issue?.issueKey || '').replace(/^:/, '').trim();
  if (!key || !issueKey) return null;
  try {
    const res = await fetch(
      `/adapters/atlassian/sessions/${encodeURIComponent(key)}/ticket`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ issue: { ...(issue || {}), key: issueKey } }),
      },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.ok) return buildJiraIssueAttachment({ ...(issue || {}), key: issueKey });
    return buildJiraIssueAttachment(body.issue || { ...(issue || {}), key: issueKey });
  } catch {
    return buildJiraIssueAttachment({ ...(issue || {}), key: issueKey });
  }
}

/**
 * Load a persisted ticket.json as a composer jira attachment chip.
 * @param {string} sessionKey
 * @returns {Promise<object|null>}
 */
export async function loadSessionJiraAttachment(sessionKey) {
  const key = String(sessionKey || '').trim();
  if (!key) return null;
  try {
    const res = await fetch(
      `/adapters/atlassian/sessions/${encodeURIComponent(key)}/ticket`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    if (!body?.issue?.key) return null;
    return buildJiraIssueAttachment(body.issue);
  } catch {
    return null;
  }
}

/**
 * True when a user message already carried this Jira chip — ticket.json may
 * still exist for tools/workflows, but the composer tray must not resurrect it.
 * @param {object[]|null|undefined} messages
 * @param {string} issueKey
 */
export function sessionMessagesHaveJiraTicket(messages, issueKey) {
  const key = String(issueKey || '').replace(/^:/, '').trim();
  if (!key) return false;
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (msg?.role !== 'user' || !Array.isArray(msg.attachments)) continue;
    for (const row of msg.attachments) {
      const rowKey = String(row?.issueKey || row?.name || '').replace(/^:/, '').trim();
      if (rowKey && rowKey === key) return true;
    }
  }
  return false;
}
