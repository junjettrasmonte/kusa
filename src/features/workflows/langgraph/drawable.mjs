/**
 * Serializable LangGraph topology for console React Flow previews.
 * Structure only — no checkpointer, no live run state.
 */
import {
  PLAN_EXECUTE_WORKFLOW_ID,
  compilePlanExecuteGraph,
} from './plan-execute.mjs';

/**
 * @param {string} workflowId
 * @returns {{ workflowId: string, nodes: object[], edges: object[] } | null}
 */
export function drawableWorkflowGraph(workflowId) {
  const id = String(workflowId || '').trim();
  if (!id) return null;

  if (id === PLAN_EXECUTE_WORKFLOW_ID) {
    const drawable = compilePlanExecuteGraph().getGraph();
    const json = typeof drawable?.toJSON === 'function'
      ? drawable.toJSON()
      : { nodes: [], edges: [] };
    return {
      workflowId: id,
      nodes: Array.isArray(json?.nodes) ? json.nodes : [],
      edges: Array.isArray(json?.edges) ? json.edges : [],
    };
  }

  return null;
}
