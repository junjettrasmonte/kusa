import { DrawerCloseIcon, DrawerDockIcon } from './ChatGlyphs.jsx';

/**
 * Shared machinery for the composer's popup lists — the Prompt Queue, the Task
 * List, and Attachments. All three are the same control in three parts, so only
 * the rows differ:
 *
 *   1. PopupToggle — a named toolbar switch (glyph + name + count). A list that
 *      tracks progress may pass a done/total fraction instead of a bare count,
 *      so the chip reads "2/5" for a task list and "3" for a queue. It is
 *      disabled while there is nothing to list, so an empty list never takes
 *      space in the composer; the count stays visible on the control, which is
 *      one click away from listing the items. ChatHarness treats the switches
 *      as tabs: opening one closes the others. Below the composer's container
 *      breakpoint the name hides and only the glyph (+ count) remains, so the
 *      row still fits on a phone without losing the toggle.
 *   2. A summary line stating what is listed and how much of it, plus a dock
 *      icon that toggles bottom (above the message box) vs right (flush left of
 *      the right rail), and a close icon that hides the list (same as flipping
 *      the toolbar switch off). Dock is shared across all three drawers.
 *   3. A scrollable box of rows that fills the sized dock ChatHarness owns —
 *      bottom height / right width are drag-resized there (up to half the chat
 *      shell). The list scrolls inside that size so it never pushes the
 *      transcript away.
 *
 * State stays with the owner (ChatHarness), exactly like ComposerDropdown keeps
 * `value` + `onSelect`: these components render and call back, they never own a
 * switch. Each list supplies its own rows and its own glyph, because the rows
 * carry the meaning — a queued prompt, a task, and a staged file are different
 * things.
 *
 * A list that measures progress may also ask its control to beat for one 2s
 * pulse (`pulseClass`, see .chat-badge-pulse in index.css) when its counters
 * move, so the number the user follows visibly answers "this list just changed".
 * A list of moving objects may ask for a bounce instead (`.chat-badge-bounce`):
 * same one-beat contract, different figure — a task status moving is progress
 * swelling, a prompt arriving or being sent is an object moving. The owner
 * picks which of the two beat names to use — this control stays stateless,
 * exactly like it stays out of the switch business.
 */
export function PopupToggle({
  icon: Icon,
  label,
  count,
  noun = 'listed',
  progress = null,
  progressNoun = 'done',
  expanded = true,
  onToggle,
  countClassName = 'text-amber-300/90',
  activeClassName = 'bg-amber-500/15 text-amber-300',
  className = '',
  // One beat for a badge whose counters just moved. Empty = no beat. The owner
  // names the beat (pulse or bounce) and alternates its two variants so a
  // change landing inside a running beat restarts it instead of being ignored
  // (a CSS animation only restarts when its animation-name changes).
  pulseClass = '',
}) {
  // A list that measures progress (the Task List) passes `progress` as a
  // done/total fraction; the chip then shows the number the user actually wants
  // to watch move, and `count` only decides whether there is anything to show.
  // A queue passes no fraction and keeps its plain item count.
  const shown = progress || count;
  const detail = progress ? `${progress} ${progressNoun}` : `${count} ${noun}`;
  const active = count > 0 && expanded;
  return (
    <button
      type="button"
      disabled={count === 0}
      onClick={() => onToggle?.()}
      aria-expanded={count > 0 ? expanded : false}
      aria-pressed={active}
      title={
        count === 0
          ? `${label} is empty`
          : expanded
            ? `${label} — hide the list (${detail})`
            : `${label} — show the list (${detail})`
      }
      aria-label={
        count === 0
          ? `${label} is empty`
          : expanded
            ? `${label}, hide the list, ${detail}`
            : `${label}, show the list, ${detail}`
      }
      className={`inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-500 ${
        active
          ? activeClassName
          : 'text-gray-500 hover:bg-gray-800/70 hover:text-gray-200'
      } ${className} ${pulseClass}`}
    >
      <Icon expanded={expanded} className={active ? undefined : 'text-gray-500'} />
      {/* Named control — the glyph alone is ambiguous on a wide composer, so the
          row spells out what it toggles. On a narrow composer the name hides
          (title / aria-label still carry it) and only the glyph + count stay,
          matching the Mode/Rule/Model collapse. Colour comes from the button
          itself, so glyph, name and count dim/brighten as one unit. */}
      <span className="hidden whitespace-nowrap @[36rem]:inline">{label}</span>
      {count > 0 ? (
        <span className={`tabular-nums ${active ? '' : countClassName}`}>{shown}</span>
      ) : null}
    </button>
  );
}

/**
 * The list itself. Renders nothing while the switch is off or the list is empty
 * — the toolbar control is the only trace of it then, and the slot stays empty
 * rather than leaving an empty capped box above the composer.
 *
 * Bottom dock: a panel bounded on every side by a visible border, only its TOP
 * corners rounded — the square bottom edge says "this belongs to the composer
 * below me". Right dock: same gray-800 border language inside the side column
 * ChatHarness sizes (left border of that column separates from the transcript).
 * Both fill the sized parent; `maxHeightPx` is only a fallback if no sized
 * parent is wrapping the list.
 */
export function PopupList({
  expanded = true,
  count = 0,
  // Kept for call-site compatibility; ChatHarness sizes the dock wrapper so
  // the list fills that box instead of applying a fixed pixel cap here.
  maxHeightPx: _maxHeightPx,
  summary = '',
  ariaLabel,
  dock = 'bottom',
  onDockToggle = null,
  onClose = null,
  children,
}) {
  if (!expanded || !count) return null;
  const right = dock === 'right';
  const dockLabel = right ? 'Dock to bottom' : 'Dock to right';
  const headerBtn =
    'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-800/70 hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50';
  return (
    <div
      className={
        right
          ? 'flex h-full min-h-0 flex-1 flex-col border-0 bg-transparent px-3 pt-3 pb-1.5'
          : 'mx-2.5 -mb-px flex h-full min-h-0 flex-col rounded-t-xl border border-gray-800 bg-gray-950/70 px-4 sm:px-6 pt-3 pb-1.5'
      }
    >
      <div className="flex shrink-0 items-center gap-1">
        <p className="min-w-0 flex-1 truncate text-[10px] text-gray-500">{summary}</p>
        {onDockToggle ? (
          <button
            type="button"
            title={dockLabel}
            aria-label={dockLabel}
            onClick={() => onDockToggle()}
            className={headerBtn}
          >
            <DrawerDockIcon dock={dock} />
          </button>
        ) : null}
        {onClose ? (
          <button
            type="button"
            title="Close"
            aria-label="Close drawer"
            onClick={() => onClose()}
            className={headerBtn}
          >
            <DrawerCloseIcon />
          </button>
        ) : null}
      </div>
      <div
        className="mt-0.5 min-h-0 flex-1 overflow-y-auto"
        role="list"
        aria-label={ariaLabel}
      >
        {children}
      </div>
    </div>
  );
}
