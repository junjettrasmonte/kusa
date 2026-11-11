/**
 * Atlassian / Jira agent tools — discovered from this extension's tools.mjs and
 * merged into the Kusă toolset. Session ticket writes go to
 * `.kusa/agents/<id>/attachments/ticket.json` (not the working copy).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// Relative on purpose: this folder has its own package.json (workspace), so
// Node will not apply the repo-root `#features/*` import map here.
import { loadMonitorSettings } from '../../src/features/monitor/lib.mjs';
import { sessionAttachmentsDir } from '../../src/features/chat/data/attachments.mjs';
import { getIssue } from './client.mjs';
import { normalizeAtlassianSettings, publicAtlassianSettings } from './settings.mjs';

export const TOOL_GROUP = 'jira';

export const SESSION_TICKET_FILE = 'ticket.json';

/**
 * Persist a Jira issue into `.kusa/agents/<id>/attachments/ticket.json`.
 * Shared by the agent tool and the Attach-to-Chat HTTP path.
 * @param {string} dataDir
 * @param {string} sessionKey
 * @param {object} issue
 */
export function writeSessionTicket(dataDir, sessionKey, issue) {
  const dir = String(dataDir || '').trim();
  if (!dir) {
    return { ok: false, error: 'no data dir', code: 'ENOENT' };
  }
  const key = String(sessionKey || '').trim();
  const sessionId = agentIdFromSessionKey(key);
  if (!sessionId) {
    return { ok: false, error: 'no session to attach ticket to', code: 'EINVAL' };
  }
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
    return { ok: false, error: 'issue object is required', code: 'EINVAL' };
  }
  const issueKey = String(issue.key || '').replace(/^:/, '').trim();
  if (!issueKey) {
    return { ok: false, error: 'issue.key is required', code: 'EINVAL' };
  }

  const harness = harnessFromSessionKey(key);
  const folder = sessionAttachmentsDir(dir, sessionId, harness);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, SESSION_TICKET_FILE);
  const payload = {
    ...issue,
    key: issueKey,
    savedAt: Date.now(),
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return {
    ok: true,
    path,
    file: SESSION_TICKET_FILE,
    issueKey,
    sessionId,
    issue: payload,
  };
}

/**
 * Read attachments/ticket.json for a session, or null when absent.
 * @param {string} dataDir
 * @param {string} sessionKey
 */
export function readSessionTicket(dataDir, sessionKey) {
  const dir = String(dataDir || '').trim();
  const key = String(sessionKey || '').trim();
  const sessionId = agentIdFromSessionKey(key);
  if (!dir || !sessionId) return null;
  const harness = harnessFromSessionKey(key);
  const path = join(sessionAttachmentsDir(dir, sessionId, harness), SESSION_TICKET_FILE);
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const issueKey = String(raw.key || '').replace(/^:/, '').trim();
    if (!issueKey) return null;
    return { ...raw, key: issueKey };
  } catch {
    return null;
  }
}

export const JIRA_TOOL_DEFS = [
  {
    name: 'kusa_jira_get_issue',
    description:
      'Fetch a Jira Cloud issue by key (e.g. ENG-123) using the configured Atlassian '
      + 'Adapter credentials. Returns the issue summary, description, status, and '
      + 'other detail fields. Does not write anything — pair with '
      + 'kusa_jira_save_session_ticket to store it on this session.',
    parameters: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description: 'Jira issue key (e.g. ENG-123)',
        },
      },
      required: ['issueKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_jira_save_session_ticket',
    description:
      'Write a Jira issue object into this session’s attachments/ticket.json '
      + '(overwrite). Pass the issue object returned by kusa_jira_get_issue '
      + '(or an equivalent { key, summary, … } shape). Use this for Ticket First '
      + 'ingest so later turns can read the ticket from the session folder.',
    parameters: {
      type: 'object',
      properties: {
        issue: {
          type: 'object',
          description: 'Issue payload to persist (must include at least key)',
        },
      },
      required: ['issue'],
      additionalProperties: false,
    },
  },
];

function agentIdFromSessionKey(sessionKey) {
  const key = String(sessionKey || '');
  const i = key.indexOf(':');
  return i >= 0 ? key.slice(i + 1) : key;
}

function harnessFromSessionKey(sessionKey) {
  const key = String(sessionKey || '');
  const i = key.indexOf(':');
  return i >= 0 ? key.slice(0, i) : 'kusa';
}

/**
 * @param {{ dataDir?: string, sessionKey?: string }} [ctx]
 */
export function createTools({ dataDir = '', sessionKey = '' } = {}) {
  const dir = String(dataDir || '').trim();
  const key = String(sessionKey || '').trim();

  async function getIssueTool(args = {}) {
    if (!dir) {
      return { ok: false, error: 'no data dir', code: 'ENOENT' };
    }
    const issueKey = String(args.issueKey || '').trim();
    if (!issueKey) {
      return { ok: false, error: 'issueKey is required', code: 'EINVAL' };
    }
    const settings = loadMonitorSettings(dir);
    const atlassian = normalizeAtlassianSettings(settings.atlassian);
    const pub = publicAtlassianSettings(atlassian);
    if (!pub.configured) {
      return {
        ok: false,
        error: 'Configure Atlassian host, email, and API token first (Extensions → Atlassian Adapter)',
        code: 'ECONFIG',
      };
    }
    try {
      return await getIssue(atlassian, issueKey);
    } catch (err) {
      return {
        ok: false,
        error: err?.message || String(err),
        code: err?.code || 'EJIRA',
      };
    }
  }

  function saveSessionTicket(args = {}) {
    return writeSessionTicket(dir, key, args.issue);
  }

  async function call(name, args = {}, _callId = null) {
    switch (String(name || '')) {
      case 'kusa_jira_get_issue':
        return getIssueTool(args);
      case 'kusa_jira_save_session_ticket':
        return saveSessionTicket(args);
      default:
        return { ok: false, error: `unknown jira tool: ${name}`, code: 'ENOENT' };
    }
  }

  return {
    defs: JIRA_TOOL_DEFS,
    call,
    getIssue: getIssueTool,
    saveSessionTicket,
  };
}
