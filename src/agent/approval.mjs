/**
 * User-approval gate for side-effecting tools (terminal, browser).
 *
 * Four rules — the "ask" rule is deliberately split in two so the fallback on
 * timeout is part of the rule, not an invisible constant:
 *   ask-deny   ask; if nobody answers within the configured timeout, DENY (safe default)
 *   ask-allow  ask; if nobody answers within the configured timeout, ALLOW
 *   allow      run without asking (composer reverts to ask-deny after a settings window)
 *   deny       never run (same temporary window as allow)
 * The ask rule carries its own timeout contract (timeoutMs / timeoutDecision) on
 * every request it emits, so the caller that owns the wait (serve) and the UI
 * countdown read the same values — the default lives in exactly one place.
 * Legacy 'ask' is accepted on read and means 'ask-deny', so settings written
 * before the split keep behaving as before.
 *
 * The wait itself also lives here, inside the gate every gated tool calls — not
 * in whichever caller happens to wrap the request. request() therefore always
 * resolves to a settled allow or deny: there is no pending / needsApproval
 * state for the model to misread. With no approver wired nobody can answer,
 * so the wait is over on arrival and the rule's default settles it immediately
 * instead of stalling for timeoutMs (same answer a human would get at the
 * deadline, just without the delay).
 */

const APPROVAL_MODES = new Set(['ask-deny', 'ask-allow', 'allow', 'deny']);
const MAX_SUMMARY = 400;

/** Tool names that need an explicit human yes before they run. */
export const APPROVAL_GATED_TOOLS = new Set([
  'kusa_terminal',
  'kusa_browse',
  'terminal',
  'bash',
  'shell',
  'run_command',
  'execute_command',
  'browse',
  'browser',
  'web_fetch',
  'fetch_url',
]);

/**
 * Canonical approval-rule id. Unknown or legacy values (including bare 'ask')
 * fall back to 'ask-deny', the safe rule.
 * @param {string} raw
 * @returns {string} 'ask-deny' | 'ask-allow' | 'allow' | 'deny'
 */
export function normalizeApprovalMode(raw) {
  const mode = String(raw ?? '').trim().toLowerCase();
  if (mode === 'allow' || mode === 'deny') return mode;
  return mode === 'ask-allow' ? 'ask-allow' : 'ask-deny';
}

/** Default ask-wait before the rule's timeout default applies (settings override). */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
/** Hard cap so a mis-set minute value cannot stall a turn for hours. */
export const MAX_APPROVAL_TIMEOUT_MS = 60 * 60_000;
/** @deprecated Prefer DEFAULT_APPROVAL_TIMEOUT_MS; kept as the public default export. */
export const APPROVAL_TIMEOUT_MS = DEFAULT_APPROVAL_TIMEOUT_MS;

/**
 * Resolve a gate timeout from an explicit ms override (or fall back to default).
 * @param {number | null | undefined} timeoutMs
 * @returns {number}
 */
export function resolveApprovalTimeoutMs(timeoutMs = null) {
  const n = Number(timeoutMs);
  if (Number.isFinite(n) && n > 0) {
    return Math.min(Math.max(Math.floor(n), 1_000), MAX_APPROVAL_TIMEOUT_MS);
  }
  return DEFAULT_APPROVAL_TIMEOUT_MS;
}

/** True when an ask rule falls back to ALLOW on timeout (ask-allow); false = deny. */
export function approvalTimeoutAllows(mode = 'ask-deny') {
  return normalizeApprovalMode(mode) === 'ask-allow';
}

/** Label shown in the composer picker and the tools panel. */
export function approvalModeLabel(mode = 'ask-deny') {
  switch (normalizeApprovalMode(mode)) {
    case 'allow': return 'Allow';
    case 'deny': return 'Deny';
    case 'ask-allow': return 'Ask · allow on timeout';
    default: return 'Ask · deny on timeout';
  }
}

function timeoutPhrase(timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS) {
  const mins = Math.max(1, Math.round(resolveApprovalTimeoutMs(timeoutMs) / 60_000));
  return mins === 1 ? '1 minute' : `${mins} minutes`;
}

/**
 * System-prompt lines that tell the model how the gate behaves, so it never
 * claims a gated action ran when it only queued a request — and never waits
 * forever for a decision that the rule will settle by itself.
 * @param {string} mode 'ask-deny' | 'ask-allow' | 'allow' | 'deny'
 * @param {number} [timeoutMs] ask-wait used in the timeout wording
 */
export function approvalSystemPromptAddon(mode = 'ask-deny', timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS) {
  const resolved = normalizeApprovalMode(mode);
  if (resolved === 'deny') {
    return 'kusa_terminal and kusa_browse are disabled for this run: do not call them.';
  }
  if (resolved === 'allow') {
    return 'kusa_terminal and kusa_browse are pre-approved for this run; keep commands short and non-interactive.';
  }
  const wait = timeoutPhrase(timeoutMs);
  const timeoutLine = resolved === 'ask-allow'
    ? `If nobody answers within ${wait} the request is ALLOWED automatically and the call runs — do not say you are still waiting for approval.`
    : `If nobody answers within ${wait} the request is DENIED automatically — treat it as not run.`;
  return [
    'kusa_terminal and kusa_browse are approval-gated: a call either runs or is refused outright —',
    'you will never see a pending or needsApproval state, so never say you are waiting for approval.',
    'When a call is refused the error names the rule that denied it; state exactly what you wanted to',
    'run and why in plain text, then retry the call once the user allows it.',
    timeoutLine,
  ].join(' ');
}

/**
 * @param {object} options
 * @param {string} options.mode 'ask-deny' (default) | 'ask-allow' | 'allow' | 'deny'
 * @param {number} [options.timeoutMs] how long an ask waits before its rule default
 * @param {(request) => boolean | { allowed, remember }} [options.onApprove]
 * @param {(request) => void} [options.emit] surfaces the request (UI/SSE)
 * @param {AbortSignal} [options.signal] Composer Stop — abort unblocks a pending ask
 *   immediately instead of waiting for the rule timeout or a human answer.
 */
export function createApprovalGate({
  mode = 'ask-deny',
  timeoutMs = null,
  onApprove = null,
  emit = null,
  signal = null,
} = {}) {
  // Mutable so a mid-turn composer Rules change can take effect on the next
  // gated call (and the next agent step) without rebuilding the gate.
  let resolvedMode = normalizeApprovalMode(mode);
  let timeoutAllows = resolvedMode === 'ask-allow';
  // One timeout, owned by the gate: serve's resolver and the UI countdown both
  // read it from the request we emit, so nothing else can invent a deadline.
  // Settings may raise this above the 2-minute default (capped by MAX).
  const askTimeoutMs = resolveApprovalTimeoutMs(timeoutMs);
  const remembered = new Map();
  const requests = [];
  let seq = 0;

  function abortError() {
    const err = new Error('aborted');
    err.code = 'ABORT';
    return err;
  }

  function summarizeArgs(args = {}) {
    const interesting = ['command', 'url', 'query', 'path', 'pattern'];
    const parts = interesting
      .map((key) => (args[key] != null ? `${key}=${args[key]}` : null))
      .filter(Boolean);
    const text = parts.length ? parts.join(' ') : JSON.stringify(args ?? {});
    return String(text || '(no arguments)').slice(0, MAX_SUMMARY);
  }

  async function request({ name = '', args = {}, callId = null } = {}) {
    if (!APPROVAL_GATED_TOOLS.has(name)) {
      return { allowed: true, decision: 'not-gated' };
    }

    const rememberedDecision = remembered.get(name);
    if (rememberedDecision) {
      return {
        allowed: rememberedDecision === 'allow',
        decision: `remembered:${rememberedDecision}`,
      };
    }

    if (resolvedMode === 'deny') {
      return { allowed: false, decision: 'mode-deny', reason: 'approval mode deny' };
    }

    const id = `${callId || 'approval'}_${(seq += 1)}`;
    const summary = summarizeArgs(args);
    const ask = {
      id,
      name,
      args,
      callId,
      summary,
      message: `Allow ${name} — ${summary}?`,
      // Timeout contract: the caller that owns the wait (serve) and the UI
      // countdown both read these, so the rule's default lives in one place.
      // timeoutStartsAt is when THIS gate started counting, which is the only
      // deadline that exists — the UI must not start its own clock.
      status: 'pending',
      timeoutMs: askTimeoutMs,
      timeoutStartsAt: Date.now(),
      timeoutDecision: timeoutAllows ? 'allow' : 'deny',
      timeoutDefaultAllowed: timeoutAllows,
    };
    requests.push(ask);
    emit?.(ask);

    if (resolvedMode === 'allow') {
      return { allowed: true, decision: 'mode-allow', id, summary };
    }

    // The wait and its fallback live HERE, inside the gate every gated tool
    // calls — not in whichever caller happens to wrap the request. So a gated
    // tool can only ever report a settled allow or deny to the model: there is
    // no pending/needsApproval state for it to misread.
    const timeoutReason = `no decision within ${Math.round(askTimeoutMs / 1000)}s — ${timeoutAllows ? 'allowed' : 'denied'} by the ${resolvedMode} rule`;

    let allowed = false;
    let remember = false;
    let settleReason = null;
    // 'human' = a person answered; 'timeout'/'unattended' = the rule's default
    // settled it, which is what the tool result and the UI both have to say.
    let decidedBy = 'human';
    if (typeof onApprove !== 'function') {
      // Nobody can answer this ask, so the wait is over on arrival: the rule's
      // default settles it immediately rather than stalling for askTimeoutMs.
      allowed = timeoutAllows;
      decidedBy = 'unattended';
      settleReason = `no approver wired — ${timeoutAllows ? 'allowed' : 'denied'} by the ${resolvedMode} rule default without waiting`;
    } else {
      let timer = null;
      let onAbort = null;
      try {
        if (signal?.aborted) throw abortError();
        const races = [
          onApprove(ask),
          // The rule's own deadline. It fires only if the resolver never got a
          // human answer; the resolver no longer needs its own timer.
          new Promise((settleTimeout) => {
            timer = setTimeout(() => settleTimeout({ timeout: true }), askTimeoutMs);
          }),
        ];
        // Composer Stop aborts the turn signal: end the ask immediately so the
        // loop can throw ABORT and the client can flush the next queued prompt,
        // instead of sitting on the approval countdown until it times out.
        if (signal && typeof signal.addEventListener === 'function') {
          races.push(new Promise((_, reject) => {
            onAbort = () => reject(abortError());
            signal.addEventListener('abort', onAbort, { once: true });
          }));
        }
        const verdict = await Promise.race(races);
        if (typeof verdict === 'object' && verdict !== null) {
          // Serve Stop settles the waiter with reason 'stopped' — treat that
          // like an abort so the turn ends instead of a soft tool deny.
          if (verdict.reason === 'stopped' || verdict.aborted === true) {
            throw abortError();
          }
          if (verdict.timeout === true) {
            allowed = timeoutAllows;
            decidedBy = 'timeout';
            settleReason = timeoutReason;
          } else {
            allowed = verdict.allowed === true;
            remember = verdict.remember === true;
            if (typeof verdict.reason === 'string') settleReason = verdict.reason;
          }
        } else {
          allowed = verdict === true;
        }
      } catch (err) {
        // Stop (and only Stop) must tear the whole turn down — a generic
        // approver failure still settles as deny so the model can continue.
        if (err?.code === 'ABORT') throw err;
        allowed = false;
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort && signal) {
          try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
        }
      }
    }

    if (remember) remembered.set(name, allowed ? 'allow' : 'deny');
    // A settled decision names how it was settled, so the caller can never read
    // a rule default as a human approval (or vice versa).
    const decision = decidedBy === 'human'
      ? (allowed ? 'approved' : 'denied')
      : `${resolvedMode}-default`;
    // Second emit for the same id: the UI merges by id, so an auto-settled
    // timeout (or a human decision) replaces the pending row instead of leaving
    // a countdown stuck at zero.
    emit?.({
      ...ask,
      status: allowed ? 'allowed' : 'denied',
      decision,
      autoSettled: decidedBy !== 'human',
      reason: settleReason || ask.message,
    });
    return {
      allowed,
      decision,
      id,
      summary,
      unattended: decidedBy === 'unattended',
      reason: settleReason || ask.message,
    };
  }

  const gate = {
    mode: resolvedMode,
    timeoutMs: askTimeoutMs,
    timeoutAllows,
    requests,
    remembered,
    request,
    setMode(next) {
      resolvedMode = normalizeApprovalMode(next);
      timeoutAllows = resolvedMode === 'ask-allow';
      gate.mode = resolvedMode;
      gate.timeoutAllows = timeoutAllows;
      return resolvedMode;
    },
    remember: (name, allowed, { remember = true } = {}) => {
      if (remember && APPROVAL_GATED_TOOLS.has(name)) {
        remembered.set(name, allowed ? 'allow' : 'deny');
      }
    },
  };
  return gate;
}
