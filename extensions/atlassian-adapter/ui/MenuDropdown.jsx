/**
 * Compact dropdown / context menus for the Atlassian panel
 * (single-select + multi-select checkbox menus).
 */
import { useEffect, useRef, useState } from 'react';
import { LucideIcon } from '#ui/shared/LucideIcons.jsx';

function Chevron({ open }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={`h-3 w-3 shrink-0 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`}
    >
      <path
        fill="currentColor"
        d="M4.47 6.22a.75.75 0 0 1 1.06 0L8 8.69l2.47-2.47a.75.75 0 1 1 1.06 1.06l-3 3a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 0 1 0-1.06Z"
      />
    </svg>
  );
}

function useOutsideClose(open, onClose) {
  const rootRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (!rootRef.current?.contains(event.target)) onClose?.();
    }
    function onKey(event) {
      if (event.key === 'Escape') onClose?.();
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  return rootRef;
}

const triggerClass = (open, disabled) => (
  `inline-flex max-w-full items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium ${
    disabled
      ? 'cursor-not-allowed border-gray-800 bg-gray-950 text-gray-600 opacity-60'
      : open
        ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
        : 'border-gray-700 bg-gray-950 text-gray-300 hover:border-gray-600 hover:text-gray-100'
  }`
);

const menuClass = 'absolute left-0 top-[calc(100%+0.25rem)] z-50 max-h-[min(20rem,50vh)] w-[18rem] overflow-y-auto overscroll-contain rounded-lg border border-gray-700 bg-gray-950 py-1 shadow-lg';

/**
 * Single-select context menu.
 * @param {{
 *   label: string,
 *   value: string,
 *   options: Array<{ id: string, label: string, hint?: string, icon?: string }>,
 *   onSelect: (id: string) => void,
 *   disabled?: boolean,
 *   className?: string,
 * }} props
 */
export function SelectDropdown({
  label,
  value,
  options = [],
  onSelect,
  disabled = false,
  className = '',
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useOutsideClose(open, () => setOpen(false));
  const selected = options.find((o) => o.id === value);
  const display = selected?.label || value || '—';

  return (
    <div className={`relative inline-flex min-w-0 ${className}`} ref={rootRef}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!disabled) setOpen((v) => !v);
        }}
        className={triggerClass(open, disabled)}
        title={`${label}: ${display}`}
      >
        <span className="text-gray-500">{label}</span>
        {selected?.icon ? (
          <LucideIcon name={selected.icon} className="h-3.5 w-3.5 text-gray-300" />
        ) : null}
        <span className="max-w-[10rem] truncate text-gray-100">{display}</span>
        <Chevron open={open} />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={label}
          className={menuClass}
          onMouseDown={(e) => e.preventDefault()}
        >
          {options.map((option) => {
            const on = option.id === value;
            return (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                onClick={() => {
                  setOpen(false);
                  if (!on) onSelect?.(option.id);
                }}
                className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs ${
                  on ? 'bg-emerald-500/10 text-emerald-300' : 'text-gray-200 hover:bg-gray-900'
                }`}
              >
                {option.icon ? (
                  <LucideIcon
                    name={option.icon}
                    className={`h-3.5 w-3.5 shrink-0 ${on ? 'text-emerald-300' : 'text-gray-400'}`}
                  />
                ) : (
                  <span className={`w-3.5 shrink-0 text-center text-[10px] ${on ? 'text-emerald-400' : 'text-transparent'}`}>
                    ✓
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{option.label}</span>
                  {option.hint ? (
                    <span className="block truncate text-[10px] text-gray-500">{option.hint}</span>
                  ) : null}
                </span>
                {on && option.icon ? (
                  <span className="shrink-0 text-[10px] text-emerald-400">✓</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Multi-select checkbox context menu.
 * @param {{
 *   label: string,
 *   summary: string,
 *   options: Array<{ id: string, label: string, hint?: string }>,
 *   selectedIds: string[],
 *   onChange: (ids: string[]) => void,
 *   onOpen?: () => void,
 *   onClose?: () => void,
 *   leading?: React.ReactNode,
 *   disabled?: boolean,
 *   emptyText?: string,
 *   className?: string,
 * }} props
 */
export function MultiSelectDropdown({
  label,
  summary,
  options = [],
  selectedIds = [],
  onChange,
  onOpen,
  onClose,
  leading = null,
  disabled = false,
  emptyText = 'No options',
  className = '',
}) {
  const [open, setOpen] = useState(false);

  function dismissMenu() {
    setOpen(false);
  }

  function closeMenu() {
    setOpen(false);
    onClose?.();
  }

  function openMenu() {
    setOpen(true);
    onOpen?.();
  }

  const rootRef = useOutsideClose(open, closeMenu);
  const selected = new Set(selectedIds);

  function toggle(id) {
    const next = selected.has(id)
      ? selectedIds.filter((x) => x !== id)
      : [...selectedIds, id];
    onChange?.(next);
  }

  function selectAll() {
    onChange?.(options.map((o) => o.id));
  }

  function clearAll() {
    onChange?.([]);
  }

  return (
    <div className={`relative inline-flex min-w-0 ${className}`} ref={rootRef}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (disabled) return;
          if (open) closeMenu();
          else openMenu();
        }}
        className={triggerClass(open, disabled)}
        title={`${label}: ${summary}`}
      >
        <span className="text-gray-500">{label}</span>
        <span className="max-w-[12rem] truncate text-gray-100">{summary}</span>
        <Chevron open={open} />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={label}
          className={menuClass}
          onMouseDown={(e) => e.preventDefault()}
        >
          {typeof leading === 'function' ? leading(dismissMenu) : leading}
          {options.length > 0 ? (
            <div className="flex items-center justify-between gap-2 border-b border-gray-800 px-2.5 py-1.5">
              <span className="text-[10px] uppercase tracking-wider text-gray-500">
                {selectedIds.length}/{options.length}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="text-[11px] text-sky-300 hover:underline"
                  onClick={selectAll}
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="text-[11px] text-gray-500 hover:underline"
                  onClick={clearAll}
                >
                  Clear
                </button>
              </div>
            </div>
          ) : null}
          {!options.length ? (
            <p className="px-2.5 py-2 text-[11px] text-gray-500">{emptyText}</p>
          ) : (
            options.map((option) => {
              const on = selected.has(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  onClick={() => toggle(option.id)}
                  className={`flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-xs ${
                    on ? 'bg-gray-900/80 text-gray-100' : 'text-gray-300 hover:bg-gray-900'
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px] ${
                      on
                        ? 'border-emerald-500/60 bg-emerald-500/20 text-emerald-300'
                        : 'border-gray-600 text-transparent'
                    }`}
                  >
                    ✓
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{option.label}</span>
                    {option.hint ? (
                      <span className="block truncate text-[10px] text-gray-500">{option.hint}</span>
                    ) : null}
                  </span>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
