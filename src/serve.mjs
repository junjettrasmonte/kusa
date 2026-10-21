#!/usr/bin/env node
/**
 * Serve the Agentic Development Console over localhost.
 *
 *   kusa serve                           -> http://localhost:1424/dashboard.html
 *   kusa serve --port 4000               -> explicit port
 *   kusa serve -p 4000                   -> same
 *   KUSA_PORT=4000 kusa serve             -> port when --port is omitted
 *
 * Routes:
 *   /                 redirect to /dashboard.html
 *   /dashboard.html   the React shell in this package
 *   /dashboard.css    prebuilt Tailwind stylesheet
 *   /dashboard.js     prebuilt React bundle
 *   /favicon.svg      Kusă mark (SVG favicon)
 *   /monitor-data.js  <workspace>/.kusa/monitor-data.js
 *   /index.json, /dashboard.md                  same folder, read-only
 *   /sessions/<harness>/<session>.json          one session's record
 *   /sessions/<harness>/<session>.events.jsonl  that session's recent events
 *   DELETE /sessions  JSON body { "keys": ["harness:id", ...] } — remove sessions
 *   GET/POST /settings  read/update SDK listener + Kusă agent settings (settings.json)
 *   POST /kusa/chat   Kusă harness prompt (JSON or SSE stream=1 / Accept: text/event-stream)
 *   GET  /kusa/chat/live?queueKey=  re-attach SSE to a running turn (survives refresh)
 *   POST /kusa/chat/options  mid-turn Mode / Rules update (takes effect on the next step)
 *   GET/POST /kusa/queue  composer held/steering prompts (persisted in kusa/queues.json)
 *   GET /kusa/sessions          list Kusă chat transcripts (.kusa/kusa/*.chat.json)
 *                                 (busy sessions include in-memory `live` while a turn runs)
 *   POST /kusa/sessions         create an empty Kusă chat (+ monitor lane)
 *   PUT /kusa/sessions          upsert one `{ session }` or many `{ sessions }`
 *   POST /kusa/sessions/migrate import legacy browser-local chats
 *   GET /kusa/tools   the tool set the Kusă agent advertises for a chat session
 *   GET /kusa/models  models the configured endpoint advertises (for the picker)
 *   GET /git          live working-copy status (git status for the workspace)
 *   GET /trail        live Trail CLI + .trail/cache readiness
 *   GET /ready        combined git + trail readiness (dashboard load check)
 *   GET/POST /skills  list / create skills (canonical store under .kusa/skills)
 *   GET/PUT/DELETE /skills/:id  read / update / delete
 *   POST /skills/:id/duplicate|publish|restore|import-destination
 *   GET /skills/:id/export|/compare
 *   GET /skills/agents  detected agents + destinations
 *   POST /skills/import  import SKILL.md (+ resources) payload
 *   GET/POST /mcp     Kusă MCP console status (enable, auth)
 *   GET/POST /mcp/tools  list / create custom tools; GET/PUT/DELETE /mcp/tools/:id
 *   POST /mcp/<workspace-slug>/rpc  Localhost MCP protocol for this project (when enabled)
 *   GET/POST /learnings  Trail learnings (list / add)
 *
 * Binds 127.0.0.1 only. No dependencies. Everything is served with no-cache
 * headers so the page's 1 s poll always sees the latest hook write.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  agentToolGroups,
  approvalModeLabel,
  APPROVAL_GATED_TOOLS,
  createKusaHookEmitter,
  listAgentModels,
  normalizeAgentMode,
  normalizeApprovalMode,
  resolveTrailPolicy,
  runKusaAgent,
  trailNotReadyMessage,
} from './agent/index.mjs';
import {
  createChatSession,
  listChatSessions,
  migrateChatSessions,
  readChatSession,
  saveChatSessions,
} from './chat-store.mjs';
import {
  broadcastTurn,
  createTurnJob,
  ingestTurnEvent,
  persistTurnCompletion,
  persistTurnPrompt,
  sessionsWithActiveTurns,
  subscribeTurn,
} from './chat-turn.mjs';
import { loadQueues, saveQueues, WORKSPACE_QUEUE_KEY } from './queue-store.mjs';
import {
  collectGitStatus,
  collectTrailStatus,
  collectWorkspaceReady,
  defaultMonitorDir,
  defaultWorkspaceRoot,
  deleteSessions,
  laneKey,
  loadMonitorSettings,
  publicSettings,
  refreshMonitorArtifacts,
  saveMonitorSettings,
  updateSdkListenerStatus,
} from './lib.mjs';
import {
  compareSkillPublications,
  createSkill,
  deleteSkill,
  detectAgentCapabilities,
  duplicateSkill,
  ensureSkillsInitialized,
  exportSkillFiles,
  importFromDestination,
  importSkillFromFiles,
  listSkills,
  publishSkill,
  readSkill,
  restoreStarterSkill,
  updateSkill,
  validateSkillMarkdown,
} from './skills/index.mjs';
import {
  addLearning,
  createCustomTool,
  deleteCustomTool,
  generateAuthToken,
  getMcpStatus,
  handleMcpRpcRequest,
  isBuiltinToolName,
  listAllTools,
  listLearnings,
  loadMcpState,
  mcpEndpointUrl,
  readCustomTool,
  saveMcpState,
  setCustomToolEnabled,
  setMcpEnabled,
  syncCursorMcpRegistration,
  updateCustomTool,
} from './mcp/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = defaultWorkspaceRoot();

function readBody(req, limit = 64_000) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { code: 'ELARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function skillErrorStatus(err) {
  if (!err) return 500;
  if (err.code === 'ENOENT') return 404;
  if (err.code === 'EEXIST') return 409;
  if (err.code === 'EINVAL' || err.code === 'EPATH' || err.code === 'ECONFIRM') return 400;
  return 500;
}

function publicSkill(record) {
  if (!record) return record;
  const { _resourcesFull, ...rest } = record;
  return {
    ...rest,
    resources: (record.resources || []).map((r) => ({
      rel: r.rel,
      size: r.size,
      hash: r.hash,
    })),
    resourceFiles: (_resourcesFull || []).map((r) => ({
      rel: r.rel,
      size: r.size,
      hash: r.hash,
      contentBase64: r.contentBase64,
    })),
  };
}

export function createMonitorServer({
  dataDir = defaultMonitorDir(repoRoot),
  pageDir = here,
  workspaceRoot = repoRoot,
  /** Bound listen port for localhost MCP URL registration (updated after listen). */
  mcpPort = 1424,
} = {}) {
  let boundMcpPort = Number(mcpPort) || 1424;
  // Pending user approvals for gated tools (kusa_terminal / kusa_browse).
  // The agent request stays open until POST /kusa/approval resolves the id.
  // There is NO timer here: the approval gate owns the one deadline (it races
  // this promise against the rule's default and ships timeoutMs/timeoutStartsAt
  // on the request), so the UI countdown, this resolver, and the settled verdict
  // can never disagree about when an ask expires or what happens then.
  /** @type {Map<string, { decide: (decision) => void }>} */
  const pendingApprovals = new Map();
  // Approvals belonging to a running turn (keyed by the composer's queueKey),
  // so Stop can settle only that turn's asks and not disturb another session.
  /** @type {Map<string, Set<string>>} */
  const approvalsByQueueKey = new Map();

  const waitForApproval = (ask, queueKey = '') => new Promise((settleDecision) => {
    // Only a human decision settles this. The gate applies the rule default if
    // nobody answers, then clears the pending row through the same handle.
    const decide = (decision) => {
      pendingApprovals.delete(ask?.id);
      if (queueKey) {
        const set = approvalsByQueueKey.get(queueKey);
        if (set) {
          set.delete(ask?.id);
          if (!set.size) approvalsByQueueKey.delete(queueKey);
        }
      }
      settleDecision(decision);
    };
    pendingApprovals.set(ask.id, { decide });
    if (queueKey) {
      let set = approvalsByQueueKey.get(queueKey);
      if (!set) {
        set = new Set();
        approvalsByQueueKey.set(queueKey, set);
      }
      set.add(ask.id);
    }
  });

  // Questions the model asked mid-turn (kusa_ask). Same shape as the approval
  // gate: the agent request stays open until POST /kusa/ask answers the id,
  // and the gate owns the one deadline (it races this promise against its
  // timeout), so the UI countdown and the settled verdict cannot disagree.
  // Unlike an approval there is no rule default — nobody answering refuses the
  // ask, it never picks an option for the model.
  /** @type {Map<string, { answer: (answer) => void }}> */
  const pendingAsks = new Map();
  /** @type {Map<string, Set<string>>} */
  const asksByQueueKey = new Map();

  const waitForAsk = (ask, queueKey = '') => new Promise((settleAnswer) => {
    const answer = (patch) => {
      pendingAsks.delete(ask?.id);
      if (queueKey) {
        const set = asksByQueueKey.get(queueKey);
        if (set) {
          set.delete(ask?.id);
          if (!set.size) asksByQueueKey.delete(queueKey);
        }
      }
      settleAnswer(patch);
    };
    pendingAsks.set(ask.id, { answer });
    if (queueKey) {
      let set = asksByQueueKey.get(queueKey);
      if (!set) {
        set = new Set();
        asksByQueueKey.set(queueKey, set);
      }
      set.add(ask.id);
    }
  });

  // Composer message queue (Cursor/Copilot style). While a turn is running for a
  // session, a new prompt is NOT a second turn — it is held here under the
  // client's queueKey. The server owns both lists so the UI and the running turn
  // can never disagree about what is pending:
  //   held     — per-session. Shown in that chat; when the turn ends the client
  //              flushes them in order as follow-up turns (action=take).
  //   parked   — workspace-shared (WORKSPACE_QUEUE_KEY). Any session can resume
  //              or send them; flush skips them until resumed onto a session.
  //   steering — "send now". Per-session; the running loop drains these at its
  //              next step boundary (onSteer below).
  // Hydrated from `.kusa/kusa/queues.json` so a serve restart keeps queues
  // (steering folds into that session's held on cold load).
  const { queued: queuedMessages, steering: steeringMessages } = loadQueues(dataDir);
  const persistQueues = () => {
    try {
      saveQueues(dataDir, queuedMessages, steeringMessages);
    } catch {
      /* disk must not break queue mutations */
    }
  };
  // Rehydrate per-session Task Lists from kusa/tasks.json into monitor-data
  // so each chat's tasks survive a serve bounce.
  try {
    refreshMonitorArtifacts(dataDir);
  } catch {
    /* best-effort — hooks will rewrite on the next event */
  }
  const sessionHeld = (queueKey) => queuedMessages.get(queueKey) || [];
  const setSessionHeld = (queueKey, list) => {
    if (!list?.length) queuedMessages.delete(queueKey);
    else queuedMessages.set(queueKey, list);
  };
  const parkedList = () => queuedMessages.get(WORKSPACE_QUEUE_KEY) || [];
  const setParkedList = (list) => {
    if (!list?.length) queuedMessages.delete(WORKSPACE_QUEUE_KEY);
    else queuedMessages.set(WORKSPACE_QUEUE_KEY, list);
  };
  // Snapshot order: session-bound held first, then cross-session parked.
  const visibleQueued = (queueKey) => [...sessionHeld(queueKey), ...parkedList()];

  const queueSnapshot = (queueKey) => ({
    queueKey,
    queued: visibleQueued(queueKey),
    steering: steeringMessages.get(queueKey) || [],
  });
  const queueTake = (map, key, id) => {
    const list = map.get(key);
    if (!Array.isArray(list)) return false;
    const idx = list.findIndex((entry) => entry?.id === id);
    if (idx < 0) return false;
    const [entry] = list.splice(idx, 1);
    if (!list.length) map.delete(key);
    return entry;
  };
  // Claim from this session's held first, then the workspace parked list.
  const takeQueued = (queueKey, id) => (
    queueTake(queuedMessages, queueKey, id)
    || queueTake(queuedMessages, WORKSPACE_QUEUE_KEY, id)
  );
  // The running turn's drain: "send now" messages go to the model at the next
  // step boundary (the agent loop calls this once per step), never twice.
  const drainSteering = (key) => {
    const list = steeringMessages.get(key);
    if (!list?.length) return [];
    steeringMessages.delete(key);
    persistQueues();
    return list.map((entry) => entry?.text || '').filter(Boolean);
  };

  // Composer Stop button. A running turn registers its AbortController here, so
  // POST /kusa/stop can end the current prompt instead of waiting for it to
  // finish. The loop checks signal.aborted at every step boundary and cancels
  // the response reader mid-stream, so a stop takes effect at the next safe
  // point rather than killing the process. stopRequested tells the chat handler
  // that the abort was asked for by the user — a clean `stopped` event, not an
  // error — and the queue snapshot it returns lets the client send the next
  // held prompt immediately (Cursor/Copilot "Stop then continue").
  /** @type {Map<string, AbortController>} */
  const activeTurns = new Map();
  /** @type {Map<string, number>} */
  const stopRequested = new Map();
  // Live turn jobs outlive any single SSE response: a page refresh unsubscribes
  // the old stream but the agent keeps running. GET /kusa/chat/live reattaches,
  // and GET /kusa/sessions overlays busy + live from this map.
  /** @type {Map<string, ReturnType<typeof createTurnJob>>} */
  const turnJobs = new Map();
  // Keep a finished job briefly so a refresh that lands right after `done` can
  // still receive the terminal frame before reading the chat sidecar.
  const TURN_JOB_GRACE_MS = 120_000;

  const pipeSse = (res, req, jobKey) => {
    const job = turnJobs.get(jobKey);
    if (!job) return false;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (type, data) => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        // Terminal frames end this listener's stream; the turn job may outlive it.
        if (type === 'done' || type === 'stopped' || type === 'error') {
          try { res.end(); } catch { /* ignore */ }
        }
      } catch {
        /* client gone */
      }
    };
    const unsubscribe = subscribeTurn(job, write);
    const onClose = () => {
      unsubscribe();
      // Do NOT abort the turn — only this listener is gone.
      if (!res.writableEnded) {
        try { res.end(); } catch { /* ignore */ }
      }
    };
    req.on('close', onClose);
    res.on('close', onClose);
    return true;
  };

  const finishTurnJob = (queueKey, terminal) => {
    const job = turnJobs.get(queueKey);
    if (!job) return;
    job.terminal = terminal;
    try {
      persistTurnCompletion(dataDir, job, terminal);
    } catch {
      // Persistence must not strand listeners without a terminal event.
    }
    broadcastTurn(job, terminal.type || 'done', terminal);
    activeTurns.delete(queueKey);
    stopRequested.delete(queueKey);
    setTimeout(() => {
      if (turnJobs.get(queueKey) === job) turnJobs.delete(queueKey);
    }, TURN_JOB_GRACE_MS);
  };

  const routes = {
    '/dashboard.html': { file: join(pageDir, 'dashboard.html'), type: 'text/html; charset=utf-8' },
    '/dashboard.css': { file: join(pageDir, 'dashboard.css'), type: 'text/css; charset=utf-8' },
    '/dashboard.js': { file: join(pageDir, 'dashboard.js'), type: 'text/javascript; charset=utf-8' },
    '/favicon.svg': { file: join(pageDir, 'favicon.svg'), type: 'image/svg+xml' },
    '/monitor-data.js': { file: join(dataDir, 'monitor-data.js'), type: 'text/javascript; charset=utf-8' },
    '/index.json': { file: join(dataDir, 'index.json'), type: 'application/json; charset=utf-8' },
    '/dashboard.md': { file: join(dataDir, 'dashboard.md'), type: 'text/markdown; charset=utf-8' },
  };
  // /sessions/<harness>/<file>: both segments must be plain names (no dots-only, no
  // separators), and the file must be a session record or its event log.
  const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
  const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const sessionRoute = (pathname) => {
    const parts = pathname.split('/');
    if (parts.length !== 4 || parts[1] !== 'sessions') return null;
    const [, , harness, file] = parts;
    if (!SEGMENT.test(harness) || !SEGMENT.test(file) || harness.includes('..') || file.includes('..')) return null;
    if (file.endsWith('.events.jsonl')) return { file: join(dataDir, harness, file), type: 'application/x-ndjson; charset=utf-8' };
    if (file.endsWith('.json')) return { file: join(dataDir, harness, file), type: 'application/json; charset=utf-8', harness, stem: file.slice(0, -'.json'.length) };
    return null;
  };

  const skillRoute = (pathname) => {
    const parts = pathname.split('/').filter(Boolean);
    if (parts[0] !== 'skills') return null;
    if (parts.length === 1) return { kind: 'collection' };
    if (parts.length === 2 && parts[1] === 'agents') return { kind: 'agents' };
    if (parts.length === 2 && parts[1] === 'import') return { kind: 'import' };
    if (parts.length === 2 && parts[1] === 'validate') return { kind: 'validate' };
    if (parts.length === 2 && SKILL_ID.test(parts[1])) return { kind: 'item', id: parts[1] };
    if (parts.length === 3 && SKILL_ID.test(parts[1])) {
      const action = parts[2];
      if (['duplicate', 'publish', 'restore', 'export', 'compare', 'import-destination'].includes(action)) {
        return { kind: 'action', id: parts[1], action };
      }
    }
    return null;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Localhost MCP protocol endpoint (Streamable HTTP JSON-RPC).
    if (await handleMcpRpcRequest(req, res, {
      url,
      dataDir,
      workspaceRoot,
      readBody,
      enabled: loadMcpState(dataDir).enabled,
    })) {
      return;
    }

    // Skills API (canonical store in dataDir/skills; publish into workspaceRoot).
    const skillsPath = skillRoute(url.pathname);
    if (skillsPath) {
      try {
        ensureSkillsInitialized(dataDir);
      } catch (err) {
        sendJson(res, 500, { error: err?.message || 'skills init failed' });
        return;
      }

      if (skillsPath.kind === 'agents' && (req.method === 'GET' || req.method === 'HEAD')) {
        sendJson(res, 200, { agents: detectAgentCapabilities(workspaceRoot) });
        return;
      }

      if (skillsPath.kind === 'collection' && (req.method === 'GET' || req.method === 'HEAD')) {
        sendJson(res, 200, {
          ...listSkills(dataDir),
          agents: detectAgentCapabilities(workspaceRoot),
        });
        return;
      }

      if (skillsPath.kind === 'collection' && req.method === 'POST') {
        let body = {};
        try {
          const raw = await readBody(req, 2_000_000);
          body = raw.trim() ? JSON.parse(raw) : {};
        } catch (err) {
          sendJson(res, err?.code === 'ELARGE' ? 413 : 400, { error: err?.code === 'ELARGE' ? 'body too large' : 'invalid json body' });
          return;
        }
        try {
          const created = createSkill(dataDir, body);
          sendJson(res, 201, publicSkill(created));
        } catch (err) {
          sendJson(res, skillErrorStatus(err), { error: err.message, validation: err.validation || null });
        }
        return;
      }

      if (skillsPath.kind === 'validate' && req.method === 'POST') {
        let body = {};
        try {
          const raw = await readBody(req, 2_000_000);
          body = raw.trim() ? JSON.parse(raw) : {};
        } catch {
          sendJson(res, 400, { error: 'invalid json body' });
          return;
        }
        const existing = listSkills(dataDir).skills.map((s) => s.name);
        sendJson(res, 200, validateSkillMarkdown(String(body.skillMd || ''), {
          directoryName: body.directoryName || null,
          existingNames: existing.filter((n) => n !== body.ignoreName),
        }));
        return;
      }

      if (skillsPath.kind === 'import' && req.method === 'POST') {
        let body = {};
        try {
          const raw = await readBody(req, 4_000_000);
          body = raw.trim() ? JSON.parse(raw) : {};
        } catch (err) {
          sendJson(res, err?.code === 'ELARGE' ? 413 : 400, { error: 'invalid json body' });
          return;
        }
        try {
          const imported = importSkillFromFiles(dataDir, body.files || [], { overwrite: Boolean(body.overwrite) });
          sendJson(res, 201, publicSkill(imported));
        } catch (err) {
          sendJson(res, skillErrorStatus(err), { error: err.message, validation: err.validation || null });
        }
        return;
      }

      if (skillsPath.kind === 'item' && (req.method === 'GET' || req.method === 'HEAD')) {
        try {
          sendJson(res, 200, publicSkill(readSkill(dataDir, skillsPath.id)));
        } catch (err) {
          sendJson(res, skillErrorStatus(err), { error: err.message });
        }
        return;
      }

      if (skillsPath.kind === 'item' && req.method === 'PUT') {
        let body = {};
        try {
          const raw = await readBody(req, 2_000_000);
          body = raw.trim() ? JSON.parse(raw) : {};
        } catch (err) {
          sendJson(res, err?.code === 'ELARGE' ? 413 : 400, { error: 'invalid json body' });
          return;
        }
        try {
          sendJson(res, 200, publicSkill(updateSkill(dataDir, skillsPath.id, body)));
        } catch (err) {
          sendJson(res, skillErrorStatus(err), { error: err.message, validation: err.validation || null });
        }
        return;
      }

      if (skillsPath.kind === 'item' && req.method === 'DELETE') {
        try {
          sendJson(res, 200, deleteSkill(dataDir, skillsPath.id));
        } catch (err) {
          sendJson(res, skillErrorStatus(err), { error: err.message });
        }
        return;
      }

      if (skillsPath.kind === 'action') {
        const { id, action } = skillsPath;

        if (action === 'export' && (req.method === 'GET' || req.method === 'HEAD')) {
          try {
            sendJson(res, 200, exportSkillFiles(dataDir, id));
          } catch (err) {
            sendJson(res, skillErrorStatus(err), { error: err.message });
          }
          return;
        }

        if (action === 'compare' && (req.method === 'GET' || req.method === 'HEAD')) {
          try {
            sendJson(res, 200, compareSkillPublications(dataDir, workspaceRoot, id));
          } catch (err) {
            sendJson(res, skillErrorStatus(err), { error: err.message });
          }
          return;
        }

        if (action === 'duplicate' && req.method === 'POST') {
          let body = {};
          try {
            const raw = await readBody(req);
            body = raw.trim() ? JSON.parse(raw) : {};
          } catch {
            sendJson(res, 400, { error: 'invalid json body' });
            return;
          }
          try {
            sendJson(res, 201, publicSkill(duplicateSkill(dataDir, id, { name: body.name })));
          } catch (err) {
            sendJson(res, skillErrorStatus(err), { error: err.message });
          }
          return;
        }

        if (action === 'restore' && req.method === 'POST') {
          let body = {};
          try {
            const raw = await readBody(req);
            body = raw.trim() ? JSON.parse(raw) : {};
          } catch {
            sendJson(res, 400, { error: 'invalid json body' });
            return;
          }
          try {
            sendJson(res, 200, publicSkill(restoreStarterSkill(dataDir, id, {
              confirmCustomized: Boolean(body.confirmCustomized),
            })));
          } catch (err) {
            sendJson(res, skillErrorStatus(err), { error: err.message });
          }
          return;
        }

        if (action === 'publish' && req.method === 'POST') {
          let body = {};
          try {
            const raw = await readBody(req, 256_000);
            body = raw.trim() ? JSON.parse(raw) : {};
          } catch {
            sendJson(res, 400, { error: 'invalid json body' });
            return;
          }
          try {
            const result = publishSkill(dataDir, workspaceRoot, id, {
              keys: Array.isArray(body.keys) ? body.keys : undefined,
              dryRun: Boolean(body.dryRun),
              overwrite: Boolean(body.overwrite),
              retryKeys: Array.isArray(body.retryKeys) ? body.retryKeys : null,
            });
            sendJson(res, 200, result);
          } catch (err) {
            sendJson(res, skillErrorStatus(err), { error: err.message });
          }
          return;
        }

        if (action === 'import-destination' && req.method === 'POST') {
          let body = {};
          try {
            const raw = await readBody(req);
            body = raw.trim() ? JSON.parse(raw) : {};
          } catch {
            sendJson(res, 400, { error: 'invalid json body' });
            return;
          }
          try {
            const payload = importFromDestination(dataDir, workspaceRoot, id, body.key);
            const updated = updateSkill(dataDir, id, {
              skillMd: payload.skillMd,
              resources: payload.resources,
            });
            sendJson(res, 200, { ...publicSkill(updated), importedFrom: payload.from });
          } catch (err) {
            sendJson(res, skillErrorStatus(err), { error: err.message });
          }
          return;
        }
      }

      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    // MCP tool management API (console): /mcp/tools and /mcp/tools/:id
    {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'mcp' && parts[1] === 'tools') {
        const toolId = parts[2] || null;
        try {
          if (!toolId && (req.method === 'GET' || req.method === 'HEAD')) {
            const flags = loadMcpState(dataDir).tools;
            sendJson(res, 200, listAllTools(dataDir, flags));
            return;
          }
          if (!toolId && req.method === 'POST') {
            let body = {};
            try {
              const raw = await readBody(req, 200_000);
              body = raw.trim() ? JSON.parse(raw) : {};
            } catch (err) {
              sendJson(res, err?.code === 'ELARGE' ? 413 : 400, { error: 'invalid json body' });
              return;
            }
            const created = createCustomTool(dataDir, body);
            sendJson(res, 201, created);
            return;
          }
          if (toolId && (req.method === 'GET' || req.method === 'HEAD')) {
            if (isBuiltinToolName(toolId)) {
              const flags = loadMcpState(dataDir).tools;
              const hit = listAllTools(dataDir, flags).tools.find((t) => t.name === toolId);
              if (!hit) {
                sendJson(res, 404, { error: 'not found' });
                return;
              }
              sendJson(res, 200, hit);
              return;
            }
            sendJson(res, 200, readCustomTool(dataDir, toolId));
            return;
          }
          if (toolId && req.method === 'PUT') {
            let body = {};
            try {
              const raw = await readBody(req, 200_000);
              body = raw.trim() ? JSON.parse(raw) : {};
            } catch (err) {
              sendJson(res, err?.code === 'ELARGE' ? 413 : 400, { error: 'invalid json body' });
              return;
            }
            if (isBuiltinToolName(toolId)) {
              if (body.enabled !== undefined) {
                saveMcpState(dataDir, { tools: { [toolId]: Boolean(body.enabled) } });
                const flags = loadMcpState(dataDir).tools;
                sendJson(res, 200, listAllTools(dataDir, flags).tools.find((t) => t.name === toolId));
                return;
              }
              sendJson(res, 400, { error: 'built-in tools only support enabling/disabling' });
              return;
            }
            if (body.enabled !== undefined && Object.keys(body).length === 1) {
              sendJson(res, 200, setCustomToolEnabled(dataDir, toolId, body.enabled));
              return;
            }
            sendJson(res, 200, updateCustomTool(dataDir, toolId, body));
            return;
          }
          if (toolId && req.method === 'DELETE') {
            sendJson(res, 200, deleteCustomTool(dataDir, toolId));
            return;
          }
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        } catch (err) {
          const code = err?.code === 'ENOENT' ? 404
            : err?.code === 'EEXIST' ? 409
              : err?.code === 'EINVAL' ? 400
                : 500;
          sendJson(res, code, { error: err?.message || 'tools api failed' });
          return;
        }
      }
    }

    if (url.pathname === '/mcp' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, getMcpStatus(workspaceRoot, dataDir, { port: boundMcpPort }));
      return;
    }

    if (url.pathname === '/mcp' && req.method === 'POST') {
      let body = {};
      try {
        const raw = await readBody(req);
        body = raw.trim() ? JSON.parse(raw) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { error: 'expected a JSON object' });
          return;
        }
      } catch (err) {
        if (err && err.code === 'ELARGE') {
          sendJson(res, 413, { error: 'body too large' });
          return;
        }
        sendJson(res, 400, { error: 'invalid json body' });
        return;
      }
      try {
        if (body.enabled !== undefined) {
          setMcpEnabled(workspaceRoot, dataDir, Boolean(body.enabled), {
            port: boundMcpPort,
            ...(body.authToken !== undefined ? { authToken: body.authToken } : {}),
          });
        } else if (body.authToken !== undefined || body.generateAuthToken || body.clearAuthToken) {
          let token = body.authToken;
          if (body.clearAuthToken) token = '';
          else if (body.generateAuthToken) token = generateAuthToken();
          saveMcpState(dataDir, { authToken: token });
          if (loadMcpState(dataDir).enabled) {
            syncCursorMcpRegistration(workspaceRoot, dataDir, { port: boundMcpPort });
          }
        }
        if (body.tools && typeof body.tools === 'object') {
          saveMcpState(dataDir, { tools: body.tools });
        }
        sendJson(res, 200, getMcpStatus(workspaceRoot, dataDir, { port: boundMcpPort }));
      } catch (err) {
        sendJson(res, 500, { error: err?.message || 'mcp update failed' });
      }
      return;
    }

    if (url.pathname === '/learnings' && (req.method === 'GET' || req.method === 'HEAD')) {
      const personal = url.searchParams.get('personal') === '1'
        || url.searchParams.get('personal') === 'true';
      try {
        sendJson(res, 200, listLearnings(workspaceRoot, { personal }));
      } catch (err) {
        sendJson(res, 500, { error: err?.message || 'learnings list failed' });
      }
      return;
    }

    if (url.pathname === '/learnings' && req.method === 'POST') {
      let body = {};
      try {
        const raw = await readBody(req, 200_000);
        body = raw.trim() ? JSON.parse(raw) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { error: 'expected a JSON object' });
          return;
        }
      } catch (err) {
        if (err && err.code === 'ELARGE') {
          sendJson(res, 413, { error: 'body too large' });
          return;
        }
        sendJson(res, 400, { error: 'invalid json body' });
        return;
      }
      try {
        const result = addLearning(workspaceRoot, {
          title: body.title,
          body: body.body,
          personal: Boolean(body.personal),
        });
        sendJson(res, 200, result);
      } catch (err) {
        const code = err?.code === 'EINVAL' ? 400 : 500;
        sendJson(res, code, { error: err?.message || 'add learning failed' });
      }
      return;
    }

    if (url.pathname === '/settings' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, publicSettings(loadMonitorSettings(dataDir)));
      return;
    }

    if (url.pathname === '/git' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, collectGitStatus(repoRoot, { force: true }));
      return;
    }

    if (url.pathname === '/trail' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, collectTrailStatus(repoRoot, { force: true }));
      return;
    }

    if (url.pathname === '/ready' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, collectWorkspaceReady(repoRoot, { force: true }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/settings') {
      let patch = {};
      try {
        const raw = await readBody(req);
        patch = raw.trim() ? JSON.parse(raw) : {};
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          sendJson(res, 400, { error: 'expected a JSON object' });
          return;
        }
      } catch (err) {
        if (err && err.code === 'ELARGE') {
          sendJson(res, 413, { error: 'body too large' });
          return;
        }
        sendJson(res, 400, { error: 'invalid json body' });
        return;
      }
      try {
        /** @type {Record<string, unknown>} */
        const update = {
          ...(patch.sdkListenerEnabled !== undefined ? { sdkListenerEnabled: Boolean(patch.sdkListenerEnabled) } : {}),
          ...(patch.collectReasoningEvents !== undefined ? { collectReasoningEvents: Boolean(patch.collectReasoningEvents) } : {}),
          ...(patch.persistReasoningText !== undefined ? { persistReasoningText: Boolean(patch.persistReasoningText) } : {}),
          ...(patch.detectTrail !== undefined ? { detectTrail: Boolean(patch.detectTrail) } : {}),
          ...(patch.enforceTrail !== undefined ? { enforceTrail: Boolean(patch.enforceTrail) } : {}),
          ...(patch.detectGit !== undefined ? { detectGit: Boolean(patch.detectGit) } : {}),
          ...(patch.enforceGit !== undefined ? { enforceGit: Boolean(patch.enforceGit) } : {}),
          ...(patch.agentBaseUrl !== undefined ? { agentBaseUrl: String(patch.agentBaseUrl ?? '') } : {}),
          ...(patch.agentModel !== undefined ? { agentModel: String(patch.agentModel ?? '') } : {}),
          ...(patch.agentMaxSteps !== undefined ? { agentMaxSteps: Number(patch.agentMaxSteps) } : {}),
          ...(patch.agentAuthMode !== undefined ? { agentAuthMode: String(patch.agentAuthMode ?? 'none') } : {}),
          ...(patch.agentBackend !== undefined ? { agentBackend: String(patch.agentBackend ?? 'native') } : {}),
          ...(patch.agentApprovalMode !== undefined
            ? { agentApprovalMode: normalizeApprovalMode(patch.agentApprovalMode) }
            : {}),
          ...(patch.agentApprovalTimeoutMinutes !== undefined
            ? { agentApprovalTimeoutMinutes: Number(patch.agentApprovalTimeoutMinutes) }
            : {}),
          ...(patch.agentAllowDenyRevertMinutes !== undefined
            ? { agentAllowDenyRevertMinutes: Number(patch.agentAllowDenyRevertMinutes) }
            : {}),
        };
        // Omit agentApiKey from the patch to leave the existing encrypted secret unchanged.
        // Empty string clears it. Legacy agentAuthToken maps to agentApiKey when present.
        if (typeof patch.agentApiKey === 'string') {
          update.agentApiKey = patch.agentApiKey;
        } else if (typeof patch.agentAuthToken === 'string') {
          update.agentApiKey = patch.agentAuthToken;
        }
        const settings = saveMonitorSettings(dataDir, update);
        // Refresh listener detail on the dashboard without inventing session events.
        updateSdkListenerStatus(dataDir, {
          detail: settings.sdkListenerEnabled
            ? 'Settings updated. Copilot CLI extension will pick them up on the next join.'
            : 'SDK listener disabled in settings. Hooks-only monitoring remains active.',
          reason: 'settings-updated',
        });
        sendJson(res, 200, publicSettings(settings));
      } catch (err) {
        const locked = err && err.code === 'ELOCK';
        sendJson(res, locked ? 503 : 500, { error: locked ? 'monitor lock timeout' : 'settings save failed' });
      }
      return;
    }

    // Kusă chat transcripts (sidecar files under .kusa/kusa/*.chat.json).
    if (url.pathname === '/kusa/sessions' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, {
        sessions: sessionsWithActiveTurns(listChatSessions(dataDir), turnJobs),
      });
      return;
    }

    // Re-attach to a running (or just-finished) turn after a page refresh.
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/kusa/chat/live') {
      const queueKey = String(url.searchParams.get('queueKey') || '').trim();
      if (!queueKey) {
        sendJson(res, 400, { error: 'queueKey is required' });
        return;
      }
      if (!turnJobs.has(queueKey)) {
        sendJson(res, 404, { error: 'no active turn for that queueKey' });
        return;
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }
      pipeSse(res, req, queueKey);
      return;
    }

    // Mid-turn composer Mode / Rules. Body: { queueKey, mode?, approvalMode? }.
    // The running loop reads job.options at each step boundary, so the change
    // takes effect on the very next model step (tools + system prompt + gate).
    if (req.method === 'POST' && url.pathname === '/kusa/chat/options') {
      let patch = {};
      try {
        const raw = await readBody(req, 8_000);
        patch = raw.trim() ? JSON.parse(raw) : {};
      } catch (err) {
        sendJson(res, err && err.code === 'ELARGE' ? 413 : 400, { error: 'invalid json body' });
        return;
      }
      const queueKey = String(patch?.queueKey || '').trim();
      if (!queueKey) {
        sendJson(res, 400, { error: 'queueKey is required' });
        return;
      }
      const job = turnJobs.get(queueKey);
      if (!job || job.terminal) {
        sendJson(res, 404, { error: 'no active turn for that queueKey' });
        return;
      }
      if (!job.options || typeof job.options !== 'object') {
        job.options = { mode: '', approvalMode: '' };
      }
      if (patch.mode != null && String(patch.mode).trim()) {
        job.options.mode = normalizeAgentMode(patch.mode);
      }
      if (patch.approvalMode != null && String(patch.approvalMode).trim()) {
        job.options.approvalMode = normalizeApprovalMode(patch.approvalMode);
      }
      sendJson(res, 200, { ok: true, options: { ...job.options } });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/kusa/sessions') {
      let body = {};
      try {
        const raw = await readBody(req, 64_000);
        body = raw.trim() ? JSON.parse(raw) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { error: 'expected a JSON object' });
          return;
        }
      } catch (err) {
        sendJson(res, err && err.code === 'ELARGE' ? 413 : 400, { error: 'invalid json body' });
        return;
      }
      try {
        const session = createChatSession(dataDir, {
          id: typeof body.id === 'string' ? body.id : undefined,
          createdAt: Number.isFinite(body.createdAt) ? body.createdAt : undefined,
          workspaceRoot,
        });
        sendJson(res, 200, { session });
      } catch (err) {
        sendJson(res, err?.code === 'EINVAL' ? 400 : 500, { error: err?.message || 'create failed' });
      }
      return;
    }

    if (req.method === 'PUT' && url.pathname === '/kusa/sessions') {
      let body = {};
      try {
        const raw = await readBody(req, 2_000_000);
        body = raw.trim() ? JSON.parse(raw) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { error: 'expected a JSON object' });
          return;
        }
      } catch (err) {
        sendJson(res, err && err.code === 'ELARGE' ? 413 : 400, { error: 'invalid json body' });
        return;
      }
      try {
        const list = Array.isArray(body.sessions)
          ? body.sessions
          : body.session
            ? [body.session]
            : null;
        if (!list) {
          sendJson(res, 400, { error: 'expected { session } or { sessions }' });
          return;
        }
        const sessions = saveChatSessions(dataDir, list);
        sendJson(res, 200, { sessions });
      } catch (err) {
        sendJson(res, err?.code === 'EINVAL' ? 400 : 500, { error: err?.message || 'save failed' });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/kusa/sessions/migrate') {
      let body = {};
      try {
        const raw = await readBody(req, 2_000_000);
        body = raw.trim() ? JSON.parse(raw) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { error: 'expected a JSON object' });
          return;
        }
      } catch (err) {
        sendJson(res, err && err.code === 'ELARGE' ? 413 : 400, { error: 'invalid json body' });
        return;
      }
      try {
        const result = migrateChatSessions(dataDir, body.sessions, { workspaceRoot });
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: err?.message || 'migrate failed' });
      }
      return;
    }

    if (
      (req.method === 'GET' || req.method === 'HEAD')
      && url.pathname.startsWith('/kusa/sessions/')
    ) {
      const id = decodeURIComponent(url.pathname.slice('/kusa/sessions/'.length)).trim();
      if (!id || id.includes('/') || id.includes('..')) {
        sendJson(res, 400, { error: 'invalid session id' });
        return;
      }
      const session = readChatSession(dataDir, id);
      if (!session) {
        sendJson(res, 404, { error: 'session not found' });
        return;
      }
      sendJson(res, 200, { session });
      return;
    }

    // GET /kusa/tools — every tool the Kusă agent can call in a chat session,
    // grouped by family. Read-only and cheap: settings only, no CLI probes.
    if (req.method === 'GET' && url.pathname === '/kusa/tools') {
      const settings = loadMonitorSettings(dataDir);
      const backend = settings?.agentBackend === 'opencode' ? 'opencode' : 'native';
      const approvalMode = normalizeApprovalMode(settings?.agentApprovalMode);
      const groups = agentToolGroups(url.searchParams.get('mode'))
        .map((entry) => ({
          group: entry.group,
          tools: entry.schemas
            .map((schema) => {
              const fn = schema?.function || {};
              const name = String(fn.name || '');
              return {
                name,
                description: String(fn.description || ''),
                approvalGated: APPROVAL_GATED_TOOLS.has(name),
              };
            })
            .filter((tool) => tool.name),
        }))
        .filter((entry) => entry.tools.length);
      const approvalTimeoutMinutes = (() => {
        const n = Number(settings?.agentApprovalTimeoutMinutes);
        if (!Number.isFinite(n)) return 2;
        return Math.min(60, Math.max(1, Math.floor(n)));
      })();
      sendJson(res, 200, {
        backend,
        model: settings?.agentModel || '',
        approvalMode,
        approvalModeLabel: approvalModeLabel(approvalMode),
        approvalTimeoutMinutes,
        approvalTimeoutMs: approvalTimeoutMinutes * 60_000,
        allowDenyRevertMinutes: (() => {
          const n = Number(settings?.agentAllowDenyRevertMinutes);
          if (!Number.isFinite(n)) return 15;
          return Math.min(240, Math.max(1, Math.floor(n)));
        })(),
        trailEnforced: settings?.detectTrail !== false && settings?.enforceTrail !== false,
        groups,
        note: backend === 'opencode'
          ? 'OpenCode SDK advertises its own built-in tools; Kusă replaces read/write/edit/list/grep/delete with sandboxed ones.'
          : null,
      });
      return;
    }

    // GET /kusa/models — models the configured endpoint advertises (GET /models).
    // A single-model endpoint still returns one entry, so the picker defaults to it.
    if (req.method === 'GET' && url.pathname === '/kusa/models') {
      const settings = loadMonitorSettings(dataDir);
      const listed = await listAgentModels(settings);
      sendJson(res, 200, {
        backend: settings?.agentBackend === 'opencode' ? 'opencode' : 'native',
        default: listed.default,
        models: listed.models,
      });
      return;
    }

    // Resolve a pending approval for a gated tool. Body: { id, allowed, remember? }
    if (req.method === 'POST' && url.pathname === '/kusa/approval') {
      let patch = {};
      try {
        const raw = await readBody(req, 32_000);
        patch = raw.trim() ? JSON.parse(raw) : {};
      } catch (err) {
        sendJson(res, err && err.code === 'ELARGE' ? 413 : 400, { error: 'invalid json body' });
        return;
      }
      const id = String(patch?.id || '');
      const pending = pendingApprovals.get(id);
      if (!pending) {
        sendJson(res, 404, {
          error: 'no pending approval for that id',
          open: [...pendingApprovals.keys()],
        });
        return;
      }
      const allowed = patch.allowed === true;
      pending.decide({ allowed, remember: patch.remember === true });
      sendJson(res, 200, { id, allowed, remembered: patch.remember === true });
      return;
    }

    // Answer a pending kusa_ask. Body: { id, optionIndex? | optionLabel? | freeText? }
    // An index wins, then a label match, then typed text — the card sends one of
    // the three, never a mix. 404 lists open ids so a stale click cannot answer
    // a question that already settled.
    if (req.method === 'POST' && url.pathname === '/kusa/ask') {
      let patch = {};
      try {
        const raw = await readBody(req, 32_000);
        patch = raw.trim() ? JSON.parse(raw) : {};
      } catch (err) {
        sendJson(res, err && err.code === 'ELARGE' ? 413 : 400, { error: 'invalid json body' });
        return;
      }
      const id = String(patch?.id || '');
      const pending = pendingAsks.get(id);
      if (!pending) {
        sendJson(res, 404, {
          error: 'no pending ask for that id',
          open: [...pendingAsks.keys()],
        });
        return;
      }
      const answer = {
        optionIndex: Number(patch?.optionIndex),
        optionLabel: String(patch?.optionLabel ?? ''),
        freeText: String(patch?.freeText ?? ''),
      };
      pending.answer(answer);
      sendJson(res, 200, { id, answered: true });
      return;
    }

    // POST /kusa/stop — the composer Stop button. Body: { queueKey }.
    // Aborts the running turn for that key (no-op if nothing is running) and
    // returns the queue snapshot, so the client can flush the next held prompt
    // straight away instead of waiting for the turn to end on its own.
    if (req.method === 'POST' && url.pathname === '/kusa/stop') {
      let patch = {};
      try {
        const raw = await readBody(req, 8_192);
        patch = raw.trim() ? JSON.parse(raw) : {};
      } catch (err) {
        sendJson(res, err && err.code === 'ELARGE' ? 413 : 400, { error: 'invalid json body' });
        return;
      }
      const queueKey = String(patch?.queueKey || '');
      if (!queueKey) {
        sendJson(res, 400, { error: 'queueKey is required' });
        return;
      }
      const turn = activeTurns.get(queueKey);
      if (turn) {
        try { turn.abort(); } catch { /* already aborted */ }
        stopRequested.set(queueKey, Date.now());
        // Unblock any Ask still waiting for this turn — otherwise Stop looks
        // dead until the approval countdown finishes, and the next queued
        // prompt never flushes. Settling also drops the pending row so a late
        // Allow/Deny click 404s instead of resurrecting a stopped ask.
        const pendingIds = [...(approvalsByQueueKey.get(queueKey) || [])];
        for (const id of pendingIds) {
          const pending = pendingApprovals.get(id);
          if (!pending) continue;
          try { pending.decide({ allowed: false, reason: 'stopped' }); } catch { /* ignore */ }
        }
        approvalsByQueueKey.delete(queueKey);
        // Unblock any Ask still waiting for this turn — otherwise Stop looks
        // dead until the countdown finishes and the next queued prompt never
        // flushes. Settling drops the row so a late option click 404s.
        const pendingAskIds = [...(asksByQueueKey.get(queueKey) || [])];
        for (const id of pendingAskIds) {
          const pending = pendingAsks.get(id);
          if (!pending) continue;
          try { pending.answer({ reason: 'stopped' }); } catch { /* ignore */ }
        }
        asksByQueueKey.delete(queueKey);
      }
      sendJson(res, 200, { stopped: Boolean(turn), ...queueSnapshot(queueKey) });
      return;
    }

    // Composer queue for a running turn. Body: { queueKey, action, text?, id? }
    //   action enqueue (default) — hold on this session (session-bound)
    //   action send             — "send now": move it into the running loop
    //   action remove           — take it out of held or parked (drop it)
    //   action take             — claim it (about to flush as a follow-up turn)
    //   action edit             — rewrite held or parked text in place
    //   action pause            — move a session-held prompt to the workspace
    //                            parked list (cross-session); flush skips it
    //   action resume           — move a parked prompt onto this session's held
    //                            list so this chat can flush/send it
    //   action reorder          — set this session's held order from `{ ids }`
    //                            (parked rows are not reordered here)
    // Every response carries the full snapshot so the UI mirror cannot drift.
    if (req.method === 'POST' && url.pathname === '/kusa/queue') {
      let patch = {};
      try {
        const raw = await readBody(req, 64_000);
        patch = raw.trim() ? JSON.parse(raw) : {};
      } catch (err) {
        sendJson(res, err && err.code === 'ELARGE' ? 413 : 400, { error: 'invalid json body' });
        return;
      }
      const queueKey = String(patch?.queueKey || '');
      if (!queueKey) {
        sendJson(res, 400, { error: 'queueKey is required' });
        return;
      }
      const action = String(patch?.action || 'enqueue');
      let error = null;
      if (action === 'enqueue') {
        const text = String(patch?.text || '').trim();
        if (!text) {
          sendJson(res, 400, { error: 'text is required' });
          return;
        }
        // Carry the composer pickers with the message so flushing it later
        // behaves exactly as if the user had pressed Send at that moment.
        const options = {
          mode: String(patch?.options?.mode || ''),
          model: String(patch?.options?.model || ''),
          approvalMode: String(patch?.options?.approvalMode || ''),
        };
        const list = sessionHeld(queueKey).slice();
        list.push({
          id: String(patch?.id || `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
          text,
          at: Date.now(),
          options,
        });
        setSessionHeld(queueKey, list);
      } else if (action === 'edit') {
        // Rewrite without moving: id, slot and options stay. May target this
        // session's held row or a workspace parked row.
        const id = String(patch?.id || '');
        const text = String(patch?.text || '').trim();
        if (!id) {
          sendJson(res, 400, { error: 'id is required' });
          return;
        }
        if (!text) {
          sendJson(res, 400, { error: 'text is required' });
          return;
        }
        const held = sessionHeld(queueKey);
        const heldIdx = held.findIndex((entry) => entry?.id === id);
        if (heldIdx >= 0) {
          const next = held.slice();
          next[heldIdx] = { ...next[heldIdx], text };
          setSessionHeld(queueKey, next);
        } else {
          const parked = parkedList();
          const parkedIdx = parked.findIndex((entry) => entry?.id === id);
          if (parkedIdx < 0) {
            error = 'not in the queued list';
          } else {
            const next = parked.slice();
            next[parkedIdx] = { ...next[parkedIdx], text };
            setParkedList(next);
          }
        }
      } else if (action === 'pause') {
        // Park: leave this session's held list and join the workspace parked
        // list so another chat can resume/send it. Id and options stay.
        const id = String(patch?.id || '');
        if (!id) {
          sendJson(res, 400, { error: 'id is required' });
          return;
        }
        const claimed = queueTake(queuedMessages, queueKey, id);
        if (!claimed) {
          error = 'not in the queued list';
        } else {
          const next = parkedList().slice();
          next.push({ ...claimed, paused: true });
          setParkedList(next);
        }
      } else if (action === 'resume') {
        // Un-park onto *this* session's held list (session-bound again).
        const id = String(patch?.id || '');
        if (!id) {
          sendJson(res, 400, { error: 'id is required' });
          return;
        }
        const claimed = queueTake(queuedMessages, WORKSPACE_QUEUE_KEY, id);
        if (!claimed) {
          error = 'not in the queued list';
        } else {
          const { paused: _paused, ...rest } = claimed;
          const next = sessionHeld(queueKey).slice();
          next.push(rest);
          setSessionHeld(queueKey, next);
        }
      } else if (action === 'reorder') {
        // Drag-and-drop: permute this session's held ids only. Parked rows are
        // cross-session and stay at the end of the snapshot in parked order.
        const ids = Array.isArray(patch?.ids)
          ? patch.ids.map((id) => String(id || '')).filter(Boolean)
          : [];
        const held = sessionHeld(queueKey);
        if (!ids.length) {
          sendJson(res, 400, { error: 'ids is required' });
          return;
        }
        if (ids.length !== held.length || new Set(ids).size !== ids.length) {
          error = 'ids must list every queued entry once';
        } else {
          const byId = new Map(held.map((entry) => [entry.id, entry]));
          if (ids.some((id) => !byId.has(id))) {
            error = 'ids must match the current queue';
          } else {
            setSessionHeld(queueKey, ids.map((id) => byId.get(id)));
          }
        }
      } else if (action === 'send' || action === 'remove' || action === 'take') {
        const id = String(patch?.id || '');
        if (!id) {
          sendJson(res, 400, { error: 'id is required' });
          return;
        }
        if (action === 'remove') {
          if (!takeQueued(queueKey, id)) error = 'not in the queued list';
        } else {
          // take/send: claim from this session's held, workspace parked, or
          // this session's steering (a second take of an already-steered id).
          const claimed = takeQueued(queueKey, id)
            || queueTake(steeringMessages, queueKey, id);
          if (!claimed) {
            error = 'not queued for this session';
          } else if (action === 'send') {
            const list = steeringMessages.get(queueKey) || [];
            const { paused: _paused, ...rest } = claimed;
            list.push({
              id: rest.id,
              text: rest.text,
              at: Date.now(),
              ...(rest.options ? { options: rest.options } : {}),
            });
            steeringMessages.set(queueKey, list);
          }
        }
      } else {
        error = `unknown action: ${action}`;
      }
      if (error) {
        sendJson(res, 404, { error, ...queueSnapshot(queueKey) });
        return;
      }
      persistQueues();
      sendJson(res, 200, queueSnapshot(queueKey));
      return;
    }

    // GET /kusa/queue[?queueKey=…] — current queue. Without a key it returns
    // one snapshot per chat session (that session's held + workspace parked +
    // that session's steering) so the UI mirror can re-attach after a reload.
    if (req.method === 'GET' && url.pathname === '/kusa/queue') {
      const queueKey = String(url.searchParams.get('queueKey') || '');
      if (queueKey) {
        sendJson(res, 200, queueSnapshot(queueKey));
        return;
      }
      const keys = new Set([
        ...listChatSessions(dataDir).map((session) => session.key).filter(Boolean),
        ...steeringMessages.keys(),
        ...[...queuedMessages.keys()].filter((key) => key !== WORKSPACE_QUEUE_KEY),
      ]);
      // Parked-only workspace with no chat sessions yet — still expose it.
      if (!keys.size && parkedList().length) keys.add(WORKSPACE_QUEUE_KEY);
      sendJson(res, 200, { queues: [...keys].map(queueSnapshot) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/kusa/chat') {
      let body = {};
      try {
        const raw = await readBody(req, 512_000);
        body = raw.trim() ? JSON.parse(raw) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { error: 'expected a JSON object' });
          return;
        }
      } catch (err) {
        if (err && err.code === 'ELARGE') {
          sendJson(res, 413, { error: 'body too large' });
          return;
        }
        sendJson(res, 400, { error: 'invalid json body' });
        return;
      }

      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) {
        sendJson(res, 400, { error: 'prompt is required' });
        return;
      }

      const settings = loadMonitorSettings(dataDir);
      const history = Array.isArray(body.history) ? body.history : [];
      const wantStream = body.stream === true
        || String(req.headers.accept || '').includes('text/event-stream');
      const chatSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      // Queue identity for this turn: the client's session key (falls back to the
      // session id). A prompt typed while this turn is already running is held
      // under this key instead of starting a second, competing turn.
      const queueKey = (typeof body.queueKey === 'string' ? body.queueKey.trim() : '') || chatSessionId;
      // Composer pickers: Ask/Plan/Agent mode, approval rules, model override.
      const agentMode = normalizeAgentMode(body.mode);
      const requestedModel = typeof body.model === 'string' ? body.model.trim().slice(0, 200) : '';
      // Ask rules carry their timeout default ('ask-deny' | 'ask-allow'); legacy
      // 'ask' normalizes to 'ask-deny'. Empty means "follow settings".
      const approvalRules = String(body.approvalMode || '').trim()
        ? normalizeApprovalMode(body.approvalMode)
        : '';
      const trailPolicy = resolveTrailPolicy(settings, workspaceRoot);
      if (trailPolicy.enforce && !trailPolicy.ready) {
        const message = trailNotReadyMessage(trailPolicy.status);
        if (wantStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.write(`event: error\ndata: ${JSON.stringify({
            type: 'error',
            message,
            code: 'ETRAIL',
          })}\n\n`);
          if (!res.writableEnded) res.end();
          return;
        }
        sendJson(res, 503, { error: message, code: 'ETRAIL', steps: trailPolicy.status?.steps || [] });
        return;
      }
      const hooks = createKusaHookEmitter({
        dataDir,
        sessionId: chatSessionId,
        workspaceRoot,
      });
      if (hooks.enabled) {
        if (body.sessionStart === true) hooks.sessionStart();
        hooks.userPrompt(prompt);
      }

      if (wantStream) {
        // A refresh (or second tab) while this session is already running should
        // reattach to the same turn — never start a competing agent loop.
        if (queueKey && turnJobs.has(queueKey) && !turnJobs.get(queueKey)?.terminal) {
          pipeSse(res, req, queueKey);
          return;
        }

        // Stop handle for this turn (see POST /kusa/stop). The loop aborts at
        // its next step boundary or cancels the stream mid-read, so partial text
        // is kept here and handed back on the `stopped` event below.
        const turnAbort = new AbortController();
        const promptMessageId = typeof body.promptMessageId === 'string'
          ? body.promptMessageId.trim()
          : '';
        const initialApproval = approvalRules || settings?.agentApprovalMode || '';
        const job = createTurnJob({
          queueKey,
          sessionId: chatSessionId,
          prompt,
          promptMessageId: promptMessageId || null,
          mode: agentMode,
          approvalMode: initialApproval,
        });
        const jobKey = queueKey || `anon:${job.turnId}`;
        activeTurns.set(jobKey, turnAbort);
        turnJobs.set(jobKey, job);
        // Persist the opening user prompt immediately — a refresh must not lose
        // it if the client's PUT has not landed yet.
        try { persistTurnPrompt(dataDir, job); } catch { /* best-effort */ }
        // Pipe this HTTP response as one listener; closing the tab only
        // unsubscribes — the agent keeps running for GET /kusa/chat/live.
        pipeSse(res, req, jobKey);

        let streamedText = '';
        try {
          const result = await runKusaAgent({
            workspaceRoot,
            settings,
            prompt,
            history,
            opencodeSessionId: typeof body.opencodeSessionId === 'string' ? body.opencodeSessionId : undefined,
            sessionTitle: typeof body.title === 'string' ? body.title : undefined,
            stream: true,
            hooks,
            mode: agentMode,
            modelOverride: requestedModel,
            approvalMode: initialApproval,
            // "Send now" while busy: the loop injects these before its next model
            // call, so the agent reacts to the new prompt mid-turn.
            onSteer: queueKey ? () => drainSteering(queueKey) : undefined,
            // Composer Mode / Rules while busy: POST /kusa/chat/options writes
            // job.options; the loop applies them before each model step.
            onOptions: () => ({ ...job.options }),
            // "Stop" while busy: POST /kusa/stop aborts this signal, and the
            // loop stops at its next step boundary (or cancels the stream).
            signal: turnAbort.signal,
            onApprove: (ask) => waitForApproval(ask, jobKey),
            onAsk: (ask) => waitForAsk(ask, jobKey),
            onEvent: (ev) => {
              const type = ev?.type || 'message';
              // Final `done` is written once below so clients get a stable payload.
              if (type === 'done') return;
              // Keep the running reply so a user Stop can still report what was
              // already streamed (the loop throws on abort and returns nothing).
              if (type === 'content' && typeof ev.text === 'string') streamedText = ev.text;
              ingestTurnEvent(job, ev);
              // The gate re-emits the same id once it is settled — by a human or
              // by its timeout default. Drop the row from pendingApprovals so a
              // late Allow/Deny click 404s instead of resurrecting a settled ask.
              if (type === 'approval_request' && ev.status && ev.status !== 'pending') {
                const id = String(ev.id || '');
                pendingApprovals.delete(id);
                const set = approvalsByQueueKey.get(jobKey);
                if (set) {
                  set.delete(id);
                  if (!set.size) approvalsByQueueKey.delete(jobKey);
                }
              }
              // Same for a settled question: the gate re-emits the id once the
              // user answered or the countdown expired, so a late click 404s.
              if (type === 'ask_request' && ev.status && ev.status !== 'pending') {
                const id = String(ev.id || '');
                pendingAsks.delete(id);
                const set = asksByQueueKey.get(jobKey);
                if (set) {
                  set.delete(id);
                  if (!set.size) asksByQueueKey.delete(jobKey);
                }
              }
              broadcastTurn(job, type, ev);
            },
          });
          if (hooks.enabled) {
            hooks.afterAgentResponse(result.text || '');
            hooks.agentStop({ stopReason: 'end_turn' });
          }
          finishTurnJob(jobKey, {
            type: 'done',
            text: result.text,
            thinking: result.thinking || '',
            backend: result.backend,
            mode: result.mode || agentMode,
            model: result.model || requestedModel || settings.agentModel,
            toolTrace: result.toolTrace || [],
            opencodeSessionId: result.opencodeSessionId || null,
            steps: result.steps ?? null,
            turnId: job.turnId,
            // Still-held prompts: the client flushes these as follow-up turns now
            // that this one is over (Cursor/Copilot queue behaviour).
            queued: visibleQueued(jobKey),
          });
        } catch (err) {
          if (stopRequested.has(jobKey)) {
            // The user pressed Stop: end the turn cleanly with whatever was
            // already streamed, and hand back the held prompts so the client
            // sends the next one right away.
            if (hooks.enabled) {
              hooks.agentStop({ stopReason: 'user_stop', status: 'stopped' });
            }
            finishTurnJob(jobKey, {
              type: 'stopped',
              reason: 'user_stop',
              text: streamedText || job.live?.text || '',
              thinking: '',
              toolTrace: [],
              turnId: job.turnId,
              queued: visibleQueued(jobKey),
            });
          } else {
            if (hooks.enabled) {
              hooks.agentStop({ stopReason: 'error', status: 'error' });
            }
            // Persist a visible error row as a normal completion so refresh still
            // sees a settled transcript (clients treat stream `error` as throw).
            finishTurnJob(jobKey, {
              type: 'done',
              text: `Agent error: ${err?.message || 'kusa chat failed'}`,
              thinking: '',
              toolTrace: [],
              turnId: job.turnId,
              queued: visibleQueued(jobKey),
            });
          }
        }
        return;
      }

      const turnAbort = new AbortController();
      if (queueKey) activeTurns.set(queueKey, turnAbort);
      try {
        const result = await runKusaAgent({
          workspaceRoot,
          settings,
          prompt,
          history,
          opencodeSessionId: typeof body.opencodeSessionId === 'string' ? body.opencodeSessionId : undefined,
          sessionTitle: typeof body.title === 'string' ? body.title : undefined,
          stream: false,
          hooks,
          mode: agentMode,
          modelOverride: requestedModel,
          approvalMode: approvalRules || settings?.agentApprovalMode,
          onSteer: queueKey ? () => drainSteering(queueKey) : undefined,
          signal: turnAbort.signal,
        });
        if (hooks.enabled) {
          hooks.afterAgentResponse(result.text || '');
          hooks.agentStop({ stopReason: 'end_turn' });
        }
        sendJson(res, 200, {
          text: result.text,
          thinking: result.thinking || '',
          backend: result.backend,
          mode: result.mode || agentMode,
          model: result.model || requestedModel || settings.agentModel,
          toolTrace: result.toolTrace || [],
          opencodeSessionId: result.opencodeSessionId || null,
          steps: result.steps ?? null,
          queued: visibleQueued(queueKey),
        });
      } catch (err) {
        if (queueKey && stopRequested.has(queueKey)) {
          // Stopped by the user (non-stream client): a clean result, not an error.
          if (hooks.enabled) {
            hooks.agentStop({ stopReason: 'user_stop', status: 'stopped' });
          }
          sendJson(res, 200, {
            stopped: true,
            reason: 'user_stop',
            text: '',
            queued: visibleQueued(queueKey),
          });
          return;
        }
        if (hooks.enabled) {
          hooks.agentStop({ stopReason: 'error', status: 'error' });
        }
        const status = err?.code === 'EINVAL' ? 400
          : err?.code === 'ENOENT' ? 503
            : err?.status && Number.isFinite(err.status) ? err.status
              : 500;
        sendJson(res, status, {
          error: err?.message || 'kusa chat failed',
          code: err?.code || null,
        });
      } finally {
        if (queueKey) {
          activeTurns.delete(queueKey);
          stopRequested.delete(queueKey);
        }
      }
      return;
    }

    if (req.method === 'DELETE' && url.pathname === '/sessions') {
      let keys = [];
      try {
        const raw = await readBody(req);
        const parsed = raw.trim() ? JSON.parse(raw) : {};
        keys = Array.isArray(parsed.keys) ? parsed.keys : [];
      } catch (err) {
        if (err && err.code === 'ELARGE') {
          sendJson(res, 413, { error: 'body too large' });
          return;
        }
        sendJson(res, 400, { error: 'invalid json body; expected { "keys": ["harness:id", ...] }' });
        return;
      }
      try {
        const result = deleteSessions(dataDir, keys);
        // Drop session-bound held + steering; workspace parked stays claimable.
        let queueDirty = false;
        for (const key of keys) {
          const qk = String(key || '');
          if (!qk.startsWith('kusa:') || qk === WORKSPACE_QUEUE_KEY) continue;
          if (queuedMessages.delete(qk)) queueDirty = true;
          if (steeringMessages.delete(qk)) queueDirty = true;
        }
        if (queueDirty) persistQueues();
        sendJson(res, 200, result);
      } catch (err) {
        const locked = err && err.code === 'ELOCK';
        sendJson(res, locked ? 503 : 500, { error: locked ? 'monitor lock timeout' : 'delete failed' });
      }
      return;
    }

    if (req.method === 'DELETE') {
      const route = sessionRoute(url.pathname);
      if (route?.stem) {
        const rel = `${route.harness}/${route.stem}.json`;
        let keys = [laneKey(route.harness, route.stem)];
        try {
          const index = JSON.parse(await readFile(join(dataDir, 'index.json'), 'utf8'));
          const matched = Object.entries(index.sessionFiles || {})
            .filter(([, path]) => path === rel)
            .map(([key]) => key);
          if (matched.length) keys = matched;
        } catch { /* index missing; fall back to harness:stem */ }
        try {
          const result = deleteSessions(dataDir, keys);
          let queueDirty = false;
          for (const key of keys) {
            const qk = String(key || '');
            if (!qk.startsWith('kusa:') || qk === WORKSPACE_QUEUE_KEY) continue;
            if (queuedMessages.delete(qk)) queueDirty = true;
            if (steeringMessages.delete(qk)) queueDirty = true;
          }
          if (queueDirty) persistQueues();
          sendJson(res, 200, result);
        } catch (err) {
          const locked = err && err.code === 'ELOCK';
          sendJson(res, locked ? 503 : 500, { error: locked ? 'monitor lock timeout' : 'delete failed' });
        }
        return;
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD, DELETE, POST' }).end();
      return;
    }
    if (url.pathname === '/') {
      res.writeHead(302, { Location: '/dashboard.html' }).end();
      return;
    }
    const route = routes[url.pathname] || sessionRoute(url.pathname);
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found\n');
      return;
    }
    try {
      const body = await readFile(route.file);
      res.writeHead(200, { 'Content-Type': route.type, 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      const missing = err && err.code === 'ENOENT';
      res.writeHead(missing ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(missing ? 'no monitor data yet\n' : 'read error\n');
    }
  });

  /** Call after listen so `.cursor/mcp.json` URL matches the bound port. */
  server.setMcpPort = (port) => {
    boundMcpPort = Number(port) || boundMcpPort;
    if (loadMcpState(dataDir).enabled) {
      syncCursorMcpRegistration(workspaceRoot, dataDir, { port: boundMcpPort });
    }
  };

  return server;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/** Port for `kusa serve`. `--port` / `-p` overrides KUSA_PORT, which overrides 1424. */
export function resolveServePort(argv = process.argv.slice(2), env = process.env) {
  let explicit;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--port' || arg === '-p') {
      explicit = argv[index + 1];
      index += 1;
      if (explicit == null || explicit.startsWith('-')) {
        throw new Error('kusa: --port requires a port number');
      }
    } else if (arg.startsWith('--port=')) {
      explicit = arg.slice('--port='.length);
    } else {
      throw new Error(`kusa: unknown serve option ${arg}`);
    }
  }
  const raw = explicit ?? env.KUSA_PORT ?? env.COPILOT_MONITOR_PORT ?? '1424';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`kusa: invalid port ${raw}`);
  }
  return port;
}

if (isMain) {
  let port;
  try {
    port = resolveServePort();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const server = createMonitorServer({ mcpPort: port });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`kusa: port ${port} is already in use (another serve.mjs?)`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, '127.0.0.1', () => {
    server.setMcpPort?.(port);
    const mcp = loadMcpState(defaultMonitorDir(repoRoot));
    console.log(`Kusă Console: http://127.0.0.1:${port}/dashboard.html`);
    console.log(`Data folder: ${defaultMonitorDir(repoRoot)}`);
    if (mcp.enabled) {
      console.log(`MCP endpoint: ${mcpEndpointUrl(port, repoRoot)}`);
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
