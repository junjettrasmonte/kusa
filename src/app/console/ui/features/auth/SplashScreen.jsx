export function SplashScreen({ message = 'Starting…' }) {
  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center bg-gradient-to-b from-gray-950 via-gray-900 to-emerald-950/40 px-6 text-center">
      <img
        src="./favicon.svg"
        alt=""
        className="mb-6 h-16 w-16 opacity-90"
      />
      <h1 className="font-serif text-4xl tracking-tight text-gray-50 sm:text-5xl">Kusă</h1>
      <p className="mt-3 max-w-sm text-sm text-gray-400">{message}</p>
      <div
        className="mt-8 h-1.5 w-28 overflow-hidden rounded-full bg-gray-800"
        aria-hidden="true"
      >
        <div className="h-full w-1/2 animate-pulse rounded-full bg-emerald-500/80" />
      </div>
    </div>
  );
}
