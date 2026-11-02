import { STATUS_TEXT } from '#ui/shared/lib/format.js';
import { AskIcon } from '#ui/shared/AskIcon.jsx';
import { ApprovalIcon } from '#ui/shared/ApprovalIcon.jsx';
import { HarnessLogo } from '#ui/shared/HarnessLogo.jsx';

// The sidebar's per-session indicator: one glyph that answers two questions at
// once. The COLOUR is unchanged from StatusDot and answers "what is this session
// doing" — emerald running, amber prompt open, sky idle, gray ended. The SHAPE
// is the provider mark (kusa / cursor / …) by default, and only swaps at the
// moments the row is worth reading: the question-mark bubble of an open ask,
// the check bubble of an open approval, or lucide's square-check-big once the
// assistant has finished the prompt it was running. A finished turn is the one
// state this column exists to be read for — "the model is done, this row is
// ready for your next prompt" — so it gets a shape of its own rather than the
// provider mark alone. Running, prompt-open, and ended rows keep the provider
// icon tinted by status. Nothing about the hue moves, so a session that is
// waiting or done never looks like a different kind of session — it looks like
// the same session, waiting or done. Resolved gates (answered, refused,
// allowed, denied) are not marked: the user already spoke, and the row goes
// back to its provider glyph.
//
// Same hues as StatusDot's DOT map, written as text-* because every glyph here
// paints through currentColor.
const ICON_COLOR = {
  busy: 'text-emerald-400',
  thinking: 'text-amber-400',
  idle: 'text-sky-400',
  ended: 'text-gray-500',
};

const GATE_LABEL = {
  ask: 'waiting for an answer',
  approval: 'waiting for an approval',
};

const TURN_LABEL = 'turn complete';

// Matches the sidebar top-bar / right-rail 18px glyph box (see learnings).
const ICON_SIZE = 'h-[18px] w-[18px]';

/**
 * The finished-turn shape. lucide `square-check-big` (icons/square-check-big.svg),
 * paths verbatim from upstream Lucide v1.64.0, ISC License (lucide.dev/license) —
 * the same shipped artwork AskIcon.jsx and ApprovalIcon.jsx borrow, and it stays
 * on lucide's own 24×24 grid at lucide's own stroke 2 rather than being redrawn
 * on the house 16×16: at the 18px row box the ink lands with the same weight as
 * the other lucide glyphs in this strip.
 */
function TurnDoneIcon({ size = ICON_SIZE, className = '', title = null }) {
  return (
    <svg
      className={`shrink-0 ${size} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? null : 'true'}
    >
      {title ? <title>{title}</title> : null}
      <path d="M21 10.656V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12.344" />
      <path d="m9 11 3 3L22 4" />
    </svg>
  );
}

// Which gate, if any, is still open on the user. A gate is open only while its
// status is 'pending' — resolveKusaAsk / resolveKusaApproval rewrite exactly
// these statuses in place, and a timeout that passes re-emits the row as
// 'unanswered' / 'denied', so an expired gate can never reopen the row here.
//
// An open ASK outranks an open approval rather than following transcript order:
// a question blocks the model outright and has no rule default behind it, while
// an approval can still be settled by the Rules pick or by its countdown. So the
// shape the row shows is the thing the user MUST do, not whichever gate was
// created last.
function openGate(parts) {
  const list = Array.isArray(parts) ? parts : [];
  let approvalOpen = false;
  for (const part of list) {
    if (part?.type === 'ask' && part.ask?.status === 'pending') return 'ask';
    if (!approvalOpen && part?.type === 'approval' && part.approval?.status === 'pending') {
      approvalOpen = true;
    }
  }
  return approvalOpen ? 'approval' : null;
}

export function SessionIndicator({ status, parts = null, harness = 'kusa', className = '' }) {
  const color = `${ICON_COLOR[status] || ICON_COLOR.idle}${className ? ` ${className}` : ''}`;
  // A gate the user still has to settle outranks everything: it names what they
  // must do next, whether or not the turn around it has closed.
  const gate = openGate(parts);
  if (gate) {
    const Icon = gate === 'ask' ? AskIcon : ApprovalIcon;
    const tooltip = `${STATUS_TEXT[status] || status} · ${GATE_LABEL[gate]}`;
    return <Icon size={ICON_SIZE} className={color} title={tooltip} />;
  }
  // Only a CLOSED turn gets the tick. 'idle' is laneStatus's own word for
  // "active session, no open turn" (features/monitor/lib.mjs): the assistant
  // finished the prompt it was running and nothing is in flight. 'thinking' is a
  // prompt still open, 'busy' a tool still running, and 'ended' a session that
  // stopped — none of them completed a turn, so those three keep the provider
  // mark tinted by status.
  if (status === 'idle') {
    const tooltip = `${STATUS_TEXT.idle} · ${TURN_LABEL}`;
    return <TurnDoneIcon size={ICON_SIZE} className={color} title={tooltip} />;
  }
  return (
    <HarnessLogo
      harness={harness}
      size={ICON_SIZE}
      className={color}
      title={STATUS_TEXT[status] || status}
    />
  );
}
