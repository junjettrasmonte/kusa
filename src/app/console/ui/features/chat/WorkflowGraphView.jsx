/**
 * Read-only LangGraph topology preview (React Flow) for the workflow info modal.
 * Expects the drawable JSON from GET /kusa/workflows/:id/graph.
 */
import { useEffect, useMemo } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

const NODE_W = 168;
const NODE_H = 40;
const LAYER_GAP_Y = 72;
const LAYER_GAP_X = 36;

function displayLabel(id) {
  const raw = String(id || '').trim();
  if (raw === '__start__') return 'Start';
  if (raw === '__end__') return 'End';
  return raw.replace(/_/g, ' ');
}

function isTerminalId(id) {
  return id === '__start__' || id === '__end__';
}

/**
 * Longest-path layering from sources (nodes with no inbound edges), then
 * center each layer horizontally. Small graphs only — fine for plan-execute.
 */
function layoutDrawable(drawable) {
  const rawNodes = Array.isArray(drawable?.nodes) ? drawable.nodes : [];
  const rawEdges = Array.isArray(drawable?.edges) ? drawable.edges : [];
  const ids = rawNodes.map((n) => String(n.id || '').trim()).filter(Boolean);
  if (!ids.length) return { nodes: [], edges: [] };

  const idSet = new Set(ids);
  const inbound = new Map(ids.map((id) => [id, []]));
  const outbound = new Map(ids.map((id) => [id, []]));
  for (const edge of rawEdges) {
    const source = String(edge?.source || '').trim();
    const target = String(edge?.target || '').trim();
    if (!idSet.has(source) || !idSet.has(target)) continue;
    outbound.get(source).push(target);
    inbound.get(target).push(source);
  }

  const depth = new Map();
  const queue = ids.filter((id) => (inbound.get(id) || []).length === 0);
  if (!queue.length) queue.push(ids[0]);
  for (const id of queue) depth.set(id, 0);

  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i];
    const d = depth.get(id) || 0;
    for (const next of outbound.get(id) || []) {
      const candidate = d + 1;
      if (!depth.has(next) || candidate > depth.get(next)) {
        depth.set(next, candidate);
        queue.push(next);
      }
    }
  }
  for (const id of ids) {
    if (!depth.has(id)) depth.set(id, 0);
  }

  const layers = new Map();
  for (const id of ids) {
    const layer = depth.get(id) || 0;
    if (!layers.has(layer)) layers.set(layer, []);
    layers.get(layer).push(id);
  }

  const positions = new Map();
  const sortedLayers = [...layers.keys()].sort((a, b) => a - b);
  for (const layer of sortedLayers) {
    const row = layers.get(layer);
    const width = row.length * NODE_W + Math.max(0, row.length - 1) * LAYER_GAP_X;
    let x = -width / 2;
    for (const id of row) {
      positions.set(id, { x, y: layer * LAYER_GAP_Y });
      x += NODE_W + LAYER_GAP_X;
    }
  }

  const nodes = ids.map((id) => {
    const pos = positions.get(id) || { x: 0, y: 0 };
    const terminal = isTerminalId(id);
    return {
      id,
      position: pos,
      data: { label: displayLabel(id) },
      sourcePosition: 'bottom',
      targetPosition: 'top',
      style: {
        width: NODE_W,
        height: NODE_H,
        borderRadius: terminal ? 999 : 8,
        border: terminal ? '1px solid rgb(56 189 248 / 0.55)' : '1px solid rgb(55 65 81)',
        background: terminal ? 'rgb(8 47 73 / 0.85)' : 'rgb(17 24 39)',
        color: terminal ? 'rgb(125 211 252)' : 'rgb(229 231 235)',
        fontSize: 11,
        fontWeight: 500,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textTransform: terminal ? 'none' : 'capitalize',
        padding: '0 10px',
      },
    };
  });

  const edges = rawEdges
    .map((edge, index) => {
      const source = String(edge?.source || '').trim();
      const target = String(edge?.target || '').trim();
      if (!idSet.has(source) || !idSet.has(target)) return null;
      const conditional = edge?.conditional === true;
      return {
        id: `e-${source}-${target}-${index}`,
        source,
        target,
        animated: conditional,
        style: {
          stroke: conditional ? 'rgb(125 211 252)' : 'rgb(107 114 128)',
          strokeWidth: 1.5,
          strokeDasharray: conditional ? '4 3' : undefined,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: conditional ? 'rgb(125 211 252)' : 'rgb(107 114 128)',
        },
      };
    })
    .filter(Boolean);

  return { nodes, edges };
}

function FitViewOnce({ nodeCount }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!nodeCount) return;
    const timer = requestAnimationFrame(() => {
      fitView({ padding: 0.18, duration: 0 });
    });
    return () => cancelAnimationFrame(timer);
  }, [fitView, nodeCount]);
  return null;
}

function WorkflowGraphCanvas({ drawable }) {
  const laidOut = useMemo(() => layoutDrawable(drawable), [drawable]);
  const [nodes, setNodes, onNodesChange] = useNodesState(laidOut.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(laidOut.edges);

  useEffect(() => {
    setNodes(laidOut.nodes);
    setEdges(laidOut.edges);
  }, [laidOut, setNodes, setEdges]);

  if (!laidOut.nodes.length) {
    return (
      <p className="px-3 py-6 text-center text-[11px] text-gray-500">
        No graph nodes for this workflow.
      </p>
    );
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      panOnScroll
      zoomOnScroll
      minZoom={0.4}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      className="bg-transparent"
    >
      <FitViewOnce nodeCount={laidOut.nodes.length} />
      <Background gap={18} size={1} color="rgb(55 65 81 / 0.55)" />
      <Controls
        showInteractive={false}
        className="!overflow-hidden !rounded-md !border !border-gray-700 !bg-gray-900 !shadow-none [&>button]:!border-gray-700 [&>button]:!bg-gray-900 [&>button]:!text-gray-300"
      />
    </ReactFlow>
  );
}

/**
 * @param {{
 *   drawable?: { nodes?: object[], edges?: object[] } | null,
 *   loading?: boolean,
 *   error?: string,
 *   className?: string,
 * }} props
 */
export function WorkflowGraphView({
  drawable = null,
  loading = false,
  error = '',
  className = '',
}) {
  return (
    <div
      className={`overflow-hidden rounded-lg border border-gray-800 bg-gray-950/80 ${className}`}
    >
      {loading ? (
        <p className="px-3 py-6 text-center text-[11px] text-gray-500">Loading graph…</p>
      ) : error ? (
        <p className="px-3 py-6 text-center text-[11px] text-rose-300/90">{error}</p>
      ) : (
        <div className="h-full min-h-[16rem] w-full">
          <ReactFlowProvider>
            <WorkflowGraphCanvas drawable={drawable} />
          </ReactFlowProvider>
        </div>
      )}
    </div>
  );
}
