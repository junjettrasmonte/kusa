import { useEffect, useState } from 'react';
import { clock } from '#ui/shared/lib/format.js';
import { AskIcon } from '#ui/shared/AskIcon.jsx';
import { ApprovalIcon } from '#ui/shared/ApprovalIcon.jsx';
import { answeredAskText, previewLine, truncate } from '#ui/shared/lib/chatText.js';
import { Chevron, StatusGlyph } from './ChatGlyphs.jsx';

/**
 * Approval and Ask gates — the two cards that wait on the user.
 *
 * Both render in two states: pending (a live CTA the user can still answer) and
 * settled (a transcript record of what was decided). gateCarryBack carries a
 * settled QUESTION back to the container whose work paused there — an approval
 * needs no such carry-back, because its verdict row stays inside that
 * container's rail.
 */
// Mirror of src/agent/approval.mjs APPROVAL_TIMEOUT_MS — only used when a live
// approval arrives without its own timeoutMs (older stream, partial frame).
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

// Mirror of src/agent/ask.mjs ASK_TIMEOUT_MS — same fallback rule: only used
// when a live question arrives without its own timeoutMs (older stream).
export const DEFAULT_ASK_TIMEOUT_MS = 120_000;

// How much of a settled question the collapsed row restates. The full text
// stays in the expandable body; the header only needs enough to say which
// question this row records.
export const ASK_HEADER_QUESTION_CHARS = 120;

export function ApprovalBlock({ approval, onApproval = null }) {
  const pending = approval?.status === 'pending';
  const allowed = approval?.status === 'allowed';
  const denied = approval?.status === 'denied';
  // Expansion follows only the pending state: an unresolved approval must stay open so
  // its Allow/Deny buttons are reachable, but a resolved one — Allowed or Denied —
  // collapses like any other finished tool call and is expandable on demand.
  const [open, setOpen] = useState(pending);
  const [deciding, setDeciding] = useState(false);

  useEffect(() => {
    setOpen(pending);
  }, [pending]);

  useEffect(() => {
    if (!pending) setDeciding(false);
  }, [pending]);

  // A waiting approval is NOT pinned: no sticky, no fixed, no floating overlay.
  // It stays in the transcript flow and the scroll-to-approval effect in the chat
  // view brings it into view, so the row reads as a step in order rather than as
  // a panel hovering over the work above it. That is why it carries no opaque
  // background either — nothing scrolls behind it.

  // Visible countdown to the rule's timeout. The approval gate owns the one
  // deadline and ships timeoutStartsAt on the request, so this counts down to
  // the moment the gate will settle — there is no second clock to drift against.
  // When it reaches zero the rule's default settles the row (ask-deny denies,
  // ask-allow allows) and the gate re-emits the resolved status, which collapses
  // this block like any other finished step.
  const timeoutMs = Number(approval?.timeoutMs) > 0 ? Number(approval.timeoutMs) : DEFAULT_APPROVAL_TIMEOUT_MS;
  const timeoutAllows = approval?.timeoutDefaultAllowed === true;
  const [deadline, setDeadline] = useState(null);
  useEffect(() => {
    if (!pending || !approval?.id) {
      setDeadline(null);
      return;
    }
    const startsAt = Number(approval?.timeoutStartsAt);
    setDeadline(Number.isFinite(startsAt) && startsAt > 0 ? startsAt + timeoutMs : Date.now() + timeoutMs);
  }, [pending, approval?.id, approval?.timeoutStartsAt, timeoutMs]);
  const [remainingMs, setRemainingMs] = useState(null);
  useEffect(() => {
    if (!deadline) {
      setRemainingMs(null);
      return;
    }
    const tick = () => setRemainingMs(Math.max(0, deadline - Date.now()));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [deadline]);
  const remainingNow = remainingMs ?? timeoutMs;
  const barPct = Math.max(0, Math.min(100, Math.round((remainingNow / timeoutMs) * 100)));

  async function decide(nextAllowed) {
    if (!onApproval || !approval?.id || deciding || !pending) return;
    setDeciding(true);
    try {
      await onApproval({ approvalId: approval.id, allowed: nextAllowed });
    } catch {
      setDeciding(false);
    }
  }

  const detail = approval?.summary || '';
  // A timeout settles the row without a human click — say so, so an
  // auto-allowed command is never read as something the user approved.
  const autoSettled = approval?.autoSettled === true;
  // A Rule switched mid-turn settles the asks that were already waiting. That
  // is the user's own pick, not a countdown expiring — it must not read as
  // "settled after Ns with no answer".
  const ruleChanged = String(approval?.decision || '').endsWith('-rule-change');
  // A newer approval settled this one without the user ever reaching it: the
  // verdict is still a denial, but naming only that would read as a command the
  // user chose to block. applyApprovalToParts marks it superseded.
  const superseded = approval?.superseded === true;
  // Allow / Deny rules settle the call BEFORE it is ever asked. The call still
  // gated, so the row has to name the Rule that decided it — a bare "Allowed"
  // would read as something the user approved, and no row at all made the run
  // (or the block) look unmotivated.
  const ruleSettled =
    approval?.decision === 'mode-allow' || approval?.decision === 'mode-deny';
  const label = pending
    ? 'Approval'
    : allowed
      ? ruleChanged || ruleSettled
        ? 'Allowed by Rule'
        : autoSettled ? 'Auto-allowed' : 'Allowed'
      : denied
        ? ruleChanged || ruleSettled
          ? 'Denied by Rule'
          : autoSettled ? 'Auto-denied' : 'Denied'
        : 'Approval';
  // Pending only: Allow / Deny rules auto-settle and never "ask" in the orchestrator.
  const relayAgent = approval?.sourceRole
    ? `${String(approval.sourceRole).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} agent`
    : 'Subagent';
  const relayLabel = approval?.relayed
    ? (pending
      ? (approval.gatePrompt || `${relayAgent} is asking for an approval`)
      : relayAgent)
    : '';

  return (
    <div
      data-kusa-approval={pending ? 'pending' : 'resolved'}
      className="text-sm"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full max-w-full items-start gap-1.5 rounded px-0.5 py-0.5 text-left hover:bg-gray-900/60"
        aria-expanded={open}
      >
        <Chevron open={open} className="mt-0.5 shrink-0 text-gray-600 group-hover:text-gray-400" />
        <ApprovalIcon
          className={`mt-0.5 ${pending ? 'text-amber-400' : allowed ? 'text-emerald-500' : denied ? 'text-rose-400' : 'text-gray-500 group-hover:text-gray-400'}`}
        />
        {pending ? <StatusGlyph status="awaiting_approval" className="mt-0.5" /> : null}
        <span className={`min-w-0 truncate ${pending ? 'chat-shimmer text-gray-300' : 'text-gray-400'}`}>
          <span className="font-medium text-gray-300">{label}</span>
          {relayLabel ? (
            <span className="text-sky-400/90">
              {' '}
              <span className="text-gray-700">·</span> {relayLabel}
            </span>
          ) : null}
          {approval?.name ? (
            <span className="text-gray-600">
              {' '}
              <span className="text-gray-700">·</span> {approval.name}
            </span>
          ) : null}
          {detail ? (
            <span className="text-gray-600">
              {' '}
              <span className="text-gray-700">·</span> {detail}
            </span>
          ) : null}
          {superseded && !pending ? (
            <span className="text-gray-600">
              {' '}
              <span className="text-gray-700">·</span> superseded by a newer approval
            </span>
          ) : null}
          {pending && deadline ? (
            <span className="ml-2 shrink-0 text-amber-300">
              {' '}
              <span className="text-gray-700">·</span> {clock(remainingNow)} left
              <span className="ml-1.5 text-gray-500">
                {' '}
                <span className="text-gray-700">→</span> {timeoutAllows ? 'auto-allow' : 'auto-deny'}
              </span>
            </span>
          ) : null}
        </span>
      </button>
      {open ? (
        <div className={`ml-5 mt-1.5 space-y-2 border-l pl-3 ${pending ? 'border-amber-900/60' : 'border-gray-800'}`}>
          <p className={`text-[12px] leading-relaxed ${pending ? 'text-amber-200/90' : 'text-gray-500'}`}>
            {approval?.message || `Allow ${approval?.name || 'this tool'} to run?`}
          </p>
          {pending ? (
            <p className="text-[11px] leading-relaxed text-gray-500">
              Nobody answering is not a stall — after {Math.round(timeoutMs / 1000)}s this rule settles as{' '}
              <code className={timeoutAllows ? 'text-emerald-300' : 'text-rose-300'}>
                {timeoutAllows ? 'allow' : 'deny'}
              </code>
              .
            </p>
          ) : null}
          {pending && deadline ? (
            <div className="flex items-center gap-2 text-[11px] text-gray-500">
              <span>Time left</span>
              <span className="relative block h-1 w-24 rounded overflow-hidden bg-gray-700">
                <span
                  className={`absolute inset-y-0 left-0 block rounded ${timeoutAllows ? 'bg-emerald-500' : 'bg-amber-400'}`}
                  style={{ width: `${barPct}%` }}
                />
              </span>
              <span className="ml-2 font-mono text-amber-300">{clock(remainingNow)}</span>
              <span className="ml-2 text-gray-400">
                on timeout → {timeoutAllows ? 'allow' : 'deny'}
              </span>
            </div>
          ) : null}
          {!pending && superseded ? (
            <p className="text-[11px] leading-relaxed text-gray-500">
              Superseded by a newer approval — this call did not run.
            </p>
          ) : null}
          {!pending && !superseded && ruleChanged ? (
            <p className="text-[11px] leading-relaxed text-gray-500">
              Settled by the Rule you switched to while this call was waiting —{' '}
              {allowed ? 'the call ran' : 'the call did not run'}.
            </p>
          ) : null}
          {/* The Rule was already Allow / Deny when the call arrived: no ask was
              ever opened, so this is neither a click nor an expired countdown. */}
          {!pending && !superseded && ruleSettled ? (
            <p className="text-[11px] leading-relaxed text-gray-500">
              {`Settled by the Rule in effect for this run — ${allowed ? 'the call ran' : 'the call did not run'} without asking, and nothing was waited for.`}
            </p>
          ) : null}
          {!pending && !superseded && !ruleChanged && autoSettled ? (
            <p className="text-[11px] leading-relaxed text-gray-500">
              Settled by the rule after {Math.round(timeoutMs / 1000)}s with no answer —{' '}
              {timeoutAllows ? 'the call ran' : 'the call did not run'}.
            </p>
          ) : null}
          {!pending && !ruleChanged && autoSettled ? (
            <p className="text-[11px] leading-relaxed text-gray-500">
              Settled by the rule after {Math.round(timeoutMs / 1000)}s with no answer —{' '}
              {timeoutAllows ? 'the call ran' : 'the call did not run'}.
            </p>
          ) : null}
          {pending && onApproval ? (
            <div data-kusa-approval-cta className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={deciding}
                onClick={() => decide(true)}
                className="rounded bg-emerald-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {deciding ? '…' : 'Allow'}
              </button>
              <button
                type="button"
                disabled={deciding}
                onClick={() => decide(false)}
                className="rounded border border-gray-700 bg-gray-900 px-2.5 py-1 text-[12px] font-medium text-gray-300 hover:border-gray-500 hover:text-gray-100 disabled:opacity-50"
              >
                Deny
              </button>
            </div>
          ) : null}
          {pending && onApproval ? (
            <p className="text-[11px] leading-relaxed text-gray-500">
              This answer covers this call only — the next gated call asks again.
              The Rule in the picker above is what holds for the rest of this
              session: switch it to Allow or Deny to stop being asked.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A question the model asked the user (kusa_ask). It sits in the transcript
 * flow like an Approval — in order, where it was asked — and it folds by the
 * same rule: open only while the question is waiting, so its options are
 * reachable, and collapsed once it is settled (answered, expired, or
 * superseded by a newer question) like any other finished step. Their answer
 * renders as a reply of its own right below it.
 *
 * The card is a choice, not a form, and it wears the same chrome as an
 * Approval — header row with the countdown in words, a left-ruled body with the
 * question, the timeout explanation, and the time-left bar. What differs is the
 * answer key: options are a left-aligned numbered list and the number itself is
 * the control — a numbered circle the user clicks to answer with that choice —
 * (the card's own icon is that same ring, carrying a question mark)
 * so the list reads as "1 2 3" rather than a stack of wide buttons. Clicking
 * sends the answer straight away; typing needs an explicit Send, since a text
 * field has no reliable "I am done" signal. Nobody answering is not a stall — the ask
 * refuses after its countdown and the model says which assumption it is
 * proceeding with, so the countdown only explains that.
 *
 * Settled, the row states what was asked in one line outside the fold: the
 * question is the record of this exchange, and hiding it behind the chevron
 * would leave a row that says only "Answered". The full wording stays in the
 * body for when it is opened. The user's words are NOT repeated here — they
 * keep their own reply bubble below, because they are what the user said,
 * not the card's chrome.
 */
export function AskCard({ ask, onAsk = null }) {
  const pending = ask?.status === 'pending';
  const answered = ask?.status === 'answered';
  // A question the model moved past without an answer is settled, not waiting:
  // applyAskToParts marks it superseded so this row can fold and say why.
  const superseded = ask?.superseded === true;
  const options = Array.isArray(ask?.options) ? ask.options : [];
  const allowFreeText = ask?.allowFreeText !== false;
  // The words the user actually used (chosen label or typed text), resolved by
  // the same helper that renders the answer as a reply — the question card and
  // that reply can never disagree about what was said.
  const answeredText = answeredAskText(ask);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!pending) setSending(false);
  }, [pending]);

  // Expansion follows only the pending state, exactly like an Approval row.
  const [open, setOpen] = useState(pending);

  useEffect(() => {
    setOpen(pending);
  }, [pending]);

  async function send(patch) {
    if (!onAsk || !ask?.id || sending || !pending) return;
    setSending(true);
    try {
      await onAsk({ askId: ask.id, ...patch });
    } catch {
      setSending(false);
    }
  }

  const timeoutMs = Number(ask?.timeoutMs) > 0 ? Number(ask.timeoutMs) : DEFAULT_ASK_TIMEOUT_MS;
  const [deadline, setDeadline] = useState(null);
  useEffect(() => {
    if (!pending || !ask?.id) {
      setDeadline(null);
      return;
    }
    const startsAt = Number(ask?.timeoutStartsAt);
    setDeadline(Number.isFinite(startsAt) && startsAt > 0 ? startsAt + timeoutMs : Date.now() + timeoutMs);
  }, [pending, ask?.id, ask?.timeoutStartsAt, timeoutMs]);
  const [remainingMs, setRemainingMs] = useState(null);
  useEffect(() => {
    if (!deadline) {
      setRemainingMs(null);
      return;
    }
    const tick = () => setRemainingMs(Math.max(0, deadline - Date.now()));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [deadline]);
  // Same presentation as the approval row: the header states the time left in
  // words, the body draws the bar against the one deadline the ask gate owns.
  const remainingNow = remainingMs ?? timeoutMs;
  const barPct = Math.max(0, Math.min(100, Math.round((remainingNow / timeoutMs) * 100)));

  const label = pending
    ? 'Question'
    : answered
      ? 'Answered'
      : 'No answer';
  const relayAgent = ask?.sourceRole
    ? `${String(ask.sourceRole).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} agent`
    : 'Subagent';
  const relayLabel = ask?.relayed
    ? (pending
      ? (ask.gatePrompt || `${relayAgent} is asking a question`)
      : relayAgent)
    : '';

  return (
    <div
      data-kusa-ask={pending ? 'pending' : 'resolved'}
      className="text-sm"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full max-w-full items-start gap-1.5 rounded px-0.5 py-0.5 text-left hover:bg-gray-900/60"
        aria-expanded={open}
      >
        <Chevron open={open} className="mt-0.5 shrink-0 text-gray-600 group-hover:text-gray-400" />
        <AskIcon
          title={ask?.question || 'the model asked a question'}
          className={`mt-0.5 ${pending ? 'text-violet-400' : answered ? 'text-emerald-500' : 'text-gray-500 group-hover:text-gray-400'}`}
        />
        {pending ? <StatusGlyph status="awaiting_answer" className="mt-0.5" /> : null}
        <span className={`min-w-0 truncate ${pending ? 'chat-shimmer text-gray-300' : 'text-gray-400'}`}>
          <span className="font-medium text-gray-300">{label}</span>
          {relayLabel ? (
            <span className="text-sky-400/90">
              {' '}
              <span className="text-gray-700">·</span> {relayLabel}
            </span>
          ) : null}
          {/* Settled, the question is no longer the user's turn to answer, so it
              stops hiding behind the fold: the row names what was asked in one
              line. The full wording stays in the body for when it is opened. */}
          {!pending && ask?.question ? (
            <span className="text-gray-600">
              {' '}
              <span className="text-gray-700">·</span> {previewLine(ask.question, ASK_HEADER_QUESTION_CHARS)}
            </span>
          ) : null}
          {superseded && !pending ? (
            <span className="text-gray-600">
              {' '}
              <span className="text-gray-700">·</span> superseded by a newer question
            </span>
          ) : null}
          {pending && deadline ? (
            <span className="ml-2 shrink-0 text-violet-300">
              {' '}
              <span className="text-gray-700">·</span> {clock(remainingNow)} left
            </span>
          ) : null}
        </span>
      </button>
      {open ? (
        <div className={`ml-5 mt-1.5 space-y-2 border-l pl-3 ${pending ? 'border-violet-900/60' : 'border-gray-800'}`}>
          <p className={`text-[12px] leading-relaxed ${pending ? 'text-violet-200/90' : 'text-gray-500'}`}>
            {ask?.question || 'The model asked a question.'}
          </p>
          {pending ? (
            <p className="text-[11px] leading-relaxed text-gray-500">
              {allowFreeText
                ? 'Click the number of the answer you want, or type your own words. '
                : 'Click the number of the answer you want. '}
              Nobody answering is not a stall — after{' '}
              {Math.round(timeoutMs / 1000)}s the question is dropped and the model states the assumption it is proceeding with.
            </p>
          ) : null}
          {pending && deadline ? (
            <div className="flex items-center gap-2 text-[11px] text-gray-500">
              <span>Time left</span>
              <span className="relative block h-1 w-24 rounded overflow-hidden bg-gray-700">
                <span
                  className="absolute inset-y-0 left-0 block rounded bg-violet-400"
                  style={{ width: `${barPct}%` }}
                />
              </span>
              <span className="ml-2 font-mono text-violet-300">{clock(remainingNow)}</span>
              <span className="ml-2 text-gray-400">
                on timeout → no answer
              </span>
            </div>
          ) : null}
          {pending ? (
            <div data-kusa-ask-cta className="flex flex-col gap-1.5">
              {options.length ? (
                <ul className="list-none flex flex-col gap-1.5" role="list" aria-label="Answer options">
                  {options.map((option) => {
                    // The number IS the control: a numbered circle the user
                    // clicks to answer with that choice. Labels stay plain text
                    // to its right, left-aligned, so the list reads as a
                    // numbered answer key rather than a stack of wide buttons.
                    const n = Number(option?.index) + 1;
                    return (
                      <li key={option?.index ?? option?.label} className="group flex items-center gap-2">
                        <button
                          type="button"
                          disabled={sending}
                          onClick={() => send({ optionIndex: Number(option?.index) })}
                          aria-label={`Answer with option ${n}: ${option?.label || ''}`}
                          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-violet-700 bg-gray-900 text-[11px] font-semibold text-violet-300 hover:border-violet-400 hover:bg-violet-600 hover:text-white disabled:opacity-50"
                        >
                          {n}
                        </button>
                        <span className="ml-1 truncate text-[12px] font-medium text-gray-200 group-hover:text-white">
                          {option?.label}
                        </span>
                        {option?.detail ? (
                          <span className="ml-1.5 text-[11px] text-gray-500 group-hover:text-gray-300">{option.detail}</span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {allowFreeText ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={draft}
                    onChange={(event) => setDraft(String(event.target?.value ?? ''))}
                    placeholder="None of these — type your answer"
                    className="w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-[12px] text-gray-200"
                  />
                  <button
                    type="button"
                    disabled={sending || !draft.trim()}
                    onClick={() => send({ freeText: draft.trim() })}
                    className="rounded bg-violet-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-violet-500 disabled:opacity-50"
                  >
                    Send answer
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          {/* The answer itself now renders as a reply of its own below the
              question, so the card only restates it when there was nothing to
              show there (no choice, no typed text). */}
          {!pending && answered && !answeredText.trim() ? (
            <p className="text-[11px] leading-relaxed text-gray-400">
              Answered without a choice — see the reply below.
            </p>
          ) : null}
          {!pending && superseded ? (
            <p className="text-[11px] leading-relaxed text-gray-500">
              Superseded by a newer question — the model moved on without an answer.
            </p>
          ) : null}
          {!pending && !answered && !superseded ? (
            <p className="text-[11px] leading-relaxed text-gray-500">
              No answer within {Math.round(timeoutMs / 1000)}s — the model proceeds on a stated assumption.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The user's answer to a mid-turn question, rendered as a reply of its own:
 * it is the user's turn, so it takes the same right-aligned bubble as a typed
 * prompt and opens a new agent container after it.
 */
export function AskAnswerReply({ ask }) {
  const text = answeredAskText(ask);
  return (
    <div className="group/user flex justify-end">
      <div className="relative max-w-[85%]">
        <div
          className="rounded-lg bg-emerald-500/15 px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-gray-100"
          aria-label="Your answer"
        >
          {text.trim() ? text : '(answered without a choice)'}
        </div>
      </div>
    </div>
  );
}

/**
 * The one phrase a settled gate hands back to the container whose work paused
 * there — and only questions hand anything back.
 *
 * An approval carries nothing: a settled one renders as its own verdict row
 * inside that container's rail (who decided it, the countdown, the command),
 * and an open one is already announced by that header's label and StatusGlyph.
 * A phrase on the header would only repeat the row, and it made every gated
 * run read as "run continued · allowed by the Rule".
 *
 * A question carries only the outcomes its own row cannot state — an answered
 * one is followed by the user's reply bubble, so it too carries nothing. A
 * pending gate always returns null: that wait is shown by the label.
 */
export function gateCarryBack(gate) {
  if (gate?.kind === 'ask') {
    const ask = gate.ask;
    // An answered question carries nothing back: the row itself states the
    // question it asked (`AskCard`) and the user's words are their own reply
    // bubble, so a phrase here would only repeat what both already say.
    if (ask?.status === 'answered') return null;
    if (ask?.superseded === true) {
      return { text: 'moved on · superseded by a newer question', className: 'text-gray-500' };
    }
    if (ask?.status === 'pending') return null;
    return { text: 'continued on a stated assumption · no answer', className: 'text-gray-400' };
  }
  return null;
}
