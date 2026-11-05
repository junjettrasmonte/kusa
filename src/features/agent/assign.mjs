/**
 * Orchestrator assign tool — spawn a Subagent for a workflow role.
 * Role defaults (provider / mode / rules / model / prompt template / plan gate)
 * come from `.kusa/workflows/{workflowId}.json` via the parent's session options.
 * Kusă Subagent tool gates resolve under the role's `rules`.
 */
import {
  createSubagent,
  readChatSession,
  readSessionConfig,
  writeSessionConfig,
} from '#features/chat/data/chat-store.mjs';
import { loadQueues, saveQueues } from '#features/chat/data/queue-store.mjs';
import { readPlan } from '#features/chat/data/plan-store.mjs';
import { normalizeApprovalMode } from '#features/agent/approval.mjs';
import {
  ORCHESTRATOR_ROLE,
  assignableWorkflowRoles,
  canonicalWorkflowRole,
  listWorkflows,
  readWorkflow,
  renderRolePrompt,
  resolveWorkflowModelId,
  workflowRole,
} from '#features/workflows/store.mjs';
import { randomBytes } from 'node:crypto';

export const ASSIGN_TOOL_DEFS = [
  {
    name: 'kusa_assign',
    description:
      'REQUIRED on orchestrated Agents for any work that needs code or a plan. '
      + 'Spawns a Subagent and starts its turn (planner → Cursor via the CAO/Cursor provider). '
      + 'Pass role (planner, executor, tester, prototyper, reviewer), a prompt, '
      + 'and planId when the role requires an approved plan. '
      + 'For a new user request, call this first with role=planner — do not implement yourself.',
    parameters: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          description: 'Workflow actor role (e.g. planner, executor, tester, prototyper, reviewer)',
        },
        prompt: {
          type: 'string',
          description: 'Task for the Subagent (filled into the role prompt template)',
        },
        planId: {
          type: 'string',
          description: 'Required when the role has requiresPlanStatus (e.g. executor needs approved)',
        },
        provider: {
          type: 'string',
          description: 'Optional provider override (defaults from workflow role)',
        },
        mode: {
          type: 'string',
          description: 'Optional mode override: ask | plan | agent',
        },
      },
      required: ['role', 'prompt'],
      additionalProperties: false,
    },
  },
];

function agentIdFromSessionKey(sessionKey) {
  const key = String(sessionKey || '');
  const i = key.indexOf(':');
  return i >= 0 ? key.slice(i + 1) : key;
}

function queueEntryId() {
  return `q_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

function enqueuePrompt(dataDir, sessionKey, text, options = {}) {
  const { queued, steering } = loadQueues(dataDir);
  const list = queued.get(sessionKey) || [];
  const rules = String(options.rules || options.approvalMode || '').trim();
  const entry = {
    id: queueEntryId(),
    text: String(text || '').trim(),
    at: Date.now(),
    options: {
      mode: options.mode || '',
      model: options.model || '',
      // Workflow role Rule — resumeIdleSubagentTurns feeds this into startAssignedTurn.
      approvalMode: rules || '',
      ...(rules ? { rules } : {}),
    },
  };
  if (!entry.text) return null;
  list.push(entry);
  queued.set(sessionKey, list);
  saveQueues(dataDir, queued, steering);
  return entry;
}

export function createAssignTools({
  dataDir = '',
  sessionKey = '',
  workspaceRoot = process.cwd(),
  /** Optional: start the Subagent turn in the background. */
  startTurn = null,
} = {}) {
  function availableRoles() {
    if (!dataDir) return [];
    const parentId = agentIdFromSessionKey(sessionKey);
    const config = readSessionConfig(dataDir, parentId) || {};
    const wf = config.workflowId ? readWorkflow(dataDir, config.workflowId) : null;
    if (wf?.roles) return assignableWorkflowRoles(wf);
    // Fall back to seeded plan-execute roles if parent has no workflow yet.
    const seeded = listWorkflows(dataDir).find((w) => w.id === 'plan-execute');
    return seeded ? assignableWorkflowRoles(seeded) : [];
  }

  async function assign(args = {}) {
    if (!dataDir) return { ok: false, error: 'no data dir', code: 'ENOENT' };
    const parentId = agentIdFromSessionKey(sessionKey);
    if (!parentId) return { ok: false, error: 'no parent agent', code: 'EINVAL' };

    const parent = readChatSession(dataDir, parentId);
    const parentConfig = readSessionConfig(dataDir, parentId) || parent?.options || {};
    const workflowId = parentConfig.workflowId || parent?.options?.workflowId || 'plan-execute';
    const roleName = canonicalWorkflowRole(args.role);
    if (!roleName) return { ok: false, error: 'role is required', code: 'EINVAL' };
    if (roleName === ORCHESTRATOR_ROLE) {
      return {
        ok: false,
        error: 'Cannot assign the orchestrator role — that is this session. Pick a Subagent role.',
        code: 'EINVAL',
        roles: availableRoles(),
      };
    }

    const roleCfg = workflowRole(dataDir, workflowId, roleName);
    if (!roleCfg) {
      const roles = availableRoles();
      return {
        ok: false,
        error: `Unknown role "${roleName}". Available: ${roles.join(', ') || '(none)'}`,
        code: 'EINVAL',
        roles,
      };
    }

    const promptText = String(args.prompt || '').trim();
    if (!promptText) return { ok: false, error: 'prompt is required', code: 'EINVAL' };

    let plan = null;
    if (roleCfg.requiresPlanStatus) {
      const planId = String(args.planId || '').trim();
      if (!planId) {
        return {
          ok: false,
          error: `Role "${roleName}" requires planId and plan status "${roleCfg.requiresPlanStatus}".`,
          code: 'EPLAN',
        };
      }
      plan = readPlan(dataDir, planId);
      if (!plan) return { ok: false, error: `plan not found: ${planId}`, code: 'ENOENT' };
      if (plan.status !== roleCfg.requiresPlanStatus) {
        return {
          ok: false,
          error: `Plan ${planId} status is "${plan.status}" — need "${roleCfg.requiresPlanStatus}" (Approve in the Plan drawer).`,
          code: 'EPLAN',
          plan: { id: plan.id, status: plan.status, name: plan.name },
        };
      }
    } else if (args.planId) {
      plan = readPlan(dataDir, args.planId);
    }

    const provider = String(args.provider || roleCfg.provider || 'kusa').trim();
    const orchCfg = workflowRole(dataDir, workflowId, ORCHESTRATOR_ROLE) || {};
    // Parent composer picks (orchestrator message box) may override role defaults
    // when allow*Override is true on the target role or the orchestrator role.
    const parentMode = String(parentConfig.mode || parent?.options?.mode || '').trim().toLowerCase();
    const parentRules = String(parentConfig.rules || parent?.options?.rules || '').trim().toLowerCase();
    const parentModel = resolveWorkflowModelId(
      parentConfig.model || parent?.options?.model || '',
    );
    const parentProvider = String(
      parentConfig.provider || parent?.provider || parent?.options?.provider || 'kusa',
    ).trim().toLowerCase();
    const childProvider = provider.trim().toLowerCase();
    // Model catalogs are per-provider (Kusă BYOK ≠ Cursor --list-models). Never
    // copy the orchestrator's Kusă pick onto a Cursor/Copilot Subagent.
    const sameModelCatalog = parentProvider === childProvider;
    const canOverrideMode = roleCfg.allowModeOverride === true || orchCfg.allowModeOverride === true;
    const canOverrideRules = roleCfg.allowRuleOverride === true || orchCfg.allowRuleOverride === true;
    const canOverrideModel = (
      (roleCfg.allowModelOverride === true || orchCfg.allowModelOverride === true)
      && sameModelCatalog
    );

    const mode = String(
      args.mode
      || (canOverrideMode && parentMode ? parentMode : '')
      || roleCfg.mode
      || 'agent',
    ).trim().toLowerCase();
    const rendered = renderRolePrompt(roleCfg.promptTemplate, {
      prompt: promptText,
      planName: plan?.name || '',
      planBody: [plan?.overview, plan?.body].filter(Boolean).join('\n\n') || '',
    });

    // Blank / auto → '' so startAssignedTurn leaves modelOverride unset and the
    // agent uses that provider's default (Kusă Settings endpoints / Cursor auto).
    const model = resolveWorkflowModelId(
      args.model
      || (canOverrideModel && parentModel ? parentModel : '')
      || roleCfg.model
      || '',
    );
    // Role Rule is where Kusă tool gates resolve for this Subagent:
    // ask-deny / ask-allow → human (orchestrator); allow / deny → auto-settle.
    const rulesRaw = String(
      args.rules
      || (canOverrideRules && parentRules ? parentRules : '')
      || roleCfg.rules
      || '',
    ).trim().toLowerCase();
    const rules = rulesRaw && normalizeApprovalMode(rulesRaw) === rulesRaw
      ? rulesRaw
      : '';
    let child;
    try {
      child = createSubagent(dataDir, {
        parentId,
        workspaceRoot,
        provider,
        role: roleName,
        workflowId,
        planId: plan?.id || null,
        mode,
        rules,
        model,
      });
    } catch (err) {
      return { ok: false, error: err?.message || String(err), code: err?.code || 'EFAIL' };
    }

    // Stamp mode / rules / model on the child so resume + merged transcript
    // header survive refresh without re-reading the workflow.
    if (mode || rules || model) {
      try {
        writeSessionConfig(
          dataDir,
          child.id,
          {
            ...(mode ? { mode } : {}),
            ...(rules ? { rules } : {}),
            ...(model ? { model } : {}),
          },
          child.harness,
          parentId,
        );
      } catch { /* best-effort */ }
    }

    // Kick the Subagent turn immediately when the serve hook is wired. Do not
    // also park the same prompt in the queue on success — that left durable
    // rows Subagents cannot flush (composer locked) and raced serve's in-memory
    // queue map. Persist the prompt via startTurn; if kickoff fails, enqueue so
    // a later idle resume can pick it up.
    let started = false;
    if (typeof startTurn === 'function') {
      try {
        const result = await startTurn({
          sessionId: child.id,
          queueKey: child.key,
          harness: child.harness,
          provider: child.provider,
          prompt: rendered,
          mode,
          model,
          rules,
          parentId,
          role: roleName,
          planId: plan?.id || null,
        });
        started = Boolean(result?.ok || result?.started);
      } catch {
        started = false;
      }
    }

    let queued = null;
    if (!started) {
      queued = enqueuePrompt(dataDir, child.key, rendered, {
        mode,
        model,
        rules,
      });
    }

    // `delegated` + childId ride in the tool result so the parent transcript
    // keeps a durable splice point for the merged group-chat view.
    return {
      ok: true,
      delegated: true,
      childId: child.id,
      role: roleName,
      workflowId,
      planId: plan?.id || null,
      model: model || null,
      rules: rules || null,
      subagent: {
        id: child.id,
        key: child.key,
        provider: child.provider,
        harness: child.harness,
        role: roleName,
        parentId,
        model: model || null,
        rules: rules || null,
      },
      queued: Boolean(queued),
      started,
      message: started
        ? `Started ${roleName} Subagent ${child.id}`
        : `Created ${roleName} Subagent ${child.id}${queued ? ' (prompt queued)' : ''}`,
    };
  }

  async function call(name, args = {}) {
    if (name === 'kusa_assign' || name === 'assign' || name.startsWith('assign_')) {
      // Soft alias: assign_planner / assign_planning → role when omitted.
      const patched = { ...args };
      if (!patched.role && name.startsWith('assign_')) {
        patched.role = name.slice('assign_'.length);
      }
      if (!patched.role && name.startsWith('kusa_assign_')) {
        patched.role = name.slice('kusa_assign_'.length);
      }
      if (patched.role) patched.role = canonicalWorkflowRole(patched.role);
      return assign(patched);
    }
    return { ok: false, error: `unknown assign tool: ${name}`, code: 'ENOENT' };
  }

  return {
    defs: ASSIGN_TOOL_DEFS,
    call,
    assign,
    availableRoles,
  };
}

export function assignSystemPromptAddon({ dataDir = '', sessionKey = '' } = {}) {
  if (!dataDir || !sessionKey) return '';
  const parentId = agentIdFromSessionKey(sessionKey);
  const config = readSessionConfig(dataDir, parentId) || {};
  if (String(config.kind || '').toLowerCase() !== 'orchestrated' && !config.workflowId) {
    return '';
  }
  const workflowId = config.workflowId || 'plan-execute';
  const wf = readWorkflow(dataDir, workflowId);
  const roles = assignableWorkflowRoles(wf);
  const plannerProvider = wf?.roles?.planner?.provider || 'cursor';
  return [
    `You are the Orchestrator for workflow "${wf?.name || workflowId}".`,
    'You do NOT implement, write files, patch, delete, or run commands yourself — those tools are unavailable.',
    'For every user request that needs design or code changes you MUST call kusa_assign immediately.',
    `First assign: kusa_assign with role=planner (provider ${plannerProvider}) and the user request as prompt.`,
    'That spawns a Subagent and starts its turn. Do not invent a plan in chat text when a Planner should be assigned.',
    'After the human Approves a plan in the Plan drawer, call kusa_assign with role=executor and that planId.',
    roles.length ? `Available roles: ${roles.join(', ')}.` : '',
    'You may also assign tester, prototyper, or reviewer (Cursor) when appropriate.',
    'Reply briefly that you assigned the work; the Subagent does the implementation.',
  ].filter(Boolean).join(' ');
}

export function assignToolSchemas() {
  return ASSIGN_TOOL_DEFS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
