import { SUBTAB_ICONS } from './SubTabIcons.jsx';

/**
 * Horizontal sub-tabs for the main pane topbar.
 * `idPrefix` keeps stable button ids (e.g. harness-tab-tools) for tests/screenshots.
 */
export function PaneSubTabs({
  ids,
  labels,
  value,
  onChange,
  idPrefix,
  ariaLabel,
}) {
  if (!ids?.length) return null;

  return (
    <nav
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      className="flex h-full min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto"
    >
      {ids.map((id) => {
        const on = id === value;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${id}`}
            aria-controls={`${idPrefix}-panel-${id}`}
            aria-selected={on}
            className={`inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-medium transition-colors ${
              on
                ? 'border-emerald-500 text-emerald-400'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
            onClick={() => onChange(id)}
          >
            {SUBTAB_ICONS[id]}
            {labels[id]}
          </button>
        );
      })}
    </nav>
  );
}
