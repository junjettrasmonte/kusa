/**
 * HTTP surface for `/adapters/atlassian/*`.
 *
 * Settings writes go through monitor settings so the API token is encrypted
 * with the user-home master key (same path as agent API keys).
 */
// Relative on purpose: this folder has its own package.json (workspace), so
// Node will not apply the repo-root `#features/*` import map here.
import { loadMonitorSettings, saveMonitorSettings } from '../../src/features/monitor/lib.mjs';
import {
  addComment,
  getIssue,
  listAssignedIssues,
  listComments,
  listLabels,
  listProjectMembers,
  listProjects,
  listProjectSprints,
  listProjectStatuses,
  listSprintIssues,
  listTransitions,
  probeAtlassian,
  transitionIssue,
  updateIssue,
} from './client.mjs';
import {
  mergeAtlassianSettingsPatch,
  normalizeAtlassianSettings,
  publicAtlassianSettings,
} from './settings.mjs';
import { readSessionTicket, writeSessionTicket } from './tools.mjs';

function statusFromError(err) {
  if (err?.code === 'ECONFIG' || err?.code === 'EVALIDATION') return 400;
  const status = Number(err?.status || err?.response?.status || 0);
  if (status >= 400 && status < 600) return status;
  return 500;
}

function errorBody(err) {
  const nested = err?.response?.data;
  const nestedMsg = typeof nested === 'string'
    ? nested
    : (nested?.errorMessages?.[0] || nested?.message || nested?.error);
  return {
    ok: false,
    error: nestedMsg || err?.message || String(err),
    code: err?.code || undefined,
  };
}

/**
 * @param {{
 *   parts: string[],
 *   method: string,
 *   dataDir: string,
 *   query?: URLSearchParams,
 *   readBody: () => Promise<string>,
 * }} opts
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleAtlassianHttp({
  parts = [],
  method = 'GET',
  dataDir,
  query = new URLSearchParams(),
  readBody,
}) {
  const verb = String(method || 'GET').toUpperCase();
  const section = parts[0] || '';
  const settings = loadMonitorSettings(dataDir);
  const atlassian = normalizeAtlassianSettings(settings.atlassian);

  try {
    // GET /adapters/atlassian — connection probe
    if (!section && (verb === 'GET' || verb === 'HEAD')) {
      const pub = publicAtlassianSettings(atlassian);
      if (!pub.configured) {
        return {
          status: 200,
          body: { ok: false, configured: false, error: 'Configure host, email, and API token first' },
        };
      }
      const probe = await probeAtlassian(atlassian);
      return { status: probe.ok ? 200 : 502, body: { ...probe, ...pub } };
    }

    // GET|PUT /adapters/atlassian/settings
    if (section === 'settings') {
      if (verb === 'GET' || verb === 'HEAD') {
        return { status: 200, body: publicAtlassianSettings(atlassian) };
      }
      if (verb === 'PUT') {
        let body = {};
        try {
          const raw = await readBody();
          body = raw.trim() ? JSON.parse(raw) : {};
        } catch (err) {
          return {
            status: err?.code === 'ELARGE' ? 413 : 400,
            body: { error: 'invalid json body' },
          };
        }
        const next = mergeAtlassianSettingsPatch(atlassian, body);
        const saved = saveMonitorSettings(dataDir, { atlassian: next });
        return {
          status: 200,
          body: publicAtlassianSettings(saved.atlassian),
        };
      }
      return { status: 405, body: { error: 'method not allowed' } };
    }

    // GET /adapters/atlassian/projects — projects visible to the user
    if (section === 'projects' && (verb === 'GET' || verb === 'HEAD')) {
      if (!publicAtlassianSettings(atlassian).configured) {
        return {
          status: 400,
          body: { ok: false, error: 'Configure Atlassian credentials first', code: 'ECONFIG' },
        };
      }
      const listed = await listProjects(atlassian, {
        maxResults: Number(query.get('maxResults') || 50),
      });
      return { status: 200, body: listed };
    }

    // GET /adapters/atlassian/members?project=KEY — discover assignable project people
    if (section === 'members' && (verb === 'GET' || verb === 'HEAD')) {
      if (!publicAtlassianSettings(atlassian).configured) {
        return {
          status: 400,
          body: { ok: false, error: 'Configure Atlassian credentials first', code: 'ECONFIG' },
        };
      }
      const projectKey = query.get('project') || atlassian.projectKey;
      const maxResults = Number(query.get('maxResults') || 100);
      const listed = await listProjectMembers(atlassian, { projectKey, maxResults });
      return { status: 200, body: listed };
    }

    // GET /adapters/atlassian/statuses?project=KEY — project workflow statuses
    if (section === 'statuses' && (verb === 'GET' || verb === 'HEAD')) {
      if (!publicAtlassianSettings(atlassian).configured) {
        return {
          status: 400,
          body: { ok: false, error: 'Configure Atlassian credentials first', code: 'ECONFIG' },
        };
      }
      const projectKey = query.get('project') || atlassian.projectKey;
      const listed = await listProjectStatuses(atlassian, { projectKey });
      return { status: 200, body: listed };
    }

    // GET /adapters/atlassian/labels — site labels from Jira
    if (section === 'labels' && (verb === 'GET' || verb === 'HEAD')) {
      if (!publicAtlassianSettings(atlassian).configured) {
        return {
          status: 400,
          body: { ok: false, error: 'Configure Atlassian credentials first', code: 'ECONFIG' },
        };
      }
      const listed = await listLabels(atlassian, {
        maxResults: Number(query.get('maxResults') || 200),
        startAt: Number(query.get('startAt') || 0),
      });
      return { status: 200, body: listed };
    }

    // GET /adapters/atlassian/sprints?project=KEY
    // GET /adapters/atlassian/sprints/:id/issues?boardId=
    if (section === 'sprints') {
      if (!publicAtlassianSettings(atlassian).configured) {
        return {
          status: 400,
          body: { ok: false, error: 'Configure Atlassian credentials first', code: 'ECONFIG' },
        };
      }
      const sprintId = parts[1] ? decodeURIComponent(parts[1]) : '';
      const sub = parts[2] || '';

      if (!sprintId && (verb === 'GET' || verb === 'HEAD')) {
        const projectKey = query.get('project') || atlassian.projectKey;
        const listed = await listProjectSprints(atlassian, {
          projectKey,
          includeClosed: query.get('includeClosed') !== '0',
          maxResults: Number(query.get('maxResults') || 50),
        });
        return { status: 200, body: listed };
      }

      if (sprintId && sub === 'issues' && (verb === 'GET' || verb === 'HEAD')) {
        const listed = await listSprintIssues(atlassian, {
          sprintId,
          boardId: query.get('boardId'),
          maxResults: Number(query.get('maxResults') || 100),
        });
        return { status: 200, body: listed };
      }

      return {
        status: sprintId ? 404 : 405,
        body: { error: sprintId ? 'not found' : 'method not allowed' },
      };
    }

    // Session ticket sidecar — attachments/ticket.json for Attach to Chat / Ticket First.
    // GET|PUT /adapters/atlassian/sessions/:sessionKey/ticket
    if (section === 'sessions') {
      const sessionKey = parts[1] ? decodeURIComponent(parts[1]) : '';
      const sub = parts[2] || '';
      if (!sessionKey || sub !== 'ticket') {
        return { status: 404, body: { error: 'not found' } };
      }
      if (verb === 'GET' || verb === 'HEAD') {
        const issue = readSessionTicket(dataDir, sessionKey);
        if (!issue) {
          return { status: 404, body: { ok: false, error: 'no ticket on this session' } };
        }
        return { status: 200, body: { ok: true, issue } };
      }
      if (verb === 'PUT' || verb === 'POST') {
        let body = {};
        try {
          const raw = await readBody();
          body = raw.trim() ? JSON.parse(raw) : {};
        } catch {
          return { status: 400, body: { error: 'invalid json body' } };
        }
        let issue = body.issue && typeof body.issue === 'object' ? body.issue : null;
        const issueKey = String(
          issue?.key || body.issueKey || body.key || '',
        ).replace(/^:/, '').trim();
        if (!issueKey) {
          return { status: 400, body: { ok: false, error: 'issue.key is required', code: 'EVALIDATION' } };
        }
        // Prefer a live fetch so ticket.json has full detail, not just the board card.
        if (publicAtlassianSettings(atlassian).configured) {
          try {
            const fetched = await getIssue(atlassian, issueKey);
            if (fetched?.issue) {
              issue = { ...(issue || {}), ...fetched.issue, key: issueKey };
            }
          } catch {
            /* keep the caller-supplied stub */
          }
        }
        const saved = writeSessionTicket(dataDir, sessionKey, {
          ...(issue || {}),
          key: issueKey,
        });
        if (!saved.ok) {
          return { status: 400, body: saved };
        }
        return { status: 200, body: saved };
      }
      return { status: 405, body: { error: 'method not allowed' } };
    }

    // Issues
    if (section === 'issues') {
      const issueKey = parts[1] ? decodeURIComponent(parts[1]) : '';
      const sub = parts[2] || '';

      // GET /adapters/atlassian/issues?project=KEY&assignees=me|all|id1,id2
      if (!issueKey && (verb === 'GET' || verb === 'HEAD')) {
        if (!publicAtlassianSettings(atlassian).configured) {
          return {
            status: 400,
            body: { ok: false, error: 'Configure Atlassian credentials first', code: 'ECONFIG' },
          };
        }
        const projectKey = query.get('project') || atlassian.projectKey;
        const maxResults = Number(query.get('maxResults') || 50);
        const rawAssignees = String(query.get('assignees') || 'me').trim();
        let assignees = /** @type {'me' | 'all' | string[]} */ ('me');
        if (rawAssignees === 'all') assignees = 'all';
        else if (rawAssignees && rawAssignees !== 'me') {
          assignees = rawAssignees.split(',').map((id) => id.trim()).filter(Boolean);
        }
        const listed = await listAssignedIssues(atlassian, { projectKey, maxResults, assignees });
        return { status: 200, body: listed };
      }

      if (!issueKey) {
        return { status: 405, body: { error: 'method not allowed' } };
      }

      // GET /adapters/atlassian/issues/:key
      if (!sub && (verb === 'GET' || verb === 'HEAD')) {
        const detail = await getIssue(atlassian, issueKey);
        return { status: 200, body: detail };
      }

      // PUT /adapters/atlassian/issues/:key — patch summary/description/duedate/assignee/labels
      if (!sub && verb === 'PUT') {
        let body = {};
        try {
          const raw = await readBody();
          body = raw.trim() ? JSON.parse(raw) : {};
        } catch {
          return { status: 400, body: { error: 'invalid json body' } };
        }
        const result = await updateIssue(atlassian, issueKey, body);
        return { status: 200, body: result };
      }

      // GET /adapters/atlassian/issues/:key/transitions
      if (sub === 'transitions' && (verb === 'GET' || verb === 'HEAD')) {
        return { status: 200, body: await listTransitions(atlassian, issueKey) };
      }

      // POST /adapters/atlassian/issues/:key/transition
      if (sub === 'transition' && verb === 'POST') {
        let body = {};
        try {
          const raw = await readBody();
          body = raw.trim() ? JSON.parse(raw) : {};
        } catch {
          return { status: 400, body: { error: 'invalid json body' } };
        }
        const transitionId = body.transitionId || body.id || body.transition?.id;
        const result = await transitionIssue(atlassian, issueKey, transitionId);
        return { status: 200, body: result };
      }

      // GET|POST /adapters/atlassian/issues/:key/comments
      if (sub === 'comments') {
        if (verb === 'GET' || verb === 'HEAD') {
          return { status: 200, body: await listComments(atlassian, issueKey) };
        }
        if (verb === 'POST') {
          let body = {};
          try {
            const raw = await readBody();
            body = raw.trim() ? JSON.parse(raw) : {};
          } catch {
            return { status: 400, body: { error: 'invalid json body' } };
          }
          const text = body.body ?? body.text ?? body.comment ?? '';
          const result = await addComment(atlassian, issueKey, text);
          return { status: 200, body: result };
        }
        return { status: 405, body: { error: 'method not allowed' } };
      }

      return { status: 404, body: { error: 'not found' } };
    }

    return { status: section ? 404 : 405, body: { error: section ? 'not found' : 'method not allowed' } };
  } catch (err) {
    return { status: statusFromError(err), body: errorBody(err) };
  }
}
