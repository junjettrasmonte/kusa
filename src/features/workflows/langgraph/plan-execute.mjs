/**
 * LangGraph light wrap for the seeded `plan-execute` workflow.
 *
 * The Orchestrator LLM still owns role decisions via `kusa_assign` on
 * `POST /kusa/chat`. This graph only frames the lifecycle: note a settled
 * orchestrator turn, interrupt for Plan-drawer approval, then call the
 * existing `continueWorkflowAfterPlanApproval` bridge to start the Executor.
 */
import {
  Annotation,
  Command,
  END,
  interrupt,
  MemorySaver,
  START,
  StateGraph,
} from '@langchain/langgraph';

export const PLAN_EXECUTE_WORKFLOW_ID = 'plan-execute';

/** @typedef {'orchestrating' | 'await_approval' | 'executing' | 'done' | ''} PlanExecutePhase */

export const PlanExecuteState = Annotation.Root({
  sessionKey: Annotation({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  workflowId: Annotation({
    reducer: (_left, right) => right,
    default: () => PLAN_EXECUTE_WORKFLOW_ID,
  }),
  prompt: Annotation({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  planId: Annotation({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  phase: Annotation({
    reducer: (_left, right) => right,
    default: () => /** @type {PlanExecutePhase} */ (''),
  }),
  /** Result from ensure_executor (continueWorkflowAfterPlanApproval). */
  continued: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),
});

/**
 * @param {{
 *   continueAfterApproval?: (args: {
 *     planId: string,
 *     sessionKey: string,
 *     prompt: string,
 *   }) => Promise<object | null>,
 * }} [deps]
 */
export function buildPlanExecuteGraph(deps = {}) {
  const continueAfterApproval = typeof deps.continueAfterApproval === 'function'
    ? deps.continueAfterApproval
    : async () => ({ ok: false, error: 'continueAfterApproval not configured' });

  function noteOrchestrating(state) {
    return {
      phase: /** @type {PlanExecutePhase} */ ('orchestrating'),
      workflowId: state.workflowId || PLAN_EXECUTE_WORKFLOW_ID,
    };
  }

  function awaitApproval(state) {
    const planId = String(state.planId || '').trim();
    if (!planId) {
      return { phase: /** @type {PlanExecutePhase} */ ('done') };
    }
    // Parks until Plan Approve / Continue resumes with Command({ resume }).
    const resume = interrupt({
      planId,
      reason: 'await_approval',
      sessionKey: state.sessionKey || '',
    });
    const resumedPlanId = resume && typeof resume === 'object' && resume.planId
      ? String(resume.planId).trim()
      : planId;
    return {
      phase: /** @type {PlanExecutePhase} */ ('await_approval'),
      planId: resumedPlanId || planId,
    };
  }

  async function ensureExecutor(state) {
    const planId = String(state.planId || '').trim();
    const continued = await continueAfterApproval({
      planId,
      sessionKey: String(state.sessionKey || ''),
      prompt: String(state.prompt || ''),
    });
    return {
      phase: /** @type {PlanExecutePhase} */ ('executing'),
      continued: continued && typeof continued === 'object' ? continued : { ok: false },
    };
  }

  function done() {
    return { phase: /** @type {PlanExecutePhase} */ ('done') };
  }

  function routeAfterNote(state) {
    return String(state.planId || '').trim() ? 'await_approval' : 'done';
  }

  return new StateGraph(PlanExecuteState)
    .addNode('note_orchestrating', noteOrchestrating)
    .addNode('await_approval', awaitApproval)
    .addNode('ensure_executor', ensureExecutor)
    .addNode('done', done)
    .addEdge(START, 'note_orchestrating')
    .addConditionalEdges('note_orchestrating', routeAfterNote, {
      await_approval: 'await_approval',
      done: 'done',
    })
    .addEdge('await_approval', 'ensure_executor')
    .addEdge('ensure_executor', 'done')
    .addEdge('done', END);
}

/**
 * Compile a plan-execute graph. Pass `checkpointer` for interrupt/resume
 * (MemorySaver in tests; FileRunStore-backed saver in serve).
 *
 * @param {{
 *   checkpointer?: import('@langchain/langgraph').BaseCheckpointSaver,
 *   continueAfterApproval?: (args: object) => Promise<object | null>,
 * }} [opts]
 */
export function compilePlanExecuteGraph(opts = {}) {
  const checkpointer = opts.checkpointer || new MemorySaver();
  return buildPlanExecuteGraph({
    continueAfterApproval: opts.continueAfterApproval,
  }).compile({ checkpointer });
}

export { Command, MemorySaver, interrupt };
