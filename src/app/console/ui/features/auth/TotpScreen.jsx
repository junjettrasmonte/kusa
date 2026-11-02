import { TotpInputs } from './TotpInputs.jsx';

/**
 * Full-page 6-digit TOTP challenge.
 */
export function TotpScreen({
  title = 'Two-factor authentication',
  subtitle = 'Enter the 6-digit code from your authenticator app.',
  onSubmit,
  onBack,
  busy,
  error,
}) {
  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center bg-gradient-to-b from-gray-950 via-gray-900 to-emerald-950/30 px-6">
      <div className="w-full max-w-sm text-center">
        <img src="./favicon.svg" alt="" className="mx-auto mb-5 h-12 w-12" />
        <h1 className="font-serif text-3xl text-gray-50">Kusă</h1>
        <h2 className="mt-4 text-base font-medium text-gray-200">{title}</h2>
        <p className="mt-1 text-sm text-gray-500">{subtitle}</p>
        <div className="mt-6">
          <TotpInputs onComplete={onSubmit} busy={busy} />
        </div>
        {error ? <p className="mt-3 text-sm text-rose-400">{error}</p> : null}
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            disabled={busy}
            className="mt-6 text-sm text-gray-500 hover:text-gray-300 disabled:opacity-50"
          >
            Back
          </button>
        ) : null}
      </div>
    </div>
  );
}
