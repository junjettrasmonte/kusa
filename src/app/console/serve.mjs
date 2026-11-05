#!/usr/bin/env node
/**
 * Serve the Agentic Development Console over localhost.
 *
 *   kusa serve                           -> http://localhost:1424/
 *   kusa serve --port 4000               -> explicit port
 *   kusa serve -p 4000                   -> same
 *   KUSA_PORT=4000 kusa serve             -> port when --port is omitted
 *   kusa serve --live                    -> Vite Fast Refresh on this port; API on port+1
 *   kusa serve --hmr                       alias — server still restarts on its import graph
 *
 * Routes:
 *   /                 the React shell in this package (index.html)
 *   /index.html       same shell
 *   /dashboard.html   redirect to /
 *   /console.css      prebuilt Tailwind stylesheet
 *   /console.js       prebuilt React bundle
 *   /favicon.svg      Kusă mark (SVG favicon)
 *   /monitor-data.js  <workspace>/.kusa/pwa/monitor-data.js
 *   /index.json                                 same pwa/ folder, read-only
 *   /agents/<agent>/lane.json                             one Agent's record
 *   /agents/<agent>/events.jsonl                          that Agent's recent events
 *   /agents/<agent>/attachments/<file>                    a file attached to that Agent
 *   /sessions/…                                           legacy URL shape (still resolved)
 *   DELETE /sessions  JSON body { "keys": ["harness:id", ...] } — remove sessions
 *   GET/POST /settings  read/update Kusă agent + workspace settings (settings.json)
 *   POST /kusa/chat   Kusă harness prompt (JSON or SSE stream=1 / Accept: text/event-stream)
 *   GET  /kusa/chat/live?queueKey=  re-attach SSE to a running turn (survives refresh)
 *   POST /kusa/chat/options  mid-turn Mode / Rules update (takes effect on the next tool call; an Allow / Deny Rule also settles an ask that is already waiting)
 *   GET/POST /kusa/queue  composer held/steering (per-session queues.json; parked in queues.json)
 *   GET /kusa/agents          list chat transcripts (.kusa/agents/<id>/chat.json)
 *                                 (busy sessions include in-memory `live` while a turn runs)
 *   POST /kusa/agents         create an empty Kusă chat (+ monitor lane)
 *   PUT /kusa/agents          upsert one `{ session }` or many `{ sessions }`
 *   POST /kusa/agents/migrate import legacy browser-local chats
 *   GET /kusa/workflows         local orchestration workflow configs (.kusa/workflows)
 *   GET/PUT /kusa/workflows/:id  one workflow (PUT saves role→profile bindings)
 *   GET /kusa/workflows/:id/graph  LangGraph drawable nodes/edges (React Flow preview)
 *   GET/POST /kusa/agent-profiles  central agent profiles (.kusa/agent-profiles)
 *   GET/PUT/DELETE /kusa/agent-profiles/:id
 *   GET/POST /kusa/plans        workspace plans (.kusa/plans); GET/PUT /kusa/plans/:id
 *   GET /kusa/tools   the tool set the Kusă agent advertises for a chat session
 *   GET /kusa/models  models every active endpoint has, grouped by endpoint / provider name (for the picker)
 *   GET /git          live working-copy status (git status for the workspace)
 *   GET /trail        live Trail CLI + .trail/cache readiness
 *   GET /files        workspace file tree (sidebar Explorer view; ?depth= ?entries=)
 *   GET /files/rev    cheap tree generation (Explorer soft-refresh; create/delete bumps)
 *   GET /search       workspace file-name search (?q= required, ?path= scope)
 *   GET /grep         workspace content search (sidebar Search; ?q= + flags)
 *   POST /grep/replace  content replace across matches (dryRun supported)
 *   GET /ready        combined git + trail readiness (dashboard load check)
 *   GET /health       lightweight serve-up probe (PWA splash; no auth; live:true under --live)
 *   GET /auth/status  console auth gate status
 *   POST /auth/setup|/auth/login|/auth/totp|/auth/logout
 *   GET /auth/oidc/start|/auth/oidc/callback  OIDC SSO
 *   GET /auth/saml/metadata|/auth/saml/start  SAML SSO
 *   POST /auth/saml/acs
 *   /manifest.webmanifest /sw.js /icons/*  PWA shell assets
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
 *   GET /live-chat        Live Chat browser-voice status (always up; no Pipecat bot)
 *   GET|PUT /live-chat/settings  browser STT/TTS/VAD prefs
 *   POST /live-chat/server/*     retired — returns 410
 *   POST /live-chat/session|rtc  retired — returns 410
 *   WS  /live-chat/ws            retired — closes with 410
 *
 * Binds 127.0.0.1 only. No dependencies. Everything is served with no-cache
 * headers so the page's 1 s poll always sees the latest hook write.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { URL as NodeURL } from 'node:url';
import {
  agentToolGroups,
  approvalModeLabel,
  APPROVAL_GATED_TOOLS,
  createKusaHookEmitter,
  mirrorCliMonitorEvent,
  listAgentModelGroups,
  normalizeAgentMode,
  normalizeApprovalMode,
  readStrataContext,
  resolveAgentEndpoint,
  resolveTrailPolicy,
  requestSessionName,
  runKusaAgent,
  supportsVision,
  trailNotReadyMessage,
} from '#features/agent/index.mjs';
import { collectWorkspaceTree } from '#features/explorer/tree.mjs';
import { getWorkspaceTreeRev } from '#features/explorer/tree-rev.mjs';
import { searchWorkspaceFiles } from '#features/explorer/search.mjs';
import {
  replaceWorkspaceContent,
  searchWorkspaceContent,
} from '#features/explorer/content-search.mjs';
import { readWorkspaceFile, writeWorkspaceFile } from '#features/explorer/file.mjs';
import {
  createChatSession,
  listChatSessions,
  migrateChatSessions,
  nameChatSession,
  readChatSession,
  readSessionConfig,
  resolveSessionRef,
  saveChatSessions,
} from '#features/chat/data/chat-store.mjs';
import {
  dispatchAdapterHttp,
  isCaoChatProvider,
  isExternalChatSession,
  resolveChatProvider,
} from '#features/chat/data/providers.mjs';
import '#features/chat/data/load-builtin-adapters.mjs';
import { runCaoChatTurn } from '#features/chat/data/cao-chat-turn.mjs';
import {
  broadcastTurn,
  createTurnJob,
  ingestTurnEvent,
  persistTurnCompletion,
  persistTurnPrompt,
  sessionsWithActiveTurns,
  subscribeTurn,
} from '#features/chat/data/chat-turn.mjs';
import { loadQueues, saveQueues, WORKSPACE_QUEUE_KEY } from '#features/chat/data/queue-store.mjs';
import {
  normalizeAttachments,
  ATTACHMENT_LIMITS,
} from '#features/chat/data/attachments.mjs';
import {
  createPlan,
  deletePlan,
  listPlans,
  planSummary,
  readPlan,
  updatePlan,
} from '#features/chat/data/plan-store.mjs';
import {
  claimUnownedPlansForAgent,
  plansBlockingAgentDelete,
  resolveAgentDeleteKeys,
} from '#features/agent/plans.mjs';
import {
  listWorkflows,
  ensureWorkflowsSeeded,
  readWorkflow,
  readWorkflowSource,
  writeWorkflow,
  workflowRoleAgentLabel,
  workflowRoleGatePrompt,
} from '#features/workflows/store.mjs';
import {
  deleteAgentProfile,
  ensureAgentProfilesSeeded,
  listAgentProfiles,
  readAgentProfile,
  writeAgentProfile,
} from '#features/agent-profiles/store.mjs';
import {
  drawableWorkflowGraph,
  isPlanExecuteOrchestrator,
  isSessionAwaitingPlanApproval,
  onOrchestratorTurnSettled,
  resumeAfterPlanApproval,
} from '#features/workflows/langgraph/index.mjs';
import {
  buildProfileDocument,
  collectCaoStatus,
  createCaoProfile,
  createCaoSession,
  deleteCaoProfile,
  getCaoTerminal,
  getCaoTerminalOutput,
  listCaoProfiles,
  listCaoWorkflows,
  parseProfileDocument,
  readCaoProfileSource,
  sendCaoTerminalInput,
  startCaoServer,
  updateCaoProfile,
} from '#features/cao/index.mjs';
import {
  appendLiveChatTranscript,
  collectLiveChatStatus,
  normalizeLiveChatSettings,
  resolveLiveChatBaseUrl,
} from '#features/live-chat/index.mjs';
import {
  collectGitStatus,
  collectTrailStatus,
  collectWorkspaceReady,
  defaultMonitorDir,
  defaultWorkspaceRoot,
  deleteSessions,
  indexJsonPath,
  LANE_FILE,
  laneKey,
  loadMonitorSettings,
  publicSettings,
  pwaFile,
  refreshMonitorArtifacts,
  saveMonitorSettings,
  AGENTS_DIR,
  agentsRoot,
} from '#features/monitor/lib.mjs';
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
} from '#features/skills/index.mjs';
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
} from '#features/mcp/index.mjs';
import {
  enforceAuthGate,
  handleAuthHttp,
  hashPassword,
  mergeAuthPatch,
} from '#features/auth/index.mjs';
import { existsSync, readdirSync } from 'node:fs';


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

  /**
   * Subagent approvals / asks surface on the orchestrator parent so the human
   * answers from the parent chat; the same id settles the child's waiter.
   */
  const parentQueueKeyForAgent = (sessionId) => {
    const id = String(sessionId || '').trim();
    if (!id) return null;
    try {
      const cfg = readSessionConfig(dataDir, id) || {};
      const parentId = String(cfg.parentId || '').trim();
      if (!parentId) return null;
      const parent = readChatSession(dataDir, parentId);
      if (parent?.key) return parent.key;
      return laneKey(parent?.harness || 'kusa', parentId);
    } catch {
      return null;
    }
  };

  const ensureParentRelayJob = (parentKey, parentId) => {
    let job = turnJobs.get(parentKey);
    if (job && !job.terminal) return job;
    job = createTurnJob({
      queueKey: parentKey,
      sessionId: parentId,
      harness: 'kusa',
      prompt: '',
    });
    job.relayOnly = true;
    turnJobs.set(parentKey, job);
    return job;
  };

  const parentRelayHasPendingGates = (job) => {
    const parts = Array.isArray(job?.live?.parts) ? job.live.parts : [];
    return parts.some((p) => (
      (p?.type === 'approval' && p.approval?.status === 'pending')
      || (p?.type === 'ask' && p.ask?.status === 'pending')
    ));
  };

  const maybeFinishParentRelayJob = (parentKey) => {
    const job = turnJobs.get(parentKey);
    if (!job?.relayOnly || job.terminal) return;
    if (parentRelayHasPendingGates(job)) return;
    const parts = Array.isArray(job?.live?.parts) ? job.live.parts : [];
    const lastGate = [...parts].reverse().find((p) => (
      (p?.type === 'approval' && p.approval?.sourceRole)
      || (p?.type === 'ask' && p.ask?.sourceRole)
    ));
    const role = lastGate?.approval?.sourceRole || lastGate?.ask?.sourceRole || '';
    const who = workflowRoleAgentLabel(role);
    finishTurnJob(parentKey, {
      type: 'done',
      text: `${who} asked for your input.`,
      relayOnly: true,
    });
  };

  const relayChildGateEvent = (childSessionId, childQueueKey, ev) => {
    const type = ev?.type || '';
    if (type !== 'approval_request' && type !== 'ask_request') return;
    const parentKey = parentQueueKeyForAgent(childSessionId);
    if (!parentKey || parentKey === childQueueKey) return;
    const parentId = parentKey.includes(':')
      ? parentKey.slice(parentKey.indexOf(':') + 1)
      : parentKey;
    const status = String(ev?.status || 'pending').toLowerCase();
    const pending = status === 'pending';
    // Workflow / session Rule of Allow or Deny settles inside the gate with no
    // human wait (decision mode-allow / mode-deny). Do not open an orchestrator
    // relay shell for those — only mirror a settle onto a shell already waiting
    // on a prior ask-* pending gate.
    const existingRelay = turnJobs.get(parentKey);
    const relayShellOpen = Boolean(existingRelay?.relayOnly && !existingRelay.terminal);
    if (!pending) {
      if (!relayShellOpen) return;
      let role = '';
      try {
        role = String(readSessionConfig(dataDir, childSessionId)?.role || '').trim();
      } catch { /* ignore */ }
      const relayed = {
        ...ev,
        sourceAgentId: String(childSessionId || ''),
        sourceQueueKey: String(childQueueKey || ''),
        sourceRole: role,
        relayed: true,
        gatePrompt: null,
      };
      ingestTurnEvent(existingRelay, relayed);
      broadcastTurn(existingRelay, type, relayed);
      maybeFinishParentRelayJob(parentKey);
      return;
    }
    let role = '';
    try {
      role = String(readSessionConfig(dataDir, childSessionId)?.role || '').trim();
    } catch { /* ignore */ }
    const kind = type === 'ask_request' ? 'ask' : 'approval';
    const tag = workflowRoleGatePrompt(role, kind);
    const alreadyTagged = (text) => {
      const s = String(text || '');
      return s.startsWith('[') && (s.includes('asking for an approval') || s.includes('asking a question') || s.startsWith('[Subagent'));
    };
    const parentJob = ensureParentRelayJob(parentKey, parentId);
    const relayed = {
      ...ev,
      sourceAgentId: String(childSessionId || ''),
      sourceQueueKey: String(childQueueKey || ''),
      sourceRole: role,
      relayed: true,
      // Only pending human waits: "Executor agent is asking for an approval"
      gatePrompt: tag,
      ...(typeof ev.message === 'string' && ev.message && !alreadyTagged(ev.message)
        ? { message: `[${tag}] ${ev.message}` }
        : {}),
      ...(typeof ev.question === 'string' && ev.question && !alreadyTagged(ev.question)
        ? { question: `[${tag}] ${ev.question}` }
        : {}),
    };
    ingestTurnEvent(parentJob, relayed);
    broadcastTurn(parentJob, type, relayed);
  };

  // Composer message queue (Cursor/Copilot style). While a turn is running for a
  // session, a new prompt is NOT a second turn — it is held here under the
  // client's queueKey. The server owns both lists so the UI and the running turn
  // can never disagree about what is pending:
  //   held     — per-session. Shown in that chat; when the turn ends the client
  //              flushes them in order as follow-up turns (action=take).
  //   parked   — workspace-shared (WORKSPACE_QUEUE_KEY). Any session can resume
  //              or send them; flush skips them until resumed onto a session.
  //   steering — "send now" (Codex/OpenCode soft-steer). Per-session; the
  //              running loop polls these per streamed chunk and after each
  //              tool, soft-cancels the in-flight completion (keeps partial
  //              text + thinking), skips tools not yet started, and injects
  //              the prompt before the next model call. Stop stays separate.
  // Hydrated from each session's `queues.json` (held/steering) plus shared
  // `kusa/queues.json` (parked only) so a serve restart keeps queues
  // (steering folds into that session's held on cold load).
  const { queued: queuedMessages, steering: steeringMessages } = loadQueues(dataDir);
  const persistQueues = () => {
    try {
      saveQueues(dataDir, queuedMessages, steeringMessages);
    } catch {
      /* disk must not break queue mutations */
    }
  };
  // Rehydrate per-session Task Lists from each session's tasks.json into monitor-data
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
  // safe point — the agent loop polls this per streamed chunk and per step, and
  // a drained prompt is never re-sent, so it lands exactly once.
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
  // and GET /kusa/agents overlays busy + live from this map.
  /** @type {Map<string, ReturnType<typeof createTurnJob>>} */
  const turnJobs = new Map();
  // Keep a finished job briefly so a refresh that lands right after `done` can
  // still receive the terminal frame before reading the chat sidecar.
  const TURN_JOB_GRACE_MS = 120_000;

  /**
   * Background turn for a Subagent spawned by kusa_assign. Creates a live job
   * (so GET /kusa/chat/live can attach) and runs without an HTTP response.
   */
  /**
   * Start a Subagent / escalation turn. Assign fire-and-forgets; escalate sets
   * awaitCompletion so the tool call blocks until that one turn finishes and
   * returns the text (orchestrator resumes with control).
   */
  const startAssignedTurn = async ({
    sessionId = '',
    queueKey = '',
    harness = 'kusa',
    provider = 'kusa',
    prompt = '',
    mode = 'agent',
    model = '',
    rules = '',
    signal = null,
    awaitCompletion = false,
    role = '',
    parentId = '',
  } = {}) => {
    const text = String(prompt || '').trim();
    const jobKey = String(queueKey || sessionId || '').trim();
    if (!text || !jobKey) return { ok: false, error: 'prompt and queueKey required' };
    if (turnJobs.has(jobKey) && !turnJobs.get(jobKey)?.terminal) {
      return {
        ok: awaitCompletion ? false : true,
        started: false,
        reason: 'already_running',
        ...(awaitCompletion ? { error: 'escalation target already has a running turn' } : {}),
      };
    }

    const settings = loadMonitorSettings(dataDir);
    const chatProvider = resolveChatProvider(provider || harness || 'kusa');
    const chatHarness = harness || chatProvider?.harness || 'kusa';
    const useCaoTurn = Boolean(chatProvider && isCaoChatProvider(chatProvider.id));
    const agentMode = normalizeAgentMode(mode);
    // Workflow role Rule wins for Subagent gates; then session sidecar; then Settings.
    let sessionRules = '';
    try {
      sessionRules = String(readSessionConfig(dataDir, sessionId)?.rules || '').trim();
    } catch { /* ignore */ }
    const approvalMode = normalizeApprovalMode(
      rules || sessionRules || settings?.agentApprovalMode,
    );
    const hooks = createKusaHookEmitter({
      dataDir,
      sessionId,
      workspaceRoot,
      harness: chatHarness,
    });
    if (hooks.enabled) {
      try { hooks.userPrompt(text); } catch { /* ignore */ }
    }

    const turnAbort = new AbortController();
    const onParentAbort = () => {
      try { turnAbort.abort(); } catch { /* ignore */ }
    };
    if (signal) {
      if (signal.aborted) onParentAbort();
      else signal.addEventListener('abort', onParentAbort, { once: true });
    }
    const turnStartedAt = Date.now();
    const job = createTurnJob({
      queueKey: jobKey,
      sessionId,
      harness: chatHarness,
      prompt: text,
      promptMessageId: null,
      mode: agentMode,
      approvalMode,
      attachments: [],
    });
    activeTurns.set(jobKey, turnAbort);
    turnJobs.set(jobKey, job);
    try { persistTurnPrompt(dataDir, job); } catch { /* best-effort */ }

    // Claim any durable held row for this prompt so a later idle flush / resume
    // does not start the same assign twice (assign used to enqueue + start).
    try {
      const held = sessionHeld(jobKey);
      let claimed = false;
      for (const entry of held) {
        if (entry?.paused) continue;
        if (String(entry?.text || '').trim() !== text) continue;
        if (takeQueued(jobKey, entry.id)) claimed = true;
      }
      if (claimed) persistQueues();
    } catch { /* best-effort */ }

    const claimPlansIfPlanning = () => {
      const roleKey = String(role || '').trim().toLowerCase();
      if (roleKey !== 'planner' && roleKey !== 'planning') return;
      try {
        const cfg = readSessionConfig(dataDir, sessionId) || {};
        claimUnownedPlansForAgent(dataDir, {
          agentId: sessionId,
          parentId: parentId || cfg.parentId || '',
          workflowId: cfg.workflowId || '',
          sinceMs: turnStartedAt,
        });
      } catch { /* best-effort */ }
    };

    const run = async () => {
      let streamedText = '';
      try {
        if (useCaoTurn) {
          const result = await runCaoChatTurn({
            dataDir,
            sessionId,
            harness: chatHarness,
            provider: chatProvider.id,
            workspaceRoot,
            prompt: text,
            model,
            signal: turnAbort.signal,
            onEvent: (ev) => {
              const type = ev?.type || 'message';
              if (type === 'done') return;
              if (type === 'content' && typeof ev.text === 'string') streamedText = ev.text;
              mirrorCliMonitorEvent(hooks, ev);
              ingestTurnEvent(job, ev);
              broadcastTurn(job, type, ev);
            },
          });
          streamedText = result?.text || streamedText;
          if (hooks.enabled) {
            try { hooks.afterAgentResponse(streamedText); } catch { /* ignore */ }
            try { hooks.agentStop({ stopReason: 'end_turn' }); } catch { /* ignore */ }
          }
          claimPlansIfPlanning();
          const usedModel = String(result?.model || model || '').trim();
          const terminal = {
            type: 'done',
            text: streamedText,
            backend: result?.backend || 'cao',
            provider: chatProvider.id,
            ...(usedModel ? { model: usedModel } : {}),
            turnId: job.turnId,
            queued: [],
          };
          finishTurnJob(jobKey, terminal);
          return { ok: true, started: true, ...terminal };
        }

        const result = await runKusaAgent({
          workspaceRoot,
          settings,
          prompt: text,
          history: [],
          stream: true,
          hooks,
          mode: agentMode,
          modelOverride: model,
          // Role / workflow Rule — same value the turn job and gate UI show.
          approvalMode,
          signal: turnAbort.signal,
          // Parent "send now" / assign-queue steers drain into this Subagent the
          // same way the main chat loop does (Codex/OpenCode soft-steer).
          onSteer: () => drainSteering(jobKey),
          onApprove: (ask) => waitForApproval(ask, jobKey),
          onAsk: (ask) => waitForAsk(ask, jobKey),
          onAssignTurn: startAssignedTurn,
          onEscalateTurn: startAssignedTurn,
          onEvent: (ev) => {
            const type = ev?.type || 'message';
            if (type === 'done') return;
            if (type === 'content' && typeof ev.text === 'string') streamedText = ev.text;
            ingestTurnEvent(job, ev);
            if (type === 'approval_request' || type === 'ask_request') {
              // Mirror onto the orchestrator; POST /kusa/approval|ask by id
              // settles this child's waiter (subagents have no own composer).
              relayChildGateEvent(sessionId, jobKey, ev);
            }
            broadcastTurn(job, type, ev);
          },
        });
        if (hooks.enabled) {
          try { hooks.afterAgentResponse(result.text || ''); } catch { /* ignore */ }
          try { hooks.agentStop({ stopReason: 'end_turn' }); } catch { /* ignore */ }
        }
        claimPlansIfPlanning();
        const terminal = {
          type: 'done',
          text: result.text,
          thinking: result.thinking || '',
          backend: result.backend,
          mode: result.mode || agentMode,
          model: result.model || model || settings.agentModel,
          toolTrace: result.toolTrace || [],
          turnId: job.turnId,
          queued: [],
        };
        finishTurnJob(jobKey, terminal);
        return { ok: true, started: true, ...terminal };
      } catch (err) {
        if (hooks.enabled) {
          try { hooks.agentStop({ stopReason: 'error', status: 'error' }); } catch { /* ignore */ }
        }
        claimPlansIfPlanning();
        const terminal = {
          type: 'error',
          message: err?.message || 'assigned turn failed',
          text: err?.message || 'assigned turn failed',
          turnId: job.turnId,
          queued: [],
        };
        finishTurnJob(jobKey, terminal);
        return { ok: false, started: true, ...terminal, error: terminal.message };
      } finally {
        activeTurns.delete(jobKey);
        if (signal) {
          try { signal.removeEventListener('abort', onParentAbort); } catch { /* ignore */ }
        }
      }
    };

    if (awaitCompletion) {
      return run();
    }
    void run();
    return { ok: true, started: true, queueKey: jobKey, turnId: job.turnId };
  };

  /**
   * Subagents cannot flush their own queue (composer locked). After a serve
   * --live restart, in-flight assign turns are lost but the user prompt (and
   * sometimes a held queue row) remains — pick those up without waiting for
   * the UI to select the child.
   */
  const resumeIdleSubagentTurns = () => {
    let sessions = [];
    try {
      sessions = listChatSessions(dataDir);
    } catch {
      return;
    }
    for (const session of sessions) {
      const parentId = session?.parentId || session?.options?.parentId;
      if (!parentId || !session?.key || !session?.id) continue;
      const jobKey = session.key;
      if (turnJobs.has(jobKey) && !turnJobs.get(jobKey)?.terminal) continue;

      const held = (queuedMessages.get(jobKey) || []).filter((entry) => entry && !entry.paused);
      if (held.length) {
        const entry = held[0];
        if (!takeQueued(jobKey, entry.id)) continue;
        try { persistQueues(); } catch { /* ignore */ }
        void startAssignedTurn({
          sessionId: session.id,
          queueKey: jobKey,
          harness: session.harness,
          provider: session.provider || session.options?.provider || session.harness,
          prompt: entry.text,
          mode: entry.options?.mode || session.options?.mode || 'agent',
          model: entry.options?.model || session.options?.model || '',
          rules: entry.options?.rules
            || entry.options?.approvalMode
            || session.options?.rules
            || '',
          role: session.role || session.options?.role || '',
          parentId,
        });
        continue;
      }

      const msgs = Array.isArray(session.messages) ? session.messages : [];
      const last = msgs[msgs.length - 1];
      const orphanPrompt = last?.role === 'user' ? String(last.text || '').trim() : '';
      if (!orphanPrompt) continue;
      void startAssignedTurn({
        sessionId: session.id,
        queueKey: jobKey,
        harness: session.harness,
        provider: session.provider || session.options?.provider || session.harness,
        prompt: orphanPrompt,
        mode: session.options?.mode || 'agent',
        model: session.options?.model || '',
        rules: session.options?.rules || '',
        role: session.role || session.options?.role || '',
        parentId,
      });
    }
  };

  // Boot resume: give listen a tick, then drain orphaned Subagent assigns.
  setTimeout(() => {
    try { resumeIdleSubagentTurns(); } catch { /* ignore */ }
  }, 750);

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
    // plan-execute LangGraph: after an orchestrator parent turn settles, park
    // on await_approval when a draft/ready plan exists (LLM still owns assigns).
    const termType = String(terminal?.type || '');
    if (termType === 'done' || termType === 'stopped') {
      const sessionKey = String(queueKey || job.sessionId || '').trim();
      if (sessionKey) {
        void onOrchestratorTurnSettled({
          dataDir,
          sessionKey,
          prompt: String(job.prompt || terminal?.text || '').trim(),
          workspaceRoot,
          startTurn: startAssignedTurn,
        }).catch(() => { /* lifecycle wrap must not break chat */ });
      }
    }
  };

  const shellHtml = { file: join(pageDir, 'index.html'), type: 'text/html; charset=utf-8' };
  const routes = {
    '/': shellHtml,
    '/index.html': shellHtml,
    '/console.css': { file: join(pageDir, 'console.css'), type: 'text/css; charset=utf-8' },
    '/console.js': { file: join(pageDir, 'console.js'), type: 'text/javascript; charset=utf-8' },
    '/favicon.svg': { file: join(pageDir, 'favicon.svg'), type: 'image/svg+xml' },
    '/manifest.webmanifest': {
      file: join(pageDir, 'manifest.webmanifest'),
      type: 'application/manifest+json; charset=utf-8',
    },
    '/sw.js': { file: join(pageDir, 'sw.js'), type: 'text/javascript; charset=utf-8' },
    '/monitor-data.js': { file: pwaFile(dataDir, 'monitor-data.js'), type: 'text/javascript; charset=utf-8' },
    '/index.json': { file: pwaFile(dataDir, 'index.json'), type: 'application/json; charset=utf-8' },
  };
  // Workbox runtime files + PWA icons published next to dashboard.*.
  try {
    for (const name of readdirSync(pageDir)) {
      if (/^workbox-.*\.js$/.test(name) && !routes[`/${name}`]) {
        routes[`/${name}`] = {
          file: join(pageDir, name),
          type: 'text/javascript; charset=utf-8',
        };
      }
    }
  } catch { /* pageDir may be incomplete during first boot */ }
  // PWA icons are resolved per-request so a new PNG/SVG under icons/ is
  // served without restarting (manifest updates land while --live is up).
  const iconsDir = join(pageDir, 'icons');
  const ICON_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(png|svg|ico|webp)$/i;
  const iconRoute = (pathname) => {
    if (!pathname.startsWith('/icons/')) return null;
    const name = pathname.slice('/icons/'.length);
    if (!ICON_NAME.test(name) || name.includes('/') || name.includes('..')) return null;
    const file = join(iconsDir, name);
    if (!existsSync(file)) return null;
    const lower = name.toLowerCase();
    const type = lower.endsWith('.svg')
      ? 'image/svg+xml'
      : lower.endsWith('.ico')
        ? 'image/x-icon'
        : lower.endsWith('.webp')
          ? 'image/webp'
          : 'image/png';
    return { file, type };
  };

  // Bundled browser voice weights (npm run voice:models) — also present under
  // ui/public/voice-models for Vite --live. Safe path segments only.
  const voiceModelsDir = join(pageDir, 'voice-models');
  const voiceModelsUiDir = join(here, 'ui/public/voice-models');
  const VOICE_SEG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
  const voiceModelType = (filePath) => {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
    if (lower.endsWith('.onnx')) return 'application/octet-stream';
    if (lower.endsWith('.bin')) return 'application/octet-stream';
    if (lower.endsWith('.wasm')) return 'application/wasm';
    if (lower.endsWith('.txt')) return 'text/plain; charset=utf-8';
    if (lower.endsWith('.md')) return 'text/markdown; charset=utf-8';
    return 'application/octet-stream';
  };
  const voiceModelRoute = (pathname) => {
    if (!pathname.startsWith('/voice-models/')) return null;
    const rel = pathname.slice('/voice-models/'.length);
    if (!rel || rel.includes('\0') || rel.includes('..')) return null;
    const parts = rel.split('/').filter(Boolean);
    if (!parts.length || parts.length > 12) return null;
    if (!parts.every((p) => VOICE_SEG.test(p))) return null;
    // Prefer published pageDir copy; fall back to ui/public for --live API child.
    const candidates = [
      join(voiceModelsDir, ...parts),
      join(voiceModelsUiDir, ...parts),
    ];
    for (const file of candidates) {
      if (existsSync(file)) return { file, type: voiceModelType(file) };
    }
    return null;
  };
  // /agents/<stem>/<file>  — shared agents/ folder layout
  // /agents/<stem>/attachments/<file>
  // Legacy /sessions/… still resolves (prefers agents/<stem>).
  // Every segment must be a plain name (no dots-only, no separators).
  const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
  const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const sessionFileType = (file) => {
    if (file.endsWith('.events.jsonl')) return 'application/x-ndjson; charset=utf-8';
    if (file.endsWith('.json')) return 'application/json; charset=utf-8';
    return null;
  };
  const resolveSessionDisk = (harness, stem, ...rest) => {
    const shared = join(agentsRoot(dataDir), stem, ...rest);
    if (existsSync(shared)) return shared;
    if (harness) {
      const legacy = join(dataDir, harness, stem, ...rest);
      if (existsSync(legacy)) return legacy;
    }
    return shared;
  };
  const sessionRoute = (pathname) => {
    const parts = pathname.split('/').filter(Boolean);
    if ((parts[0] !== 'agents' && parts[0] !== 'sessions') || parts.length < 3) return null;

    // /agents/<stem>/attachments/<file> (or legacy /sessions/…)
    if (parts.length === 4 && parts[2] === 'attachments') {
      const stem = parts[1];
      const file = parts[3];
      if (!SEGMENT.test(stem) || !SEGMENT.test(file) || stem.includes('..') || file.includes('..')) return null;
      return {
        file: resolveSessionDisk(null, stem, 'attachments', file),
        type: 'application/octet-stream',
        harness: AGENTS_DIR,
        stem,
        attachment: true,
      };
    }
    // Legacy: /sessions/<harness>/<stem>/attachments/<file>
    if (parts.length === 5 && parts[3] === 'attachments') {
      const harness = parts[1];
      const stem = parts[2];
      const file = parts[4];
      if (!SEGMENT.test(harness) || !SEGMENT.test(stem) || !SEGMENT.test(file)) return null;
      if (harness.includes('..') || stem.includes('..') || file.includes('..')) return null;
      return {
        file: resolveSessionDisk(harness, stem, 'attachments', file),
        type: 'application/octet-stream',
        harness,
        stem,
        attachment: true,
      };
    }
    // /agents/<stem>/<file> (or legacy /sessions/…)
    if (parts.length === 3) {
      const stem = parts[1];
      const file = parts[2];
      if (!SEGMENT.test(stem) || !SEGMENT.test(file) || stem.includes('..') || file.includes('..')) return null;
      const type = sessionFileType(file);
      if (!type) return null;
      return {
        file: resolveSessionDisk(null, stem, file),
        type,
        harness: AGENTS_DIR,
        // Folder name is the session stem; short in-folder names (lane.json, …)
        // must not be mistaken for the stem.
        stem,
      };
    }
    // Legacy: /sessions/<harness>/<stem>/<file>  OR flat /sessions/<harness>/<file>
    if (parts.length === 4) {
      const harness = parts[1];
      const stem = parts[2];
      const file = parts[3];
      if (!SEGMENT.test(harness) || harness.includes('..')) return null;
      if (!SEGMENT.test(stem) || !SEGMENT.test(file) || stem.includes('..') || file.includes('..')) return null;
      const type = sessionFileType(file);
      if (!type) return null;
      return {
        file: resolveSessionDisk(harness, stem, file),
        type,
        harness,
        stem,
      };
    }
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
    // Service worker must be cacheable enough to update; APIs stay no-store.
    if (url.pathname === '/sw.js' || url.pathname.startsWith('/workbox-')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      res.setHeader('Service-Worker-Allowed', '/');
    } else if (url.pathname === '/manifest.webmanifest') {
      // Installability reads this on every visit — never serve a stale copy
      // that still lists SVG-only icons (Chrome then hides Install).
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else if (
      url.pathname.startsWith('/icons/')
      || url.pathname === '/favicon.svg'
      || url.pathname.startsWith('/voice-models/')
    ) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    } else {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // PWA splash / login / SSO — before the session gate.
    if (await handleAuthHttp(req, res, {
      url,
      dataDir,
      readBody,
      sendJson,
      mcpPort: boundMcpPort,
    })) {
      return;
    }

    // Console APIs require a session once auth is configured (or setup first).
    if (enforceAuthGate(req, res, { url, dataDir, sendJson })) {
      return;
    }

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

    // Provider adapter HTTP (workspace trust, etc.) — owned by built-in
    // extensions under extensions/*-adapter/, not by core chat.
    {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'adapters' && parts[1]) {
        try {
          const result = await dispatchAdapterHttp({
            providerId: decodeURIComponent(parts[1]),
            action: parts[2] ? decodeURIComponent(parts[2]) : '',
            method: req.method,
            workspaceRoot,
          });
          if (result) {
            sendJson(res, result.status || 200, result.body || {});
            return;
          }
          sendJson(res, 404, { error: 'adapter action not found' });
        } catch (err) {
          sendJson(res, 500, { error: err?.message || 'adapter request failed' });
        }
        return;
      }
    }

    // CAO (CLI Agent Orchestrator): status + profile/connection CRUD proxied to
    // local cao-server. Profiles are the writable provider connections.
    {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'cao') {
        const section = parts[1] || null;
        const profileName = parts[2] ? decodeURIComponent(parts[2]) : null;
        try {
          if (!section && (req.method === 'GET' || req.method === 'HEAD')) {
            sendJson(res, 200, await collectCaoStatus({ force: true }));
            return;
          }
          // Start local cao-server (detached) when the CLI is installed but down.
          if (section === 'server' && parts[2] === 'start' && req.method === 'POST') {
            const result = await startCaoServer();
            sendJson(res, result.ok ? 200 : (result.started ? 504 : 503), result);
            return;
          }
          if (section === 'providers' && (req.method === 'GET' || req.method === 'HEAD')) {
            const status = await collectCaoStatus({ force: true });
            sendJson(res, 200, { providers: status.providers || [], serverUp: status.serverUp });
            return;
          }
          if (section === 'workflows' && (req.method === 'GET' || req.method === 'HEAD')) {
            sendJson(res, 200, await listCaoWorkflows());
            return;
          }
          if (section === 'sessions' && !profileName && req.method === 'POST') {
            let body = {};
            try {
              const raw = await readBody(req, 64_000);
              body = raw.trim() ? JSON.parse(raw) : {};
            } catch (err) {
              sendJson(res, err?.code === 'ELARGE' ? 413 : 400, { error: 'invalid json body' });
              return;
            }
            const created = await createCaoSession({
              agentProfile: body.agentProfile || body.agent_profile || 'developer',
              provider: body.provider,
              sessionName: body.sessionName || body.session_name,
              workingDirectory: body.workingDirectory || body.working_directory || workspaceRoot,
              model: body.model,
              initialMessage: body.initialMessage || body.initial_message,
            });
            sendJson(res, 201, created);
            return;
          }
          if (section === 'terminals' && profileName && parts[3] === 'input' && req.method === 'POST') {
            let body = {};
            try {
              const raw = await readBody(req, 200_000);
              body = raw.trim() ? JSON.parse(raw) : {};
            } catch (err) {
              sendJson(res, err?.code === 'ELARGE' ? 413 : 400, { error: 'invalid json body' });
              return;
            }
            const message = typeof body.message === 'string'
              ? body.message
              : (url.searchParams.get('message') || '');
            sendJson(res, 200, await sendCaoTerminalInput(profileName, message));
            return;
          }
          if (section === 'terminals' && profileName && parts[3] === 'output' && (req.method === 'GET' || req.method === 'HEAD')) {
            sendJson(res, 200, await getCaoTerminalOutput(profileName, {
              mode: url.searchParams.get('mode') || 'full',
            }));
            return;
          }
          if (section === 'terminals' && profileName && !parts[3] && (req.method === 'GET' || req.method === 'HEAD')) {
            sendJson(res, 200, await getCaoTerminal(profileName));
            return;
          }
          if (section === 'profiles' && !profileName && (req.method === 'GET' || req.method === 'HEAD')) {
            sendJson(res, 200, await listCaoProfiles());
            return;
          }
          if (section === 'profiles' && !profileName && req.method === 'POST') {
            let body = {};
            try {
              const raw = await readBody(req, 200_000);
              body = raw.trim() ? JSON.parse(raw) : {};
            } catch (err) {
              sendJson(res, err?.code === 'ELARGE' ? 413 : 400, { error: 'invalid json body' });
              return;
            }
            const name = String(body.name || '').trim();
            const content = typeof body.content === 'string' && body.content.trim()
              ? body.content
              : buildProfileDocument({
                name,
                provider: body.provider,
                model: body.model,
                description: body.description,
                body: body.body,
              });
            const created = await createCaoProfile({ name, content });
            sendJson(res, 201, { ...created, name, parsed: parseProfileDocument(content) });
            return;
          }
          if (section === 'profiles' && profileName && (req.method === 'GET' || req.method === 'HEAD')) {
            const source = await readCaoProfileSource(profileName);
            const parsed = parseProfileDocument(source.content);
            const editable = !source.profile?.builtin;
            sendJson(res, 200, { ...source, parsed, editable });
            return;
          }
          if (section === 'profiles' && profileName && req.method === 'PUT') {
            let body = {};
            try {
              const raw = await readBody(req, 200_000);
              body = raw.trim() ? JSON.parse(raw) : {};
            } catch (err) {
              sendJson(res, err?.code === 'ELARGE' ? 413 : 400, { error: 'invalid json body' });
              return;
            }
            const name = String(body.name || profileName).trim();
            const content = typeof body.content === 'string' && body.content.trim()
              ? body.content
              : buildProfileDocument({
                name,
                provider: body.provider,
                model: body.model,
                description: body.description,
                body: body.body,
              });
            const updated = await updateCaoProfile(profileName, { content });
            sendJson(res, 200, { ...updated, name: profileName, parsed: parseProfileDocument(content) });
            return;
          }
          if (section === 'profiles' && profileName && req.method === 'DELETE') {
            sendJson(res, 200, await deleteCaoProfile(profileName));
            return;
          }
          sendJson(res, section ? 405 : 404, { error: section ? 'method not allowed' : 'not found' });
          return;
        } catch (err) {
          const code = err?.code === 'ENOENT' ? 404
            : err?.code === 'EEXIST' ? 409
              : err?.code === 'EINVAL' ? 400
                : err?.code === 'ECONN' || err?.status === 0 ? 503
                  : err?.status >= 400 && err?.status < 600 ? err.status
                    : 500;
          sendJson(res, code, {
            error: err?.message || 'cao api failed',
            ...(err?.data?.detail ? { detail: err.data.detail } : {}),
          });
          return;
        }
      }
    }

    // Live Chat (Pipecat): status + settings + session mint + RTC signaling
    // proxied to the external bot. WS upgrades are handled on server 'upgrade'.
    {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'live-chat') {
        const section = parts[1] || null;
        const settings = loadMonitorSettings(dataDir);
        const baseUrl = resolveLiveChatBaseUrl(process.env, settings);
        try {
          if (!section && (req.method === 'GET' || req.method === 'HEAD')) {
            sendJson(res, 200, await collectLiveChatStatus({
              force: true,
              baseUrl,
              settings,
              workspaceRoot,
            }));
            return;
          }
          // Pipecat bot lifecycle retired — browser-native voice needs no daemon.
          if (section === 'server' && ['start', 'stop', 'restart'].includes(parts[2]) && req.method === 'POST') {
            const status = await collectLiveChatStatus({
              force: true,
              baseUrl,
              settings,
              workspaceRoot,
            });
            sendJson(res, 410, {
              ok: false,
              retired: true,
              error: 'Pipecat Live Chat bot is retired. Voice runs in the browser — use Dev Tools › Live Chat for providers and models.',
              status,
            });
            return;
          }
          if (section === 'settings' && (req.method === 'GET' || req.method === 'HEAD')) {
            sendJson(res, 200, {
              ...normalizeLiveChatSettings(settings.liveChat),
              resolvedBaseUrl: baseUrl,
            });
            return;
          }
          if (section === 'settings' && req.method === 'PUT') {
            let body = {};
            try {
              const raw = await readBody(req, 64_000);
              body = raw.trim() ? JSON.parse(raw) : {};
            } catch (err) {
              sendJson(res, err?.code === 'ELARGE' ? 413 : 400, { error: 'invalid json body' });
              return;
            }
            const patchKeys = [
              'transport', 'tts', 'baseUrl', 'gender', 'voice', 'expressiveness',
              'sttProvider', 'ttsProvider', 'vadProvider', 'offlineOnly', 'language',
              'autoSpeak', 'interruptible', 'speechRate', 'whisperModel',
            ];
            const patch = {};
            for (const key of patchKeys) {
              if (body[key] !== undefined) patch[key] = body[key];
            }
            const next = normalizeLiveChatSettings({
              ...settings.liveChat,
              ...patch,
            });
            const saved = saveMonitorSettings(dataDir, { liveChat: next });
            try { refreshMonitorArtifacts(dataDir, { origin: '' }); } catch { /* best-effort */ }
            sendJson(res, 200, {
              ...normalizeLiveChatSettings(saved.liveChat),
              resolvedBaseUrl: resolveLiveChatBaseUrl(process.env, saved),
            });
            return;
          }
          if (section === 'session' && req.method === 'POST') {
            sendJson(res, 410, {
              error: 'Voice sessions are browser-native — no /live-chat/session mint. Use the Live button in chat.',
              retired: true,
              mode: 'browser',
            });
            return;
          }
          if (section === 'transcript' && req.method === 'POST') {
            let body = {};
            try {
              const raw = await readBody(req, 200_000);
              body = raw.trim() ? JSON.parse(raw) : {};
            } catch (err) {
              sendJson(res, err?.code === 'ELARGE' ? 413 : 400, { error: 'invalid json body' });
              return;
            }
            const role = body.role === 'assistant' ? 'assistant' : 'user';
            const text = typeof body.text === 'string' ? body.text : '';
            let sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
            let harness = typeof body.harness === 'string' ? body.harness.trim() : '';
            const queueKey = typeof body.queueKey === 'string' ? body.queueKey.trim() : '';
            if ((!sessionId || !harness) && queueKey.includes(':')) {
              const ref = resolveSessionRef(dataDir, queueKey);
              sessionId = sessionId || ref?.id || queueKey.slice(queueKey.indexOf(':') + 1);
              harness = harness || ref?.harness || queueKey.slice(0, queueKey.indexOf(':'));
            }
            const written = appendLiveChatTranscript(dataDir, {
              sessionId,
              harness: harness || undefined,
              queueKey: queueKey || null,
              role,
              text,
            });
            if (!written) {
              sendJson(res, 404, {
                error: 'session not found or empty transcript',
                sessionId: sessionId || null,
                queueKey: queueKey || null,
              });
              return;
            }
            sendJson(res, 200, { ok: true, session: written });
            return;
          }
          if (section === 'rtc' && req.method === 'POST') {
            sendJson(res, 410, {
              error: 'WebRTC Live Chat transport is retired. Audio stays in the browser.',
              retired: true,
              mode: 'browser',
            });
            return;
          }
          sendJson(res, section ? 405 : 404, { error: section ? 'method not allowed' : 'not found' });
          return;
        } catch (err) {
          const code = err?.code === 'ECONN' || err?.status === 0 ? 503
            : err?.status >= 400 && err?.status < 600 ? err.status
              : 500;
          sendJson(res, code, { error: err?.message || 'live-chat api failed' });
          return;
        }
      }
    }

    // Sidebar Explorer: one bounded walk of the workspace source tree. Depth and
    // entry caps come from the query so a huge folder can never blow up the
    // response; VCS and build output are skipped server-side, and any folder over
    // 50 entries (node_modules, a data dump) comes back as a counted stub. `path`
    // loads one such folder's children on demand — the parent row is always in the
    // payload, so the UI can offer the click that triggers this request.
    // Cheap fingerprint for Explorer soft-refresh. Bumped on create/delete only
    // (see tree-rev.mjs) so overwriting an open file does not re-walk the tree.
    if (url.pathname === '/files/rev' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, { ok: true, ...getWorkspaceTreeRev() });
      return;
    }

    if (url.pathname === '/files' && (req.method === 'GET' || req.method === 'HEAD')) {
      const pathParam = url.searchParams.get('path');
      const opts = {
        ...(Number(url.searchParams.get('depth')) > 0
          ? { maxDepth: Number(url.searchParams.get('depth')) }
          : {}),
        ...(Number(url.searchParams.get('entries')) > 0
          ? { maxEntries: Number(url.searchParams.get('entries')) }
          : {}),
        ...(pathParam ? { path: pathParam } : {}),
      };
      const tree = collectWorkspaceTree(workspaceRoot, opts);
      sendJson(res, 200, { ...tree, rev: getWorkspaceTreeRev().rev });
      return;
    }

    // Sidebar Search: file and folder NAMES across the same workspace the Explorer
    // walks, with the same skip rules. Unlike the tree this walk descends into
    // folders the tree left as counted stubs — a name search has to see every
    // name to answer at all — so it runs on its own name budget and match cap,
    // and `truncated` says the list is partial rather than the whole workspace
    // being searched. `path` scopes the search to one folder.
    if (url.pathname === '/search' && (req.method === 'GET' || req.method === 'HEAD')) {
      const q = String(url.searchParams.get('q') ?? '').trim();
      if (!q) {
        sendJson(res, 400, { error: 'q is required' });
        return;
      }
      const scopeParam = url.searchParams.get('path');
      const searchOpts = {
        query: q,
        ...(scopeParam ? { path: scopeParam } : {}),
        ...(Number(url.searchParams.get('limit')) > 0
          ? { maxResults: Number(url.searchParams.get('limit')) }
          : {}),
      };
      sendJson(res, 200, searchWorkspaceFiles(workspaceRoot, searchOpts));
      return;
    }

    // Sidebar Search: text inside workspace files (not just names). Same sandbox
    // as agent grep; include/exclude globs and Aa / whole-word / regex flags.
    if (url.pathname === '/grep' && (req.method === 'GET' || req.method === 'HEAD')) {
      const q = String(url.searchParams.get('q') ?? '');
      if (!String(q).trim()) {
        sendJson(res, 400, { ok: false, error: 'q is required' });
        return;
      }
      const result = searchWorkspaceContent(workspaceRoot, {
        query: q,
        path: url.searchParams.get('path') || '',
        regex: url.searchParams.get('regex') === '1',
        matchCase: url.searchParams.get('case') === '1',
        wholeWord: url.searchParams.get('word') === '1',
        include: url.searchParams.get('include') || '',
        exclude: url.searchParams.get('exclude') || '',
        ...(Number(url.searchParams.get('limit')) > 0
          ? { maxHits: Number(url.searchParams.get('limit')) }
          : {}),
      });
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }

    if (url.pathname === '/grep/replace' && req.method === 'POST') {
      let body = {};
      try {
        const raw = await readBody(req, 200_000);
        body = raw.trim() ? JSON.parse(raw) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { ok: false, error: 'expected a JSON object' });
          return;
        }
      } catch (err) {
        if (err && err.code === 'ELARGE') {
          sendJson(res, 413, { ok: false, error: 'body too large' });
          return;
        }
        sendJson(res, 400, { ok: false, error: 'invalid json body' });
        return;
      }
      const result = replaceWorkspaceContent(workspaceRoot, {
        query: String(body.query ?? body.q ?? ''),
        replacement: body.replacement == null ? '' : String(body.replacement),
        regex: Boolean(body.regex),
        matchCase: Boolean(body.matchCase ?? body.case),
        wholeWord: Boolean(body.wholeWord ?? body.word),
        include: String(body.include || ''),
        exclude: String(body.exclude || ''),
        dryRun: Boolean(body.dryRun),
        paths: Array.isArray(body.paths) ? body.paths.map(String) : null,
      });
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }

    // Console editor: one workspace file at a time. Path is sandboxed the same
    // way as agent file tools — never absolute, never outside workspaceRoot.
    if (url.pathname === '/file' && (req.method === 'GET' || req.method === 'HEAD')) {
      const pathParam = String(url.searchParams.get('path') ?? '').trim();
      const result = readWorkspaceFile(workspaceRoot, pathParam);
      if (!result.ok) {
        const status = result.code === 'ENOENT' ? 404
          : result.code === 'EPERM' || result.code === 'EBINARY' || result.code === 'EISDIR' ? 403
          : result.code === 'ELARGE' ? 413
          : 400;
        sendJson(res, status, { ok: false, error: result.error, code: result.code });
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    if (url.pathname === '/file' && req.method === 'PUT') {
      const pathParam = String(url.searchParams.get('path') ?? '').trim();
      let body = {};
      try {
        const raw = await readBody(req, 1_100_000);
        body = raw.trim() ? JSON.parse(raw) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { ok: false, error: 'expected a JSON object', code: 'EINVAL' });
          return;
        }
      } catch (err) {
        if (err && err.code === 'ELARGE') {
          sendJson(res, 413, { ok: false, error: 'body too large', code: 'ELARGE' });
          return;
        }
        sendJson(res, 400, { ok: false, error: 'invalid json body', code: 'EINVAL' });
        return;
      }
      const result = writeWorkspaceFile(workspaceRoot, pathParam, body.contents);
      if (!result.ok) {
        const status = result.code === 'EPERM' || result.code === 'EISDIR' ? 403
          : result.code === 'ELARGE' ? 413
          : 400;
        sendJson(res, status, { ok: false, error: result.error, code: result.code });
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    if (url.pathname === '/ready' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, collectWorkspaceReady(repoRoot, { force: true }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/settings') {
      let patch = {};
      try {
        // Avatar data URLs need headroom beyond the default 64KB body cap.
        const raw = await readBody(req, 200_000);
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
          ...(patch.agentAvatar !== undefined ? { agentAvatar: String(patch.agentAvatar ?? '') } : {}),
          // The Default endpoint's model list and the extra endpoint list pass
          // through untouched: normalizeMonitorSettings owns their shape (it
          // splits the comma-delimited field itself) and settingsToDisk owns the
          // per-endpoint credential encryption, so no key can leave as plaintext.
          ...(patch.agentModels !== undefined ? { agentModels: patch.agentModels } : {}),
          ...(patch.agentEndpoints !== undefined ? { agentEndpoints: patch.agentEndpoints } : {}),
          ...(patch.liveChat !== undefined
            ? { liveChat: normalizeLiveChatSettings(patch.liveChat) }
            : {}),
        };
        // Omit agentApiKey from the patch to leave the existing encrypted secret unchanged.
        // Empty string clears it. Legacy agentAuthToken maps to agentApiKey when present.
        if (typeof patch.agentApiKey === 'string') {
          update.agentApiKey = patch.agentApiKey;
        } else if (typeof patch.agentAuthToken === 'string') {
          update.agentApiKey = patch.agentAuthToken;
        }
        // Console auth (Settings → Auth). Password plaintext is hashed here; omit
        // secrets to keep prior values (same pattern as agent API keys).
        if (patch.auth && typeof patch.auth === 'object') {
          const authPatch = { ...patch.auth };
          if (authPatch.local && typeof authPatch.local === 'object') {
            const local = { ...authPatch.local };
            if (typeof local.password === 'string') {
              if (local.password) local.passwordHash = hashPassword(local.password);
              delete local.password;
            }
            authPatch.local = local;
          }
          update.auth = mergeAuthPatch(
            loadMonitorSettings(dataDir).auth,
            authPatch,
          );
        }
        const settings = saveMonitorSettings(dataDir, update);
        // Push settings into monitor-data.js so the console poll cannot overwrite
        // the POST response with a stale endpoints snapshot.
        try { refreshMonitorArtifacts(dataDir, { origin: '' }); } catch { /* best-effort */ }
        sendJson(res, 200, publicSettings(settings));
      } catch (err) {
        const locked = err && err.code === 'ELOCK';
        sendJson(res, locked ? 503 : 500, { error: locked ? 'monitor lock timeout' : 'settings save failed' });
      }
      return;
    }

    // Kusă chat transcripts (sidecar files under .kusa/agents/<id>/chat.json).
    if ((url.pathname === '/kusa/agents' || url.pathname === '/kusa/sessions') && (req.method === 'GET' || req.method === 'HEAD')) {
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
    // The running loop re-reads job.options before every model step AND every
    // tool call, so the change takes effect on the very next gated call — and
    // the gate settles an ask that is already waiting under the new Rule.
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
      let nextRule = '';
      if (patch.approvalMode != null && String(patch.approvalMode).trim()) {
        nextRule = normalizeApprovalMode(patch.approvalMode);
        job.options.approvalMode = nextRule;
      }
      // A Rule the user picks while an approval is on screen is a decision about
      // THAT call, not only the next one. The loop is blocked inside the gated
      // tool call while the ask waits, so it cannot reach its own applyLiveOptions
      // to hand the new rule to the gate — serve owns the wait, so it settles the
      // asks still open for this turn here. Allow runs them, Deny blocks them, and
      // the gate re-emits each id settled, so the UI row stops counting down and
      // says which rule moved. Ask rules keep the wait open: only their timeout
      // default moved, and a human can still answer.
      const settledApprovals = [];
      if (nextRule === 'allow' || nextRule === 'deny') {
        for (const id of [...(approvalsByQueueKey.get(queueKey) || [])]) {
          const pending = pendingApprovals.get(id);
          if (!pending) continue;
          try {
            pending.decide({
              ruleChanged: true,
              allowed: nextRule === 'allow',
              rule: nextRule,
              reason: `approval rule switched to ${nextRule}`,
            });
            settledApprovals.push(id);
          } catch { /* already settled */ }
        }
        approvalsByQueueKey.delete(queueKey);
      }
      sendJson(res, 200, {
        ok: true,
        options: { ...job.options },
        settledApprovals,
      });
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/kusa/agents' || url.pathname === '/kusa/sessions')) {
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
          provider: typeof body.provider === 'string' ? body.provider : 'kusa',
          kind: typeof body.kind === 'string' ? body.kind : 'standard',
          workflowId: typeof body.workflowId === 'string' ? body.workflowId : null,
        });
        sendJson(res, 200, { session });
      } catch (err) {
        sendJson(res, err?.code === 'EINVAL' ? 400 : 500, { error: err?.message || 'create failed' });
      }
      return;
    }

    if (req.method === 'PUT' && (url.pathname === '/kusa/agents' || url.pathname === '/kusa/sessions')) {
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

    // Central agent profiles (.kusa/agent-profiles/) — source of truth for workflow roles.
    if (url.pathname === '/kusa/agent-profiles' && (req.method === 'GET' || req.method === 'HEAD')) {
      try {
        ensureAgentProfilesSeeded(dataDir);
        sendJson(res, 200, { profiles: listAgentProfiles(dataDir) });
      } catch (err) {
        sendJson(res, 500, { error: err?.message || 'agent profiles list failed' });
      }
      return;
    }
    if (url.pathname === '/kusa/agent-profiles' && req.method === 'POST') {
      try {
        const raw = await readBody(req, 200_000);
        const body = raw.trim() ? JSON.parse(raw) : {};
        const saved = writeAgentProfile(dataDir, body);
        sendJson(res, 201, { profile: saved });
      } catch (err) {
        const status = err?.code === 'EINVAL' ? 400 : (err?.code === 'ELARGE' ? 413 : 500);
        sendJson(res, status, { error: err?.message || 'agent profile create failed' });
      }
      return;
    }
    if (/^\/kusa\/agent-profiles\/[^/]+$/.test(url.pathname)) {
      const profileId = decodeURIComponent(url.pathname.slice('/kusa/agent-profiles/'.length)).trim();
      if (req.method === 'GET' || req.method === 'HEAD') {
        try {
          const profile = readAgentProfile(dataDir, profileId);
          if (!profile) {
            sendJson(res, 404, { error: 'agent profile not found' });
            return;
          }
          sendJson(res, 200, { profile });
        } catch (err) {
          sendJson(res, 500, { error: err?.message || 'agent profile read failed' });
        }
        return;
      }
      if (req.method === 'PUT') {
        try {
          const raw = await readBody(req, 200_000);
          const body = raw.trim() ? JSON.parse(raw) : {};
          const saved = writeAgentProfile(dataDir, { ...body, id: profileId });
          sendJson(res, 200, { profile: saved });
        } catch (err) {
          const status = err?.code === 'EINVAL' ? 400 : (err?.code === 'ELARGE' ? 413 : 500);
          sendJson(res, status, { error: err?.message || 'agent profile save failed' });
        }
        return;
      }
      if (req.method === 'DELETE') {
        try {
          sendJson(res, 200, deleteAgentProfile(dataDir, profileId));
        } catch (err) {
          const status = err?.code === 'ENOENT' ? 404 : (err?.code === 'EINVAL' ? 400 : 500);
          sendJson(res, status, { error: err?.message || 'agent profile delete failed' });
        }
        return;
      }
    }

    // Local orchestration workflows (seeded under .kusa/workflows/).
    if (url.pathname === '/kusa/workflows' && (req.method === 'GET' || req.method === 'HEAD')) {
      try {
        ensureWorkflowsSeeded(dataDir);
        const workflows = listWorkflows(dataDir).map((wf) => {
          const source = readWorkflowSource(dataDir, wf.id);
          return {
            id: wf.id,
            name: wf.name,
            label: wf.name,
            description: wf.description,
            provider: 'kusa',
            ...(wf.runtime ? { runtime: wf.runtime } : {}),
            // Name list kept for older callers; full role configs power tool-stats grouping.
            roles: Object.keys(wf.roles || {}),
            roleConfigs: wf.roles || {},
            // Unresolved bindings for the workflow editor (profile refs).
            roleBindings: source?.roles || {},
          };
        });
        sendJson(res, 200, { workflows });
      } catch (err) {
        sendJson(res, 500, { error: err?.message || 'workflows list failed' });
      }
      return;
    }

    // One workflow: GET source+resolved, PUT save bindings.
    if (
      /^\/kusa\/workflows\/[^/]+$/.test(url.pathname)
      && !url.pathname.endsWith('/graph')
    ) {
      const workflowId = decodeURIComponent(url.pathname.slice('/kusa/workflows/'.length)).trim();
      if (req.method === 'GET' || req.method === 'HEAD') {
        try {
          const resolved = readWorkflow(dataDir, workflowId);
          const source = readWorkflowSource(dataDir, workflowId);
          if (!resolved || !source) {
            sendJson(res, 404, { error: 'workflow not found' });
            return;
          }
          sendJson(res, 200, {
            workflow: {
              id: resolved.id,
              name: resolved.name,
              label: resolved.name,
              description: resolved.description,
              ...(resolved.runtime ? { runtime: resolved.runtime } : {}),
              roles: Object.keys(resolved.roles || {}),
              roleConfigs: resolved.roles || {},
              roleBindings: source.roles || {},
            },
          });
        } catch (err) {
          sendJson(res, 500, { error: err?.message || 'workflow read failed' });
        }
        return;
      }
      if (req.method === 'PUT') {
        try {
          const raw = await readBody(req, 200_000);
          const body = raw.trim() ? JSON.parse(raw) : {};
          const saved = writeWorkflow(dataDir, {
            id: workflowId,
            name: body.name,
            description: body.description,
            runtime: body.runtime,
            roles: body.roles || body.roleBindings || {},
          });
          const source = readWorkflowSource(dataDir, saved.id);
          sendJson(res, 200, {
            workflow: {
              id: saved.id,
              name: saved.name,
              label: saved.name,
              description: saved.description,
              ...(saved.runtime ? { runtime: saved.runtime } : {}),
              roles: Object.keys(saved.roles || {}),
              roleConfigs: saved.roles || {},
              roleBindings: source?.roles || {},
            },
          });
        } catch (err) {
          const status = err?.code === 'EINVAL' ? 400 : (err?.code === 'ELARGE' ? 413 : 500);
          sendJson(res, status, { error: err?.message || 'workflow save failed' });
        }
        return;
      }
    }

    // LangGraph drawable for a workflow (structure only — for the info modal).
    if (
      (req.method === 'GET' || req.method === 'HEAD')
      && /^\/kusa\/workflows\/[^/]+\/graph$/.test(url.pathname)
    ) {
      try {
        const workflowId = decodeURIComponent(
          url.pathname.slice('/kusa/workflows/'.length).replace(/\/graph$/, ''),
        ).trim();
        ensureWorkflowsSeeded(dataDir);
        const wf = listWorkflows(dataDir).find((entry) => entry.id === workflowId);
        if (!wf) {
          sendJson(res, 404, { error: 'workflow not found' });
          return;
        }
        if (String(wf.runtime || '').toLowerCase() !== 'langgraph') {
          sendJson(res, 404, { error: 'workflow has no LangGraph runtime' });
          return;
        }
        const graph = drawableWorkflowGraph(workflowId);
        if (!graph) {
          sendJson(res, 404, { error: 'no drawable graph for this workflow' });
          return;
        }
        sendJson(res, 200, { graph });
      } catch (err) {
        sendJson(res, 500, { error: err?.message || 'workflow graph failed' });
      }
      return;
    }

    // Workspace plans (shared across Agents).
    if (url.pathname === '/kusa/plans' && (req.method === 'GET' || req.method === 'HEAD')) {
      try {
        const plans = listPlans(dataDir).map(planSummary);
        sendJson(res, 200, { plans });
      } catch (err) {
        sendJson(res, 500, { error: err?.message || 'plans list failed' });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/kusa/plans') {
      let body = {};
      try {
        const raw = await readBody(req, 512_000);
        body = raw.trim() ? JSON.parse(raw) : {};
      } catch (err) {
        sendJson(res, err?.code === 'ELARGE' ? 413 : 400, { error: 'invalid json body' });
        return;
      }
      try {
        const plan = createPlan(dataDir, body);
        sendJson(res, 200, { plan });
      } catch (err) {
        sendJson(res, err?.code === 'EINVAL' ? 400 : 500, { error: err?.message || 'create plan failed' });
      }
      return;
    }

    if (req.method === 'DELETE' && /^\/kusa\/plans\/[^/]+$/.test(url.pathname) && url.pathname !== '/kusa/plans/') {
      const planId = decodeURIComponent(url.pathname.slice('/kusa/plans/'.length)).trim();
      if (!planId || planId.includes('/')) {
        sendJson(res, 400, { error: 'invalid plan id' });
        return;
      }
      const existing = readPlan(dataDir, planId);
      if (!existing) {
        sendJson(res, 404, { error: 'plan not found' });
        return;
      }
      const ok = deletePlan(dataDir, planId);
      sendJson(res, ok ? 200 : 500, ok ? { ok: true, id: planId } : { error: 'delete failed' });
      return;
    }

    // Resume an already-approved plan (Approve before continue-on-approve existed).
    if (req.method === 'POST' && /^\/kusa\/plans\/[^/]+\/continue$/.test(url.pathname)) {
      const planId = decodeURIComponent(url.pathname.slice('/kusa/plans/'.length).replace(/\/continue$/, '')).trim();
      const plan = readPlan(dataDir, planId);
      if (!plan) {
        sendJson(res, 404, { error: 'plan not found' });
        return;
      }
      if (String(plan.status || '') !== 'approved' && String(plan.status || '') !== 'executing') {
        sendJson(res, 400, { error: `plan status is "${plan.status}" — Approve it first` });
        return;
      }
      let continueBody = {};
      try {
        const raw = await readBody(req, 64_000);
        continueBody = raw.trim() ? JSON.parse(raw) : {};
      } catch {
        continueBody = {};
      }
      try {
        const continued = await resumeAfterPlanApproval({
          dataDir,
          plan,
          workspaceRoot,
          startTurn: startAssignedTurn,
          prompt: typeof continueBody?.prompt === 'string' ? continueBody.prompt : '',
          assignToAgentId: typeof continueBody?.assignToAgentId === 'string' ? continueBody.assignToAgentId : '',
          detachWorkflow: continueBody?.detachWorkflow === true,
        });
        const next = readPlan(dataDir, planId) || plan;
        sendJson(res, continued?.ok === false ? 409 : 200, { plan: next, continued });
      } catch (err) {
        sendJson(res, 500, { error: err?.message || 'continue failed' });
      }
      return;
    }

    if (url.pathname.startsWith('/kusa/plans/') && url.pathname !== '/kusa/plans/') {
      const planId = decodeURIComponent(url.pathname.slice('/kusa/plans/'.length)).trim();
      if (!planId || planId.includes('/')) {
        sendJson(res, 400, { error: 'invalid plan id' });
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const plan = readPlan(dataDir, planId);
        if (!plan) {
          sendJson(res, 404, { error: 'plan not found' });
          return;
        }
        sendJson(res, 200, { plan });
        return;
      }
      if (req.method === 'PUT') {
        let body = {};
        try {
          const raw = await readBody(req, 512_000);
          body = raw.trim() ? JSON.parse(raw) : {};
        } catch (err) {
          sendJson(res, err?.code === 'ELARGE' ? 413 : 400, { error: 'invalid json body' });
          return;
        }
        try {
          const before = readPlan(dataDir, planId);
          // Approve / assign options ride on the PUT body but are not plan fields.
          const {
            continue: forceContinueFlag,
            prompt: approvePrompt,
            assignToAgentId,
            assignToSessionId,
            detachWorkflow,
            ...planPatch
          } = body && typeof body === 'object' ? body : {};

          const assignSessionId = typeof assignToSessionId === 'string'
            ? assignToSessionId.trim()
            : '';
          if (assignSessionId) {
            const target = readChatSession(dataDir, assignSessionId);
            const targetCfg = readSessionConfig(dataDir, assignSessionId) || target?.options || {};
            const parentId = String(targetCfg.parentId || target?.parentId || '').trim();
            const orchId = parentId || assignSessionId;
            planPatch.createdByAgentId = assignSessionId;
            planPatch.orchestratorAgentId = orchId;
            if (detachWorkflow === true) {
              planPatch.workflowId = '';
            } else {
              const wf = String(targetCfg.workflowId || target?.workflowId || '').trim();
              if (wf) planPatch.workflowId = wf;
            }
          }

          const plan = updatePlan(dataDir, planId, planPatch);
          const becameApproved = String(plan?.status || '') === 'approved'
            && String(before?.status || '') !== 'approved';
          const statusApproved = String(plan?.status || '') === 'approved'
            || String(plan?.status || '') === 'executing';
          // `continue: false` skips auto-assign (status reset / content-only edits).
          const skipContinue = forceContinueFlag === false;
          const forceContinue = forceContinueFlag === true;

          // Auto-continue only when a plan-execute orchestrator is actually
          // waiting — never for a plain status flip on a standard Agent.
          async function orchestratorIsAwaiting(sessionOrId) {
            const id = typeof sessionOrId === 'string'
              ? sessionOrId.trim()
              : String(sessionOrId?.id || '').trim();
            if (!id) return false;
            const row = typeof sessionOrId === 'object' && sessionOrId?.id
              ? sessionOrId
              : (readChatSession(dataDir, id) || { id });
            const cfg = readSessionConfig(dataDir, id) || row?.options || {};
            if (!isPlanExecuteOrchestrator(row, cfg)) return false;
            const key = row?.key || `kusa:${id}`;
            return isSessionAwaitingPlanApproval(dataDir, key, {
              workspaceRoot,
              startTurn: startAssignedTurn,
            });
          }

          let assignedToWaitingSession = false;
          if (!skipContinue && assignSessionId && statusApproved) {
            const target = readChatSession(dataDir, assignSessionId);
            const targetCfg = readSessionConfig(dataDir, assignSessionId) || target?.options || {};
            const parentId = String(targetCfg.parentId || target?.parentId || '').trim();
            assignedToWaitingSession = await orchestratorIsAwaiting(parentId || target || assignSessionId);
          }

          let awaitingLinkedOrchestrator = false;
          if (!skipContinue && becameApproved && statusApproved && !assignedToWaitingSession) {
            const orchId = String(plan.orchestratorAgentId || '').trim();
            const creatorId = String(plan.createdByAgentId || '').trim();
            // Only the explicitly linked orchestrator/creator — do not fall back
            // to an unrelated plan-execute parent via resolveOrchestratorForPlan.
            if (orchId) {
              awaitingLinkedOrchestrator = await orchestratorIsAwaiting(orchId);
            } else if (creatorId) {
              const creator = readChatSession(dataDir, creatorId);
              const creatorCfg = readSessionConfig(dataDir, creatorId) || creator?.options || {};
              const parentId = String(creatorCfg.parentId || creator?.parentId || '').trim();
              awaitingLinkedOrchestrator = await orchestratorIsAwaiting(parentId || creator || creatorId);
            }
          }

          let continued = null;
          const shouldContinue = !skipContinue && (
            (forceContinue && statusApproved)
            || assignedToWaitingSession
            || awaitingLinkedOrchestrator
          );
          if (shouldContinue && statusApproved) {
            try {
              // Explicit agent override only — session assign links the plan then
              // resumes the LangGraph interrupt on the linked orchestrator.
              const continueAssignId = typeof assignToAgentId === 'string'
                ? assignToAgentId.trim()
                : '';
              continued = await resumeAfterPlanApproval({
                dataDir,
                plan,
                workspaceRoot,
                startTurn: startAssignedTurn,
                prompt: typeof approvePrompt === 'string' ? approvePrompt : '',
                assignToAgentId: continueAssignId,
                detachWorkflow: detachWorkflow === true,
              });
              // Prefer the post-continue plan (status may flip to executing).
              if (continued?.ok && !continued.skipped) {
                const next = readPlan(dataDir, planId);
                sendJson(res, 200, { plan: next || plan, continued });
                return;
              }
            } catch (err) {
              continued = { ok: false, error: err?.message || String(err) };
            }
          }
          sendJson(res, 200, { plan, ...(continued ? { continued } : {}) });
        } catch (err) {
          sendJson(res, err?.code === 'ENOENT' ? 404 : 400, { error: err?.message || 'update plan failed' });
        }
        return;
      }
    }

    if (req.method === 'POST' && (url.pathname === '/kusa/agents/migrate' || url.pathname === '/kusa/sessions/migrate')) {
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
      && (url.pathname.startsWith('/kusa/agents/') || url.pathname.startsWith('/kusa/sessions/'))
    ) {
      const idPrefix = url.pathname.startsWith('/kusa/agents/') ? '/kusa/agents/' : '/kusa/sessions/';
      const id = decodeURIComponent(url.pathname.slice(idPrefix.length)).trim();
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
      // Include escalate in the catalog so Tools panel discovers it; the model
      // only receives the schema on orchestrated sessions.
      const groups = agentToolGroups(url.searchParams.get('mode'), { orchestrated: true })
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

    // GET /kusa/models — models EVERY active endpoint has, grouped by endpoint
    // name: the composer's Model picker lists all of them under the endpoint they
    // belong to, so the group heading is what tells the user which credentials a
    // pick would use. Each endpoint with a base URL is active — its group merges
    // declared ids with what its own GET /models advertises. `groups` is what the
    // picker needs; `models` stays the flat union so an older page still works.
    if (req.method === 'GET' && url.pathname === '/kusa/models') {
      const settings = loadMonitorSettings(dataDir);
      const listed = await listAgentModelGroups(settings);
      const withCapability = (ids) => (
        Array.isArray(ids) ? ids : []
      ).map((id) => ({ id, vision: supportsVision(id) }));
      sendJson(res, 200, {
        backend: settings?.agentBackend === 'opencode' ? 'opencode' : 'native',
        default: listed.default,
        groups: listed.groups.map((group) => ({
          name: group.name,
          // Empty for Default; extras carry their settings id so the composer
          // can send it back on POST /kusa/chat and route probed-only picks.
          endpointId: String(group.endpointId || ''),
          models: withCapability(group.models),
        })),
        models: withCapability(listed.groups.flatMap((group) => group.models)),
      });
      return;
    }

    // GET /kusa/context — live context-window meter for the active endpoint.
    // When that endpoint is Strata, reads GET /slots (n_prompt_tokens / n_ctx)
    // so the composer ContextRing shows the server's real usage instead of the
    // local char/4 estimate. Non-Strata endpoints return { strata: false }.
    if (req.method === 'GET' && url.pathname === '/kusa/context') {
      const settings = loadMonitorSettings(dataDir);
      const model = String(url.searchParams.get('model') || settings?.agentModel || '').trim();
      const endpointId = String(url.searchParams.get('endpointId') || '').trim();
      const endpoint = resolveAgentEndpoint({
        ...settings,
        agentModel: model || settings?.agentModel,
        agentEndpointId: endpointId,
      });
      if (!endpoint.baseUrl) {
        sendJson(res, 200, { ok: true, strata: false });
        return;
      }
      const ctx = await readStrataContext(endpoint.baseUrl, endpoint.headers);
      sendJson(res, 200, {
        ok: true,
        ...ctx,
        endpointId,
        baseUrl: endpoint.baseUrl,
      });
      return;
    }

    // Resolve a pending approval for a gated tool. Body: { id, allowed }.
    // The answer settles THIS call and nothing else. It is not a Rule: it does
    // not restamp the running turn's live options and it is never written into
    // the session record — the Rules picker (POST /kusa/chat/options) is the
    // only thing that carries a sticky preference, and that is where a user's
    // newest word about the Rule lands. Stamping the click here used to flip
    // the Rule for the rest of the session behind a pick the user never made.
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
      pending.decide({ allowed });
      sendJson(res, 200, { id, allowed });
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
    //                             (interrupts the in-flight model call)
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
        // behaves exactly as if the user had pressed Send at that moment —
        // including the files they had attached to it.
        const options = {
          mode: String(patch?.options?.mode || ''),
          model: String(patch?.options?.model || ''),
          endpointId: String(patch?.options?.endpointId || ''),
          approvalMode: String(patch?.options?.approvalMode || ''),
          ...(normalizeAttachments(patch?.options?.attachments).length
            ? { attachments: normalizeAttachments(patch?.options?.attachments) }
            : {}),
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
        // The budget has to hold the composer's files too: an attachment is
        // carried inline as base64, so the body limit follows ATTACHMENT_LIMITS
        // rather than staying at "a prompt and a little history".
        const raw = await readBody(req, ATTACHMENT_LIMITS.dataUrlChars * 4);
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
      // Files the composer attached. A prompt may be nothing but a picture,
      // so "prompt is required" only applies when there is no attachment either.
      const attachments = normalizeAttachments(body.attachments);
      if (!prompt && !attachments.length) {
        sendJson(res, 400, { error: 'prompt or attachments are required' });
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
      // Which Endpoints card the Model pick sat under (agentEndpoints[].id).
      // Empty / absent = Default (agentBaseUrl). Required for probed-only picks
      // that were never typed into that card's Models field.
      const requestedEndpointId = typeof body.endpointId === 'string'
        ? body.endpointId.trim().slice(0, 80)
        : '';
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
      // Prefer queueKey (`cursor:<id>`) so a bare sessionId cannot resolve to a
      // shadow kusa/ folder created by an earlier mis-routed BYOK turn.
      const sessionRefKey = queueKey || chatSessionId;
      const existingChat = sessionRefKey
        ? readChatSession(dataDir, sessionRefKey)
        : null;
      // Cursor UI (and other IDE-owned) sessions are observe-only in Kusă —
      // prompting here would fork a separate CLI session and mix transcripts.
      if (isExternalChatSession(existingChat)) {
        const message = 'This session is owned by Cursor UI. Prompting is disabled in Kusă — continue the chat in Cursor.';
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
            code: 'EEXTERNAL',
          })}\n\n`);
          if (!res.writableEnded) res.end();
          return;
        }
        sendJson(res, 403, { error: message, code: 'EEXTERNAL' });
        return;
      }
      const chatProvider = resolveChatProvider(
        existingChat?.provider
        || existingChat?.options?.provider
        || existingChat?.harness
        || 'kusa',
      );
      const chatHarness = existingChat?.harness || chatProvider?.harness || 'kusa';
      const resolvedSessionId = existingChat?.id || chatSessionId;
      const useCaoTurn = Boolean(chatProvider && isCaoChatProvider(chatProvider.id));

      const hooks = createKusaHookEmitter({
        dataDir,
        sessionId: resolvedSessionId,
        workspaceRoot,
        harness: chatHarness,
      });
      if (hooks.enabled) {
        if (body.sessionStart === true) hooks.sessionStart();
        // An attachment-only prompt has no words to record as a user prompt.
        if (prompt) hooks.userPrompt(prompt);
      }

      // Name the chat with the model. A brand-new row would otherwise be
      // labelled by its first prompt verbatim ("ok so basically the parser is
      // slow because…"), and the first prompt is the only moment what the
      // session is *about* is unambiguous — so the name is written here, once,
      // rather than left to the model deciding to call its tool mid-turn.
      // It runs BESIDE the turn (never awaited before it): the reply starts
      // immediately and the sidebar row changes when the name lands. The
      // monitor re-render is what tells the browser to re-read the session.
      // Skipped for agent-owned sessions (Cursor/CAO keep their own title) and
      // whenever a name already exists, so a chat is named once, not per turn.
      const alreadyNamed = Boolean(existingChat?.options?.name);
      const firstTurn = body.sessionStart === true || !existingChat?.messages?.length;
      if (firstTurn && !alreadyNamed && !useCaoTurn && chatHarness === 'kusa' && resolvedSessionId) {
        const scopedSettings = {
          ...settings,
          ...(requestedModel ? { agentModel: requestedModel } : {}),
          ...(requestedEndpointId ? { agentEndpointId: requestedEndpointId } : {}),
        };
        void (async () => {
          try {
            const titled = await requestSessionName({
              settings: scopedSettings,
              prompt,
              attachments,
            });
            if (!titled?.name) return;
            const applied = nameChatSession(dataDir, sessionRefKey, titled.name, chatHarness);
            if (!applied?.ok) return;
            try { refreshMonitorArtifacts(dataDir, { origin: '' }); } catch { /* best-effort */ }
          } catch { /* naming must never fail a turn */ }
        })();
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
          sessionId: resolvedSessionId,
          harness: chatHarness,
          prompt,
          promptMessageId: promptMessageId || null,
          mode: agentMode,
          approvalMode: initialApproval,
          attachments,
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

        if (useCaoTurn) {
          try {
            const caoPrompt = [
              prompt,
              attachments.length
                ? `\n\n[Attachments: ${attachments.map((a) => a.name || 'file').join(', ')}]`
                : '',
            ].join('').trim();
            const result = await runCaoChatTurn({
              dataDir,
              sessionId: resolvedSessionId,
              harness: chatHarness,
              provider: chatProvider.id,
              workspaceRoot,
              prompt: caoPrompt || prompt,
              model: requestedModel,
              signal: turnAbort.signal,
              onEvent: (ev) => {
                const type = ev?.type || 'message';
                if (type === 'done') return;
                if (type === 'content' && typeof ev.text === 'string') streamedText = ev.text;
                mirrorCliMonitorEvent(hooks, ev);
                ingestTurnEvent(job, ev);
                broadcastTurn(job, type, ev);
              },
            });
            streamedText = result?.text || streamedText;
            if (hooks.enabled) {
              try { hooks.afterAgentResponse(streamedText); } catch { /* ignore */ }
              try { hooks.agentStop({ stopReason: 'end_turn' }); } catch { /* ignore */ }
            }
            finishTurnJob(jobKey, {
              type: 'done',
              text: streamedText,
              backend: result?.backend || 'cao',
              provider: chatProvider.id,
              turnId: job.turnId,
              queued: visibleQueued(jobKey),
            });
          } catch (err) {
            const aborted = err?.name === 'AbortError' || turnAbort.signal.aborted || stopRequested.has(jobKey);
            if (aborted) {
              if (hooks.enabled) {
                try { hooks.agentStop({ stopReason: 'user_stop', status: 'stopped' }); } catch { /* ignore */ }
              }
              finishTurnJob(jobKey, {
                type: 'stopped',
                text: streamedText,
                stopped: true,
                turnId: job.turnId,
                queued: visibleQueued(jobKey),
              });
            } else {
              const message = err?.message || String(err) || 'CAO turn failed';
              finishTurnJob(jobKey, {
                type: 'error',
                text: streamedText || message,
                message,
                code: err?.code || 'ECAO',
                turnId: job.turnId,
                queued: visibleQueued(jobKey),
              });
            }
          }
          return;
        }

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
            endpointIdOverride: requestedEndpointId,
            approvalMode: initialApproval,
            // "Send now" while busy: Codex/OpenCode soft-steer — poll per chunk
            // and after each tool, soft-cancel the in-flight completion (keep
            // partial text + thinking), skip tools not yet started, inject
            // before the next model call. Stop remains a hard abort.
            onSteer: queueKey ? () => drainSteering(queueKey) : undefined,
            // Composer Mode / Rules while busy: POST /kusa/chat/options writes
            // job.options; the loop re-reads them before each model step and
            // each tool call, so a pick applies to the very next gated call.
            onOptions: () => ({ ...job.options }),
            attachments,
            // "Stop" while busy: POST /kusa/stop aborts this signal, and the
            // loop stops at its next step boundary (or cancels the stream).
            signal: turnAbort.signal,
            onApprove: (ask) => waitForApproval(ask, jobKey),
            onAsk: (ask) => waitForAsk(ask, jobKey),
            onAssignTurn: startAssignedTurn,
            onEscalateTurn: startAssignedTurn,
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
              if (type === 'approval_request' || type === 'ask_request') {
                relayChildGateEvent(job.sessionId || resolvedSessionId, jobKey, ev);
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
            // Settled error frame (like `stopped`): client treats it as a final
            // payload, persists error:true on the assistant row, and keeps the
            // user prompt + prior transcript. Do not prefix "Agent error:" —
            // the harness renders a styled card from the message body.
            finishTurnJob(jobKey, {
              type: 'error',
              message: err?.message || 'kusa chat failed',
              text: err?.message || 'kusa chat failed',
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
          endpointIdOverride: requestedEndpointId,
          approvalMode: approvalRules || settings?.agentApprovalMode,
          onSteer: queueKey ? () => drainSteering(queueKey) : undefined,
          signal: turnAbort.signal,
          onAssignTurn: startAssignedTurn,
          onEscalateTurn: startAssignedTurn,
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
      let force = false;
      try {
        const raw = await readBody(req);
        const parsed = raw.trim() ? JSON.parse(raw) : {};
        keys = Array.isArray(parsed.keys) ? parsed.keys : [];
        force = parsed.force === true;
      } catch (err) {
        if (err && err.code === 'ELARGE') {
          sendJson(res, 413, { error: 'body too large' });
          return;
        }
        sendJson(res, 400, { error: 'invalid json body; expected { "keys": ["harness:id", ...] }' });
        return;
      }
      try {
        const resolved = resolveAgentDeleteKeys(dataDir, keys);
        if (!resolved.keys.length) {
          sendJson(res, 400, {
            error: 'Subagents cannot be deleted on their own — delete the parent Agent instead',
            code: 'ESUBAGENT',
            blocked: resolved.blocked,
          });
          return;
        }
        const locked = plansBlockingAgentDelete(dataDir, resolved.keys);
        if (locked.length) {
          if (!force) {
            sendJson(res, 409, {
              error: `Delete the plan first: ${locked.map((p) => p.name || p.id).join(', ')}`,
              code: 'EPLAN_LOCK',
              plans: locked.map(planSummary),
            });
            return;
          }
          // Force delete: drop blocking plans, then wipe the sessions.
          for (const plan of locked) deletePlan(dataDir, plan.id);
        }
        const result = deleteSessions(dataDir, resolved.keys);
        // Drop session-bound held + steering; workspace parked stays claimable.
        let queueDirty = false;
        for (const key of resolved.keys) {
          const qk = String(key || '');
          if (!qk.startsWith('kusa:') || qk === WORKSPACE_QUEUE_KEY) continue;
          if (queuedMessages.delete(qk)) queueDirty = true;
          if (steeringMessages.delete(qk)) queueDirty = true;
        }
        if (queueDirty) persistQueues();
        sendJson(res, 200, {
          ...result,
          deletedPlans: force && locked.length ? locked.map((p) => p.id) : undefined,
        });
      } catch (err) {
        const locked = err && err.code === 'ELOCK';
        sendJson(res, locked ? 503 : 500, { error: locked ? 'monitor lock timeout' : 'delete failed' });
      }
      return;
    }

    if (req.method === 'DELETE') {
      const route = sessionRoute(url.pathname);
      if (route?.stem) {
        const stem = route.stem;
        const rels = new Set([
          `${AGENTS_DIR}/${stem}/${LANE_FILE}`,
          // Legacy stem-prefixed / harness-folder paths still referenced in older indexes.
          `${AGENTS_DIR}/${stem}/${stem}.json`,
          route.harness && route.harness !== AGENTS_DIR
            ? `${route.harness}/${stem}/${LANE_FILE}`
            : null,
          route.harness && route.harness !== AGENTS_DIR
            ? `${route.harness}/${stem}/${stem}.json`
            : null,
          route.harness && route.harness !== AGENTS_DIR
            ? `${route.harness}/${stem}.json`
            : null,
        ].filter(Boolean));
        let keys = [];
        try {
          const index = JSON.parse(await readFile(indexJsonPath(dataDir), 'utf8'));
          keys = Object.entries(index.sessionFiles || {})
            .filter(([, path]) => rels.has(String(path || '').split('\\').join('/')))
            .map(([key]) => key);
        } catch { /* index missing */ }
        if (!keys.length) {
          try {
            const lane = JSON.parse(await readFile(route.file, 'utf8'));
            if (lane?.key) keys = [lane.key];
            else if (lane?.id) keys = [laneKey(lane.harness || route.harness || 'kusa', lane.id)];
          } catch { /* ignore */ }
        }
        if (!keys.length && route.harness && route.harness !== AGENTS_DIR) {
          keys = [laneKey(route.harness, stem)];
        }
        // Stem deletes rarely carry a JSON body; `?force=1` matches the bulk
        // DELETE's `{ force: true }` and drops blocking plans before the wipe.
        const force = url.searchParams.get('force') === '1'
          || url.searchParams.get('force') === 'true';
        try {
          const resolved = resolveAgentDeleteKeys(dataDir, keys);
          if (!resolved.keys.length) {
            sendJson(res, 400, {
              error: 'Subagents cannot be deleted on their own — delete the parent Agent instead',
              code: 'ESUBAGENT',
              blocked: resolved.blocked,
            });
            return;
          }
          const locked = plansBlockingAgentDelete(dataDir, resolved.keys);
          if (locked.length) {
            if (!force) {
              sendJson(res, 409, {
                error: `Delete the plan first: ${locked.map((p) => p.name || p.id).join(', ')}`,
                code: 'EPLAN_LOCK',
                plans: locked.map(planSummary),
              });
              return;
            }
            for (const plan of locked) deletePlan(dataDir, plan.id);
          }
          const result = deleteSessions(dataDir, resolved.keys);
          let queueDirty = false;
          for (const key of resolved.keys) {
            const qk = String(key || '');
            if (!qk.startsWith('kusa:') || qk === WORKSPACE_QUEUE_KEY) continue;
            if (queuedMessages.delete(qk)) queueDirty = true;
            if (steeringMessages.delete(qk)) queueDirty = true;
          }
          if (queueDirty) persistQueues();
          sendJson(res, 200, {
            ...result,
            deletedPlans: force && locked.length ? locked.map((p) => p.id) : undefined,
          });
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
    if (url.pathname === '/dashboard.html') {
      res.writeHead(302, { Location: '/' }).end();
      return;
    }
    const route = routes[url.pathname]
      || iconRoute(url.pathname)
      || voiceModelRoute(url.pathname)
      || sessionRoute(url.pathname);
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

  // Live Chat WebSocket proxy retired — browser voice needs no WS to WSL.
  server.on('upgrade', (req, socket) => {
    let pathname = '/';
    try {
      const u = new NodeURL(req.url || '/', 'http://127.0.0.1');
      pathname = u.pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname === '/live-chat/ws') {
      try {
        socket.write(
          'HTTP/1.1 410 Gone\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n'
          + 'Live Chat WebSocket is retired. Voice runs in the browser.\r\n',
        );
      } catch { /* ignore */ }
    }
    socket.destroy();
  });

  return server;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/**
 * Serve flags. `--port` / `-p` overrides KUSA_PORT, which overrides 1424.
 * `--live` / `--hmr` asks for Vite Fast Refresh (see `serve-live.mjs`);
 * `--no-live` turns it off again, and the live supervisor passes that to the
 * API child so a restart never re-enters supervisor mode.
 */
export function resolveServeOptions(argv = process.argv.slice(2), env = process.env) {
  let explicit;
  let live = false;
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
    } else if (arg === '--live' || arg === '--hmr' || arg === '--live-reload') {
      live = true;
    } else if (arg === '--no-live' || arg === '--no-hmr') {
      live = false;
    } else {
      throw new Error(`kusa: unknown serve option ${arg}`);
    }
  }
  const raw = explicit ?? env.KUSA_PORT ?? env.COPILOT_MONITOR_PORT ?? '1424';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`kusa: invalid port ${raw}`);
  }
  return { port, live };
}

/** Back-compat: the port alone, as `kusa test` and callers expect. */
export function resolveServePort(argv = process.argv.slice(2), env = process.env) {
  return resolveServeOptions(argv, env).port;
}

/**
 * Hand `--live` to the supervisor in `serve-live.mjs`. Args are normalized here
 * so the child never re-parses a flag it does not own: the port is explicit and
 * watch mode is switched off one level down (`--no-live`).
 */
function delegateLiveServe(port) {
  const child = spawn(process.execPath, [join(here, 'serve-live.mjs'), '--port', String(port)], {
    stdio: 'inherit',
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('exit', (code, signal) => process.exit(signal ? 0 : (code ?? 1)));
}

/** Plain `kusa serve`: one server, in this process, no watchers. */
function startMonitorServer(port) {
  // Under `serve --live`, Vite owns the public URL; this process is API-only
  // on port+1. Advertise MCP / redirects on the public port when set.
  const publicPort = Number(process.env.KUSA_PUBLIC_PORT) || port;
  const supervised = process.env.KUSA_SUPERVISED === '1';
  const server = createMonitorServer({ mcpPort: publicPort });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`kusa: port ${port} is already in use (another serve.mjs?)`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, '127.0.0.1', () => {
    server.setMcpPort?.(publicPort);
    const mcp = loadMcpState(defaultMonitorDir(repoRoot));
    if (supervised) {
      console.log(`Kusă API: http://127.0.0.1:${port}/ (proxied via :${publicPort})`);
    } else {
      console.log(`Kusă Console: http://127.0.0.1:${port}/`);
    }
    console.log(`Data folder: ${defaultMonitorDir(repoRoot)}`);
    if (mcp.enabled) {
      console.log(`MCP endpoint: ${mcpEndpointUrl(publicPort, repoRoot)}`);
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

if (isMain) {
  let options;
  try {
    options = resolveServeOptions();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  // `--live` is a supervisor, not a mode flag on this server: it owns the child
  // so it can restart it, and hands the child `--no-live` to keep it a leaf.
  if (options.live) delegateLiveServe(options.port);
  else startMonitorServer(options.port);
}
