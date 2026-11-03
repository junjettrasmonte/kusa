import { SubTabIcon } from './SubTabIcons.jsx';

/**
 * The sub-views of one rail section, as a context menu hanging beside the rail
 * icon rather than as a horizontal strip in the pane topbar.
 *
 * The menu is ALWAYS in the DOM — index.css (.rail-submenu) hides it with
 * visibility + opacity and shows it while its rail icon (.rail-submenu-group)
 * is hovered or keyboard-focused. Keeping the buttons live is what lets the
 * screenshot scripts click `session-tab-chat` without needing a pointer over
 * the rail, and keeps a keyboard user able to reach a sub-view they cannot
 * see yet.
 *
 * Button ids stay `${idPrefix}-tab-${id}` so every panel keeps resolving its
 * `aria-labelledby` and the tests/screenshots keep their selectors.
 *
 * The menu hangs to the LEFT of the rail (the rail is the rightmost column). It
 * grows DOWN from the icon's top edge — that is right for the icons in the top
 * nav, but wrong for the one in the bottom nav: it sits against the viewport's
 * lower edge, so a menu that grows down from its top edge always runs past the
 * viewport by (menu height − icon height). That overflow is not cosmetic: an
 * absolutely positioned box extends the document's scrollable area, so the
 * always-present (visibility-hidden) Settings submenu was what put a scrollbar
 * on the whole page. `anchor: 'up'` anchors the same menu to the icon's bottom edge
 * instead, so it opens upward and stays inside the viewport.
 */
export function RailSubmenu({
  ids,
  labels,
  value,
  onChange,
  idPrefix,
  ariaLabel,
  // 'down' = anchored to the icon's top edge (top nav); 'up' = anchored to its
  // bottom edge (bottom nav, where downward would spill past the viewport and
  // grow the document). Both literals must stay literal: Tailwind generates a
  // utility only for a class it can see in the source.
  anchor = 'down',
  /** Optional per-id status: `{ [id]: { tone: 'ok'|'down', title?: string } }`. */
  itemStatus = null,
}) {
  if (!ids?.length) return null;

  return (
    <nav
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="vertical"
      className={`rail-submenu absolute right-[100%] z-30 flex flex-col items-stretch w-44 rounded-md border border-gray-700 bg-gray-900 py-1.5 px-2 shadow-lg ${anchor === 'up' ? 'bottom-0' : 'top-0'}`}
    >
      {ids.map((id) => {
        const on = id === value;
        const status = itemStatus?.[id] || null;
        const statusTitle = status?.title || '';
        const label = labels[id];
        const title = statusTitle ? `${label} — ${statusTitle}` : label;
        const toneClass = status?.tone === 'ok'
          ? 'bg-emerald-500 shadow-[0_0_0_2px_rgba(16,185,129,0.25)]'
          : status?.tone === 'down'
            ? 'bg-rose-500 shadow-[0_0_0_2px_rgba(244,63,94,0.25)]'
            : '';
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${id}`}
            aria-controls={`${idPrefix}-panel-${id}`}
            aria-selected={on}
            title={title}
            aria-label={title}
            className={`flex w-full h-6 items-center gap-1.5 rounded-md px-1.5 text-[11px] font-medium text-left transition-colors ${
              on
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-100'
            }`}
            onClick={() => onChange(id)}
          >
            <SubTabIcon id={id} />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {status && toneClass ? (
              <span
                className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${toneClass}`}
                title={statusTitle}
                aria-hidden="true"
              />
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
