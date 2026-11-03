/**
 * Developer Tools › Live Chat — Pipecat bot status and transport/TTS prefs.
 * When the bot is down and extensions/live-chat is ready, SetupGuide offers
 * Start (POST /live-chat/server/start). Prefs go through PUT /live-chat/settings.
 * Restart (POST /live-chat/server/restart) reloads TRANSPORT / TTS_ENGINE from prefs.
 */
import { useCallback, useEffect, useState } from 'react';
import { stamp } from '#ui/shared/lib/format.js';
import { IconButton, RefreshIcon } from '#ui/shared/IconButton.jsx';
import { SetupGuide } from '#ui/shared/SetupGuide.jsx';
import { Choice, Field } from '#ui/shared/SettingsControls.jsx';

function emptyStatus() {
  return {
    ok: false,
    checkedAt: null,
    installed: false,
    serverUp: false,
    baseUrl: 'http://127.0.0.1:7860',
    transport: 'websocket',
    tts: 'piper',
    model: null,
    strataConfigured: false,
    version: null,
    error: null,
    steps: [],
  };
}

async function api(path, { method = 'GET', body = null } = {}) {
  const res = await fetch(path, {
    method,
    headers: body != null
      ? { Accept: 'application/json', 'Content-Type': 'application/json' }
      : { Accept: 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function StatusChip({ label, value, ok }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`mt-0.5 truncate text-sm ${ok ? 'text-emerald-300' : 'text-amber-300'}`}>
        {value}
      </div>
    </div>
  );
}

export function LiveChatPanel({ canPersist = false }) {
  const [status, setStatus] = useState(emptyStatus);
  const [prefs, setPrefs] = useState({ transport: 'websocket', tts: 'piper', baseUrl: '' });
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saveNote, setSaveNote] = useState('');
  const [starting, setStarting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [startNote, setStartNote] = useState('');

  const refresh = useCallback(async () => {
    if (!canPersist) return;
    setBusy(true);
    try {
      const [nextStatus, nextPrefs] = await Promise.all([
        api('/live-chat'),
        api('/live-chat/settings'),
      ]);
      setStatus(nextStatus || emptyStatus());
      setPrefs({
        transport: nextPrefs?.transport === 'webrtc' ? 'webrtc' : 'websocket',
        tts: nextPrefs?.tts === 'kokoro' ? 'kokoro' : 'piper',
        baseUrl: typeof nextPrefs?.baseUrl === 'string' ? nextPrefs.baseUrl : '',
      });
      setLoadError(null);
    } catch (err) {
      setLoadError(err?.message || String(err));
      setStatus(emptyStatus());
    } finally {
      setBusy(false);
    }
  }, [canPersist]);

  const startBot = useCallback(async () => {
    if (!canPersist || starting || restarting) return;
    setStarting(true);
    setStartNote('');
    try {
      const result = await api('/live-chat/server/start', { method: 'POST' });
      if (result?.status) setStatus(result.status);
      else await refresh();
      setStartNote(result?.alreadyUp
        ? 'Live Chat bot was already up. Use Restart to apply transport/TTS changes.'
        : 'Live Chat bot started.');
    } catch (err) {
      const data = err?.data;
      if (data?.status) setStatus(data.status);
      else await refresh();
      setStartNote(data?.error || err?.message || 'Could not start Live Chat bot');
    } finally {
      setStarting(false);
    }
  }, [canPersist, starting, restarting, refresh]);

  const restartBot = useCallback(async () => {
    if (!canPersist || starting || restarting) return;
    setRestarting(true);
    setStartNote('');
    setSaveNote('');
    try {
      const result = await api('/live-chat/server/restart', { method: 'POST' });
      if (result?.status) setStatus(result.status);
      else await refresh();
      const tts = result?.status?.tts || prefs.tts;
      const transport = result?.status?.transport || prefs.transport;
      setStartNote(result?.ok
        ? `Live Chat bot restarted (${transport} / ${tts}).`
        : (result?.error || 'Restart finished with errors — check status.'));
    } catch (err) {
      const data = err?.data;
      if (data?.status) setStatus(data.status);
      else await refresh();
      setStartNote(data?.error || err?.message || 'Could not restart Live Chat bot');
    } finally {
      setRestarting(false);
    }
  }, [canPersist, starting, restarting, refresh, prefs.tts, prefs.transport]);

  useEffect(() => {
    refresh();
    if (!canPersist) return undefined;
    const id = setInterval(refresh, 8000);
    return () => clearInterval(id);
  }, [canPersist, refresh]);

  async function savePrefs(patch) {
    if (!canPersist || busy) return;
    setBusy(true);
    setSaveNote('');
    try {
      const next = await api('/live-chat/settings', {
        method: 'PUT',
        body: { ...prefs, ...patch },
      });
      setPrefs({
        transport: next?.transport === 'webrtc' ? 'webrtc' : 'websocket',
        tts: next?.tts === 'kokoro' ? 'kokoro' : 'piper',
        baseUrl: typeof next?.baseUrl === 'string' ? next.baseUrl : '',
      });
      setSaveNote('Saved. Click Restart bot to apply transport/TTS on the running process.');
      await refresh();
    } catch (err) {
      setSaveNote(err?.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  if (!canPersist) {
    return (
      <div className="p-4 text-sm text-gray-500">
        Open the console over HTTP (<code className="text-sky-300">kusa serve</code>) to manage Live Chat.
      </div>
    );
  }

  const s = status;
  const prefsMismatch = Boolean(
    s.serverUp
    && (
      (s.tts && s.tts !== prefs.tts)
      || (s.transport && s.transport !== prefs.transport)
    ),
  );
  const botBusy = starting || restarting;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-lg font-semibold text-gray-100">Live Chat</h1>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-gray-500">
              {s.checkedAt ? `Checked ${stamp(s.checkedAt)}` : 'Not checked yet'}
              {' · live'}
            </span>
            <IconButton label="Refresh" icon={RefreshIcon} disabled={busy || botBusy} onClick={refresh} />
          </div>
        </div>
        <p className="mb-3 text-xs text-gray-500">
          Voice pipeline via{' '}
          <a
            className="text-sky-300 hover:underline"
            href="https://github.com/pipecat-ai/pipecat"
            target="_blank"
            rel="noreferrer"
          >
            Pipecat
          </a>
          {' '}(Silero → Faster Whisper → Strata → Piper/Kokoro). Start the bot from{' '}
          <code className="text-sky-300">extensions/live-chat</code>, then use the empty-composer{' '}
          <strong className="font-medium text-gray-300">Live voice</strong> button in a chat session.
          Proxied at <code className="text-sky-300">{s.baseUrl}</code>.
        </p>
        {loadError ? (
          <p className="mb-3 text-xs text-amber-400">Live check failed: {loadError}</p>
        ) : null}

        <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 text-sm">
          <StatusChip label="Server" value={s.serverUp ? 'up' : 'down'} ok={s.serverUp} />
          <StatusChip
            label="Transport"
            value={s.transport || prefs.transport}
            ok={s.serverUp && (!s.transport || s.transport === prefs.transport)}
          />
          <StatusChip
            label="TTS"
            value={s.tts || prefs.tts}
            ok={s.serverUp && (!s.tts || s.tts === prefs.tts)}
          />
          <StatusChip
            label="Strata"
            value={s.strataConfigured ? (s.model || 'configured') : 'not set'}
            ok={Boolean(s.strataConfigured)}
          />
        </div>

        {s.serverUp ? (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                prefsMismatch
                  ? 'bg-amber-600 text-white hover:bg-amber-500'
                  : 'bg-gray-800 text-gray-100 hover:bg-gray-700'
              } disabled:opacity-50`}
              disabled={busy || botBusy}
              onClick={() => { void restartBot(); }}
            >
              {restarting ? 'Restarting…' : 'Restart bot'}
            </button>
            {prefsMismatch ? (
              <span className="text-xs text-amber-400">
                Running {s.transport}/{s.tts} — prefs are {prefs.transport}/{prefs.tts}. Restart to apply.
              </span>
            ) : (
              <span className="text-xs text-gray-500">
                Reloads the process with saved transport/TTS (and Strata) settings.
              </span>
            )}
          </div>
        ) : null}

        {!s.ok ? (
          <SetupGuide
            title={s.installed ? 'Start the Live Chat bot' : 'Install Live Chat'}
            summary={s.error}
            steps={s.steps?.length ? s.steps : [
              'cd extensions/live-chat && uv sync',
              'export STRATA_BASE_URL=…',
              'uv run python -m live_chat',
              'curl http://127.0.0.1:7860/health',
            ]}
            action={s.installed ? {
              label: 'Start Live Chat bot',
              busyLabel: 'Starting Live Chat bot…',
              busy: starting,
              disabled: busy || restarting,
              onClick: startBot,
            } : null}
            footnote={
              startNote
                || 'After installing or starting the bot, click Refresh — this panel polls /live-chat while open.'
            }
          />
        ) : null}

        {s.ok && startNote ? (
          <p className="mb-3 text-xs text-gray-400">{startNote}</p>
        ) : null}
      </section>

      <section className="rounded-xl border border-gray-800 bg-gray-950/40 p-4">
        <h2 className="mb-2 text-base font-semibold text-gray-100">Preferences</h2>
        <p className="mb-3 text-xs text-gray-500">
          Saved for session mint and for bot spawn/restart (
          <code className="text-sky-300">TRANSPORT</code> / <code className="text-sky-300">TTS_ENGINE</code>
          ). Use <strong className="font-medium text-gray-300">Restart bot</strong> after changing these.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <span className="mb-1 block text-sm text-gray-300">Transport</span>
            <div className="flex flex-wrap gap-2">
              <Choice
                label="WebSocket"
                active={prefs.transport === 'websocket'}
                disabled={busy || botBusy}
                onClick={() => {
                  setPrefs((p) => ({ ...p, transport: 'websocket' }));
                  void savePrefs({ transport: 'websocket' });
                }}
              />
              <Choice
                label="WebRTC"
                active={prefs.transport === 'webrtc'}
                disabled={busy || botBusy}
                onClick={() => {
                  setPrefs((p) => ({ ...p, transport: 'webrtc' }));
                  void savePrefs({ transport: 'webrtc' });
                }}
              />
            </div>
          </div>
          <div>
            <span className="mb-1 block text-sm text-gray-300">TTS</span>
            <div className="flex flex-wrap gap-2">
              <Choice
                label="Piper"
                active={prefs.tts === 'piper'}
                disabled={busy || botBusy}
                onClick={() => {
                  setPrefs((p) => ({ ...p, tts: 'piper' }));
                  void savePrefs({ tts: 'piper' });
                }}
              />
              <Choice
                label="Kokoro"
                active={prefs.tts === 'kokoro'}
                disabled={busy || botBusy}
                onClick={() => {
                  setPrefs((p) => ({ ...p, tts: 'kokoro' }));
                  void savePrefs({ tts: 'kokoro' });
                }}
              />
            </div>
          </div>
        </div>
        <div className="mt-3">
          <Field
            label="Bot base URL override (optional)"
            value={prefs.baseUrl}
            placeholder="http://127.0.0.1:7860"
            disabled={busy || botBusy}
            onCommit={(baseUrl) => {
              setPrefs((p) => ({ ...p, baseUrl }));
              void savePrefs({ baseUrl });
            }}
          />
        </div>
        {saveNote ? <p className="mt-2 text-[11px] text-gray-500">{saveNote}</p> : null}
      </section>
    </div>
  );
}
