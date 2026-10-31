/**
 * Shared machinery for the composer's popup lists — the Prompt Queue and the
 * Task List. Both are the same control in three parts, so only the rows differ:
 *
 *   1. PopupToggle — a named toolbar switch (glyph + name + count). A list that
 *      tracks progress may pass a done/total fraction instead of a bare count,
 *      so the chip reads "2/5" for a task list and "3" for a queue. It is
 *      disabled while there is nothing to list, so an empty list never takes
 *      space in the composer; the count stays visible on the control, which is
 *      one click away from listing the items. ChatHarness treats the two
 *      switches as tabs: opening one closes the other.
 *   2. A summary line stating what is listed and how much of it.
 *   3. A height-capped, scrollable box of rows — a long list can never push the
 *      composer or the transcript away, so the list is bounded, not thinned.
 *
 * State stays with the owner (ChatHarness), exactly like ComposerDropdown keeps
 * `value` + `onSelect`: these components render and call back, they never own a
 * switch. Each list supplies its own rows and its own glyph, because the rows
 * carry the meaning — a queued prompt and a task are different things.
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
      {/* Named control — the glyph alone is ambiguous, so the row spells out
          what it toggles. Colour comes from the button itself, so glyph, name
          and count dim/brighten as one unit. */}
      <span className="whitespace-nowrap">{label}</span>
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
 * The box is a panel, not loose rows on the page: it is bounded on every side
 * by a visible border, and only its TOP corners are rounded — the square bottom
 * edge is what says "this belongs to the composer below me", while the rounded
 * top is what says "the transcript above me ends here". The fill matches the
 * composer band, so a held list reads as part of the composer, not as chat.
 */
export function PopupList({
  expanded = true,
  count = 0,
  maxHeightPx,
  summary = '',
  ariaLabel,
  children,
}) {
  if (!expanded || !count) return null;
  return (
    <div
      className="mx-2.5 shrink-0 -mb-px flex flex-col rounded-t-xl border border-gray-800 bg-gray-950/70 px-4 sm:px-6 pt-3 pb-1.5"
    >
      <p className="truncate text-[10px] text-gray-500">{summary}</p>
      <div
        className="mt-0.5 overflow-y-auto"
        style={{ maxHeight: maxHeightPx }}
        role="list"
        aria-label={ariaLabel}
      >
        {children}
      </div>
    </div>
  );
}
