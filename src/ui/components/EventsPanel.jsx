import { fmt, stamp } from '../lib/format.js';

export function EventsPanel({ recent = [] }) {
  return (
    <section>
      <h2 className="mb-2 text-base font-semibold">Recent events</h2>
      <div className="overflow-x-auto rounded-xl border border-gray-800">
        <table className="w-full text-sm">
          <thead className="bg-gray-900 text-xs uppercase tracking-wide text-gray-400">
            <tr>
              <th className="px-3 py-2 text-left font-medium">When</th>
              <th className="px-3 py-2 text-left font-medium">Event</th>
              <th className="px-3 py-2 text-left font-medium">Tool</th>
              <th className="px-3 py-2 text-right font-medium">Duration</th>
              <th className="px-3 py-2 text-left font-medium">Correlation</th>
              <th className="px-3 py-2 text-left font-medium">Outcome</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {recent.length ? recent.map((e, i) => (
              <tr key={`${e.atWall}-${e.event}-${i}`}>
                <td className="px-3 py-1.5 font-mono text-xs text-gray-400">{stamp(e.atWall)}</td>
                <td className="px-3 py-1.5">{e.event}</td>
                <td className="px-3 py-1.5">
                  {e.toolName}
                  {e.subName ? <> <code className="text-xs text-sky-300">{e.subName}</code></> : null}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmt(e.durationMs)}</td>
                <td className="px-3 py-1.5 text-gray-400">{e.correlation}</td>
                <td className="px-3 py-1.5">{e.outcome}</td>
              </tr>
            )) : (
              <tr><td colSpan={6} className="px-3 py-3 text-gray-500">None.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
