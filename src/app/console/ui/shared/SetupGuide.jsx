/**
 * Shared install / init checklist shown when Trail, Git, or CAO is not ready.
 * Optional `action` renders a primary button (e.g. start cao-server from serve).
 *
 * @param {{ label: string, onClick: () => void, disabled?: boolean, busy?: boolean, busyLabel?: string }} [action]
 */
export function SetupGuide({ title, summary, steps = [], footnote, action = null }) {
  return (
    <section className="rounded-xl border border-amber-900/60 bg-amber-950/20 p-4">
      <h2 className="text-base font-semibold text-amber-200">{title}</h2>
      {summary ? <p className="mt-2 text-sm text-gray-300">{summary}</p> : null}
      {steps.length ? (
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-gray-300">
          {steps.map((step) => (
            <li key={step}>
              <code className="whitespace-pre-wrap break-words font-mono text-[12px] text-sky-300">
                {step}
              </code>
            </li>
          ))}
        </ol>
      ) : null}
      {action?.label && typeof action.onClick === 'function' ? (
        <div className="mt-4">
          <button
            type="button"
            disabled={Boolean(action.disabled || action.busy)}
            onClick={action.onClick}
            className="rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {action.busy ? (action.busyLabel || 'Working…') : action.label}
          </button>
        </div>
      ) : null}
      {footnote ? <p className="mt-3 text-xs text-gray-500">{footnote}</p> : null}
    </section>
  );
}
