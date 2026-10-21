/**
 * Shared machinery for the composer's popup lists — the Prompt Queue and the
 * Task List. Both are the same control in three parts, so only the rows differ:
 *
 *   1. PopupToggle — a named toolbar switch (glyph + name + count). It is
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
 */
export function PopupToggle({
  icon: Icon,
  label,
  count,
  noun = 'listed',
  expanded = true,
  onToggle,
  countClassName = 'text-amber-300/90',
  activeClassName = 'bg-amber-500/15 text-amber-300',
  className = '',
}) {
  // Same control as a tab: when the list is open, the switch reads as the
  // selected tab (filled accent); when closed it stays a quiet toolbar chip.
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
            ? `${label} — hide the list (${count} ${noun})`
            : `${label} — show the list (${count} ${noun})`
      }
      aria-label={
        count === 0
          ? `${label} is empty`
          : expanded
            ? `${label}, hide the list, ${count} ${noun}`
            : `${label}, show the list, ${count} ${noun}`
      }
      className={`inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-500 ${
        active
          ? activeClassName
          : 'text-gray-500 hover:bg-gray-800/70 hover:text-gray-200'
      } ${className}`}
    >
      <Icon expanded={expanded} className={active ? undefined : 'text-gray-500'} />
      {/* Named control — the glyph alone is ambiguous, so the row spells out
          what it toggles. Colour comes from the button itself, so glyph, name
          and count dim/brighten as one unit. */}
      <span className="whitespace-nowrap">{label}</span>
      {count > 0 ? (
        <span className={`tabular-nums ${active ? '' : countClassName}`}>{count}</span>
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
