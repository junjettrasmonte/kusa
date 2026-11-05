/**
 * Serve-facing helpers for the plan-execute LangGraph wrap.
 *
 * - `onOrchestratorTurnSettled` advances the graph after a parent turn ends
 *   (parks on `await_approval` when a draft/ready plan is linked).
 * - `resumeAfterPlanApproval` resumes an interrupted thread, or falls back to
 *   `continueWorkflowAfterPlanApproval` when only a run marker remains.
 */
import { Command } from '@langchain/langgraph';
import {
  continueWorkflowAfterPlanApproval,
  resolveOrchestratorForPlan,
} from '#features/agent/plans.mjs';
import { listPlans, readPlan } from '#features/chat/data/plan-store.mjs';
import {
  readChatSession,
  readSessionConfig,
} from '#features/chat/data/chat-store.mjs';
import {
  deleteRunMarker,
  getMemorySaver,
  hasRunMarker,
  readRunMarker,
  writeRunMarker,
} from './checkpointer.mjs';
import {
  compilePlanExecuteGraph,
  PLAN_EXECUTE_WORKFLOW_ID,
} from './plan-execute.mjs';

/**
 * @param {string} sessionKey
 * @returns {string}
 */
export function threadIdForSession(sessionKey) {
  const key = String(sessionKey || '').trim();
  return key ? `plan-execute:${key}` : '';
}

/**
 * @param {object | null | undefined} session
 * @param {object | null | undefined} [config]
 * @returns {boolean}
 */
export function isPlanExecuteOrchestrator(session, config = null) {
  if (!session && !config) return false;
  const cfg = config || session?.options || {};
  const parentId = String(session?.parentId || cfg.parentId || '').trim();
  if (parentId) return false;
  const workflowId = String(
    cfg.workflowId || session?.workflowId || session?.options?.workflowId || '',
  ).trim();
  if (workflowId !== PLAN_EXECUTE_WORKFLOW_ID) return false;
  const kind = String(cfg.kind || session?.kind || session?.options?.kind || '').toLowerCase();
  return kind === 'orchestrated' || Boolean(workflowId);
}

/**
 * True when this session's plan-execute graph is parked on await_approval
 * (live interrupt or durable run marker).
 *
 * @param {string} dataDir
 * @param {string} sessionKey
 * @param {{ workspaceRoot?: string, startTurn?: Function | null }} [ctx]
 * @returns {Promise<boolean>}
 */
export async function isSessionAwaitingPlanApproval(
  dataDir,
  sessionKey,
  { workspaceRoot = process.cwd(), startTurn = null } = {},
) {
  const key = String(sessionKey || '').trim();
  if (!dataDir || !key) return false;
  const threadId = threadIdForSession(key);
  if (!threadId) return false;
  const marker = readRunMarker(dataDir, threadId);
  if (String(marker?.phase || '') === 'await_approval') return true;
  try {
    const graph = getPlanExecuteGraph(dataDir, { workspaceRoot, startTurn });
    return graphHasPendingInterrupt(graph, { configurable: { thread_id: threadId } });
  } catch {
    return Boolean(marker) || hasRunMarker(dataDir, threadId);
  }
}

/**
 * Prefer a draft/ready plan owned by this orchestrator (or its planner kids).
 * @param {string} dataDir
 * @param {object} orchestrator
 * @returns {object | null}
 */
export function findPendingPlanForOrchestrator(dataDir, orchestrator) {
  if (!dataDir || !orchestrator?.id) return null;
  const orchId = String(orchestrator.id).trim();
  const kidIds = new Set(
    (Array.isArray(orchestrator.subagents) ? orchestrator.subagents : [])
      .map((kid) => String(kid?.id || '').trim())
      .filter(Boolean),
  );
  const pending = listPlans(dataDir).filter((plan) => {
    const status = String(plan?.status || '').toLowerCase();
    if (status !== 'draft' && status !== 'ready') return false;
    const creator = String(plan.createdByAgentId || '').trim();
    const orch = String(plan.orchestratorAgentId || '').trim();
    if (orch && orch === orchId) return true;
    if (creator && (creator === orchId || kidIds.has(creator))) return true;
    const wf = String(plan.workflowId || '').trim();
    return wf === PLAN_EXECUTE_WORKFLOW_ID && !orch && !creator;
  });
  if (!pending.length) return null;
  pending.sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
  return pending[0];
}

/**
 * @type {Map<string, {
 *   graph: import('@langchain/langgraph').CompiledStateGraph,
 *   ctx: { workspaceRoot: string, startTurn: Function | null },
 * }>}
 */
const graphsByDataDir = new Map();

/**
 * @param {string} dataDir
 * @param {{
 *   startTurn?: Function | null,
 *   workspaceRoot?: string,
 * }} [ctx]
 */
export function getPlanExecuteGraph(dataDir, ctx = {}) {
  const key = String(dataDir || '') || ':memory:';
  let entry = graphsByDataDir.get(key);
  if (entry) {
    if (ctx.workspaceRoot) entry.ctx.workspaceRoot = ctx.workspaceRoot;
    if (ctx.startTurn) entry.ctx.startTurn = ctx.startTurn;
    return entry.graph;
  }

  const liveCtx = {
    workspaceRoot: ctx.workspaceRoot || process.cwd(),
    startTurn: ctx.startTurn || null,
  };
  const checkpointer = getMemorySaver(dataDir);
  const graph = compilePlanExecuteGraph({
    checkpointer,
    continueAfterApproval: async ({ planId }) => {
      const plan = readPlan(dataDir, planId);
      if (!plan) return { ok: false, error: 'plan not found', code: 'ENOENT' };
      return continueWorkflowAfterPlanApproval({
        dataDir,
        plan,
        workspaceRoot: liveCtx.workspaceRoot || process.cwd(),
        startTurn: liveCtx.startTurn || null,
      });
    },
  });
  graphsByDataDir.set(key, { graph, ctx: liveCtx });
  return graph;
}

/** Drop compiled graphs (tests). */
export function resetPlanExecuteGraphs() {
  graphsByDataDir.clear();
}

/**
 * @param {import('@langchain/langgraph').CompiledStateGraph} graph
 * @param {object} config
 * @returns {Promise<boolean>}
 */
async function graphHasPendingInterrupt(graph, config) {
  try {
    const snap = await graph.getState(config);
    const tasks = Array.isArray(snap?.tasks) ? snap.tasks : [];
    return tasks.some((task) => Array.isArray(task?.interrupts) && task.interrupts.length > 0);
  } catch {
    return false;
  }
}

/**
 * After an orchestrator parent turn settles: if plan-execute and a pending
 * plan exists, invoke the graph until it parks on approval interrupt.
 *
 * @param {{
 *   dataDir: string,
 *   sessionKey: string,
 *   prompt?: string,
 *   workspaceRoot?: string,
 *   startTurn?: Function,
 * }} args
 */
export async function onOrchestratorTurnSettled({
  dataDir = '',
  sessionKey = '',
  prompt = '',
  workspaceRoot = process.cwd(),
  startTurn = null,
} = {}) {
  const key = String(sessionKey || '').trim();
  if (!dataDir || !key) return { ok: false, skipped: true, reason: 'missing_args' };

  const session = readChatSession(dataDir, key);
  const config = readSessionConfig(dataDir, session?.id || key) || session?.options || {};
  if (!isPlanExecuteOrchestrator(session, config)) {
    return { ok: true, skipped: true, reason: 'not_plan_execute' };
  }

  const pending = findPendingPlanForOrchestrator(dataDir, {
    ...session,
    ...config,
    id: session?.id,
    options: config,
    subagents: session?.subagents || config.subagents || [],
  });
  const planId = pending?.id ? String(pending.id) : '';
  const threadId = threadIdForSession(key);
  const graph = getPlanExecuteGraph(dataDir, { workspaceRoot, startTurn });
  const runnableConfig = { configurable: { thread_id: threadId } };

  // Already waiting on this (or another) plan — refresh marker and stop.
  if (await graphHasPendingInterrupt(graph, runnableConfig)) {
    writeRunMarker(dataDir, threadId, {
      sessionKey: key,
      workflowId: PLAN_EXECUTE_WORKFLOW_ID,
      planId: planId || readRunMarker(dataDir, threadId)?.planId || '',
      phase: 'await_approval',
    });
    return { ok: true, skipped: true, reason: 'already_waiting', threadId, planId };
  }

  const input = {
    sessionKey: key,
    workflowId: PLAN_EXECUTE_WORKFLOW_ID,
    prompt: String(prompt || '').trim(),
    planId,
    phase: '',
    continued: null,
  };

  let result;
  try {
    result = await graph.invoke(input, runnableConfig);
  } catch (err) {
    return {
      ok: false,
      error: err?.message || 'plan-execute graph invoke failed',
      threadId,
      planId,
    };
  }

  const interrupted = Array.isArray(result?.__interrupt__) && result.__interrupt__.length > 0;
  if (interrupted || planId) {
    writeRunMarker(dataDir, threadId, {
      sessionKey: key,
      workflowId: PLAN_EXECUTE_WORKFLOW_ID,
      planId,
      phase: interrupted ? 'await_approval' : String(result?.phase || 'done'),
    });
  } else {
    deleteRunMarker(dataDir, threadId);
  }

  return {
    ok: true,
    threadId,
    planId,
    phase: result?.phase || (interrupted ? 'await_approval' : 'done'),
    interrupted,
  };
}

/**
 * Resume plan-execute after Plan Approve / Continue.
 * Prefers LangGraph Command resume; falls back to direct continue when the
 * in-memory interrupt is gone but a run marker (or no graph) remains.
 *
 * @param {{
 *   dataDir: string,
 *   plan: object,
 *   workspaceRoot?: string,
 *   startTurn?: Function,
 *   prompt?: string,
 *   assignToAgentId?: string,
 *   detachWorkflow?: boolean,
 * }} args
 */
export async function resumeAfterPlanApproval({
  dataDir = '',
  plan = null,
  workspaceRoot = process.cwd(),
  startTurn = null,
  prompt = '',
  assignToAgentId = '',
  detachWorkflow = false,
} = {}) {
  if (!dataDir || !plan?.id) {
    return { ok: false, error: 'dataDir and plan required', code: 'EINVAL' };
  }

  const continueOpts = {
    dataDir,
    plan,
    workspaceRoot,
    startTurn,
    prompt,
    assignToAgentId,
    detachWorkflow,
  };

  // Custom agent / detach bypasses the LangGraph interrupt — go direct.
  if (detachWorkflow || String(assignToAgentId || '').trim()) {
    const continued = await continueWorkflowAfterPlanApproval(continueOpts);
    const orch = resolveOrchestratorForPlan(dataDir, plan);
    const tid = threadIdForSession(orch?.key || (orch?.id ? `kusa:${orch.id}` : ''));
    if (tid) deleteRunMarker(dataDir, tid);
    return { ...continued, resumedVia: 'direct' };
  }

  const orchestrator = resolveOrchestratorForPlan(dataDir, plan);
  const sessionKey = orchestrator?.key
    || (orchestrator?.id ? `kusa:${orchestrator.id}` : '');
  const threadId = threadIdForSession(sessionKey);
  const marker = threadId ? readRunMarker(dataDir, threadId) : null;

  const fallback = async () => {
    const continued = await continueWorkflowAfterPlanApproval(continueOpts);
    if (threadId) deleteRunMarker(dataDir, threadId);
    return { ...continued, resumedVia: 'direct' };
  };

  if (!threadId || !sessionKey) {
    return fallback();
  }

  const graph = getPlanExecuteGraph(dataDir, { workspaceRoot, startTurn });
  const runnableConfig = { configurable: { thread_id: threadId } };
  const waiting = await graphHasPendingInterrupt(graph, runnableConfig);

  if (!waiting) {
    // Restart / older session: marker alone → direct continue.
    if (marker || hasRunMarker(dataDir, threadId)) {
      return fallback();
    }
    return fallback();
  }

  let result;
  try {
    result = await graph.invoke(
      new Command({
        resume: {
          planId: String(plan.id),
          approved: true,
        },
      }),
      runnableConfig,
    );
  } catch (err) {
    // Resume failed — still try the durable continue path.
    const continued = await fallback();
    return {
      ...continued,
      graphError: err?.message || 'resume failed',
      resumedVia: 'direct_after_graph_error',
    };
  }

  deleteRunMarker(dataDir, threadId);
  const continued = result?.continued && typeof result.continued === 'object'
    ? result.continued
    : { ok: true };
  return {
    ...continued,
    resumedVia: 'langgraph',
    phase: result?.phase || 'done',
    threadId,
  };
}

export { PLAN_EXECUTE_WORKFLOW_ID };
