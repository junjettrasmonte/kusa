/**
 * Orchestrator escalate tool — hand one blocked action to another chat
 * provider for a single turn, then resume with that provider's result.
 * Only available on orchestrated sessions (kind=orchestrated / workflowId).
 * Approval-gated like terminal/browse: the session Rule must allow the handoff.
 */
import { createApprovalGate } from '#features/agent/approval.mjs';
import {
  createSubagent,
  readChatSession,
  readSessionConfig,
  writeSessionConfig,
} from '#features/chat/data/chat-store.mjs';
import {
  listChatProviders,
  resolveChatProvider,
  SESSION_KIND_ORCHESTRATED,
} from '#features/chat/data/providers.mjs';

export const ESCALATE_TOOL_DEFS = [
  {
    name: 'kusa_escalate',
    description:
      'When stuck on a blocker in an orchestrated session, hand one concrete action to another '
      + 'chat provider for a single turn, then resume with that provider\'s result. '
      + 'Approval-gated: the call either runs or is refused outright under the session Rule. '
      + 'Prefer a different provider than the one currently running (e.g. cursor, copilot, kusa). '
      + 'Control returns after that turn completes — do not escalate work that belongs to a '
      + 'workflow role Subagent (use kusa_assign for that).',
    parameters: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Target provider id (e.g. cursor, copilot, kusa)',
        },
        action: {
          type: 'string',
          description: 'Concrete action / prompt for the other provider to execute this turn',
        },
        reason: {
          type: 'string',
          description: 'Optional short note on why you are escalating (helps the other provider)',
        },
        model: {
          type: 'string',
          description: 'Optional model override for the escalated turn',
        },
        mode: {
          type: 'string',
          description: 'Optional mode override: ask | plan | agent (default agent)',
        },
      },
      required: ['provider', 'action'],
      additionalProperties: false,
    },
  },
];

function agentIdFromSessionKey(sessionKey) {
  const key = String(sessionKey || '');
  const i = key.indexOf(':');
  return i >= 0 ? key.slice(i + 1) : key;
}

/** True when this session is an orchestrated Agent (or has a workflow). */
export function isOrchestratedSessionKey(dataDir, sessionKey) {
  if (!dataDir || !sessionKey) return false;
  const parentId = agentIdFromSessionKey(sessionKey);
  if (!parentId) return false;
  const parent = readChatSession(dataDir, parentId);
  const config = readSessionConfig(dataDir, parentId) || parent?.options || {};
  const kind = String(config.kind || parent?.kind || '').toLowerCase();
  return kind === SESSION_KIND_ORCHESTRATED || Boolean(config.workflowId || parent?.options?.workflowId);
}

function availableProviderIds() {
  return listChatProviders().map((p) => p.id).sort();
}

function buildEscalationPrompt({ action, reason = '' } = {}) {
  const lines = [
    'You are handling a one-turn escalation from a Kusă orchestrator that hit a blocker.',
    'Complete ONLY the action below, then stop. The orchestrator resumes with your reply as tool output.',
  ];
  const why = String(reason || '').trim();
  if (why) lines.push(`Why escalated: ${why}`);
  lines.push('', 'Action:', String(action || '').trim());
  return lines.join('\n');
}

export function createEscalateTools({
  dataDir = '',
  sessionKey = '',
  workspaceRoot = process.cwd(),
  /** Await a single provider turn and return its result. */
  runTurn = null,
  signal = null,
  approval = createApprovalGate(),
} = {}) {
  async function escalate(args = {}) {
    if (!dataDir) return { ok: false, error: 'no data dir', code: 'ENOENT' };
    const parentId = agentIdFromSessionKey(sessionKey);
    if (!parentId) return { ok: false, error: 'no parent agent', code: 'EINVAL' };

    if (!isOrchestratedSessionKey(dataDir, sessionKey)) {
      return {
        ok: false,
        error: 'kusa_escalate is only available on orchestrated sessions',
        code: 'EORCH',
      };
    }

    const providerRaw = String(args.provider || '').trim();
    if (!providerRaw) return { ok: false, error: 'provider is required', code: 'EINVAL' };
    const meta = resolveChatProvider(providerRaw);
    if (!meta) {
      return {
        ok: false,
        error: `Unknown provider "${providerRaw}". Available: ${availableProviderIds().join(', ') || '(none)'}`,
        code: 'EINVAL',
        providers: availableProviderIds(),
      };
    }

    const action = String(args.action || '').trim();
    if (!action) return { ok: false, error: 'action is required', code: 'EINVAL' };

    const parent = readChatSession(dataDir, parentId);
    const parentConfig = readSessionConfig(dataDir, parentId) || parent?.options || {};
    const workflowId = parentConfig.workflowId || parent?.options?.workflowId || null;
    const mode = String(args.mode || 'agent').trim().toLowerCase() || 'agent';
    const model = String(args.model || '').trim();
    const reason = String(args.reason || '').trim();
    const rendered = buildEscalationPrompt({ action, reason });

    if (typeof runTurn !== 'function') {
      return {
        ok: false,
        error: 'escalation runner unavailable (orchestrated serve path required)',
        code: 'ENOENT',
      };
    }

    let child;
    try {
      child = createSubagent(dataDir, {
        parentId,
        workspaceRoot,
        provider: meta.id,
        role: 'escalation',
        workflowId,
        mode,
      });
    } catch (err) {
      return { ok: false, error: err?.message || String(err), code: err?.code || 'EFAIL' };
    }

    if (model) {
      try {
        writeSessionConfig(dataDir, child.id, { model }, child.harness, parentId);
      } catch { /* best-effort */ }
    }

    let result;
    try {
      result = await runTurn({
        sessionId: child.id,
        queueKey: child.key,
        harness: child.harness,
        provider: child.provider,
        prompt: rendered,
        mode,
        model,
        parentId,
        role: 'escalation',
        signal,
        awaitCompletion: true,
      });
    } catch (err) {
      return {
        ok: false,
        delegated: true,
        childId: child.id,
        error: err?.message || String(err),
        code: err?.code || 'EFAIL',
        subagent: {
          id: child.id,
          key: child.key,
          provider: child.provider,
          harness: child.harness,
          role: 'escalation',
          parentId,
          model: model || null,
        },
      };
    }

    const text = typeof result?.text === 'string' ? result.text : '';
    const ok = result?.ok !== false && result?.type !== 'error';
    return {
      ok,
      delegated: true,
      childId: child.id,
      provider: meta.id,
      reason: reason || null,
      action,
      model: model || null,
      text: text || result?.message || '',
      error: ok ? undefined : (result?.message || result?.error || 'escalated turn failed'),
      code: ok ? undefined : (result?.code || 'EFAIL'),
      subagent: {
        id: child.id,
        key: child.key,
        provider: child.provider,
        harness: child.harness,
        role: 'escalation',
        parentId,
        model: model || null,
      },
      turnId: result?.turnId || null,
      message: ok
        ? `Escalation to ${meta.id} finished; resume with the result below.`
        : `Escalation to ${meta.id} failed`,
    };
  }

  async function call(name, args = {}, callId = null) {
    if (name !== 'kusa_escalate' && name !== 'escalate') {
      return { ok: false, error: `unknown escalate tool: ${name}`, code: 'ENOENT' };
    }
    // Refuse unavailable contexts before asking — an approval row for a tool
    // that cannot run would mislead the user into Allowing a no-op.
    if (!dataDir) return { ok: false, error: 'no data dir', code: 'ENOENT' };
    if (!isOrchestratedSessionKey(dataDir, sessionKey)) {
      return {
        ok: false,
        error: 'kusa_escalate is only available on orchestrated sessions',
        code: 'EORCH',
      };
    }
    const verdict = await approval.request({
      name,
      args,
      callId,
    });
    if (!verdict.allowed) {
      const reason = verdict?.reason || `${name} was not approved`;
      const decision = String(verdict?.decision || '');
      const byRule = decision.endsWith('-default');
      const ruleIsDeny = decision === 'mode-deny';
      return {
        ok: false,
        denied: true,
        approval: verdict,
        error: verdict?.unattended === true
          ? `DENIED before escalating: no approver is wired for this run, so the rule default applied — ${reason}. Retrying will be denied again; ask the user to switch the approval rule to Allow if this must run.`
          : ruleIsDeny
            ? `DENIED before escalating: the approval Rule is Deny, so nothing was asked and the escalation was NOT started. Retrying will be denied again — ask the user to switch the Rule to Allow if this must run.`
            : byRule
            ? `DENIED before escalating: nobody answered in time, so the rule default applied — ${reason}. The escalation was NOT started. Describe the provider and action, then retry once the user allows it.`
            : `DENIED by the user before escalating: ${reason} — the escalation was not started.`,
      };
    }
    return escalate(args);
  }

  return {
    defs: ESCALATE_TOOL_DEFS,
    call,
    escalate,
    approval,
  };
}

export function escalateSystemPromptAddon({ dataDir = '', sessionKey = '' } = {}) {
  if (!isOrchestratedSessionKey(dataDir, sessionKey)) return '';
  const providers = availableProviderIds();
  return [
    'If you are stuck on a blocker you cannot break through yourself, use kusa_escalate',
    'to hand that one action to another chat provider for a single turn, then continue',
    'with the returned result. Prefer a different provider than the one currently running.',
    'kusa_escalate is approval-gated like kusa_terminal — the call either runs or is refused outright.',
    providers.length ? `Registered providers: ${providers.join(', ')}.` : '',
    'Do not use kusa_escalate for normal role work — that is kusa_assign.',
  ].filter(Boolean).join(' ');
}

export function escalateToolSchemas() {
  return ESCALATE_TOOL_DEFS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
