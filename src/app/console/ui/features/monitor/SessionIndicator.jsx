import { STATUS_TEXT } from '#ui/shared/lib/format.js';
import { AskIcon } from '#ui/shared/AskIcon.jsx';
import { ApprovalIcon } from '#ui/shared/ApprovalIcon.jsx';
import { LucideIcon } from '#ui/shared/LucideIcons.jsx';

// Right-side status glyph for a sidebar session row. The provider (or multi-agent)
// mark lives to the LEFT of the label; this column answers ask / approval /
// busy (animated lucide loader-circle) / turn-complete. Thinking and ended
// rows stay blank here so the provider mark is never displaced.
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

// Sidebar session status glyphs (ask / approval / busy / turn-complete).
const ICON_SIZE = 'h-[14px] w-[14px]';

/**
 * The finished-turn shape. lucide `badge-check` (icons/badge-check.svg),
 * paths verbatim from upstream Lucide, ISC License (lucide.dev/license) —
 * same licensing / grid rule as AskIcon.jsx and ApprovalIcon.jsx, kept on
 * lucide's own 24×24 grid at lucide's own stroke 2 rather than being redrawn
 * on the house 16×16.
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
      <path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z" />
      <path d="m16 9-5.5 5.5L8 12" />
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
export function openGate(parts) {
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

export function SessionIndicator({ status, parts = null, className = '' }) {
  const color = `${ICON_COLOR[status] || ICON_COLOR.idle}${className ? ` ${className}` : ''}`;
  // A gate the user still has to settle outranks everything: it names what they
  // must do next, whether or not the turn around it has closed.
  const gate = openGate(parts);
  if (gate) {
    const Icon = gate === 'ask' ? AskIcon : ApprovalIcon;
    const tooltip = `${STATUS_TEXT[status] || status} · ${GATE_LABEL[gate]}`;
    return <Icon size={ICON_SIZE} className={color} title={tooltip} />;
  }
  // Tool(s) in flight — lucide loader-circle spun with Tailwind animate-spin.
  if (status === 'busy') {
    return (
      <LucideIcon
        name="loader-circle"
        className={`${ICON_SIZE} animate-spin ${color}`}
        title={STATUS_TEXT.busy}
      />
    );
  }
  // Only a CLOSED turn gets the tick. 'idle' is laneStatus's own word for
  // "active session, no open turn" (features/monitor/lib.mjs): the assistant
  // finished the prompt it was running and nothing is in flight.
  if (status === 'idle') {
    const tooltip = `${STATUS_TEXT.idle} · ${TURN_LABEL}`;
    return <TurnDoneIcon size={ICON_SIZE} className={color} title={tooltip} />;
  }
  return null;
}
