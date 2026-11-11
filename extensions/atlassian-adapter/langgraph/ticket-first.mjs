/**
 * LangGraph lifecycle for the Atlassian-owned `ticket-first` workflow.
 *
 * Catalog roles / kickoff prompt live in `workflow.mjs` (seeded JSON). This
 * graph only frames the session: ensure a ticket key, note kickoff, park on
 * await_direction for the human's kusa_ask choice, then done. Expand later
 * with investigate / plan / execute nodes after resume.
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
import { TICKET_FIRST_WORKFLOW_ID } from '../workflow.mjs';

export { TICKET_FIRST_WORKFLOW_ID };

/** @typedef {'ensure_ticket' | 'orchestrating' | 'await_direction' | 'done' | ''} TicketFirstPhase */

export const TicketFirstState = Annotation.Root({
  sessionKey: Annotation({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  workflowId: Annotation({
    reducer: (_left, right) => right,
    default: () => TICKET_FIRST_WORKFLOW_ID,
  }),
  issueKey: Annotation({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  phase: Annotation({
    reducer: (_left, right) => right,
    default: () => /** @type {TicketFirstPhase} */ (''),
  }),
  /** Resume payload from await_direction (user's chosen next step). */
  choice: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),
});

/**
 * @param {{
 *   resolveIssueKey?: (args: {
 *     sessionKey: string,
 *     issueKey: string,
 *   }) => Promise<string> | string,
 * }} [deps]
 */
export function buildTicketFirstGraph(deps = {}) {
  const resolveIssueKey = typeof deps.resolveIssueKey === 'function'
    ? deps.resolveIssueKey
    : ({ issueKey }) => String(issueKey || '').trim();

  async function ensureTicket(state) {
    const fromState = String(state.issueKey || '').trim();
    const resolved = await resolveIssueKey({
      sessionKey: String(state.sessionKey || ''),
      issueKey: fromState,
    });
    const issueKey = String(resolved || fromState || '').trim();
    if (!issueKey) {
      return {
        phase: /** @type {TicketFirstPhase} */ ('done'),
        issueKey: '',
      };
    }
    return {
      phase: /** @type {TicketFirstPhase} */ ('ensure_ticket'),
      issueKey,
      workflowId: state.workflowId || TICKET_FIRST_WORKFLOW_ID,
    };
  }

  function noteKickoff(state) {
    return {
      phase: /** @type {TicketFirstPhase} */ ('orchestrating'),
      workflowId: state.workflowId || TICKET_FIRST_WORKFLOW_ID,
      issueKey: String(state.issueKey || '').trim(),
    };
  }

  function awaitDirection(state) {
    const issueKey = String(state.issueKey || '').trim();
    if (!issueKey) {
      return { phase: /** @type {TicketFirstPhase} */ ('done') };
    }
    // Parks until a later resume supplies the human's chosen next step.
    const resume = interrupt({
      reason: 'await_direction',
      sessionKey: state.sessionKey || '',
      issueKey,
    });
    const choice = resume && typeof resume === 'object' ? resume : { value: resume };
    return {
      phase: /** @type {TicketFirstPhase} */ ('await_direction'),
      choice,
      issueKey,
    };
  }

  function done() {
    return { phase: /** @type {TicketFirstPhase} */ ('done') };
  }

  function routeAfterEnsure(state) {
    return String(state.issueKey || '').trim() ? 'note_kickoff' : 'done';
  }

  return new StateGraph(TicketFirstState)
    .addNode('ensure_ticket', ensureTicket)
    .addNode('note_kickoff', noteKickoff)
    .addNode('await_direction', awaitDirection)
    .addNode('done', done)
    .addEdge(START, 'ensure_ticket')
    .addConditionalEdges('ensure_ticket', routeAfterEnsure, {
      note_kickoff: 'note_kickoff',
      done: 'done',
    })
    .addEdge('note_kickoff', 'await_direction')
    .addEdge('await_direction', 'done')
    .addEdge('done', END);
}

/**
 * Compile a ticket-first graph. Pass `checkpointer` for interrupt/resume
 * (MemorySaver in tests; FileRunStore-backed saver in serve).
 *
 * @param {{
 *   checkpointer?: import('@langchain/langgraph').BaseCheckpointSaver,
 *   resolveIssueKey?: (args: object) => Promise<string> | string,
 * }} [opts]
 */
export function compileTicketFirstGraph(opts = {}) {
  const checkpointer = opts.checkpointer || new MemorySaver();
  return buildTicketFirstGraph({
    resolveIssueKey: opts.resolveIssueKey,
  }).compile({ checkpointer });
}

export { Command, MemorySaver, interrupt };
