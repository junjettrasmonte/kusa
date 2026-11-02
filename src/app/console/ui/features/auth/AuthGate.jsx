import { useCallback, useEffect, useState } from 'react';
import { SplashScreen } from './SplashScreen.jsx';
import { ServeDownScreen } from './ServeDownScreen.jsx';
import { SetupScreen } from './SetupScreen.jsx';
import { LoginScreen } from './LoginScreen.jsx';
import { TotpScreen } from './TotpScreen.jsx';

const RETRY_MS = 4000;

async function probeHealth() {
  const res = await fetch('/health', { method: 'GET', cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (!data?.ok) throw new Error('unhealthy');
  return true;
}

async function fetchStatus() {
  const res = await fetch('/auth/status', { method: 'GET', cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Splash → serve probe → setup / login / TOTP → children.
 * Works from the SW-cached shell when `kusa serve` is down.
 */
export function AuthGate({ children }) {
  const [phase, setPhase] = useState('splash'); // splash | down | setup | login | totp | ready
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await probeHealth();
    } catch {
      setPhase('down');
      setBusy(false);
      return;
    }
    try {
      const next = await fetchStatus();
      setStatus(next);
      if (next.authenticated) setPhase('ready');
      else if (next.needsSetup) setPhase('setup');
      else if (next.needsTotp) setPhase('totp');
      else setPhase('login');
    } catch (err) {
      setError(err?.message || String(err));
      setPhase('down');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (phase !== 'down') return undefined;
    const id = setInterval(() => {
      refresh();
    }, RETRY_MS);
    return () => clearInterval(id);
  }, [phase, refresh]);

  async function handleLogin({ username, password }) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.needsTotp) setPhase('totp');
      else await refresh();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleTotp(code) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/auth/totp', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await refresh();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  function handleSso(mode) {
    window.location.href = mode === 'saml' ? '/auth/saml/start' : '/auth/oidc/start';
  }

  if (phase === 'splash') {
    return <SplashScreen message="Checking local server…" />;
  }
  if (phase === 'down') {
    return <ServeDownScreen onRetry={refresh} busy={busy} />;
  }
  if (phase === 'setup') {
    return (
      <SetupScreen
        busy={busy}
        error={error}
        setError={setError}
        onComplete={() => refresh()}
      />
    );
  }
  if (phase === 'login') {
    return (
      <LoginScreen
        mode={status?.authMode || 'local'}
        onLogin={handleLogin}
        onSso={handleSso}
        busy={busy}
        error={error}
      />
    );
  }
  if (phase === 'totp') {
    return (
      <TotpScreen
        onSubmit={handleTotp}
        onBack={() => {
          setError(null);
          setPhase('login');
        }}
        busy={busy}
        error={error}
      />
    );
  }
  return children;
}
