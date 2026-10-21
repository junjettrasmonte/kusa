import { STATUS_TEXT } from '../lib/format.js';

const DOT = {
  busy: 'bg-emerald-400 animate-pulse',
  thinking: 'bg-amber-400 animate-pulse',
  idle: 'bg-sky-400',
  ended: 'border border-gray-500',
};

export function StatusDot({ status, className = '' }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[status] || DOT.idle} ${className}`}
      title={STATUS_TEXT[status] || status}
    />
  );
}
