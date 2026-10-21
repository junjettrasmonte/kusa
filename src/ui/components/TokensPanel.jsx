import { num, stamp } from '../lib/format.js';

export function TokensPanel({ tokens, tokenTurns = [] }) {
  const tok = tokens || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, uncached: 0, turns: 0 };

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-base font-semibold">Token usage</h2>
        <p className="mb-3 text-xs text-gray-500">
          From Cursor <code className="text-sky-300">stop</code> / <code className="text-sky-300">afterAgentResponse</code>.
          Parent agent only; input includes cache. Copilot and VS Code Local hooks do not include token fields.
        </p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Input" value={num(tok.input)} />
          <Stat label="Output" value={num(tok.output)} />
          <Stat label="Cache read" value={num(tok.cacheRead)} />
          <Stat label="Cache write" value={num(tok.cacheWrite)} />
          <Stat label="Uncached input" value={num(tok.uncached)} />
          <Stat label="Turns with tokens" value={num(tok.turns)} />
        </div>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold">Per turn</h2>
        <div className="overflow-x-auto rounded-xl border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-xs uppercase tracking-wide text-gray-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">When</th>
                <th className="px-3 py-2 text-left font-medium">Prompt</th>
                <th className="px-3 py-2 text-left font-medium">Model</th>
                <th className="px-3 py-2 text-right font-medium">Input</th>
                <th className="px-3 py-2 text-right font-medium">Output</th>
                <th className="px-3 py-2 text-right font-medium">Cache read</th>
                <th className="px-3 py-2 text-right font-medium">Cache write</th>
                <th className="px-3 py-2 text-right font-medium">Uncached</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {tokenTurns.length ? tokenTurns.map((t, i) => (
                <tr key={t.generationId || i}>
                  <td className="px-3 py-1.5 font-mono text-xs text-gray-400">{stamp(t.atWall)}</td>
                  <td className="px-3 py-1.5 tabular-nums">#{t.promptIndex == null ? '—' : t.promptIndex}</td>
                  <td className="px-3 py-1.5">{t.model || '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{num(t.input)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{num(t.output)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{num(t.cacheRead)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{num(t.cacheWrite)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{num(t.uncached)}</td>
                </tr>
              )) : (
                <tr><td colSpan={8} className="px-3 py-3 text-gray-500">No token usage yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div className="text-xs text-gray-400">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
    </div>
  );
}
