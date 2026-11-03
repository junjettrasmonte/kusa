/**
 * Orchestration workflow configs under `.kusa/workflows/`.
 * Each file is `{id}.json` describing roles the parent Agent may assign.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const WORKFLOWS_DIR = 'workflows';

/**
 * Legacy verb role ids → actor nouns. Accepted on assign / plan continue so
 * older sessions and prompts keep working after the rename.
 */
export const WORKFLOW_ROLE_ALIASES = Object.freeze({
  planning: 'planner',
  execution: 'executor',
  testing: 'tester',
  prototyping: 'prototyper',
  review: 'reviewer',
});

/** Role owned by the orchestrated parent session — not assignable as a Subagent. */
export const ORCHESTRATOR_ROLE = 'orchestrator';

export function canonicalWorkflowRole(roleName) {
  const key = String(roleName || '').trim().toLowerCase();
  if (!key) return '';
  return WORKFLOW_ROLE_ALIASES[key] || key;
}

/** Built-in first workflow: plan → approve → execute (+ extra actor roles). */
export const PLAN_EXECUTE_WORKFLOW = {
  id: 'plan-execute',
  name: 'Plan then Execute',
  description:
    'The Orchestrator receives the request, assigns a Planner (Cursor), '
    + 'waits for plan approval, then assigns an Executor. Reviewer also runs on Cursor.',
  roles: {
    orchestrator: {
      provider: 'kusa',
      mode: 'agent',
      promptTemplate:
        'You are the Orchestrator. Do not implement yourself — assign work to '
        + 'other roles with kusa_assign.\n\n{{prompt}}',
    },
    planner: {
      provider: 'cursor',
      mode: 'plan',
      promptTemplate:
        'Create a concrete implementation plan for the following request. '
        + 'Use kusa_plan_create (or kusa_plan_update) so the plan appears in the Plan drawer. '
        + 'Do not implement yet.\n\n{{prompt}}',
    },
    executor: {
      provider: 'kusa',
      mode: 'agent',
      requiresPlanStatus: 'approved',
      promptTemplate:
        'Implement the approved plan below. Do not edit the plan file itself — execute the steps.\n\n'
        + '## Plan: {{planName}}\n\n{{planBody}}\n\n## Original request\n\n{{prompt}}',
    },
    tester: {
      provider: 'kusa',
      mode: 'agent',
      promptTemplate:
        'Test the work described below. Report failures clearly and fix only what the tests require.\n\n{{prompt}}',
    },
    prototyper: {
      provider: 'kusa',
      mode: 'agent',
      promptTemplate:
        'Prototype the idea below with a small, focused change. Prefer speed over polish.\n\n{{prompt}}',
    },
    reviewer: {
      provider: 'cursor',
      mode: 'ask',
      promptTemplate:
        'Review the work described below. Be specific about risks, gaps, and suggested fixes. Read-only.\n\n{{prompt}}',
    },
  },
};

export function workflowsRoot(monitorDir) {
  return join(monitorDir, WORKFLOWS_DIR);
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

function normalizeRole(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const provider = typeof raw.provider === 'string' ? raw.provider.trim().slice(0, 80) : '';
  if (!provider) return null;
  const mode = typeof raw.mode === 'string' ? raw.mode.trim().toLowerCase().slice(0, 40) : 'agent';
  const out = {
    provider,
    mode: mode || 'agent',
    promptTemplate: typeof raw.promptTemplate === 'string' ? raw.promptTemplate : '',
  };
  if (typeof raw.requiresPlanStatus === 'string' && raw.requiresPlanStatus.trim()) {
    out.requiresPlanStatus = raw.requiresPlanStatus.trim().toLowerCase().slice(0, 40);
  }
  if (typeof raw.model === 'string' && raw.model.trim()) {
    out.model = raw.model.trim().slice(0, 200);
  }
  return out;
}

export function normalizeWorkflow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim().slice(0, 120);
  if (!id) return null;
  const rolesIn = raw.roles && typeof raw.roles === 'object' ? raw.roles : {};
  /** @type {Record<string, object>} */
  const roles = {};
  for (const [name, value] of Object.entries(rolesIn)) {
    const key = String(name || '').trim().toLowerCase().slice(0, 60);
    const role = normalizeRole(value);
    if (key && role) roles[key] = role;
  }
  return {
    id,
    name: String(raw.name || id).trim().slice(0, 200) || id,
    description: String(raw.description || '').trim().slice(0, 2000),
    roles,
  };
}

export function ensureWorkflowsSeeded(monitorDir) {
  const root = workflowsRoot(monitorDir);
  mkdirSync(root, { recursive: true });
  const path = join(root, `${PLAN_EXECUTE_WORKFLOW.id}.json`);
  if (!existsSync(path)) {
    atomicWriteFile(path, `${JSON.stringify(PLAN_EXECUTE_WORKFLOW, null, 2)}\n`);
  }
  return root;
}

export function readWorkflow(monitorDir, workflowId) {
  const id = String(workflowId || '').trim();
  if (!id) return null;
  ensureWorkflowsSeeded(monitorDir);
  const path = join(workflowsRoot(monitorDir), `${id}.json`);
  if (!existsSync(path)) return null;
  return normalizeWorkflow(readJsonSafe(path));
}

export function listWorkflows(monitorDir) {
  const root = ensureWorkflowsSeeded(monitorDir);
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const raw = readJsonSafe(join(root, entry.name));
    const wf = normalizeWorkflow(raw);
    if (wf) out.push(wf);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function workflowRole(monitorDir, workflowId, roleName) {
  const wf = readWorkflow(monitorDir, workflowId);
  if (!wf) return null;
  const role = canonicalWorkflowRole(roleName);
  if (!role) return null;
  return wf.roles[role] || null;
}

/** Roles the orchestrator may pass to kusa_assign (excludes the Orchestrator itself). */
export function assignableWorkflowRoles(workflow) {
  const roles = workflow?.roles && typeof workflow.roles === 'object' ? workflow.roles : {};
  return Object.keys(roles).filter((name) => canonicalWorkflowRole(name) !== ORCHESTRATOR_ROLE);
}

/** True when a Subagent role is the Planner (incl. legacy `planning`). */
export function isPlannerRole(roleName) {
  return canonicalWorkflowRole(roleName) === 'planner';
}

/** True when a Subagent role is the Executor (incl. legacy `execution`). */
export function isExecutorRole(roleName) {
  return canonicalWorkflowRole(roleName) === 'executor';
}

/** Fill `{{prompt}}`, `{{planName}}`, `{{planBody}}` in a role template. */
export function renderRolePrompt(template, vars = {}) {
  const src = typeof template === 'string' && template.trim()
    ? template
    : String(vars.prompt || '');
  return src
    .replaceAll('{{prompt}}', String(vars.prompt || ''))
    .replaceAll('{{planName}}', String(vars.planName || ''))
    .replaceAll('{{planBody}}', String(vars.planBody || ''))
    .trim();
}
