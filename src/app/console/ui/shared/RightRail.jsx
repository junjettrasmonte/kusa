import { TAB_IDS, TAB_LABELS } from './lib/format.js';
import { LucideIcon } from './LucideIcons.jsx';
import { RailSubmenu } from './RailSubmenu.jsx';
import { userAvatarInitials } from '#ui/features/user/UserPanel.jsx';

/** Right-rail glyphs — all lucide, 18×18 on lucide's 24×24 grid at stroke 2
 * (→ 1.5px ink), matching the left sidebar top-bar view icons. Account uses
 * an initials avatar instead of a lucide glyph. */
const ICONS = {
  monitors: <LucideIcon name="chart-column" />,
  session: <LucideIcon name="bot-message-square" />,
  harness: <LucideIcon name="orbit" />,
  devtools: <LucideIcon name="tool-case" />,
  settings: <LucideIcon name="cog" />,
};

/** Settings stays with the primary section icons; Account sits under theme. */
const PRIMARY_TABS = TAB_IDS.filter((id) => id !== 'user');
const BOTTOM_TABS = TAB_IDS.filter((id) => id === 'user');

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
 * icons open their menus downward; a bottom-nav icon (Account) opens upward
 * (`anchor: 'up'`) when it has a submenu, because it sits against the
 * viewport's lower edge and a downward menu would spill past it — and an
 * absolutely positioned box that spills past the viewport grows the document,
 * which is what put a scrollbar on the whole page.
 */
function TabButton({ id, on, badge = false, badgeTone = 'down', badgeTitle = '', onSelect, submenu, avatarName = '' }) {
  const icon = id === 'user' ? (
    <span
      className={`flex h-[18px] w-[18px] items-center justify-center rounded-full text-[9px] font-semibold leading-none ${
        on
          ? 'bg-emerald-500/30 text-emerald-200'
          : 'bg-gray-700 text-gray-200'
      }`}
      aria-hidden="true"
    >
      {userAvatarInitials(avatarName)}
    </span>
  ) : ICONS[id];

  const badgeClass = badgeTone === 'ok'
    ? 'bg-emerald-500 shadow-[0_0_0_2px_rgba(16,185,129,0.25)]'
    : 'bg-rose-500 shadow-[0_0_0_2px_rgba(244,63,94,0.25)]';

  return (
    <div className="rail-submenu-group relative flex h-9 w-9 items-center justify-center">
      <button
        type="button"
        role="tab"
        id={`tab-${id}`}
        aria-controls={`panel-${id}`}
        aria-selected={on}
        title={badgeTitle ? `${TAB_LABELS[id]} — ${badgeTitle}` : TAB_LABELS[id]}
        aria-label={badgeTitle ? `${TAB_LABELS[id]} — ${badgeTitle}` : TAB_LABELS[id]}
        className={`relative flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
          on
            ? 'bg-emerald-500/15 text-emerald-400'
            : 'text-gray-400 hover:bg-gray-800 hover:text-gray-100'
        }`}
        onClick={() => onSelect(id)}
      >
        {icon}
        {badge ? (
          <span
            className={`absolute right-1 top-1 inline-block h-1.5 w-1.5 rounded-full ${badgeClass}`}
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
  caoBadge = false,
  liveChatBadge = false,
  /** Display name for the Account avatar initials (auth username). */
  userName = '',
  // Per-section sub-views ({ ids, labels, value, onChange, idPrefix, ariaLabel })
  // keyed by rail tab. They used to be a horizontal strip in the pane topbar;
  // they now live under the icon that owns them, so one hover + one click
  // reaches a sub-view — and a section you are not in can be entered at a
  // specific view in the same gesture.
  subTabs = null,
}) {
  function badgeFor(id) {
    if (id !== 'devtools') return { badge: false, badgeTone: 'down', badgeTitle: '' };
    const parts = [];
    if (trailBadge) {
      parts.push('Trail is missing, needs upgrade from Graft, or is not initialized in this workspace');
    }
    if (gitBadge) {
      parts.push('Git is not installed or this workspace is not a git repository');
    }
    if (caoBadge) {
      parts.push('CLI Agent Orchestrator is not ready (cao CLI missing or cao-server down)');
    }
    if (liveChatBadge) {
      parts.push('Live Chat bot is not ready (not installed or server down)');
    }
    // Always show a status dot on Dev Tools: green when every checked host is up.
    if (!parts.length) {
      return { badge: true, badgeTone: 'ok', badgeTitle: 'All Dev Tools hosts are ready' };
    }
    return { badge: true, badgeTone: 'down', badgeTitle: parts.join(' · ') };
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
          const { badge, badgeTone, badgeTitle } = badgeFor(id);
          return (
            <TabButton
              key={id}
              id={id}
              on={id === tab}
              badge={badge}
              badgeTone={badgeTone}
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
            <LucideIcon name="moon" />
          ) : (
            <LucideIcon name="sun" />
          )}
        </button>
      </div>
      <nav
        role="tablist"
        aria-label="Account"
        aria-orientation="vertical"
        className="flex flex-col items-center gap-1 border-t border-gray-800 py-2"
      >
        {BOTTOM_TABS.map((id) => {
          const { badge, badgeTone, badgeTitle } = badgeFor(id);
          return (
            <TabButton
              key={id}
              id={id}
              on={id === tab}
              badge={badge}
              badgeTone={badgeTone}
              badgeTitle={badgeTitle}
              onSelect={onTabChange}
              avatarName={userName}
              submenu={subTabs?.[id] ? { ...subTabs[id], anchor: 'up' } : null}
            />
          );
        })}
      </nav>
    </aside>
  );
}
