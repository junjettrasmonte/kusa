import { TAB_IDS, TAB_LABELS } from '../lib/format.js';

/** Compact 16×16 stroke icons — same visual language as the left sidebar. */
const ICONS = {
  monitors: (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12.5V8M8 12.5V3.5M13 12.5V6" />
    </svg>
  ),
  session: (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 3.5h9a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H7l-2.5 2v-2h-1a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z" />
    </svg>
  ),
  harness: (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 2.5 3.5 5v6L8 13.5 12.5 11V5L8 2.5z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 8.5v5M8 8.5 3.5 5.5M8 8.5l4.5-3" />
    </svg>
  ),
  devtools: (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.5 6.5h11v7H2.5zM4 6.5l1-3h6l1 3M6.5 9h3" />
    </svg>
  ),
  settings: (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path
        strokeLinejoin="round"
        d="M9.1 1.6 9.65 3.15l1.7.35 1.1-1.3 1.55 1.55-1.3 1.1.35 1.7 1.55.55v2.2l-1.55.55-.35 1.7 1.3 1.1-1.55 1.55-1.1-1.3-1.7.35L9.1 14.4H6.9l-.55-1.55-1.7-.35-1.1 1.3-1.55-1.55 1.3-1.1-.35-1.7L1.6 9.1V6.9l1.55-.55.35-1.7-1.3-1.1L3.55 2.2l1.1 1.3 1.7-.35L6.9 1.6h2.2z"
      />
      <circle cx="8" cy="8" r="2.15" />
    </svg>
  ),
};

const PRIMARY_TABS = TAB_IDS.filter((id) => id !== 'settings');
const BOTTOM_TABS = TAB_IDS.filter((id) => id === 'settings');

function TabButton({ id, on, badge, badgeTitle, onSelect }) {
  return (
    <button
      type="button"
      role="tab"
      id={`tab-${id}`}
      aria-controls={`panel-${id}`}
      aria-selected={on}
      title={TAB_LABELS[id]}
      aria-label={badge ? `${TAB_LABELS[id]} — ${badgeTitle}` : TAB_LABELS[id]}
      className={`relative flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
        on
          ? 'bg-emerald-500/15 text-emerald-400'
          : 'text-gray-400 hover:bg-gray-800 hover:text-gray-100'
      }`}
      onClick={() => onSelect(id)}
    >
      {ICONS[id]}
      {badge ? (
        <span
          className="absolute right-1 top-1 inline-block h-1.5 w-1.5 rounded-full bg-rose-500 shadow-[0_0_0_2px_rgba(244,63,94,0.25)]"
          title={badgeTitle}
          aria-hidden="true"
        />
      ) : null}
    </button>
  );
}

export function RightRail({
  tab,
  onTabChange,
  theme = 'dark',
  onThemeChange,
  trailBadge = false,
  gitBadge = false,
}) {
  function badgeFor(id) {
    if (id !== 'devtools') return { badge: false, badgeTitle: '' };
    const parts = [];
    if (trailBadge) {
      parts.push('Trail is missing, needs upgrade from Graft, or is not initialized in this workspace');
    }
    if (gitBadge) {
      parts.push('Git is not installed or this workspace is not a git repository');
    }
    if (!parts.length) return { badge: false, badgeTitle: '' };
    return { badge: true, badgeTitle: parts.join(' · ') };
  }

  const themeLabel = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';

  return (
    <aside
      id="right-rail"
      className="flex w-12 shrink-0 flex-col border-l border-gray-800 bg-gray-900"
    >
      <nav
        role="tablist"
        aria-label="Main sections"
        aria-orientation="vertical"
        className="flex flex-1 flex-col items-center gap-1 overflow-y-auto py-2"
      >
        {PRIMARY_TABS.map((id) => {
          const { badge, badgeTitle } = badgeFor(id);
          return (
            <TabButton
              key={id}
              id={id}
              on={id === tab}
              badge={badge}
              badgeTitle={badgeTitle}
              onSelect={onTabChange}
            />
          );
        })}
      </nav>
      <div className="flex flex-col items-center gap-1 px-0 pb-2">
        <button
          type="button"
          title={themeLabel}
          aria-label={themeLabel}
          className="flex h-9 w-9 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-100"
          onClick={() => onThemeChange?.(theme === 'light' ? 'dark' : 'light')}
        >
          {theme === 'light' ? (
            <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5z" />
            </svg>
          ) : (
            <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <circle cx="8" cy="8" r="2.5" />
              <path strokeLinecap="round" d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.5 3.5l1 1M11.5 11.5l1 1M3.5 12.5l1-1M11.5 4.5l1-1" />
            </svg>
          )}
        </button>
      </div>
      <nav
        role="tablist"
        aria-label="Console settings"
        aria-orientation="vertical"
        className="flex flex-col items-center gap-1 border-t border-gray-800 py-2"
      >
        {BOTTOM_TABS.map((id) => {
          const { badge, badgeTitle } = badgeFor(id);
          return (
            <TabButton
              key={id}
              id={id}
              on={id === tab}
              badge={badge}
              badgeTitle={badgeTitle}
              onSelect={onTabChange}
            />
          );
        })}
      </nav>
    </aside>
  );
}
