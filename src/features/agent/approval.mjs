/**
 * User-approval gate for side-effecting tools (terminal, browser, escalate).
 *
 * Four rules — the "ask" rule is deliberately split in two so the fallback on
 * timeout is part of the rule, not an invisible constant:
 *   ask-deny   ask; if nobody answers within the configured timeout, DENY (safe default)
 *   ask-allow  ask; if nobody answers within the configured timeout, ALLOW
 *   allow      run without asking (the pick holds for the rest of the session)
 *   deny       never run (same sticky window as allow)
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
 *
 * A human answer covers ONLY the call it was asked for: nothing is remembered
 * per tool, and an Allow/Deny click never moves the Rule. Stickiness belongs to
 * the Rule the user picked in the composer — allow / deny hold for the rest of
 * the session until that picker is used again — and a Rule the user switches to
 * mid-turn settles the asks that are already waiting (see setMode), which is the
 * user's newest word about the Rule and the only thing that decides what the
 * next gated call does.
 */

const APPROVAL_MODES = new Set(['ask-deny', 'ask-allow', 'allow', 'deny']);
const MAX_SUMMARY = 400;

/** Tool names that need an explicit human yes before they run. */
export const APPROVAL_GATED_TOOLS = new Set([
  'kusa_terminal',
  'kusa_browse',
  'kusa_escalate',
  'terminal',
  'bash',
  'shell',
  'run_command',
  'execute_command',
  'browse',
  'browser',
  'web_fetch',
  'fetch_url',
  'escalate',
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
    return 'kusa_terminal, kusa_browse, and kusa_escalate are disabled for this run: do not call them.';
  }
  if (resolved === 'allow') {
    return 'kusa_terminal, kusa_browse, and kusa_escalate are pre-approved for this run; keep commands short and non-interactive.';
  }
  const wait = timeoutPhrase(timeoutMs);
  const timeoutLine = resolved === 'ask-allow'
    ? `If nobody answers within ${wait} the request is ALLOWED automatically and the call runs — do not say you are still waiting for approval.`
    : `If nobody answers within ${wait} the request is DENIED automatically — treat it as not run.`;
  return [
    'kusa_terminal, kusa_browse, and kusa_escalate are approval-gated: a call either runs or is refused outright —',
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
 * @param {(request) => boolean | { allowed }} [options.onApprove]
 * @param {(request) => void} [options.emit] surfaces a gate decision (UI/SSE) —
 *   the two ask rules surface a pending ask and then the settled row; 'allow'
 *   and 'deny' surface only the settled row, with no countdown to answer
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
  // Mutable so a mid-turn composer Rules change takes effect straight away:
  // the next gated call reads the new rule, and an ask that is already waiting
  // is settled by it (see setMode) — no rebuilt gate, no stuck countdown.
  let resolvedMode = normalizeApprovalMode(mode);
  let timeoutAllows = resolvedMode === 'ask-allow';
  // One timeout, owned by the gate: serve's resolver and the UI countdown both
  // read it from the request we emit, so nothing else can invent a deadline.
  // Settings may raise this above the 2-minute default (capped by MAX).
  const askTimeoutMs = resolveApprovalTimeoutMs(timeoutMs);
  const requests = [];
  let seq = 0;
  // Asks still waiting on a human, by id → the handle the race awaits. A
  // mid-turn Rule change resolves these through setMode, so the new pick
  // covers calls already in flight and not only the next one.
  /** @type {Map<string, (decision: object) => void>} */
  const pendingWaiters = new Map();

  function abortError() {
    const err = new Error('aborted');
    err.code = 'ABORT';
    return err;
  }

  function summarizeArgs(args = {}) {
    const interesting = ['command', 'url', 'query', 'path', 'pattern', 'provider', 'action', 'reason'];
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

    // Allow and Deny decide the call without ever asking — but the call still
    // gated, and a gate that decides in silence reads as a command that ran (or
    // did not) for no stated reason. Emit the verdict as an ALREADY-RESOLVED
    // row so the chat can say "Allowed by Rule" / "Denied by Rule": it carries
    // no countdown, no Allow/Deny buttons and nothing to answer, so it cannot be
    // read as a wait — which is the trap the earlier shape avoided by shipping
    // nothing at all. The verdict returned to the model keeps its exact shape;
    // only the transcript gains the row.
    function settledByRule({ allowed, reason }) {
      const id = `${callId || 'approval'}_${(seq += 1)}`;
      const summary = summarizeArgs(args);
      const row = {
        id,
        name,
        args,
        callId,
        summary,
        message: allowed
          ? `${name} ran without asking — the Rule for this run is Allow.`
          : `${name} did not run — the Rule for this run is Deny.`,
        status: allowed ? 'allowed' : 'denied',
        // The UI reads this token as "settled by the Rule in effect", which is
        // a different sentence from a switched Rule or an expired countdown.
        decision: allowed ? 'mode-allow' : 'mode-deny',
        // Not autoSettled: nothing timed out and nobody was waited for.
        autoSettled: false,
        // No timeout contract — this rule never waits, so the UI must not draw
        // a countdown for it.
        timeoutMs: null,
        timeoutStartsAt: null,
        timeoutDecision: null,
        timeoutDefaultAllowed: false,
        reason,
      };
      requests.push(row);
      emit?.(row);
      return { id, summary, reason };
    }

    if (resolvedMode === 'deny') {
      const settled = settledByRule({ allowed: false, reason: 'approval mode deny' });
      return {
        allowed: false,
        decision: 'mode-deny',
        id: settled.id,
        summary: settled.summary,
        reason: settled.reason,
      };
    }

    if (resolvedMode === 'allow') {
      const settled = settledByRule({ allowed: true, reason: 'approval mode allow' });
      return {
        allowed: true,
        decision: 'mode-allow',
        id: settled.id,
        summary: settled.summary,
        reason: settled.reason,
      };
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

    // Only the ask rules reach here: they are the only rules that wait, and the
    // only ones that surface a row for the user to answer.
    // The wait and its fallback live HERE, inside the gate every gated tool
    // calls — not in whichever caller happens to wrap the request. So a gated
    // tool can only ever report a settled allow or deny to the model: there is
    // no pending/needsApproval state for it to misread.
    const timeoutReason = `no decision within ${Math.round(askTimeoutMs / 1000)}s — ${timeoutAllows ? 'allowed' : 'denied'} by the ${resolvedMode} rule`;

    let allowed = false;
    let settleReason = null;
    // 'human' = a person answered; 'timeout'/'unattended' = the rule's default
    // settled it, which is what the tool result and the UI both have to say.
    // 'rule-change' = the user moved the Rule while the ask was still waiting,
    // which is a decision about THIS call, not a fallback.
    let decidedBy = 'human';
    // The rule the user switched TO, when a rule-change settled this ask. The
    // gate's own mode is still the OLD rule at that moment (the loop adopts the
    // new one at its next boundary), so naming the decision after the gate's
    // mode would blame the rule the user just replaced.
    let ruleChangedTo = '';
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
          // A Rule the user switches to mid-turn decides the asks that are
          // already waiting — see setMode. Allow runs this call, Deny blocks it.
          new Promise((settleRuleChange) => {
            pendingWaiters.set(ask.id, settleRuleChange);
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
          if (verdict.ruleChanged === true) {
            // The Rule moved while this ask was waiting. The user's new pick
            // settled it — not a human click, not a timeout default.
            allowed = verdict.allowed === true;
            decidedBy = 'rule-change';
            if (typeof verdict.rule === 'string' && verdict.rule.trim()) {
              ruleChangedTo = normalizeApprovalMode(verdict.rule);
            }
            if (typeof verdict.reason === 'string') settleReason = verdict.reason;
          } else if (verdict.timeout === true) {
            allowed = timeoutAllows;
            decidedBy = 'timeout';
            settleReason = timeoutReason;
          } else {
            allowed = verdict.allowed === true;
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
        // Settled (by any route) or abandoned: this ask is no longer waiting,
        // so a later Rule change must not reach it again.
        pendingWaiters.delete(ask.id);
      }
    }

    // Nothing is remembered from an answer: it settles this call only. The next
    // gated call asks again under the ask rule, or runs under whatever Rule the
    // user picked in the composer — the Rule, not a click, is what holds.
    // A settled decision names how it was settled, so the caller can never read
    // a rule default as a human approval (or vice versa).
    // A rule-change settle is named apart from a timeout default so the tool
    // result and the UI can both say what actually moved the Rule.
    const decision = decidedBy === 'human'
      ? (allowed ? 'approved' : 'denied')
      : decidedBy === 'rule-change'
        ? `${ruleChangedTo || resolvedMode}-rule-change`
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
    request,
    setMode(next) {
      resolvedMode = normalizeApprovalMode(next);
      timeoutAllows = resolvedMode === 'ask-allow';
      gate.mode = resolvedMode;
      gate.timeoutAllows = timeoutAllows;
      // Allow / Deny are a decision about the calls already waiting, not only
      // about the next one: switching to Allow must leave the ask that opened
      // moments ago off its countdown. Ask rules keep the wait open — only the
      // timeout default moves, and a human can still answer.
      if (resolvedMode === 'allow' || resolvedMode === 'deny') {
        for (const [id, settle] of [...pendingWaiters.entries()]) {
          pendingWaiters.delete(id);
          settle({
            ruleChanged: true,
            allowed: resolvedMode === 'allow',
            reason: `approval rule switched to ${resolvedMode}`,
          });
        }
      }
      // The Rule is the user's newest word about the calls that follow, and it
      // decides them outright — nothing a single click was remembered for can
      // still be blocking this tool, because no click ever remembered anything.
      return resolvedMode;
    },
  };
  return gate;
}
