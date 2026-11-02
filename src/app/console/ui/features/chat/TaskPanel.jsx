import { PopupList, PopupToggle } from './PopupList.jsx';
import { previewLine, truncate } from '#ui/shared/lib/chatText.js';

/**
 * Task List rows — the same control as the Prompt Queue (see PopupList.jsx) with
 * its own caps and its own rows.
 *
 * The row vocabulary (mark, status word, label, tone, body) is data, so it is
 * mapped here once; TaskRow only draws what a map says. State stays with ChatHarness.
 */
export const TASK_MAX_HEIGHT_PX = 168;

// Task rows reuse the plan vocabulary the Prompts panel already draws (✓ done,
// ● in progress, – cancelled, ○ pending) so a task reads identically in both
// surfaces; colour carries the state, the tag only names it in one word.
export const TASK_MARK = {
  completed: <span className="text-emerald-400" aria-hidden="true">✓</span>,
  in_progress: <span className="text-amber-400" aria-hidden="true">●</span>,
  cancelled: <span className="text-gray-600" aria-hidden="true">–</span>,
  pending: <span className="text-gray-700" aria-hidden="true">○</span>,
};

export const TASK_STATUS = {
  completed: 'completed',
  in_progress: 'in_progress',
  cancelled: 'cancelled',
};

export const TASK_LABEL = {
  completed: 'done',
  in_progress: 'doing',
  cancelled: 'skipped',
  pending: 'open',
};

export const TASK_TONE = {
  completed: 'text-emerald-300/80',
  in_progress: 'text-amber-300/80',
  cancelled: 'text-gray-600',
  pending: 'text-gray-600',
};

export const TASK_BODY = {
  completed: 'text-gray-500 line-through',
  in_progress: 'text-gray-200',
  cancelled: 'text-gray-600 line-through',
  pending: 'text-gray-300',
};

export const TASK_PREVIEW_CHARS = 120;

/**
 * Task List — the same popup control as the queue (PopupToggle + PopupList),
 * over the plan/todo snapshot this lane already carries. Rows are read-only on
 * the chat surface: the tasks are written by the agent's plan tools and by the
 * harness hooks, so the composer lists and bounds them but never edits them —
 * which is why there is no row action bar here, only a status mark and a tag.
 * Off or empty renders nothing, and a long list scrolls inside the cap rather
 * than pushing the composer down.
 *
 * The summary line leads with the same done/total counter the task tools report
 * (`5 tasks · 2/5 done`), so the chat and the tool results state progress in one
 * form. The rows themselves refresh on every monitor poll (one second), which is
 * what keeps the counter moving after each step instead of only at the end.
 */
export function TaskStack({ tasks, expanded = true, dock = 'bottom', onDockToggle = null, onClose = null }) {
  const total = tasks.length;
  if (!total || !expanded) return null;
  const done = tasks.filter((task) => task?.status === 'completed').length;
  const doing = tasks.filter((task) => task?.status === 'in_progress').length;
  const cancelled = tasks.filter((task) => task?.status === 'cancelled').length;
  const summary = [
    `${total} task${total === 1 ? '' : 's'}`,
    ` · ${done}/${total} done`,
    doing ? ` · ${doing} in progress` : '',
    cancelled ? ` · ${cancelled} cancelled` : '',
  ].join('');

  return (
    <PopupList
      expanded={expanded}
      count={total}
      maxHeightPx={TASK_MAX_HEIGHT_PX}
      summary={summary}
      ariaLabel="Session task list"
      dock={dock}
      onDockToggle={onDockToggle}
      onClose={onClose}
    >
      {tasks.map((task, index) => (
        <TaskRow key={task?.id || `task-${index}`} task={task} index={index} />
      ))}
    </PopupList>
  );
}

/**
 * One task row: ordinal, status mark, the task text, and a one-word status tag
 * flushed right. Same row rhythm as a queued prompt (h-7, mark column,
 * truncated body, right-aligned tag) so the two lists read as one vocabulary.
 * There is no action bar: the chat surface lists tasks but never edits them.
 */
export function TaskRow({ task, index = 0 }) {
  const content = String(task?.content || '').trim();
  const status = TASK_STATUS[task?.status] || 'pending';
  return (
    <div
      role="listitem"
      title={content}
      className="flex h-7 items-center gap-1.5 px-1 hover:bg-gray-900/40"
    >
      <span className="shrink-0 tabular-nums text-[9px] text-gray-600">{index + 1}</span>
      <span className="ml-1.5 shrink-0">{TASK_MARK[status]}</span>
      {/* leading-tight, not leading-none: these rows are single-line and
          clipped by `truncate`, so a line box exactly as tall as the font
          (line-height 1) crops the ascenders and descenders of the task text
          — 'g', 'p', accents — instead of showing them. */}
      <p
        className={`min-w-0 flex-1 truncate text-[12px] leading-tight ${TASK_BODY[status]}`}
      >
        {previewLine(content, TASK_PREVIEW_CHARS)}
      </p>
      <span
        className={`ml-auto shrink-0 rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide ${TASK_TONE[status]}`}
      >
        {TASK_LABEL[status]}
      </span>
    </div>
  );
}
