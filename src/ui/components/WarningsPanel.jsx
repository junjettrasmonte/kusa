import { stamp } from '../lib/format.js';

export function WarningsPanel({ warnings = [] }) {
  return (
    <section>
      <h2 className="mb-2 text-base font-semibold">Warnings</h2>
      <ul className="space-y-1 text-sm">
        {warnings.length ? warnings.map((w, i) => (
          <li key={`${w.atWall}-${i}`} className="text-amber-300">
            {stamp(w.atWall)} · {w.message}
          </li>
        )) : (
          <li className="text-gray-500">None.</li>
        )}
      </ul>
    </section>
  );
}
