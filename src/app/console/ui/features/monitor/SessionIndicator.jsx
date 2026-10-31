import { STATUS_TEXT } from '#ui/shared/lib/format.js';
import { StatusDot } from './StatusDot.jsx';
import { AskIcon } from '#ui/shared/AskIcon.jsx';
import { ApprovalIcon } from '#ui/shared/ApprovalIcon.jsx';

// The sidebar's per-session indicator: one glyph that answers two questions at
// once. The COLOUR is unchanged from StatusDot and answers "what is this session
// doing" — emerald running, amber prompt open, sky idle, gray ended. The SHAPE
// only changes while the session is stopped at a gate the user has to resolve:
// the dot becomes the question-mark bubble of an open ask, or the check bubble of
// an open approval. Nothing about the hue moves, so a session that is waiting never
// looks like a different kind of session — it looks like the same session,
// waiting. Resolved gates (answered, refused, allowed, denied) are not marked:
// the user already spoke, and the row goes back to a plain dot.
//
// Same hues as StatusDot's DOT map, written as text-* because both glyphs paint
// through currentColor while the dot paints a background.
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

export function SessionIndicator({ status, parts = null, className = '' }) {
  const gate = openGate(parts);
  if (!gate) {
    return <StatusDot status={status} className={className} />;
  }
  const Icon = gate === 'ask' ? AskIcon : ApprovalIcon;
  const tooltip = `${STATUS_TEXT[status] || status} · ${GATE_LABEL[gate]}`;
  // h-3 w-3, not the chat's h-4: the row already carries a 14px checkbox and a
  // 16px trash button, so a 12px glyph swaps the dot without moving the label
  // baseline or growing the row.
  return <Icon size="h-3 w-3" className={ICON_COLOR[status] || ICON_COLOR.idle} title={tooltip} />;
}
