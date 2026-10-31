/**
 * In-page confirmation gate for destructive actions.
 *
 * `window.confirm` is the wrong control here. It answers with a bare OK/Cancel
 * strip that carries no styling, no theme, and no idea what is about to be
 * destroyed — the user clicks "OK" for a sentence they cannot aim at anything on
 * the page. This renders the same gate as a page-level dialog in the console's
 * own visual language: the action spelled out on a button that looks like the
 * button that asked for it (same glyph, same danger tint), the affected items
 * listed inside the dialog, and a dismiss that leaves the request where the
 * owner decides.
 *
 * The owner keeps the pending request and the `open` switch — exactly like
 * ComposerDropdown keeps `value` + `onSelect` and PopupList keeps nothing about
 * its toggle. This control renders and calls back; it never owns a gate.
 * Confirming calls `onConfirm`, which runs the action; anything that closes the
 * dialog (dismiss button or Close glyph) calls `onDismiss` so the owner can
 * drop its pending request. `error` is the owner's last failure: showing it
 * inside the open dialog keeps the gate alive, so the user can retry the same
 * action or walk away from it instead of losing it on the first hiccup.
 */
import { CloseIcon, IconButton } from './IconButton.jsx';

export function ConfirmDialog({
  open = false,
  title,
  detail = '',
  items = [],
  error = null,
  icon: Icon = null,
  confirmLabel,
  cancelLabel = 'Cancel',
  disabled = false,
  onConfirm,
  onDismiss,
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div className="w-full max-w-md rounded-xl border border-gray-700 bg-gray-950 p-4 shadow-xl">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {Icon ? <Icon className="h-4 w-4 shrink-0 text-rose-400" /> : null}
            <h2 id="confirm-dialog-title" className="text-sm font-semibold text-rose-300">
              {title}
            </h2>
          </div>
          <IconButton label="Dismiss" icon={CloseIcon} onClick={onDismiss} />
        </div>
        {detail ? <p className="mt-1.5 text-xs text-gray-400">{detail}</p> : null}
        {items.length ? (
          <ul className="mt-2 space-y-1 text-xs text-gray-300">
            {items.map((label, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <span className="shrink-0 h-1 w-1 rounded-full bg-rose-400" />
                <span className="truncate">{label}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p className="mt-2 rounded-md border border-rose-800/60 bg-rose-950/30 px-3 py-1.5 text-xs text-rose-300">
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            title={confirmLabel}
            onClick={onConfirm}
            disabled={disabled}
            className="btn btn-danger flex items-center gap-1.5 disabled:cursor-not-allowed"
          >
            {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
            <span className="whitespace-nowrap">{confirmLabel}</span>
          </button>
          <button
            type="button"
            title={cancelLabel}
            onClick={onDismiss}
            className="btn ml-2 whitespace-nowrap"
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
