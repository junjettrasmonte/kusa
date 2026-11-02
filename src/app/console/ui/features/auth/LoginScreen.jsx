import { useState } from 'react';

export function LoginScreen({
  mode = 'local',
  onLogin,
  onSso,
  busy,
  error,
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const sso = mode === 'oidc' || mode === 'saml';

  function submit(event) {
    event.preventDefault();
    if (sso) {
      onSso?.(mode);
      return;
    }
    onLogin?.({ username: username.trim(), password });
  }

  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center bg-gradient-to-b from-gray-950 via-gray-900 to-emerald-950/30 px-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-gray-800 bg-gray-950/80 p-6 shadow-xl"
      >
        <div className="mb-5 text-center">
          <img src="./favicon.svg" alt="" className="mx-auto mb-3 h-12 w-12" />
          <h1 className="font-serif text-3xl text-gray-50">Kusă</h1>
          <p className="mt-2 text-sm text-gray-500">Sign in to the console</p>
        </div>

        {sso ? (
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? 'Redirecting…' : mode === 'oidc' ? 'Sign in with OIDC' : 'Sign in with SAML'}
          </button>
        ) : (
          <>
            <label className="block text-xs font-medium text-gray-400">
              Username
              <input
                type="text"
                autoComplete="username"
                value={username}
                disabled={busy}
                onChange={(event) => setUsername(event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-emerald-500"
              />
            </label>
            <label className="mt-3 block text-xs font-medium text-gray-400">
              Password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                disabled={busy}
                onChange={(event) => setPassword(event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-emerald-500"
              />
            </label>
            <button
              type="submit"
              disabled={busy || !username.trim() || !password}
              className="mt-5 w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Signing in…' : 'Continue'}
            </button>
          </>
        )}
        {error ? <p className="mt-3 text-sm text-rose-400">{error}</p> : null}
      </form>
    </div>
  );
}
