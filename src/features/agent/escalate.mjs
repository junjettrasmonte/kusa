/**
 * Orchestrator escalate tool — hand one blocked action to another chat
 * provider for a single turn, then resume with that provider's result.
 * Only available on orchestrated sessions (kind=orchestrated / workflowId).
 *
 * Ask-gated like kusa_ask (no timer): each call shows a provider picker;
 * after that one escalated turn, control always returns to the caller.
 * Escalating again prompts a fresh ask — nothing is sticky.
 */
import { MAX_OPTION_DETAIL, MAX_OPTION_LABEL, MAX_OPTIONS } from '#features/agent/ask.mjs';
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

export const ESCALATE_CANCEL_LABEL = 'Do not escalate';

export const ESCALATE_TOOL_DEFS = [
  {
    name: 'kusa_escalate',
    description:
      'When stuck on a blocker in an orchestrated session, hand one concrete action to another '
      + 'chat provider for a single turn, then resume with that provider\'s result. '
      + 'Ask-gated (no timer): the user picks which registered provider to escalate to — or cancels. '
      + 'Control always returns after that one turn; escalate again only if still blocked (a new ask). '
      + 'Do not escalate work that belongs to a workflow role Subagent (use kusa_assign for that).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Concrete action / prompt for the other provider to execute this turn',
        },
        reason: {
          type: 'string',
          description: 'Optional short note on why you are escalating (helps the user and the other provider)',
        },
        provider: {
          type: 'string',
          description:
            'Optional preferred provider id (e.g. cursor, copilot, kusa). The user still picks; '
            + 'this only ranks that option first when listed.',
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
      required: ['action'],
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

function availableProviders() {
  return listChatProviders()
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function availableProviderIds() {
  return availableProviders().map((p) => p.id);
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

/**
 * Clickable choices for the escalate ask — registered providers, plus cancel.
 * Optional preferred id is listed first when present.
 * @param {{ preferredId?: string }} [opts]
 */
export function escalateProviderOptions({ preferredId = '' } = {}) {
  const preferred = String(preferredId || '').trim().toLowerCase();
  const providers = availableProviders();
  const ranked = preferred
    ? [
      ...providers.filter((p) => p.id === preferred),
      ...providers.filter((p) => p.id !== preferred),
    ]
    : providers;
  // Leave one slot for Cancel so the card never exceeds MAX_OPTIONS.
  const slots = Math.max(1, MAX_OPTIONS - 1);
  const options = ranked.slice(0, slots).map((p) => ({
    label: String(p.label || p.id).trim().slice(0, MAX_OPTION_LABEL) || p.id,
    detail: String(p.id).slice(0, MAX_OPTION_DETAIL),
  }));
  options.push({
    label: ESCALATE_CANCEL_LABEL,
    detail: 'Keep control with the current agent; do not start a handoff',
  });
  return options;
}

function escalateAskQuestion({ action, reason = '', preferredId = '' } = {}) {
  const act = String(action || '').trim();
  const why = String(reason || '').trim();
  const preferred = String(preferredId || '').trim();
  const head = 'Escalate this one-turn action to which provider? Control returns after that turn.';
  const bits = [head];
  if (preferred) bits.push(`Suggested: ${preferred}.`);
  if (why) bits.push(`Why: ${why}`);
  if (act) bits.push(`Action: ${act}`);
  const question = bits.join(' ');
  return question.length <= 600 ? question : `${head} Action: ${act.slice(0, 500)}`;
}

/**
 * Map an ask verdict onto a registered provider, cancel, or unanswered.
 * @param {object} verdict
 * @returns {{ provider?: object, cancelled?: boolean, unanswered?: boolean, reason?: string, error?: string }}
 */
export function providerFromEscalateAsk(verdict) {
  if (!verdict?.ok) {
    return {
      unanswered: true,
      reason: verdict?.reason || 'unanswered',
      error: verdict?.error
        || 'the user did not choose a provider — escalation was not started',
    };
  }
  const label = String(verdict?.selected?.label || verdict?.answer || '').trim();
  const detail = String(verdict?.selected?.detail || '').trim();
  if (!label) {
    return {
      unanswered: true,
      reason: 'empty',
      error: 'the user did not choose a provider — escalation was not started',
    };
  }
  if (label.toLowerCase() === ESCALATE_CANCEL_LABEL.toLowerCase()) {
    return {
      cancelled: true,
      reason: 'cancelled',
      error: 'User cancelled the escalation — no provider turn was started.',
    };
  }
  const byDetail = detail ? resolveChatProvider(detail) : null;
  if (byDetail) return { provider: byDetail };
  const byLabelId = resolveChatProvider(label);
  if (byLabelId) return { provider: byLabelId };
  const match = availableProviders().find(
    (p) => String(p.label || '').toLowerCase() === label.toLowerCase(),
  );
  if (match) return { provider: match };
  return {
    unanswered: true,
    reason: 'unrecognized',
    error: `Could not match "${label}" to a registered provider. Available: ${availableProviderIds().join(', ') || '(none)'}`,
  };
}

export function createEscalateTools({
  dataDir = '',
  sessionKey = '',
  workspaceRoot = process.cwd(),
  /** Await a single provider turn and return its result. */
  runTurn = null,
  signal = null,
  /**
   * Ask channel — same shape tasks use: `(prompt, callId) => ask.call(...)`.
   * Without it the escalate ask refuses immediately (no silent provider pick).
   */
  ask = null,
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
        ? `Escalation to ${meta.id} finished; control returned after one turn. Resume with the result below — escalate again only if still blocked (that prompts a new ask).`
        : `Escalation to ${meta.id} failed`,
    };
  }

  async function call(name, args = {}, callId = null) {
    if (name !== 'kusa_escalate' && name !== 'escalate') {
      return { ok: false, error: `unknown escalate tool: ${name}`, code: 'ENOENT' };
    }
    // Refuse unavailable contexts before asking — a picker for a tool that
    // cannot run would mislead the user into choosing a no-op.
    if (!dataDir) return { ok: false, error: 'no data dir', code: 'ENOENT' };
    if (!isOrchestratedSessionKey(dataDir, sessionKey)) {
      return {
        ok: false,
        error: 'kusa_escalate is only available on orchestrated sessions',
        code: 'EORCH',
      };
    }

    const action = String(args.action || '').trim();
    if (!action) return { ok: false, error: 'action is required', code: 'EINVAL' };

    const preferredId = String(args.provider || '').trim();
    const reason = String(args.reason || '').trim();
    const options = escalateProviderOptions({ preferredId });
    if (options.length <= 1) {
      return {
        ok: false,
        error: 'No chat providers are registered to escalate to',
        code: 'ENOENT',
        providers: [],
      };
    }

    if (typeof ask !== 'function') {
      return {
        ok: false,
        unanswered: true,
        reason: 'unattended',
        error:
          'Escalation needs an interactive ask channel so the user can pick a provider. '
          + 'None is wired for this run — the handoff was NOT started. State the assumption '
          + 'you are proceeding with, or retry once the console can answer.',
      };
    }

    const verdict = await ask({
      question: escalateAskQuestion({ action, reason, preferredId }),
      options,
      allowFreeText: false,
    }, callId);

    const picked = providerFromEscalateAsk(verdict);
    if (picked.cancelled) {
      return {
        ok: false,
        cancelled: true,
        denied: true,
        reason: picked.reason || 'cancelled',
        error: picked.error || 'User cancelled the escalation — no provider turn was started.',
      };
    }
    if (picked.unanswered || !picked.provider) {
      return {
        ok: false,
        unanswered: true,
        reason: picked.reason || 'unanswered',
        error: picked.error
          || 'the user did not choose a provider — escalation was not started',
      };
    }

    return escalate({
      ...args,
      provider: picked.provider.id,
      action,
      reason,
    });
  }

  return {
    defs: ESCALATE_TOOL_DEFS,
    call,
    escalate,
  };
}

export function escalateSystemPromptAddon({ dataDir = '', sessionKey = '' } = {}) {
  if (!isOrchestratedSessionKey(dataDir, sessionKey)) return '';
  const providers = availableProviderIds();
  return [
    'If you are stuck on a blocker you cannot break through yourself, use kusa_escalate',
    'to hand that one action to another chat provider for a single turn, then continue',
    'with the returned result. Prefer a different provider than the one currently running.',
    'kusa_escalate asks the user (no timer) which registered provider to escalate to —',
    'control always returns after that one turn; escalate again only if still blocked',
    '(each call prompts a fresh ask). Optional provider is only a preference ranking.',
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
