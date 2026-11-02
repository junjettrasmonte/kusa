import { useState } from 'react';
import { TotpInputs } from './TotpInputs.jsx';

export function SetupScreen({ onComplete, busy, error, setError }) {
  const [phase, setPhase] = useState('account'); // account | enroll
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [enrollment, setEnrollment] = useState(null);
  const [localBusy, setLocalBusy] = useState(false);
  const pending = busy || localBusy;

  async function startEnroll(event) {
    event.preventDefault();
    setError?.(null);
    if (password.length < 8) {
      setError?.('Password must be at least 8 characters');
      return;
    }
    if (password !== confirm) {
      setError?.('Passwords do not match');
      return;
    }
    setLocalBusy(true);
    try {
      const res = await fetch('/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setEnrollment(data);
      setPhase('enroll');
    } catch (err) {
      setError?.(err?.message || String(err));
    } finally {
      setLocalBusy(false);
    }
  }

  async function verifyTotp(code) {
    setError?.(null);
    setLocalBusy(true);
    try {
      const res = await fetch('/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.trim(),
          password,
          totpSecret: enrollment?.totpSecret,
          totpCode: code,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onComplete?.(data);
    } catch (err) {
      setError?.(err?.message || String(err));
    } finally {
      setLocalBusy(false);
    }
  }

  if (phase === 'enroll') {
    return (
      <div className="flex h-full min-h-screen flex-col items-center justify-center bg-gradient-to-b from-gray-950 via-gray-900 to-emerald-950/30 px-6">
        <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-950/80 p-6 text-center shadow-xl">
          <h2 className="text-base font-medium text-gray-100">Set up authenticator</h2>
          <p className="mt-1 text-sm text-gray-500">
            Scan this QR code, then enter the 6-digit code.
          </p>
          {enrollment?.qrDataUrl ? (
            <img
              src={enrollment.qrDataUrl}
              alt="TOTP QR code"
              className="mx-auto mt-4 h-48 w-48 rounded-lg bg-white p-2"
            />
          ) : null}
          {enrollment?.totpSecret ? (
            <p className="mt-3 break-all font-mono text-xs text-gray-500">
              {enrollment.totpSecret}
            </p>
          ) : null}
          <div className="mt-5">
            <TotpInputs onComplete={verifyTotp} busy={pending} />
          </div>
          {error ? <p className="mt-3 text-sm text-rose-400">{error}</p> : null}
          <button
            type="button"
            onClick={() => {
              setPhase('account');
              setEnrollment(null);
              setError?.(null);
            }}
            disabled={pending}
            className="mt-5 text-sm text-gray-500 hover:text-gray-300 disabled:opacity-50"
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center bg-gradient-to-b from-gray-950 via-gray-900 to-emerald-950/30 px-6">
      <form
        onSubmit={startEnroll}
        className="w-full max-w-sm rounded-2xl border border-gray-800 bg-gray-950/80 p-6 shadow-xl"
      >
        <div className="mb-5 text-center">
          <img src="./favicon.svg" alt="" className="mx-auto mb-3 h-12 w-12" />
          <h1 className="font-serif text-3xl text-gray-50">Kusă</h1>
          <p className="mt-2 text-sm text-gray-500">Create the console admin account</p>
        </div>
        <label className="block text-xs font-medium text-gray-400">
          Username
          <input
            type="text"
            autoComplete="username"
            value={username}
            disabled={pending}
            onChange={(event) => setUsername(event.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-emerald-500"
            required
          />
        </label>
        <label className="mt-3 block text-xs font-medium text-gray-400">
          Password
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            disabled={pending}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-emerald-500"
            required
            minLength={8}
          />
        </label>
        <label className="mt-3 block text-xs font-medium text-gray-400">
          Confirm password
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            disabled={pending}
            onChange={(event) => setConfirm(event.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-emerald-500"
            required
            minLength={8}
          />
        </label>
        <button
          type="submit"
          disabled={pending || !username.trim() || !password || !confirm}
          className="mt-5 w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? 'Working…' : 'Continue to 2FA'}
        </button>
        {error ? <p className="mt-3 text-sm text-rose-400">{error}</p> : null}
      </form>
    </div>
  );
}
