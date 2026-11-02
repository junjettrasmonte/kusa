/**
 * Inline glyphs for the chat surface — status dots, chevrons, and the small
 * action icons (edit, stop, resend, trash, pause/resume, drag handle).
 *
 * These are drawn, never owned: a glyph holds no state and decides nothing about
 * a click. Callers pass className for tone and position, exactly like AskIcon.jsx
 * and ApprovalIcon.jsx, so one shape reads the same in every row.
 */
/**
 * The composer's paperclip at chip size — the same wire as the footer icon
 * (AttachmentIcon in ComposerControls.jsx), so an attached file and the
 * control that attached it read as one thing.
 */
export function PaperclipIcon({ className = 'h-3 w-3 shrink-0' }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

export function StatusGlyph({ status, className = '' }) {
  if (status === 'awaiting_answer') {
    return (
      <span
        className={`inline-flex h-4.5 w-4.5 shrink-0 items-center justify-center ${className}`}
        aria-hidden="true"
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" />
      </span>
    );
  }
  if (status === 'awaiting_approval') {
    return (
      <span
        className={`inline-flex h-4.5 w-4.5 shrink-0 items-center justify-center ${className}`}
        aria-hidden="true"
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
      </span>
    );
  }
  if (status === 'running') {
    return (
      <svg className={`h-4.5 w-4.5 shrink-0 animate-spin text-sky-400 ${className}`} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
        <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === 'error') {
    return (
      <svg className={`h-4.5 w-4.5 shrink-0 text-rose-400 ${className}`} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 5v3.5M8 11h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  // Done: subtle chevron-dot, not a loud checkmark (VS Code default).
  return (
    <span className={`inline-flex h-4.5 w-4.5 shrink-0 items-center justify-center ${className}`} aria-hidden="true">
      <span className="h-1.5 w-1.5 rounded-full bg-gray-600" />
    </span>
  );
}

export function Chevron({ open, className = 'text-gray-500' }) {
  return (
    <svg
      className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''} ${className}`}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4z" />
    </svg>
  );
}

/**
 * Down chevron for the jump-to-bottom control. It only ever renders while the
 * transcript is parked above the newest turn, so the arrow alone carries the
 * whole message: the latest turn is further down, and this button reaches it.
 */
export function ChevronDownIcon({ className = 'text-gray-500' }) {
  return (
    <svg
      className={`h-4 w-4 shrink-0 ${className}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 5.5l4 4 4-4" />
    </svg>
  );
}

/**
 * Prompt Queue toggle glyph — lucide `message-square` (on) / `message-square-plus`
 * (off), drawn at lucide's own 24×24 grid and stroke weight so the two popup
 * glyphs share one artwork family with the Task List's `list-checks`/`list-check`.
 * A prompt is a message, so the bubble is the picture; the plus is lucide's own
 * "there is more of this, and this control opens it" affordance — on, the rows
 * are already on screen, so the bubble alone is honest, and off, the bubble
 * carries a plus because prompts exist but are not listed.
 */
export function QueueIcon({ expanded = true, className = 'text-gray-500' }) {
  return (
    <svg
      className={`h-3.5 w-3.5 shrink-0 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* lucide message-square */}
      <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
      {/* lucide message-square-plus: the plus is only lucide's addition when the
          rows are NOT on screen. */}
      {expanded ? null : <path d="M12 8v6" />}
      {expanded ? null : <path d="M9 11h6" />}
    </svg>
  );
}

/**
 * Task List toggle glyph — lucide `list-checks` (on) / `list-check` (off), the
 * sibling of the queue glyph at the same 24×24 grid. It must not read as the
 * queue, so it is a checklist, not a bulleted list and not a bubble: on, three
 * rows of work with two ticks — "some of this is done", which is what a task
 * list is. Off, one row of the same list carries a single tick: tasks exist and
 * progress exists, but they are not listed, and this is the control that lists
 * them. Both states are official lucide artwork, so the pair differs only by
 * what it counts.
 */
export function TaskIcon({ expanded = true, className = 'text-gray-500' }) {
  return (
    <svg
      className={`h-3.5 w-3.5 shrink-0 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {expanded ? (
        <>
          {/* lucide list-checks: three rows, two of them ticked. */}
          <path d="M13 5h8" />
          <path d="M13 12h8" />
          <path d="M13 19h8" />
          <path d="m3 7 2 2 4-4" />
          <path d="m3 17 2 2 4-4" />
        </>
      ) : (
        <>
          {/* lucide list-check: the same list, one tick — progress exists,
              the rows do not. */}
          <path d="M16 5H3" />
          <path d="M16 12H3" />
          <path d="M11 19H3" />
          <path d="m15 18 2 2 4-4" />
        </>
      )}
    </svg>
  );
}

/** lucide brain (verbatim path data) for thinking rows. */
export function BrainIcon({ className = 'text-gray-500' }) {
  return (
    <svg
      className={`h-4.5 w-4.5 shrink-0 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 18V5" />
      <path d="M15 13a4.17 4.17 0 01-3-4 4.17 4.17 0 01-3 4" />
      <path d="M17.707 6.294A3 3 0 1012 5a3 3 0 10-5.707 1.294" />
      <path d="M17.996 5.125a4 4 0 012.526 5.77" />
      <path d="M18 18a4 4 0 002-7.465" />
      <path d="M19.967 17.482a4 4 0 11-7.967.517 4 4 0 11-7.967-.517" />
      <path d="M6 18a4 4 0 01-2-7.465" />
      <path d="M6.004 5.125a4 4 0 00-2.526 5.77" />
    </svg>
  );
}

/** lucide `hammer` (verbatim path data) for tool call rows. */
export function ToolIcon({ className = 'text-gray-500' }) {
  return (
    <svg
      className={`h-4.5 w-4.5 shrink-0 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m15 12-9.373 9.373a1 1 0 0 1-3.001-3L12 9" />
      <path d="m18 15 4-4" />
      <path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172v-.344a2 2 0 0 0-.586-1.414l-1.657-1.657A6 6 0 0 0 12.516 3H9l1.243 1.243A6 6 0 0 1 12 8.485V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5" />
    </svg>
  );
}

/**
 * The agent's own glyph, drawn on an 18×18 grid inside the h-4.5 w-4.5 box the
 * chat's row headers give it — the same grid as its box, so the stroke is a true
 * 1.5px and the robot fills that box instead of floating inside it. It is the
 * house drawing of the original 16×16 glyph, scaled ×1.2 and re-centred: the head
 * keeps its rounded corners, its antenna, its eyes, and its mouth, and the whole
 * thing keeps the side / vertical padding the other house glyphs keep inside their
 * own grid. Scaling the drawing rather than the box is the point: an 18px box over
 * a 16-unit drawing put 1.69px of ink on screen next to the lucide glyphs' 1.5px,
 * so one grid drift read as a heavier robot at the same size.
 */
export function AgentIcon({ className = 'text-gray-500' }) {
  return (
    <svg
      className={`h-4.5 w-4.5 shrink-0 ${className}`}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 2.4v1.8M4.8 6.6h8.4a1.8 1.8 0 0 1 1.8 1.8v5.4a1.8 1.8 0 0 1-1.8 1.8h-8.4A1.8 1.8 0 0 1 3 13.8v-5.4a1.8 1.8 0 0 1 1.8-1.8z"
      />
      <path strokeLinecap="round" d="M6.9 10.2h.01M11.1 10.2h.01M7.2 12.6h3.6" />
    </svg>
  );
}

export function EditIcon() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.5 2.5 13.5 4.5 5.5 12.5H3.5v-2z" />
    </svg>
  );
}

export function ArrowUpIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 12.5V3.5M8 3.5 4.5 7M8 3.5 11.5 7" />
    </svg>
  );
}

export function StopIcon() {
  return (
    <svg className="h-2.5 w-2.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.5 4.5h9M6 4.5V3.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5 4.5l.5 8h5l.5-8"
      />
    </svg>
  );
}

/**
 * Parked prompt (pause bars): the row is skipped by the end-of-run flush, not
 * deleted — so it keeps the media-control meaning of "hold this one back".
 */
export function PauseIcon() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
      <path d="M5.75 3.75v8.5M10.25 3.75v8.5" />
    </svg>
  );
}

/** Un-parked prompt (bar + play triangle): it is back in line to be sent. */
export function ResumeIcon() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 3.5v9M7.5 3.5 12.5 8 7.5 12.5z" />
    </svg>
  );
}

/** Six-dot grip for queue drag-and-drop. */
export function DragHandleIcon() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="5.5" cy="4" r="1" />
      <circle cx="10.5" cy="4" r="1" />
      <circle cx="5.5" cy="8" r="1" />
      <circle cx="10.5" cy="8" r="1" />
      <circle cx="5.5" cy="12" r="1" />
      <circle cx="10.5" cy="12" r="1" />
    </svg>
  );
}
