/**
 * Trail enforcement for the Kusă agent — readiness gate + trail ask/map tools.
 * When settings.enforceTrail is on, chat is blocked until Trail is ready, and
 * explore tools require a successful kusa_trail_* call first each turn.
 */
import { spawnSync } from 'node:child_process';
import { collectTrailStatus } from '#features/monitor/lib.mjs';
import { FILE_TOOL_DEFS, createFileTools, openaiToolSchemas as fileToolSchemas } from '#features/agent/files.mjs';
import { TERMINAL_TOOL_DEFS, createTerminalTools } from '#features/agent/terminal.mjs';
import { BROWSER_TOOL_DEFS, createBrowserTools } from '#features/agent/browser.mjs';
import { TASK_TOOL_DEFS, createTaskTools, taskToolSchemas } from '#features/agent/tasks.mjs';
import { createPlanTools, planToolSchemas } from '#features/agent/plans.mjs';
import { createAssignTools, assignToolSchemas } from '#features/agent/assign.mjs';
import {
  createEscalateTools,
  escalateToolSchemas,
  isOrchestratedSessionKey,
} from '#features/agent/escalate.mjs';
import { SESSION_NAME_TOOL_DEFS, createSessionNameTools, sessionNameToolSchemas } from '#features/agent/session-name.mjs';
import { ASK_TOOL_DEFS, createAskGate, askToolSchemas } from '#features/agent/ask.mjs';
import { createApprovalGate } from '#features/agent/approval.mjs';
import {
  createMergedExtensionTools,
  extensionToolGroups,
} from '#features/agent/extension-tools.mjs';
import {
  AGENT_MODE_AGENT,
  isToolAllowedInMode,
  isWriteOrExecTool,
  normalizeAgentMode,
} from '#features/agent/modes.mjs';

const TRAIL_BIN = process.platform === 'win32' ? 'trail.cmd' : 'trail';
const TRAIL_TIMEOUT_MS = 45_000;
const MAX_TRAIL_OUT = 120_000;

/** File tools that must wait for Trail when enforceTrail is on. */
export const TRAIL_GATED_TOOLS = new Set([
  'kusa_read_file',
  'kusa_list_dir',
  'kusa_grep',
  'kusa_write_file',
  'kusa_patch_file',
  'kusa_delete_file',
  'read',
  'read_file',
  'list',
  'list_dir',
  'grep',
  'write',
  'write_file',
  'patch',
  'patch_file',
  'str_replace',
  'delete',
  'delete_file',
  'rm',
]);

export const TRAIL_TOOL_DEFS = [
  {
    name: 'kusa_trail_ask',
    description:
      'Query the Trail context graph (trail ask --source). Use this BEFORE exploring files with '
      + 'kusa_read_file / kusa_grep / kusa_list_dir. Pass a concrete question or symbol/file name.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up in the graph' },
        full: {
          type: 'boolean',
          description: 'Pass --full for whole definitions when the default crux is too short',
        },
        scope: {
          type: 'string',
          description: 'Optional --in <scope>/ path prefix to narrow monorepo hits',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_trail_map',
    description:
      'Token-budgeted repo orientation from Trail (trail map). Use once when new to the workspace '
      + 'before asking narrower trail questions.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

/**
 * @param {Array<{ name: string, description: string, parameters: object }>} defs
 */
function toOpenAiSchemas(defs = []) {
  return defs.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * @param {object} settings
 * @param {string} workspaceRoot
 */
export function resolveTrailPolicy(settings = {}, workspaceRoot = process.cwd()) {
  const detect = settings.detectTrail !== false;
  const enforce = detect && settings.enforceTrail !== false;
  const status = detect
    ? collectTrailStatus(workspaceRoot, { force: true })
    : { ok: true, steps: [], error: null };
  return {
    detect,
    enforce,
    ready: Boolean(status?.ok),
    status,
  };
}

/**
 * Extra system-prompt lines when Trail detection/enforcement is on.
 * @param {{ detect: boolean, enforce: boolean, ready: boolean }} policy
 */
export function trailSystemPromptAddon(policy) {
  if (!policy?.detect) return '';
  if (policy.enforce) {
    return [
      'Trail enforcement is ON for this workspace.',
      'For ANY task that needs code context — understanding, finding symbols, or scoping edits —',
      'you MUST call kusa_trail_ask (or kusa_trail_map once if new here) BEFORE kusa_read_file,',
      'kusa_grep, kusa_list_dir, or other file tools. Re-ask freely with concrete identifiers.',
      'Cite covers: file:line spans from Trail and edit from those spans; only open a source file',
      'when the graph node lacks a needed detail. After large edits, remind the user to run trail build.',
    ].join(' ');
  }
  return [
    'This workspace has a Trail context graph. Prefer kusa_trail_ask before broad file exploration',
    'when the graph is available — it is cheaper than grepping the whole tree.',
  ].join(' ');
}

/**
 * Human-readable block when chat is refused because Trail is not ready.
 * @param {object} status from collectTrailStatus
 */
export function trailNotReadyMessage(status) {
  const steps = Array.isArray(status?.steps) && status.steps.length
    ? status.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : '1. Install Trail: npm install -g @trailhq/trail-code\n2. Run: trail build';
  const err = status?.error ? `\n\nDetail: ${status.error}` : '';
  return [
    'Kusă will not run the agent until Trail is ready (Settings → enforce Trail).',
    '',
    steps,
    err,
  ].join('\n');
}

/**
 * @param {string} workspaceRoot
 * @param {string[]} args
 */
function runTrailCli(workspaceRoot, args) {
  const result = spawnSync(TRAIL_BIN, args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    timeout: TRAIL_TIMEOUT_MS,
    maxBuffer: MAX_TRAIL_OUT,
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  if (result.error) {
    const code = result.error.code || 'ENOENT';
    return {
      ok: false,
      error: code === 'ENOENT'
        ? 'trail CLI not found on PATH (npm install -g @trailhq/trail-code)'
        : (result.error.message || String(result.error)),
      code,
    };
  }
  const stdout = String(result.stdout || '').slice(0, MAX_TRAIL_OUT);
  const stderr = String(result.stderr || '').slice(0, 4_000);
  if (result.status !== 0) {
    return {
      ok: false,
      error: stderr.trim() || stdout.trim() || `trail exited ${result.status}`,
      status: result.status,
    };
  }
  return { ok: true, output: stdout || '(empty trail output)', stderr: stderr || undefined };
}

/**
 * Wrap file tools with Trail ask/map + optional explore gate, plus the approval-gated
 * terminal and browser tools.
 * @param {string} workspaceRoot
 * @param {{ enforceTrail?: boolean, approvalMode?: 'ask-deny'|'ask-allow'|'allow'|'deny', mode?: 'ask'|'plan'|'agent', onApprove?: (request) => boolean, approvalEvent?: (request) => void, signal?: AbortSignal, dataDir?: string, sessionKey?: string, onAsk?: Function, askEvent?: Function, onAssignTurn?: Function, onEscalateTurn?: Function }} [options]
 *   dataDir + sessionKey are the monitor context for this turn — the task tools
 *   need them to keep the model's task list in that session's `tasks.json`.
 *   onAsk + askEvent are the interactive channel for kusa_ask: without them the
 *   ask cannot reach a human and refuses immediately instead of stalling.
 *   onEscalateTurn awaits one provider turn for kusa_escalate (orchestrated only);
 *   the escalate tool asks (no timer) which provider to use before calling it.
 */
export function createTrailAwareTools(
  workspaceRoot,
  {
    enforceTrail = false,
    approvalMode = 'ask-deny',
    approvalTimeoutMs = null,
    mode = null,
    onApprove = null,
    approvalEvent = null,
    signal = null,
    dataDir = '',
    sessionKey = '',
    onAsk = null,
    askEvent = null,
    onAssignTurn = null,
    onEscalateTurn = null,
  } = {},
) {
  // Mutable so a mid-turn composer Mode change takes effect on the next tool
  // call / next model step without rebuilding the whole tool set.
  let agentMode = normalizeAgentMode(mode);
  // Orchestrated parents coordinate Subagents — they must not implement themselves.
  const orchestrated = isOrchestratedSessionKey(dataDir, sessionKey);
  const allowed = (name) => {
    if (orchestrated && isWriteOrExecTool(name)) return false;
    return isToolAllowedInMode(name, agentMode);
  };
  const files = createFileTools(workspaceRoot);
  const gate = { consulted: !enforceTrail };
  const approval = createApprovalGate({
    mode: approvalMode,
    timeoutMs: approvalTimeoutMs,
    onApprove,
    emit: approvalEvent,
    signal,
  });
  const terminal = createTerminalTools(workspaceRoot, { approval });
  const browser = createBrowserTools({ approval });
  const ask = createAskGate({ onAsk, emit: askEvent, signal });
  // A batch that meets an existing list asks start-fresh or merge on this same
  // channel, so the chat shows the question card and Stop still unblocks it.
  const tasks = createTaskTools({
    dataDir,
    sessionKey,
    ask: (prompt, callId) => ask.call('kusa_ask', prompt, callId),
  });
  // workspaceRoot is needed by kusa_plan_ingest: it reads a plan file from the
  // workspace, so the tool resolves that path against the same sandbox the file
  // tools use (never an absolute jump out of the tree).
  const plans = createPlanTools({ dataDir, sessionKey, workspaceRoot });
  const assign = createAssignTools({
    dataDir,
    sessionKey,
    workspaceRoot,
    startTurn: onAssignTurn,
  });
  // One-turn provider handoff for orchestrated Agents only; awaits the result
  // so the caller resumes with the other provider's reply. Uses the ask
  // channel (no timer) so the user picks which provider — each escalate asks
  // again; control always returns after that single turn.
  const escalate = createEscalateTools({
    dataDir,
    sessionKey,
    workspaceRoot,
    runTurn: onEscalateTurn,
    signal,
    ask: (prompt, callId) => ask.call('kusa_ask', prompt, callId),
  });
  // Session naming owns the same per-session sidecar the task tools write, so it
  // takes the same dataDir / sessionKey pair: absent, the name stays unpersisted
  // and the tool says so rather than inventing a row for a phantom session.
  const names = createSessionNameTools({ dataDir, sessionKey });
  // Extension-contributed tools (e.g. Atlassian Jira) — discovered from
  // extensions/*/tools.mjs and merged when the cache is warm.
  const extensionTools = createMergedExtensionTools({
    dataDir,
    sessionKey,
    workspaceRoot,
  });

  function trailAsk(args = {}) {
    const query = String(args.query || '').trim();
    if (!query) return { ok: false, error: 'query is required' };
    const argv = ['ask', query, '--source'];
    if (args.full) argv.push('--full');
    if (typeof args.scope === 'string' && args.scope.trim()) {
      argv.push('--in', args.scope.trim());
    }
    const out = runTrailCli(workspaceRoot, argv);
    if (out.ok) gate.consulted = true;
    return out;
  }

  function trailMap() {
    const out = runTrailCli(workspaceRoot, ['map']);
    if (out.ok) gate.consulted = true;
    return out;
  }

  async function call(name, args = {}, callId = null) {
    if (!allowed(name)) {
      return {
        ok: false,
        error: orchestrated
          ? `${name} is blocked on orchestrated Agents. Assign a Subagent with kusa_assign (e.g. role=planner for Cursor) instead of implementing yourself.`
          : `${agentMode} mode cannot call ${name}. Ask and Plan modes are read-only — answer from what you can read, or switch to Agent mode to change files.`,
        code: 'EMODE',
      };
    }
    if (name === 'kusa_trail_ask' || name === 'trail_ask') return trailAsk(args);
    if (name === 'kusa_trail_map' || name === 'trail_map') return trailMap(args);

    if (name === 'kusa_terminal' || name === 'terminal') return terminal.call(name, args, callId);
    if (name === 'kusa_browse' || name === 'browse') return browser.call(name, args, callId);

    // Task tools are not Trail-gated: they change the session's task list, not
    // the working copy, so the model can plan and re-plan before any file read.
    if (/^kusa_task_|^(task_list|task_add|task_update|add_task|update_task|complete_task|list_tasks)$/.test(name)) {
      return tasks.call(name, args, callId);
    }

    // Workspace plans are not Trail-gated (shared JSON under .kusa/plans/).
    if (/^kusa_plan_|^(plan_list|plan_create|plan_ingest|plan_read|plan_update|plan_complete)$/.test(name)) {
      return plans.call(name, args, callId);
    }

    // Orchestrator assign spawns Subagents — not a working-copy edit.
    if (/^kusa_assign|^assign_/.test(name)) {
      return assign.call(name, args, callId);
    }

    // One-turn escalation to another provider — orchestrated sessions only.
    if (name === 'kusa_escalate' || name === 'escalate') {
      return escalate.call(name, args, callId);
    }

    // Naming is not Trail-gated either: it writes the session's own name, never
    // the working copy, so the model can name a chat before reading anything.
    if (/^kusa_name_|^(name_session|rename_session|set_session_name)$/.test(name)) {
      return names.call(name, args, callId);
    }

    // Asking the user is not Trail-gated either: it reads nothing and writes
    // nothing, it just waits for a human answer.
    if (name === 'kusa_ask' || name === 'ask' || name === 'ask_user') {
      return await ask.call(name, args, callId);
    }

    // Extension tools (Jira, …) — not Trail-gated; they talk to external APIs
    // or session sidecars, never the working copy.
    if (extensionTools.names.has(name)) {
      return extensionTools.call(name, args, callId);
    }

    if (enforceTrail && TRAIL_GATED_TOOLS.has(name) && !gate.consulted) {
      return {
        ok: false,
        error:
          'Trail enforce: call kusa_trail_ask (or kusa_trail_map) before exploring or editing files.',
        code: 'ETRAIL',
      };
    }
    return files.call(name, args);
  }

  const defs = [
    ...FILE_TOOL_DEFS,
    ...TRAIL_TOOL_DEFS,
    ...tasks.defs,
    ...plans.defs,
    ...assign.defs,
    // Advertise escalate only on orchestrated sessions; the tool still refuses
    // elsewhere so a stale schema cannot quietly spawn provider turns.
    ...(orchestrated ? escalate.defs : []),
    ...names.defs,
    ...ask.defs,
    ...terminal.defs,
    ...browser.defs,
    ...extensionTools.defs,
  ].filter((def) => allowed(def?.name));

  const api = {
    root: files.root,
    defs,
    mode: agentMode,
    allowed,
    gate,
    approval,
    ask,
    names,
    setMode(next) {
      agentMode = normalizeAgentMode(next);
      api.mode = agentMode;
      return agentMode;
    },
    trailAsk,
    trailMap,
    tasks,
    plans,
    assign,
    escalate,
    names,
    call,
    readFile: files.readFile,
    writeFile: files.writeFile,
    patchFile: files.patchFile,
    listDir: files.listDir,
    grep: files.grep,
    deleteFile: files.deleteFile,
  };
  return api;
}

/**
 * The agent's tool set, grouped by family (file / trail / terminal / browser).
 * The console lists these per session, so the grouping stays here rather than
 * being re-derived from tool names in the UI.
 */
export function agentToolGroups(mode = null, { orchestrated = false } = {}) {
  const groups = [
    { group: 'file', schemas: fileToolSchemas() },
    { group: 'trail', schemas: toOpenAiSchemas(TRAIL_TOOL_DEFS) },
    { group: 'task', schemas: taskToolSchemas() },
    { group: 'plan', schemas: planToolSchemas() },
    { group: 'assign', schemas: assignToolSchemas() },
    ...(orchestrated ? [{ group: 'escalate', schemas: escalateToolSchemas() }] : []),
    { group: 'session', schemas: sessionNameToolSchemas() },
    { group: 'ask', schemas: askToolSchemas() },
    { group: 'terminal', schemas: toOpenAiSchemas(TERMINAL_TOOL_DEFS) },
    { group: 'browser', schemas: toOpenAiSchemas(BROWSER_TOOL_DEFS) },
    ...extensionToolGroups(),
  ];
  const normalized = normalizeAgentMode(mode);
  // Orchestrators stay coordination-only even in Agent mode (no write/exec).
  const allow = (name) => {
    if (orchestrated && isWriteOrExecTool(name)) return false;
    return isToolAllowedInMode(name, normalized);
  };
  if (normalized === AGENT_MODE_AGENT && !orchestrated) return groups;
  return groups
    .map((entry) => ({
      ...entry,
      schemas: entry.schemas.filter((schema) => allow(schema?.function?.name)),
    }))
    .filter((entry) => entry.schemas.length);
}

/** OpenAI tool schemas including Trail tools, filtered by agent mode. */
export function openaiToolSchemasWithTrail(mode = null, opts = {}) {
  return agentToolGroups(mode, opts).flatMap((entry) => entry.schemas);
}
