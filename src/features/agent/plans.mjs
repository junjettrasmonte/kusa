/**
 * Workspace plan tools — create / read / update plans shared across Agents.
 * Plans live in `.kusa/plans/` (not per-session), so the Plan drawer and any
 * Subagent can see the same records. Approval is a status flip (usually from UI);
 * approving continues the orchestrated workflow (assign execution).
 */
import {
  createPlan,
  listPlans,
  planSummary,
  plansLockingAgentIds,
  readPlan,
  updatePlan,
  PLAN_STATUSES,
} from '#features/chat/data/plan-store.mjs';
import {
  listChatSessions,
  readChatSession,
  readSessionConfig,
  writeChatSession,
  writeSessionConfig,
} from '#features/chat/data/chat-store.mjs';
import { isExecutorRole, isPlannerRole } from '#features/workflows/store.mjs';
import { createAssignTools } from './assign.mjs';

export const PLAN_TOOL_DEFS = [
  {
    name: 'kusa_plan_list',
    description:
      'List workspace plans (id, name, status, overview). Plans are shared across all Agents — '
      + 'not tied to this chat alone. Use before assigning an Executor so you know which planId to pass.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: PLAN_STATUSES,
          description: 'Optional filter by status',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_plan_create',
    description:
      'Create a workspace plan visible in the Plan drawer. Pass name, overview, body (markdown), '
      + 'and optional todos. Status defaults to draft; the human Approves in the Plan drawer before execution.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short plan title' },
        overview: { type: 'string', description: 'One-paragraph summary' },
        body: { type: 'string', description: 'Full plan markdown' },
        todos: {
          type: 'array',
          maxItems: 40,
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              id: { type: 'string' },
              status: { type: 'string' },
            },
            required: ['content'],
            additionalProperties: false,
          },
        },
        status: {
          type: 'string',
          enum: ['draft', 'ready'],
          description: 'Defaults to draft. Do not set approved — the human Approves in the UI.',
        },
        workflowId: { type: 'string' },
      },
      required: ['name', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_plan_read',
    description: 'Read one workspace plan by id (full body + todos + status).',
    parameters: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'Plan id from kusa_plan_list or kusa_plan_create' },
      },
      required: ['planId'],
      additionalProperties: false,
    },
  },
  {
    name: 'kusa_plan_update',
    description:
      'Update an existing workspace plan (name, overview, body, todos, status). '
      + 'Prefer status ready when the plan is complete enough for human review. '
      + 'Do not set approved yourself — that is the Plan drawer Approve action.',
    parameters: {
      type: 'object',
      properties: {
        planId: { type: 'string' },
        name: { type: 'string' },
        overview: { type: 'string' },
        body: { type: 'string' },
        todos: {
          type: 'array',
          maxItems: 40,
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              id: { type: 'string' },
              status: { type: 'string' },
            },
            required: ['content'],
            additionalProperties: false,
          },
        },
        status: {
          type: 'string',
          enum: ['draft', 'ready', 'executing', 'done', 'cancelled'],
        },
      },
      required: ['planId'],
      additionalProperties: false,
    },
  },
];

function agentIdFromSessionKey(sessionKey) {
  const key = String(sessionKey || '');
  const i = key.indexOf(':');
  return i >= 0 ? key.slice(i + 1) : key;
}

function sessionParentId(session) {
  return String(session?.parentId || session?.options?.parentId || '').trim();
}

function sessionWorkflowId(session) {
  return String(session?.workflowId || session?.options?.workflowId || '').trim();
}

function isOrchestratorSession(session) {
  if (!session) return false;
  const kind = String(session.kind || session.options?.kind || '').toLowerCase();
  return kind === 'orchestrated' || Boolean(sessionWorkflowId(session));
}

function firstUserPrompt(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  for (const msg of messages) {
    if (msg?.role !== 'user') continue;
    const text = String(msg.text || msg.content || '').trim();
    if (text) return text;
  }
  return '';
}

function hasExecutionForPlan(session, planId) {
  const id = String(planId || '').trim();
  if (!id || !session) return false;
  const kids = Array.isArray(session.subagents)
    ? session.subagents
    : (Array.isArray(session.options?.subagents) ? session.options.subagents : []);
  return kids.some((kid) => (
    isExecutorRole(kid?.role)
    && String(kid?.planId || '') === id
  ));
}

/**
 * Find the orchestrated parent that should continue after a plan is approved.
 * Prefers plan.createdByAgentId (walks up to parent when that agent is a Subagent),
 * then parents that already reference this planId, then recent Planner Subagents.
 */
export function resolveOrchestratorForPlan(dataDir, plan) {
  if (!dataDir || !plan) return null;
  const planId = String(plan.id || '').trim();
  const byId = String(plan.createdByAgentId || '').trim();

  if (byId) {
    const creator = readChatSession(dataDir, byId);
    const creatorConfig = readSessionConfig(dataDir, byId) || creator?.options || {};
    const parentId = String(creatorConfig.parentId || sessionParentId(creator) || '').trim();
    if (parentId) {
      const parent = readChatSession(dataDir, parentId);
      if (parent) return parent;
    }
    if (creator && isOrchestratorSession({ ...creator, ...creatorConfig, options: creatorConfig })) {
      return creator;
    }
  }

  const sessions = listChatSessions(dataDir);
  if (planId) {
    const byPlanRef = sessions.find((s) => (
      !sessionParentId(s)
      && isOrchestratorSession(s)
      && hasExecutionForPlan(s, planId) === false
      && (Array.isArray(s.subagents) ? s.subagents : []).some((kid) => String(kid?.planId || '') === planId)
    ));
    if (byPlanRef) return byPlanRef;
  }

  // Fallback: orchestrator with a Planner Subagent and no Executor for this plan yet.
  const candidates = sessions.filter((s) => {
    if (sessionParentId(s) || !isOrchestratorSession(s)) return false;
    if (planId && hasExecutionForPlan(s, planId)) return false;
    const kids = Array.isArray(s.subagents) ? s.subagents : [];
    return kids.some((kid) => isPlannerRole(kid?.role));
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
  return candidates[0];
}

/**
 * Persist plan ↔ planner / orchestrator linkage on the plan record and session
 * sidecars so the Plan drawer can show the planner and delete can refuse the tree.
 */
export function linkPlanToAgents(dataDir, plan, {
  plannerId = '',
  orchestratorId = '',
} = {}) {
  if (!dataDir || !plan?.id) return plan;
  const planner = String(plannerId || plan.createdByAgentId || '').trim();
  let orch = String(orchestratorId || plan.orchestratorAgentId || '').trim();
  if (!orch && planner) {
    const cfg = readSessionConfig(dataDir, planner) || {};
    orch = String(cfg.parentId || '').trim();
  }
  const patch = {};
  if (planner && planner !== plan.createdByAgentId) patch.createdByAgentId = planner;
  if (orch && orch !== plan.orchestratorAgentId) patch.orchestratorAgentId = orch;
  let next = plan;
  if (Object.keys(patch).length) {
    try {
      next = updatePlan(dataDir, plan.id, patch);
    } catch {
      next = plan;
    }
  }

  if (planner) {
    try {
      const cfg = readSessionConfig(dataDir, planner) || {};
      writeSessionConfig(dataDir, planner, { ...cfg, planId: next.id }, null, cfg.parentId || null);
    } catch { /* best-effort */ }
  }
  if (orch && planner) {
    try {
      const parentCfg = readSessionConfig(dataDir, orch) || {};
      const kids = Array.isArray(parentCfg.subagents) ? parentCfg.subagents : [];
      const updated = kids.map((kid) => (
        kid?.id === planner ? { ...kid, planId: next.id } : kid
      ));
      if (updated.some((kid, i) => kid !== kids[i])) {
        writeSessionConfig(dataDir, orch, { ...parentCfg, subagents: updated });
      }
    } catch { /* best-effort */ }
  }
  return next;
}

/**
 * Cursor (and other CLI planners) often write `.kusa/plans/*.json` without
 * kusa_plan_create — claim unowned plans updated during/after the turn.
 */
export function claimUnownedPlansForAgent(dataDir, {
  agentId = '',
  parentId = '',
  workflowId = '',
  sinceMs = 0,
} = {}) {
  const planner = String(agentId || '').trim();
  if (!dataDir || !planner) return [];
  const since = Number.isFinite(sinceMs) ? sinceMs : 0;
  const wf = String(workflowId || '').trim();
  const claimed = [];
  for (const plan of listPlans(dataDir)) {
    if (plan.createdByAgentId) continue;
    if (since && Number(plan.updatedAt || plan.createdAt || 0) + 60_000 < since) continue;
    if (wf && plan.workflowId && plan.workflowId !== wf) continue;
    const linked = linkPlanToAgents(dataDir, plan, {
      plannerId: planner,
      orchestratorId: parentId,
    });
    if (wf && !linked.workflowId) {
      try {
        claimed.push(updatePlan(dataDir, linked.id, { workflowId: wf }));
        continue;
      } catch { /* ignore */ }
    }
    claimed.push(linked);
  }
  return claimed;
}

/**
 * Plans that block deleting these Agents — by planner/orchestrator refs or by
 * a session in the tree that still carries the planId.
 */
export function plansBlockingAgentDelete(dataDir, keysOrIds = []) {
  const treeIds = expandAgentTreeIds(dataDir, keysOrIds);
  const byRef = plansLockingAgentIds(dataDir, treeIds);
  const planIdsOnSessions = new Set();
  for (const s of listChatSessions(dataDir)) {
    if (!treeIds.includes(s.id)) continue;
    const pid = String(s.planId || s.options?.planId || '').trim();
    if (pid) planIdsOnSessions.add(pid);
  }
  const bySession = listPlans(dataDir).filter((p) => planIdsOnSessions.has(p.id));
  const seen = new Set();
  const out = [];
  for (const plan of [...byRef, ...bySession]) {
    if (!plan?.id || seen.has(plan.id)) continue;
    seen.add(plan.id);
    out.push(plan);
  }
  return out;
}

/**
 * Expand session keys / ids to every Agent id in the same tree (parent +
 * Subagents). Used before refusing delete when a plan still references the tree.
 */
export function expandAgentTreeIds(dataDir, keysOrIds = []) {
  const seeds = new Set();
  for (const raw of keysOrIds || []) {
    const text = String(raw || '').trim();
    if (!text) continue;
    seeds.add(text.includes(':') ? text.slice(text.indexOf(':') + 1) : text);
  }
  if (!seeds.size || !dataDir) return [...seeds];

  const sessions = listChatSessions(dataDir);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const roots = new Set();
  for (const id of seeds) {
    const row = byId.get(id);
    const parent = String(row?.parentId || row?.options?.parentId || '').trim();
    roots.add(parent || id);
  }
  const out = new Set(seeds);
  for (const root of roots) out.add(root);
  for (const s of sessions) {
    const parent = String(s.parentId || s.options?.parentId || '').trim();
    if (roots.has(s.id) || (parent && roots.has(parent))) {
      out.add(s.id);
      if (parent) out.add(parent);
    }
  }
  return [...out];
}

/**
 * Resolve DELETE keys for Agents: Subagents cannot be removed on their own
 * (they live under a parent). Parent deletes expand to include every child key
 * so monitor state stays in sync with the recursive folder wipe.
 *
 * @returns {{ keys: string[], blocked: string[] }}
 */
export function resolveAgentDeleteKeys(dataDir, keys = []) {
  const wanted = [...new Set(
    (Array.isArray(keys) ? keys : []).map((key) => String(key || '').trim()).filter(Boolean),
  )];
  if (!wanted.length) return { keys: [], blocked: [] };
  if (!dataDir) return { keys: wanted, blocked: [] };

  const sessions = listChatSessions(dataDir);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const byKey = new Map(sessions.filter((s) => s?.key).map((s) => [s.key, s]));

  const requestedIds = new Set();
  for (const key of wanted) {
    const id = agentIdFromSessionKey(key);
    if (id) requestedIds.add(id);
  }

  const allowed = [];
  const blocked = [];
  for (const key of wanted) {
    const id = agentIdFromSessionKey(key);
    const session = byKey.get(key) || byId.get(id) || null;
    const parent = sessionParentId(session);
    if (parent && !requestedIds.has(parent)) {
      blocked.push(key);
      continue;
    }
    allowed.push(key);
  }

  // Expand each allowed parent to its Subagent keys for a clean wipe.
  const out = new Set(allowed);
  const parentIds = new Set();
  for (const key of allowed) {
    const id = agentIdFromSessionKey(key);
    const session = byKey.get(key) || byId.get(id) || null;
    if (!sessionParentId(session)) parentIds.add(id);
  }
  for (const s of sessions) {
    const parent = sessionParentId(s);
    if (!parent || !parentIds.has(parent) || !s?.key) continue;
    out.add(s.key);
  }
  return { keys: [...out], blocked };
}

function appendParentApprovalNote(dataDir, orchestrator, plan) {
  if (!dataDir || !orchestrator?.id || !plan?.id) return;
  const session = readChatSession(dataDir, orchestrator.id, orchestrator.harness) || orchestrator;
  const note = `Plan approved: ${plan.name || plan.id} (${plan.id}). Starting execution.`;
  const messages = Array.isArray(session.messages) ? [...session.messages] : [];
  const already = messages.some((m) => m?.role === 'user' && String(m.text || '').includes(plan.id) && /Plan approved/i.test(String(m.text || '')));
  if (already) return;
  messages.push({
    id: `plan-approved-${plan.id}`,
    role: 'user',
    text: note,
    at: Date.now(),
  });
  try {
    writeChatSession(dataDir, { ...session, messages });
  } catch {
    /* best-effort transcript note */
  }
}

/**
 * After a human Approves a plan, assign the workflow's execution role on the
 * owning orchestrator (idempotent if execution for this planId already exists).
 */
export async function continueWorkflowAfterPlanApproval({
  dataDir = '',
  plan = null,
  workspaceRoot = process.cwd(),
  startTurn = null,
} = {}) {
  if (!dataDir || !plan?.id) {
    return { ok: false, error: 'dataDir and plan required', code: 'EINVAL' };
  }
  if (String(plan.status || '').toLowerCase() !== 'approved'
    && String(plan.status || '').toLowerCase() !== 'executing') {
    return { ok: false, error: `plan status is "${plan.status}" — need approved`, code: 'EPLAN' };
  }

  const orchestrator = resolveOrchestratorForPlan(dataDir, plan);
  if (!orchestrator?.id) {
    return { ok: false, error: 'no orchestrator Agent found for this plan', code: 'ENOENT' };
  }

  if (hasExecutionForPlan(orchestrator, plan.id)) {
    return {
      ok: true,
      skipped: true,
      reason: 'execution_already_assigned',
      orchestratorId: orchestrator.id,
      planId: plan.id,
    };
  }

  // Backfill linkage when the Planner wrote the plan without kusa_plan_create metadata.
  try {
    const planner = (Array.isArray(orchestrator.subagents) ? orchestrator.subagents : [])
      .find((kid) => isPlannerRole(kid?.role));
    plan = linkPlanToAgents(dataDir, plan, {
      plannerId: plan.createdByAgentId || planner?.id || '',
      orchestratorId: orchestrator.id,
    });
    if (!plan.workflowId && sessionWorkflowId(orchestrator)) {
      plan = updatePlan(dataDir, plan.id, { workflowId: sessionWorkflowId(orchestrator) });
    }
  } catch {
    /* non-fatal */
  }

  const original = firstUserPrompt(orchestrator) || plan.overview || plan.name || plan.id;
  const sessionKey = orchestrator.key || `kusa:${orchestrator.id}`;
  const assign = createAssignTools({
    dataDir,
    sessionKey,
    workspaceRoot,
    startTurn,
  });
  const result = await assign.assign({
    role: 'executor',
    planId: plan.id,
    prompt: original,
  });

  if (result?.ok) {
    appendParentApprovalNote(dataDir, orchestrator, plan);
    try {
      updatePlan(dataDir, plan.id, { status: 'executing' });
    } catch {
      /* status flip is best-effort */
    }
  }

  return {
    ...result,
    orchestratorId: orchestrator.id,
    planId: plan.id,
  };
}

export function createPlanTools({ dataDir = '', sessionKey = '' } = {}) {
  function list(args = {}) {
    if (!dataDir) return { ok: false, error: 'no data dir', code: 'ENOENT' };
    let plans = listPlans(dataDir).map(planSummary);
    const status = typeof args.status === 'string' ? args.status.trim().toLowerCase() : '';
    if (status) plans = plans.filter((p) => p.status === status);
    return { ok: true, plans, count: plans.length };
  }

  function create(args = {}) {
    if (!dataDir) return { ok: false, error: 'no data dir', code: 'ENOENT' };
    const agentId = agentIdFromSessionKey(sessionKey);
    const config = agentId ? (readSessionConfig(dataDir, agentId) || {}) : {};
    const workflowId = String(args.workflowId || config.workflowId || '').trim();
    const orchestratorAgentId = String(config.parentId || '').trim();
    try {
      let plan = createPlan(dataDir, {
        name: args.name,
        overview: args.overview,
        body: args.body,
        todos: args.todos,
        status: args.status === 'ready' ? 'ready' : 'draft',
        workflowId,
        createdByAgentId: agentId,
        orchestratorAgentId,
      });
      plan = linkPlanToAgents(dataDir, plan, {
        plannerId: agentId,
        orchestratorId: orchestratorAgentId,
      });
      return { ok: true, plan };
    } catch (err) {
      return { ok: false, error: err?.message || String(err), code: err?.code || 'EINVAL' };
    }
  }

  function read(args = {}) {
    if (!dataDir) return { ok: false, error: 'no data dir', code: 'ENOENT' };
    const plan = readPlan(dataDir, args.planId);
    if (!plan) return { ok: false, error: `plan not found: ${args.planId}`, code: 'ENOENT' };
    return { ok: true, plan };
  }

  function update(args = {}) {
    if (!dataDir) return { ok: false, error: 'no data dir', code: 'ENOENT' };
    const patch = {};
    for (const key of ['name', 'overview', 'body', 'todos', 'status']) {
      if (args[key] !== undefined) patch[key] = args[key];
    }
    // Models must not self-approve — only draft/ready/executing/done/cancelled via tools.
    if (patch.status === 'approved') {
      return {
        ok: false,
        error: 'Cannot set status to approved via tools — the human Approves in the Plan drawer.',
        code: 'EPERM',
      };
    }
    try {
      const plan = updatePlan(dataDir, args.planId, patch);
      return { ok: true, plan };
    } catch (err) {
      return { ok: false, error: err?.message || String(err), code: err?.code || 'EINVAL' };
    }
  }

  function call(name, args = {}) {
    if (name === 'kusa_plan_list' || name === 'plan_list') return list(args);
    if (name === 'kusa_plan_create' || name === 'plan_create') return create(args);
    if (name === 'kusa_plan_read' || name === 'plan_read') return read(args);
    if (name === 'kusa_plan_update' || name === 'plan_update') return update(args);
    return { ok: false, error: `unknown plan tool: ${name}`, code: 'ENOENT' };
  }

  return {
    defs: PLAN_TOOL_DEFS,
    call,
    list,
    create,
    read,
    update,
  };
}

export function planSystemPromptAddon() {
  return [
    'Workspace plans are shared across Agents via kusa_plan_list / kusa_plan_create /',
    'kusa_plan_read / kusa_plan_update. When planning work, write the plan with these tools',
    'so it appears in the Plan drawer. Humans Approve plans in the UI — never set status',
    'to approved yourself. After approval, an Orchestrator may kusa_assign role=executor',
    'with that planId.',
  ].join(' ');
}

export function planToolSchemas() {
  return PLAN_TOOL_DEFS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
