import { TAB_IDS, TAB_LABELS } from './lib/format.js';
import { RailSubmenu } from './RailSubmenu.jsx';

/** Compact stroke icons — same visual language as the left sidebar. Hand-drawn ones
 * sit on a 16×16 grid at strokeWidth 1.5; lucide-sourced ones keep lucide's own
 * 24×24 grid, noted inline. */
const ICONS = {
  monitors: (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12.5V8M8 12.5V3.5M13 12.5V6" />
    </svg>
  ),
  // Chat Session — lucide `bot-message-square`, verbatim artwork on lucide's own
  // 24×24 grid (like the chat glyphs in ChatGlyphs.jsx). The stroke is 2.25, not
  // 1.5: this box renders at 16px from a 24-unit grid, so 2.25 * 16/24 = 1.5px —
  // the same ink weight as the other rail icons.
  session: (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 6V2H8" />
      <path d="M15 11v2" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="M20 16a2 2 0 0 1-2 2H8.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 4 20.286V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
      <path d="M9 11v2" />
    </svg>
  ),
  // Harness — lucide `orbit`, verbatim artwork on lucide's own 24×24 grid. The
  // stroke is 2.25, not lucide's 2: this box renders at 16px from a 24-unit grid,
  // so 2.25 * 16/24 = 1.5px — the same ink weight as the other rail icons.
  harness: (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.341 6.484A10 10 0 0 1 10.266 21.85" />
      <path d="M3.659 17.516A10 10 0 0 1 13.74 2.152" />
      <circle cx="12" cy="12" r="3" />
      <circle cx="19" cy="5" r="2" />
      <circle cx="5" cy="19" r="2" />
    </svg>
  ),
  // Developer Tools — lucide `tool-case`, verbatim artwork on lucide's own
  // 24×24 grid. The stroke is 2.25, not lucide's 2: this box renders at 16px from
  // a 24-unit grid, so 2.25 * 16/24 = 1.5px — the same ink weight as the other
  // rail icons.
  devtools: (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 15h4" />
      <path d="m14.5 4.058.571-1.429a1 1 0 011.3-.558l5 2a1 1 0 01.549.534.88.88 0 01.01.765l-2.332 5.83" />
      <path d="M15.634 11a2 2 0 00-.186-.34l-1.17-1.757 1.31-1.656a2 2 0 00-2.109-3.165l-2.032.57-1.17-1.758a2 2 0 00-3.664 1.028l-.086 2.11-2.032.568a2 2 0 00-.155 3.8l1.617.6" />
      <path d="M4 12.006A1 1 0 014.994 11H19a1 1 0 011 1v7a2 2 0 01-2 2H6a2 2 0 01-2-2z" />
    </svg>
  ),
  // Settings — lucide `cog`, verbatim artwork on lucide's own 24×24 grid. The
  // stroke is 2.25, not lucide's 2: this box renders at 16px from a 24-unit grid,
  // so 2.25 * 16/24 = 1.5px — the same ink weight as the other rail icons.
  settings: (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 10.27 7 3.34" />
      <path d="m11 13.73-4 6.93" />
      <path d="M12 22v-2" />
      <path d="M12 2v2" />
      <path d="M14 12h8" />
      <path d="m17 20.66-1-1.73" />
      <path d="m17 3.34-1 1.73" />
      <path d="M2 12h2" />
      <path d="m20.66 17-1.73-1" />
      <path d="m20.66 7-1.73 1" />
      <path d="m3.34 17 1.73-1" />
      <path d="m3.34 7 1.73 1" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="12" cy="12" r="8" />
    </svg>
  ),
};

const PRIMARY_TABS = TAB_IDS.filter((id) => id !== 'settings');
const BOTTOM_TABS = TAB_IDS.filter((id) => id === 'settings');

/**
 * A rail icon, plus the context menu of its sub-views that fades in while the
 * icon is hovered (see .rail-submenu / .rail-submenu-group in index.css).
 *
 * The wrapper is the hover target and the anchor for the menu: `right-[100%]`
 * puts the menu to the LEFT of the icon, inside the pane, where there is room
 * for it. The nav that holds this wrapper must not clip overflow — that is why
 * its `overflow-y-auto` was dropped: a scroll container would cut the menu off
 * at the rail's edge.
 *
 * Vertical anchoring is per group, not one rule for every icon: the top nav's
 * icons open their menus downward, the bottom nav's Settings icon opens its
 * menu upward (`anchor: 'up'`), because that icon sits against the viewport's
 * lower edge and a downward menu would spill past it — and an absolutely
 * positioned box that spills past the viewport grows the document, which is
 * what put a scrollbar on the whole page.
 */
function TabButton({ id, on, badge, badgeTitle, onSelect, submenu }) {
  return (
    <div className="rail-submenu-group relative flex h-9 w-9 items-center justify-center">
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
      {submenu ? <RailSubmenu {...submenu} /> : null}
    </div>
  );
}

export function RightRail({
  tab,
  onTabChange,
  theme = 'dark',
  onThemeChange,
  trailBadge = false,
  gitBadge = false,
  // Per-section sub-views ({ ids, labels, value, onChange, idPrefix, ariaLabel })
  // keyed by rail tab. They used to be a horizontal strip in the pane topbar;
  // they now live under the icon that owns them, so one hover + one click
  // reaches a sub-view — and a section you are not in can be entered at a
  // specific view in the same gesture.
  subTabs = null,
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
        className="flex flex-1 flex-col items-center gap-1 py-2"
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
              submenu={subTabs?.[id]}
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
              submenu={subTabs?.[id] ? { ...subTabs[id], anchor: 'up' } : null}
            />
          );
        })}
      </nav>
    </aside>
  );
}
