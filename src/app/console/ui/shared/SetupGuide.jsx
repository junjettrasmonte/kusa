/** Shared install / init checklist shown when Trail or Git is not ready. */
export function SetupGuide({ title, summary, steps = [], footnote }) {
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
      {footnote ? <p className="mt-3 text-xs text-gray-500">{footnote}</p> : null}
    </section>
  );
}
