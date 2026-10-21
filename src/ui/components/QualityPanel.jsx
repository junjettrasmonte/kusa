import { stamp } from '../lib/format.js';

export function QualityPanel({ notes = [], errors = [] }) {
  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-2 text-base font-semibold">Data quality</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-gray-400">
          {notes.length ? notes.map((n, i) => <li key={i}>{n}</li>) : <li>—</li>}
        </ul>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold">Console errors</h2>
        <p className="mb-1 text-xs text-gray-500">Separate from agent and tool errors.</p>
        <ul className="space-y-1 text-sm">
          {errors.length ? errors.map((e, i) => (
            <li key={`${e.atWall}-${i}`} className="text-rose-300">
              {stamp(e.atWall)} · {e.message}
            </li>
          )) : (
            <li className="text-gray-500">None.</li>
          )}
        </ul>
      </section>
    </div>
  );
}
