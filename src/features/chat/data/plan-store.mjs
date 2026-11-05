/**
 * Workspace-global plans under `.kusa/plans/{id}.json`.
 * Any Agent (or Subagent) can create / read / update them via tools or HTTP.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const PLANS_DIR = 'plans';
export const PLAN_STATUSES = ['draft', 'ready', 'approved', 'executing', 'done', 'cancelled'];

export function plansRoot(monitorDir) {
  return join(monitorDir, PLANS_DIR);
}

function atomicWriteFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, path);
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function newPlanId() {
  return `plan_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

function normalizeTodo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const content = String(raw.content || '').trim().slice(0, 500);
  if (!content) return null;
  const id = String(raw.id || content.slice(0, 40)).trim().slice(0, 80) || content.slice(0, 40);
  const status = PLAN_STATUSES.includes(raw.status) || ['pending', 'in_progress', 'completed', 'cancelled'].includes(raw.status)
    ? String(raw.status)
    : 'pending';
  return { id, content, status };
}

export function normalizePlan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim().slice(0, 120);
  if (!id) return null;
  const status = PLAN_STATUSES.includes(String(raw.status || '').trim().toLowerCase())
    ? String(raw.status).trim().toLowerCase()
    : 'draft';
  const todos = Array.isArray(raw.todos)
    ? raw.todos.map(normalizeTodo).filter(Boolean).slice(0, 60)
    : [];
  return {
    id,
    name: String(raw.name || 'Untitled plan').trim().slice(0, 200) || 'Untitled plan',
    overview: String(raw.overview || '').trim().slice(0, 2000),
    body: String(raw.body || '').trim().slice(0, 100_000),
    todos,
    status,
    createdByAgentId: String(raw.createdByAgentId || raw.createdBySessionId || '').trim().slice(0, 120),
    /** Orchestrated parent Agent that owns the planner Subagent (if any). */
    orchestratorAgentId: String(raw.orchestratorAgentId || '').trim().slice(0, 120),
    workflowId: String(raw.workflowId || '').trim().slice(0, 200),
    /** Prompt sent with Approve → assign / execute (editable in the Plan drawer). */
    executionPrompt: String(raw.executionPrompt || '').trim().slice(0, 20_000),
    /** Origin path when intercepted from CreatePlan / `*.plan.md` (dedupe key). */
    sourcePath: String(raw.sourcePath || '').trim().slice(0, 500),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  };
}

export function ensurePlansStore(monitorDir) {
  const root = plansRoot(monitorDir);
  mkdirSync(root, { recursive: true });
  return root;
}

export function listPlans(monitorDir) {
  const root = ensurePlansStore(monitorDir);
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const plan = normalizePlan(readJsonSafe(join(root, entry.name)));
    if (plan) out.push(plan);
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function readPlan(monitorDir, planId) {
  const id = String(planId || '').trim();
  if (!id) return null;
  const path = join(ensurePlansStore(monitorDir), `${id}.json`);
  if (!existsSync(path)) return null;
  return normalizePlan(readJsonSafe(path));
}

export function writePlan(monitorDir, plan) {
  const normalized = normalizePlan(plan);
  if (!normalized) {
    const err = new Error('invalid plan');
    err.code = 'EINVAL';
    throw err;
  }
  const path = join(ensurePlansStore(monitorDir), `${normalized.id}.json`);
  atomicWriteFile(path, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

export function createPlan(monitorDir, input = {}) {
  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : newPlanId();
  const now = Date.now();
  return writePlan(monitorDir, {
    id,
    name: input.name,
    overview: input.overview,
    body: input.body,
    todos: input.todos,
    status: input.status || 'draft',
    createdByAgentId: input.createdByAgentId || input.createdBySessionId || '',
    orchestratorAgentId: input.orchestratorAgentId || '',
    workflowId: input.workflowId || '',
    executionPrompt: input.executionPrompt || '',
    sourcePath: input.sourcePath || '',
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Resolve which workspace plan an external source belongs to — an explicit planId,
 * otherwise the plan already stamped with the same `sourcePath` — then create or
 * refresh it. Shared by the monitor's lane capture and `kusa_plan_ingest`, so a
 * plan file on disk and a captured CreatePlan land in the same record.
 * @param {object} input { id?, sourcePath?, mode?: 'upsert'|'create'|'update', name, overview, body, todos, status, createdByAgentId }
 * @returns {{ ok, plan?, created?, updated?, matchedBy?, error?, code? }}
 */
export function upsertPlanFromSource(monitorDir, input = {}) {
  if (!monitorDir) return { ok: false, error: 'no data dir', code: 'ENOENT' };
  const mode = ['create', 'update'].includes(String(input.mode || '').trim().toLowerCase())
    ? String(input.mode).trim().toLowerCase()
    : 'upsert';
  const sourcePath = String(input.sourcePath || '').trim().slice(0, 500);
  const explicitId = String(input.id || '').trim();
  const agentId = String(input.createdByAgentId || '').trim();
  const name = String(input.name || '').trim();
  const overview = String(input.overview || '').trim();
  const body = String(input.body || '').trim();
  const todos = Array.isArray(input.todos) ? input.todos : [];
  if (!name && !overview && !body && !todos.length) {
    return { ok: false, error: 'plan source carries no name, overview, body, or todos', code: 'EINVAL' };
  }

  let existing = null;
  let matchedBy = '';
  if (explicitId) {
    const byId = readPlan(monitorDir, explicitId);
    if (byId) {
      existing = byId;
      matchedBy = 'planId';
    }
  }
  if (!existing && sourcePath) {
    const byPath = listPlans(monitorDir).find((plan) => plan.sourcePath && plan.sourcePath === sourcePath);
    if (byPath) {
      existing = byPath;
      matchedBy = 'sourcePath';
    }
  }

  const label = sourcePath || explicitId || 'this source';

  if (existing) {
    if (mode === 'create') {
      return {
        ok: false,
        error: `a plan already matches ${label} (${existing.id}) — pass mode "upsert" to refresh it`,
        code: 'EEXISTS',
        existing: planSummary(existing),
      };
    }
    const status = String(existing.status || 'draft');
    const editable = status === 'draft' || status === 'ready';
    // Only refresh content while the human has not moved past ready: an approved /
    // executing plan is being run, so a re-read of the file must not rewrite it.
    const patch = editable
      ? {
        name: name || existing.name,
        overview: overview || existing.overview,
        body: body || existing.body,
        ...(todos.length ? { todos } : {}),
        ...(sourcePath ? { sourcePath } : {}),
        ...(agentId && !existing.createdByAgentId ? { createdByAgentId: agentId } : {}),
      }
      : {
        ...(agentId && !existing.createdByAgentId ? { createdByAgentId: agentId } : {}),
        ...(sourcePath && !existing.sourcePath ? { sourcePath } : {}),
      };
    try {
      const plan = updatePlan(monitorDir, existing.id, patch);
      return {
        ok: true,
        plan,
        updated: true,
        matchedBy,
        ...(editable ? {} : { note: `plan is "${status}" — content left untouched, only linkage refreshed` }),
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err), code: err?.code || 'EINVAL' };
    }
  }

  if (mode === 'update') {
    return {
      ok: false,
      error: `no workspace plan matches ${label} — pass mode "create" (or "upsert") to add one`,
      code: 'EPLAN',
      ...(sourcePath ? { sourcePath } : {}),
    };
  }

  try {
    const plan = createPlan(monitorDir, {
      id: explicitId,
      name: name || 'Untitled plan',
      overview,
      body,
      todos,
      status: input.status || 'ready',
      createdByAgentId: agentId,
      sourcePath,
    });
    return { ok: true, plan, created: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), code: err?.code || 'EINVAL' };
  }
}

/**
 * Upsert a workspace plan from a monitor lane's intercepted CreatePlan /
 * `*.plan.md` snapshot so external (Cursor IDE) sessions land in the Plan drawer.
 * Stamps `lane.plan.workspacePlanId` for stable updates on later edits.
 */
export function upsertPlanFromLaneCapture(monitorDir, lane) {
  if (!monitorDir || !lane?.plan || typeof lane.plan !== 'object') return null;
  const snap = lane.plan;
  const result = upsertPlanFromSource(monitorDir, {
    id: String(snap.workspacePlanId || '').trim(),
    sourcePath: String(snap.path || '').trim(),
    name: String(snap.name || '').trim(),
    overview: String(snap.overview || '').trim(),
    body: String(snap.body || '').trim(),
    todos: Array.isArray(lane.todos) ? lane.todos : (Array.isArray(snap.todos) ? snap.todos : []),
    status: 'ready',
    createdByAgentId: String(lane.id || '').trim(),
  });
  if (!result?.ok) return null;
  snap.workspacePlanId = result.plan.id;
  return result.plan;
}

export function updatePlan(monitorDir, planId, patch = {}) {
  const existing = readPlan(monitorDir, planId);
  if (!existing) {
    const err = new Error(`plan not found: ${planId}`);
    err.code = 'ENOENT';
    throw err;
  }
  const next = {
    ...existing,
    ...patch,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };
  // Allow explicitly clearing or setting agent linkage via patch.
  if (patch.createdByAgentId !== undefined) {
    next.createdByAgentId = String(patch.createdByAgentId || '').trim();
  }
  if (patch.orchestratorAgentId !== undefined) {
    next.orchestratorAgentId = String(patch.orchestratorAgentId || '').trim();
  }
  return writePlan(monitorDir, next);
}

export function deletePlan(monitorDir, planId) {
  const id = String(planId || '').trim();
  if (!id) return false;
  const path = join(ensurePlansStore(monitorDir), `${id}.json`);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Compact list rows for the Plan drawer. */
export function planSummary(plan) {
  if (!plan) return null;
  return {
    id: plan.id,
    name: plan.name,
    overview: plan.overview,
    status: plan.status,
    todoCount: Array.isArray(plan.todos) ? plan.todos.length : 0,
    updatedAt: plan.updatedAt,
    createdByAgentId: plan.createdByAgentId,
    orchestratorAgentId: plan.orchestratorAgentId,
    workflowId: plan.workflowId,
    executionPrompt: plan.executionPrompt || '',
    sourcePath: plan.sourcePath || '',
  };
}

/**
 * Plans that block deleting these Agent ids (planner, orchestrator, or
 * sessions that carry the planId). Caller should expand the agent tree first.
 */
export function plansLockingAgentIds(monitorDir, agentIds = []) {
  const ids = new Set(
    (Array.isArray(agentIds) ? agentIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  if (!ids.size) return [];
  return listPlans(monitorDir).filter((plan) => {
    if (plan.createdByAgentId && ids.has(plan.createdByAgentId)) return true;
    if (plan.orchestratorAgentId && ids.has(plan.orchestratorAgentId)) return true;
    return false;
  });
}
