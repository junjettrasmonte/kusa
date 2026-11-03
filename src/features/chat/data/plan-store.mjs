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
    createdAt: now,
    updatedAt: now,
  });
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
