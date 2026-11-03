/**
 * Dev Tools › Live Chat — browser-native voice providers, models, and offline prefs.
 * No Pipecat bot start/stop.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  filterVoicesByGender,
  KOKORO_VOICES,
  LIVE_CHAT_GENDERS,
} from '#features/live-chat/voices.mjs';
import {
  detectVoiceCapabilities,
  PROVIDER_LABELS,
  VOICE_MODEL_CATALOG,
  VoiceModelManager,
} from './voiceClient.js';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

function emptyPrefs() {
  return {
    sttProvider: 'whisper',
    ttsProvider: 'kokoro',
    vadProvider: 'silero',
    offlineOnly: true,
    language: 'en',
    autoSpeak: true,
    interruptible: true,
    speechRate: 1,
    whisperModel: 'onnx-community/whisper-tiny.en',
    gender: 'any',
    voice: 'af_heart',
    expressiveness: 'balanced',
  };
}

function prefsFromApi(raw) {
  const base = emptyPrefs();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    offlineOnly: raw.offlineOnly !== false,
    autoSpeak: raw.autoSpeak !== false,
    interruptible: raw.interruptible !== false,
  };
}

function Select({ label, value, onChange, options, disabled }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-gray-400">
      <span>{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-xs text-gray-100"
      >
        {options.map((opt) => (
          <option key={opt.id} value={opt.id}>{opt.label}</option>
        ))}
      </select>
    </label>
  );
}

export function LiveChatPanel({ canPersist = false }) {
  const [prefs, setPrefs] = useState(emptyPrefs);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saveNote, setSaveNote] = useState('');
  const [caps, setCaps] = useState(null);
  const [models, setModels] = useState([]);
  const [modelNote, setModelNote] = useState('');
  const modelManager = useMemo(() => new VoiceModelManager(VOICE_MODEL_CATALOG), []);

  const voiceOptions = useMemo(() => {
    return filterVoicesByGender(KOKORO_VOICES, prefs.gender);
  }, [prefs.gender]);

  const refresh = useCallback(async () => {
    if (!canPersist) return;
    setBusy(true);
    try {
      const nextPrefs = await api('/live-chat/settings');
      setPrefs(prefsFromApi(nextPrefs));
      setLoadError(null);
      await modelManager.refresh();
      setModels(modelManager.listModels());
    } catch (err) {
      setLoadError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }, [canPersist, modelManager]);

  useEffect(() => {
    void refresh();
    void detectVoiceCapabilities().then(setCaps).catch(() => setCaps(null));
  }, [refresh]);

  const savePrefs = useCallback(async (patch = {}) => {
    if (!canPersist) return;
    setSaveNote('');
    const nextLocal = { ...prefs, ...patch };
    setPrefs(nextLocal);
    try {
      const saved = await api('/live-chat/settings', {
        method: 'PUT',
        body: nextLocal,
      });
      setPrefs(prefsFromApi(saved));
      setSaveNote('Saved.');
    } catch (err) {
      setSaveNote(err?.message || 'Save failed');
    }
  }, [canPersist, prefs]);

  const downloadModel = useCallback(async (id) => {
    setModelNote(`Downloading ${id}…`);
    try {
      await modelManager.download(id);
      setModels(modelManager.listModels());
      setModelNote(`Ready: ${id}`);
    } catch (err) {
      setModelNote(err?.message || String(err));
      setModels(modelManager.listModels());
    }
  }, [modelManager]);

  const removeModel = useCallback(async (id) => {
    await modelManager.remove(id);
    setModels(modelManager.listModels());
    setModelNote(`Removed marker for ${id}`);
  }, [modelManager]);

  const sttOptions = Object.entries(PROVIDER_LABELS.stt).map(([id, label]) => ({ id, label }));
  const ttsOptions = Object.entries(PROVIDER_LABELS.tts).map(([id, label]) => ({ id, label }));
  const vadOptions = Object.entries(PROVIDER_LABELS.vad).map(([id, label]) => ({ id, label }));

  return (
    <div className="space-y-4 text-sm text-gray-300">
      <div>
        <h2 className="text-base font-semibold text-gray-100">Live Chat — browser voice</h2>
        <p className="mt-1 text-xs text-gray-500">
          Microphone, STT, VAD and TTS run in the PWA. Agent turns still use this chat’s
          Kusă model and tools via <code className="text-gray-400">/kusa/chat</code>.
          No separate voice bot or WebRTC to WSL.
        </p>
      </div>

      {loadError ? (
        <p className="text-xs text-amber-400">{loadError}</p>
      ) : null}

      <section className="space-y-2 rounded-lg border border-gray-800 bg-gray-950/50 p-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Providers</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <Select
            label="Speech-to-text"
            value={prefs.sttProvider}
            disabled={!canPersist || busy}
            options={sttOptions}
            onChange={(sttProvider) => void savePrefs({ sttProvider })}
          />
          <Select
            label="Text-to-speech"
            value={prefs.ttsProvider}
            disabled={!canPersist || busy}
            options={ttsOptions}
            onChange={(ttsProvider) => void savePrefs({ ttsProvider })}
          />
          <Select
            label="Voice activity"
            value={prefs.vadProvider}
            disabled={!canPersist || busy}
            options={vadOptions}
            onChange={(vadProvider) => void savePrefs({ vadProvider })}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Select
            label="Gender filter"
            value={prefs.gender}
            disabled={!canPersist || busy}
            options={LIVE_CHAT_GENDERS.map((g) => ({ id: g, label: g }))}
            onChange={(gender) => {
              const catalog = filterVoicesByGender(KOKORO_VOICES, gender);
              const keep = catalog.some((v) => v.id === prefs.voice)
                ? prefs.voice
                : (catalog[0]?.id || 'af_heart');
              void savePrefs({ gender, voice: keep });
            }}
          />
          <Select
            label="TTS voice"
            value={prefs.voice}
            disabled={!canPersist || busy}
            options={voiceOptions.map((v) => ({ id: v.id, label: v.label }))}
            onChange={(voice) => void savePrefs({ voice })}
          />
          <Select
            label="Whisper model"
            value={prefs.whisperModel?.includes('whisper-tiny')
              ? 'onnx-community/whisper-tiny.en'
              : (prefs.whisperModel || 'onnx-community/whisper-tiny.en')}
            disabled={!canPersist || busy || prefs.sttProvider !== 'whisper'}
            options={[
              { id: 'onnx-community/whisper-tiny.en', label: 'Tiny EN (bundled)' },
            ]}
            onChange={(whisperModel) => void savePrefs({ whisperModel })}
          />
        </div>
        <label className="flex flex-col gap-1 text-[11px] text-gray-400">
          <span>Speech rate ({prefs.speechRate})</span>
          <input
            type="range"
            min="0.5"
            max="2"
            step="0.05"
            value={prefs.speechRate}
            disabled={!canPersist || busy}
            onChange={(e) => setPrefs((p) => ({ ...p, speechRate: Number(e.target.value) }))}
            onMouseUp={() => void savePrefs({ speechRate: prefs.speechRate })}
            onTouchEnd={() => void savePrefs({ speechRate: prefs.speechRate })}
            className="accent-emerald-500"
          />
        </label>
        <div className="flex flex-wrap gap-4 text-[11px] text-gray-400">
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={prefs.offlineOnly}
              disabled={!canPersist || busy}
              onChange={(e) => void savePrefs({ offlineOnly: e.target.checked })}
            />
            Offline-only (no cloud Speech APIs)
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={prefs.autoSpeak}
              disabled={!canPersist || busy}
              onChange={(e) => void savePrefs({ autoSpeak: e.target.checked })}
            />
            Auto-speak replies
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={prefs.interruptible}
              disabled={!canPersist || busy}
              onChange={(e) => void savePrefs({ interruptible: e.target.checked })}
            />
            Interruptible speech
          </label>
        </div>
        {saveNote ? <p className="text-[11px] text-emerald-400/90">{saveNote}</p> : null}
      </section>

      <section className="space-y-2 rounded-lg border border-gray-800 bg-gray-950/50 p-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Browser capabilities</h3>
        {caps ? (
          <ul className="grid grid-cols-2 gap-1 text-[11px] text-gray-400 sm:grid-cols-4">
            {[
              ['WebGPU', caps.webgpu],
              ['WASM', caps.wasm],
              ['Mic', caps.getUserMedia],
              ['AudioWorklet', caps.audioWorklet],
              ['SpeechRecognition', caps.speechRecognition],
              ['SpeechSynthesis', caps.speechSynthesis],
              ['OPFS', caps.opfs],
              ['IndexedDB', caps.indexedDB],
            ].map(([label, ok]) => (
              <li key={label} className={ok ? 'text-emerald-400/90' : 'text-gray-600'}>
                {ok ? '✓' : '·'} {label}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-gray-600">Detecting…</p>
        )}
        {caps?.webgpuError && !caps.webgpu ? (
          <p className="text-[11px] text-gray-600">WebGPU: {caps.webgpuError}</p>
        ) : null}
      </section>

      <section className="space-y-2 rounded-lg border border-gray-800 bg-gray-950/50 p-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Models</h3>
          <button
            type="button"
            disabled={busy}
            onClick={() => void refresh()}
            className="rounded-md px-2 py-1 text-[11px] text-gray-400 hover:bg-gray-800 hover:text-gray-200"
          >
            Refresh
          </button>
        </div>
        <ul className="space-y-2">
          {models.map((m) => (
            <li
              key={m.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-gray-800/80 px-2 py-1.5 text-[11px]"
            >
              <div>
                <div className="text-gray-200">{m.label}</div>
                <div className="text-gray-600">{m.id} · {m.status}</div>
              </div>
              <div className="flex gap-1">
                {m.status !== 'ready' ? (
                  <button
                    type="button"
                    className="rounded-md bg-emerald-600/20 px-2 py-1 text-emerald-300 hover:bg-emerald-600/30"
                    onClick={() => void downloadModel(m.id)}
                  >
                    Check bundle
                  </button>
                ) : (
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-gray-500 hover:bg-gray-800"
                    onClick={() => void removeModel(m.id)}
                  >
                    Clear
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {modelNote ? <p className="text-[11px] text-gray-500">{modelNote}</p> : null}
        <p className="text-[11px] text-gray-600">
          Weights are bundled into the PWA under <code className="text-gray-400">/voice-models/</code>.
          From the repo: <code className="text-gray-400">npm run voice:models</code>
          (also runs before <code className="text-gray-400">npm run build</code>).
          Offline-only mode will not fall back to cloud Speech APIs or Hugging Face.
        </p>
      </section>
    </div>
  );
}
