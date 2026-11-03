export function ServeDownScreen({ onRetry, busy }) {
  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center bg-gradient-to-b from-gray-950 via-gray-900 to-amber-950/30 px-6 text-center">
      <img src="/favicon.svg" alt="" className="mb-6 h-14 w-14 opacity-90" />
      <h1 className="font-serif text-4xl tracking-tight text-gray-50">Kusă</h1>
      <p className="mt-3 max-w-md text-sm text-gray-400">
        The console shell is ready, but the local server is not running.
      </p>
      <div className="mt-8 w-full max-w-md rounded-2xl border border-gray-800 bg-gray-950/80 p-5 text-left shadow-xl">
        <p className="text-sm font-medium text-gray-200">Start the server</p>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-gray-400">
          <li>Open a terminal in your workspace</li>
          <li>
            Run{' '}
            <code className="rounded bg-gray-900 px-1.5 py-0.5 text-emerald-300">kusa serve</code>
          </li>
          <li>Return here — this page retries automatically</li>
        </ol>
        <pre className="mt-4 overflow-x-auto rounded-lg border border-gray-800 bg-black/40 p-3 text-xs text-emerald-200/90">
          kusa serve
        </pre>
        <button
          type="button"
          onClick={onRetry}
          disabled={busy}
          className="mt-4 w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Checking…' : 'Retry connection'}
        </button>
      </div>
    </div>
  );
}
