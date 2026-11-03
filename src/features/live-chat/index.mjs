/**
 * Live Chat — browser-native offline voice prefs + retired Pipecat helpers.
 *
 * Voice STT/TTS/VAD now run in the PWA. Settings are stored in monitor
 * `liveChat`. Pipecat bot spawn / WS / RTC helpers remain exported for
 * compatibility but status reports `mode: 'browser'` and `serverUp: true`
 * so the Live button no longer waits on an external bot.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAgentEndpoint } from '#features/agent/openai-loop.mjs';
import {
  readChatSession,
  writeChatSession,
  KUSA_HARNESS,
} from '#features/chat/data/chat-store.mjs';
import { laneKey } from '#features/monitor/lib.mjs';
import { pkgRoot } from '#shared/lib/pkg.mjs';
import { spawnDetached } from '#shared/lib/spawn-detached.mjs';

import {
  expressivenessSpeed,
  normalizeLiveChatExpressiveness,
  normalizeLiveChatGender,
  resolveVoiceId,
} from '#features/live-chat/voices.mjs';

export const DEFAULT_LIVE_CHAT_BASE_URL = 'http://127.0.0.1:7860';
export const LIVE_CHAT_TRANSPORTS = ['websocket', 'webrtc'];
export const LIVE_CHAT_TTS = ['piper', 'kokoro'];
export const LIVE_CHAT_STT_PROVIDERS = ['whisper', 'webSpeech', 'mock'];
export const LIVE_CHAT_TTS_PROVIDERS = ['kokoro', 'browserSpeech', 'mock'];
export const LIVE_CHAT_VAD_PROVIDERS = ['silero', 'energy', 'mock'];
export const DEFAULT_WHISPER_MODEL = 'onnx-community/whisper-tiny.en';
export {
  LIVE_CHAT_EXPRESSIVENESS,
  LIVE_CHAT_GENDERS,
  KOKORO_VOICES,
  PIPER_VOICES,
  expressivenessSpeed,
  filterVoicesByGender,
  normalizeLiveChatExpressiveness,
  normalizeLiveChatGender,
  resolveVoiceId,
  voicesForEngine,
} from '#features/live-chat/voices.mjs';

const LIVE_CHAT_TIMEOUT_MS = 4000;
const LIVE_CHAT_STATUS_CACHE_MS = 2000;
let liveChatStatusCache = { at: 0, baseUrl: '', value: null };

export const LIVE_CHAT_INSTALL_STEPS = [
  'Open a chat session and click Live — voice runs in the browser',
  'First use downloads Whisper / Kokoro / Silero models (Dev Tools › Live Chat)',
  'Prefer Chrome/Edge with WebGPU for faster local inference; WASM works as fallback',
  'Enable Offline-only in Live Chat settings to block cloud SpeechRecognition / SpeechSynthesis',
];

export const LIVE_CHAT_SERVER_STEPS = LIVE_CHAT_INSTALL_STEPS;

function pickProvider(raw, allowed, fallback) {
  const v = String(raw ?? '').trim();
  return allowed.includes(v) ? v : fallback;
}

function normalizeSpeechRate(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(2, Math.max(0.5, n));
}

export function resolveLiveChatBaseUrl(env = process.env, settings = null) {
  const fromSettings = settings?.liveChat?.baseUrl;
  const raw = String(
    (typeof fromSettings === 'string' && fromSettings.trim())
      || env.LIVE_CHAT_BASE_URL
      || '',
  ).trim();
  if (!raw) return DEFAULT_LIVE_CHAT_BASE_URL;
  return raw.replace(/\/+$/, '');
}

export function normalizeLiveChatTransport(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return LIVE_CHAT_TRANSPORTS.includes(v) ? v : 'websocket';
}

export function normalizeLiveChatTts(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return LIVE_CHAT_TTS.includes(v) ? v : 'piper';
}

/**
 * Normalize the liveChat block stored in monitor settings.
 * Migrates legacy Pipecat prefs (`tts: piper|kokoro`, transport) into browser providers.
 * @param {unknown} raw
 */
export function normalizeLiveChatSettings(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const baseUrl = typeof src.baseUrl === 'string' ? src.baseUrl.trim().replace(/\/+$/, '') : '';
  // Legacy engine field — map piper → kokoro for browser TTS.
  const legacyTts = normalizeLiveChatTts(src.tts);
  const ttsProvider = pickProvider(
    src.ttsProvider,
    LIVE_CHAT_TTS_PROVIDERS,
    legacyTts === 'kokoro' || !src.ttsProvider ? 'kokoro' : 'kokoro',
  );
  const sttProvider = pickProvider(src.sttProvider, LIVE_CHAT_STT_PROVIDERS, 'whisper');
  const vadProvider = pickProvider(src.vadProvider, LIVE_CHAT_VAD_PROVIDERS, 'silero');
  const gender = normalizeLiveChatGender(src.gender);
  const expressiveness = normalizeLiveChatExpressiveness(src.expressiveness);
  const voiceEngine = ttsProvider === 'kokoro' ? 'kokoro' : 'kokoro';
  const voice = resolveVoiceId(voiceEngine, {
    gender,
    preferred: typeof src.voice === 'string' ? src.voice : '',
  });
  // Only tiny is bundled in the PWA; clamp legacy base selections.
  const whisperRaw = typeof src.whisperModel === 'string' ? src.whisperModel.trim() : '';
  const whisperModel = whisperRaw.includes('whisper-base')
    ? DEFAULT_WHISPER_MODEL
    : (whisperRaw || DEFAULT_WHISPER_MODEL);
  const language = typeof src.language === 'string' && src.language.trim()
    ? src.language.trim()
    : 'en';
  return {
    // Legacy fields retained for older UI/tests; unused by browser voice path.
    transport: normalizeLiveChatTransport(src.transport),
    tts: ttsProvider === 'kokoro' ? 'kokoro' : legacyTts,
    baseUrl,
    gender,
    voice,
    expressiveness,
    // Browser-native providers
    sttProvider,
    ttsProvider,
    vadProvider,
    offlineOnly: src.offlineOnly !== false,
    language,
    autoSpeak: src.autoSpeak !== false,
    interruptible: src.interruptible !== false,
    speechRate: normalizeSpeechRate(src.speechRate),
    whisperModel,
    mode: 'browser',
  };
}

export function emptyLiveChatStatus(error = null) {
  const failed = Boolean(error);
  return {
    ok: !failed,
    checkedAt: Date.now(),
    installed: !failed,
    serverUp: !failed,
    mode: 'browser',
    baseUrl: DEFAULT_LIVE_CHAT_BASE_URL,
    transport: 'browser',
    tts: 'kokoro',
    model: null,
    modelConfigured: !failed,
    wsPath: null,
    rtcPath: null,
    version: 'browser',
    error: error || null,
    steps: LIVE_CHAT_INSTALL_STEPS,
    root: null,
  };
}

/** Host + port for spawning the bot from LIVE_CHAT_BASE_URL. */
export function liveChatListenFromBaseUrl(baseUrl = resolveLiveChatBaseUrl()) {
  try {
    const u = new URL(baseUrl);
    const host = u.hostname || '127.0.0.1';
    const port = u.port
      ? Number(u.port)
      : (u.protocol === 'https:' ? 443 : 80);
    return {
      host: host === 'localhost' ? '127.0.0.1' : host,
      port: Number.isFinite(port) && port > 0 ? port : 7860,
    };
  } catch {
    return { host: '127.0.0.1', port: 7860 };
  }
}

/**
 * On-disk home for the Pipecat package (`extensions/live-chat`).
 * Prefers the consumer workspace copy, then this package's shipped folder.
 */
export function resolveLiveChatExtRoot(workspaceRoot = null) {
  const candidates = [
    workspaceRoot ? join(workspaceRoot, 'extensions', 'live-chat') : null,
    join(pkgRoot, 'extensions', 'live-chat'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (
      existsSync(join(dir, 'pyproject.toml'))
      || existsSync(join(dir, 'live_chat', '__main__.py'))
    ) {
      return dir;
    }
  }
  return null;
}

function whichUv() {
  const probe = spawnSync('uv', ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 3000,
  });
  if (probe.error && probe.error.code === 'ENOENT') return false;
  return probe.status === 0 || Boolean((probe.stdout || probe.stderr || '').trim());
}

/**
 * Detect whether the Live Chat extension can be started (venv python or uv + tree).
 */
export function probeLiveChatInstall(workspaceRoot = null) {
  const root = resolveLiveChatExtRoot(workspaceRoot);
  if (!root) {
    return { installed: false, runner: null, python: null, root: null };
  }
  const venvPy = process.platform === 'win32'
    ? join(root, '.venv', 'Scripts', 'python.exe')
    : join(root, '.venv', 'bin', 'python');
  if (existsSync(venvPy)) {
    return { installed: true, runner: 'venv', python: venvPy, root };
  }
  if (whichUv() && existsSync(join(root, 'pyproject.toml'))) {
    return { installed: true, runner: 'uv', python: null, root };
  }
  return {
    installed: false,
    runner: null,
    python: null,
    root,
    needsSync: existsSync(join(root, 'pyproject.toml')),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function liveChatPidPath(extRoot) {
  return join(extRoot, '.run', 'live-chat.pid');
}

function writeLiveChatPid(extRoot, pid) {
  if (!extRoot || !pid) return;
  try {
    const dir = join(extRoot, '.run');
    mkdirSync(dir, { recursive: true });
    writeFileSync(liveChatPidPath(extRoot), `${pid}\n`, 'utf8');
  } catch { /* ignore */ }
}

function readLiveChatPid(extRoot) {
  if (!extRoot) return null;
  try {
    const raw = readFileSync(liveChatPidPath(extRoot), 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function clearLiveChatPid(extRoot) {
  if (!extRoot) return;
  try { unlinkSync(liveChatPidPath(extRoot)); } catch { /* ignore */ }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort: PIDs listening on TCP port (Unix lsof / fuser). */
function pidsListeningOnPort(port) {
  const n = Number(port);
  if (!Number.isFinite(n) || n <= 0) return [];
  const found = new Set();
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${n}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 3000,
  });
  if (!lsof.error && lsof.status === 0) {
    for (const line of String(lsof.stdout || '').split(/\s+/)) {
      const pid = Number.parseInt(line, 10);
      if (Number.isFinite(pid) && pid > 0) found.add(pid);
    }
  }
  if (!found.size) {
    const fuser = spawnSync('fuser', [`${n}/tcp`], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    });
    const blob = `${fuser.stdout || ''}\n${fuser.stderr || ''}`;
    for (const m of blob.matchAll(/\b(\d+)\b/g)) {
      const pid = Number.parseInt(m[1], 10);
      if (Number.isFinite(pid) && pid > 0) found.add(pid);
    }
  }
  return [...found];
}

function signalPid(pid, signal = 'SIGTERM') {
  if (!pid) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    // Session leader / process group (setsid spawn).
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function llmEnvFromSettings(settings) {
  if (!settings || typeof settings !== 'object') return {};
  try {
    const endpoint = resolveAgentEndpoint(settings);
    const env = {};
    if (endpoint?.baseUrl) {
      const base = String(endpoint.baseUrl).replace(/\/+$/, '');
      env.LLM_BASE_URL = base;
      env.STRATA_BASE_URL = base; // alias for older bot processes
    }
    if (endpoint?.apiKey) {
      env.LLM_API_KEY = String(endpoint.apiKey);
      env.STRATA_API_KEY = String(endpoint.apiKey);
    }
    if (endpoint?.model) {
      env.LLM_MODEL = String(endpoint.model);
      env.STRATA_MODEL = String(endpoint.model);
    }
    return env;
  } catch {
    return {};
  }
}

/** Coalesce concurrent Start / Restart clicks. */
let liveChatStartInFlight = null;
let liveChatStopInFlight = null;

/**
 * Spawn the Pipecat bot detached from extensions/live-chat.
 * Uses setsid (Unix) so `kusa serve --live` restarts do not kill the bot.
 */
async function spawnLiveChatProcess({
  install,
  host,
  port,
  transport,
  tts,
  settings = null,
  transcriptCallbackUrl = null,
}) {
  const prefs = normalizeLiveChatSettings(settings?.liveChat);
  const engine = normalizeLiveChatTts(tts || prefs.tts);
  const voice = resolveVoiceId(engine, {
    gender: prefs.gender,
    preferred: prefs.voice,
  });
  const env = {
    ...process.env,
    ...llmEnvFromSettings(settings),
    LIVE_CHAT_HOST: host,
    LIVE_CHAT_PORT: String(port),
    TRANSPORT: normalizeLiveChatTransport(transport || prefs.transport),
    TTS_ENGINE: engine,
    TTS_SPEED: String(expressivenessSpeed(prefs.expressiveness)),
    TTS_EXPRESSIVENESS: prefs.expressiveness,
    TTS_GENDER: prefs.gender,
  };
  if (engine === 'kokoro') env.KOKORO_VOICE = voice;
  else env.PIPER_VOICE = voice;
  if (transcriptCallbackUrl) {
    env.LIVE_CHAT_TRANSCRIPT_URL = transcriptCallbackUrl;
  }

  let command;
  let args;
  if (install.runner === 'venv' && install.python) {
    command = install.python;
    args = ['-m', 'live_chat'];
  } else if (install.runner === 'uv') {
    command = 'uv';
    args = ['run', 'python', '-m', 'live_chat'];
  } else {
    return {
      ok: false,
      pid: null,
      error: 'Live Chat bot is not installed (run uv sync in extensions/live-chat)',
    };
  }

  const spawned = await spawnDetached(command, args, { cwd: install.root, env });
  if (spawned.ok && spawned.pid) writeLiveChatPid(install.root, spawned.pid);
  return spawned;
}

/**
 * Start the local Live Chat bot when it is down. No-ops if /health already succeeds.
 * Survives `kusa serve --live` restarts; concurrent calls share one in-flight promise.
 *
 * Not `async` — must return the shared promise identity, not a wrapped one.
 */
export function startLiveChatServer(opts = {}) {
  if (!liveChatStartInFlight) {
    liveChatStartInFlight = startLiveChatServerUnlocked(opts).finally(() => {
      liveChatStartInFlight = null;
    });
  }
  return liveChatStartInFlight;
}

async function startLiveChatServerUnlocked({
  baseUrl = null,
  settings = null,
  workspaceRoot = null,
  transcriptCallbackUrl = null,
  waitMs = 30_000,
} = {}) {
  const resolved = (typeof baseUrl === 'string' && baseUrl.trim()
    ? baseUrl.trim().replace(/\/+$/, '')
    : null)
    || resolveLiveChatBaseUrl(process.env, settings);
  const rootUrl = resolved.replace(/\/+$/, '');
  const already = await liveChatFetch('/health', { baseUrl: rootUrl });
  if (already.ok) {
    const status = await collectLiveChatStatus({ force: true, baseUrl: rootUrl, settings, workspaceRoot });
    return {
      ok: true,
      started: false,
      alreadyUp: true,
      pid: null,
      error: null,
      status,
    };
  }

  const install = probeLiveChatInstall(workspaceRoot);
  if (!install.installed) {
    return {
      ok: false,
      started: false,
      alreadyUp: false,
      pid: null,
      error: install.needsSync
        ? 'Live Chat deps missing — run: cd extensions/live-chat && uv sync'
        : 'Live Chat extension not found (extensions/live-chat)',
      status: await collectLiveChatStatus({ force: true, baseUrl: rootUrl, settings, workspaceRoot }),
    };
  }

  const { host, port } = liveChatListenFromBaseUrl(rootUrl);
  const spawned = await spawnLiveChatProcess({
    install,
    host,
    port,
    settings,
    transcriptCallbackUrl,
  });
  if (!spawned.ok) {
    return {
      ok: false,
      started: false,
      alreadyUp: false,
      pid: null,
      error: spawned.error || 'failed to spawn Live Chat bot',
      status: await collectLiveChatStatus({ force: true, baseUrl: rootUrl, settings, workspaceRoot }),
    };
  }

  const deadline = Date.now() + Math.max(2000, waitMs);
  while (Date.now() < deadline) {
    await sleep(500);
    const health = await liveChatFetch('/health', { baseUrl: rootUrl });
    if (health.ok) {
      const status = await collectLiveChatStatus({ force: true, baseUrl: rootUrl, settings, workspaceRoot });
      return {
        ok: true,
        started: true,
        alreadyUp: false,
        pid: spawned.pid,
        error: null,
        status,
      };
    }
  }

  return {
    ok: false,
    started: true,
    alreadyUp: false,
    pid: spawned.pid,
    error: `Live Chat bot launched (pid ${spawned.pid || '?'}) but ${rootUrl}/health did not pass within ${waitMs}ms`,
    status: await collectLiveChatStatus({ force: true, baseUrl: rootUrl, settings, workspaceRoot }),
  };
}

/**
 * Stop the local Live Chat bot (pidfile and/or listener on the configured port).
 * Safe when the bot is already down.
 */
export function stopLiveChatServer(opts = {}) {
  if (!liveChatStopInFlight) {
    liveChatStopInFlight = stopLiveChatServerUnlocked(opts).finally(() => {
      liveChatStopInFlight = null;
    });
  }
  return liveChatStopInFlight;
}

async function stopLiveChatServerUnlocked({
  baseUrl = null,
  settings = null,
  workspaceRoot = null,
  waitMs = 8_000,
} = {}) {
  const resolved = (typeof baseUrl === 'string' && baseUrl.trim()
    ? baseUrl.trim().replace(/\/+$/, '')
    : null)
    || resolveLiveChatBaseUrl(process.env, settings);
  const rootUrl = resolved.replace(/\/+$/, '');
  const { port } = liveChatListenFromBaseUrl(rootUrl);
  const install = probeLiveChatInstall(workspaceRoot);
  const extRoot = install.root || resolveLiveChatExtRoot(workspaceRoot);

  const targets = new Set();
  const filePid = readLiveChatPid(extRoot);
  if (filePid) targets.add(filePid);
  for (const pid of pidsListeningOnPort(port)) targets.add(pid);

  if (!targets.size) {
    clearLiveChatPid(extRoot);
    const status = await collectLiveChatStatus({ force: true, baseUrl: rootUrl, settings, workspaceRoot });
    return {
      ok: true,
      stopped: false,
      alreadyDown: !status.serverUp,
      pids: [],
      error: null,
      status,
    };
  }

  for (const pid of targets) signalPid(pid, 'SIGTERM');

  const deadline = Date.now() + Math.max(1000, waitMs);
  while (Date.now() < deadline) {
    await sleep(250);
    const health = await liveChatFetch('/health', { baseUrl: rootUrl, timeoutMs: 1500 });
    if (!health.ok) break;
  }

  // Still up — escalate.
  const still = await liveChatFetch('/health', { baseUrl: rootUrl, timeoutMs: 1500 });
  if (still.ok) {
    for (const pid of targets) {
      if (pidAlive(pid)) signalPid(pid, 'SIGKILL');
    }
    for (const pid of pidsListeningOnPort(port)) signalPid(pid, 'SIGKILL');
    await sleep(400);
  }

  clearLiveChatPid(extRoot);
  const status = await collectLiveChatStatus({ force: true, baseUrl: rootUrl, settings, workspaceRoot });
  return {
    ok: !status.serverUp,
    stopped: true,
    alreadyDown: false,
    pids: [...targets],
    error: status.serverUp ? 'Live Chat bot did not exit after stop signal' : null,
    status,
  };
}

/**
 * Stop then start so TRANSPORT / TTS_ENGINE (and Kusă model) match current settings.
 */
export function restartLiveChatServer(opts = {}) {
  if (!liveChatStartInFlight) {
    liveChatStartInFlight = restartLiveChatServerUnlocked(opts).finally(() => {
      liveChatStartInFlight = null;
    });
  }
  return liveChatStartInFlight;
}

async function restartLiveChatServerUnlocked(opts = {}) {
  const stopped = await stopLiveChatServer(opts);
  if (stopped.error && stopped.status?.serverUp) {
    return {
      ok: false,
      restarted: false,
      started: false,
      alreadyUp: false,
      stopped,
      pid: null,
      error: stopped.error,
      status: stopped.status,
    };
  }
  // Ensure the listen port is free before spawn (brief grace after kill).
  await sleep(400);
  const started = await startLiveChatServerUnlocked(opts);
  return {
    ...started,
    restarted: true,
    stopped,
  };
}

/**
 * Fetch JSON from the Live Chat bot. Returns { ok, status, data, error }.
 */
export async function liveChatFetch(pathname, {
  baseUrl = resolveLiveChatBaseUrl(),
  method = 'GET',
  body = null,
  timeoutMs = LIVE_CHAT_TIMEOUT_MS,
} = {}) {
  const url = `${baseUrl.replace(/\/+$/, '')}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: body != null
        ? { 'Content-Type': 'application/json', Accept: 'application/json' }
        : { Accept: 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const message = data?.error || data?.detail || data?.message || `HTTP ${res.status}`;
      return { ok: false, status: res.status, data, error: typeof message === 'string' ? message : `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, data, error: null };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      data: null,
      error: aborted
        ? `Live Chat bot timed out at ${url}`
        : (err?.message || String(err) || `could not reach ${url}`),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function collectLiveChatStatus({
  force = false,
  baseUrl = null,
  settings = null,
  workspaceRoot = null,
} = {}) {
  // Browser-native voice: no Pipecat health probe. Status stays "up" so the
  // Live button works without a separate bot process.
  const resolved = (typeof baseUrl === 'string' && baseUrl.trim()
    ? baseUrl.trim().replace(/\/+$/, '')
    : null)
    || resolveLiveChatBaseUrl(process.env, settings);
  const now = Date.now();
  if (
    !force
    && liveChatStatusCache.value
    && liveChatStatusCache.baseUrl === resolved
    && (now - liveChatStatusCache.at) < LIVE_CHAT_STATUS_CACHE_MS
  ) {
    return liveChatStatusCache.value;
  }

  const prefs = normalizeLiveChatSettings(settings?.liveChat);
  const install = probeLiveChatInstall(workspaceRoot);
  const value = {
    ok: true,
    checkedAt: now,
    installed: true,
    serverUp: true,
    mode: 'browser',
    baseUrl: resolved,
    root: install.root,
    transport: 'browser',
    tts: prefs.ttsProvider || prefs.tts,
    sttProvider: prefs.sttProvider,
    ttsProvider: prefs.ttsProvider,
    vadProvider: prefs.vadProvider,
    offlineOnly: prefs.offlineOnly,
    model: null,
    modelConfigured: true,
    wsPath: null,
    rtcPath: null,
    version: 'browser',
    error: null,
    steps: [...LIVE_CHAT_INSTALL_STEPS],
    retiredPipecat: true,
  };
  liveChatStatusCache = { at: now, baseUrl: resolved, value };
  return value;
}

/** @deprecated Pipecat health path — kept for tests that import the old shape. */
export async function collectLiveChatStatusLegacy({
  force = false,
  baseUrl = null,
  settings = null,
  workspaceRoot = null,
} = {}) {
  const resolved = (typeof baseUrl === 'string' && baseUrl.trim()
    ? baseUrl.trim().replace(/\/+$/, '')
    : null)
    || resolveLiveChatBaseUrl(process.env, settings);
  const now = Date.now();
  const prefs = normalizeLiveChatSettings(settings?.liveChat);
  const install = probeLiveChatInstall(workspaceRoot);
  const health = await liveChatFetch('/health', { baseUrl: resolved });
  if (!health.ok) {
    return {
      ...emptyLiveChatStatus(health.error || (install.installed
        ? 'Live Chat bot is not reachable'
        : 'Live Chat bot not installed')),
      ok: false,
      serverUp: false,
      mode: 'pipecat',
      baseUrl: resolved,
      installed: install.installed,
      root: install.root,
      transport: prefs.transport,
      tts: prefs.tts,
      steps: install.installed ? [...LIVE_CHAT_SERVER_STEPS] : [...LIVE_CHAT_INSTALL_STEPS],
    };
  }

  const data = health.data || {};
  return {
    ok: true,
    checkedAt: now,
    installed: true,
    mode: 'pipecat',
    force,
    serverUp: data.serverUp !== false,
    baseUrl: resolved,
    root: install.root,
    transport: normalizeLiveChatTransport(data.transport || prefs.transport),
    tts: normalizeLiveChatTts(data.tts || prefs.tts),
    model: typeof data.model === 'string' ? data.model : null,
    modelConfigured: Boolean(data.modelConfigured ?? data.strataConfigured),
    wsPath: typeof data.wsPath === 'string' ? data.wsPath : '/ws',
    rtcPath: typeof data.rtcPath === 'string' ? data.rtcPath : '/rtc',
    version: typeof data.version === 'string' ? data.version : null,
    error: null,
    steps: [],
  };
}

/** Soft caps so mint payloads stay small enough for spoken context. */
export const LIVE_CHAT_HISTORY_MAX_MESSAGES = 40;
export const LIVE_CHAT_HISTORY_MAX_CHARS = 12_000;

/**
 * Resolve a chat session the same way transcript append does (id, then queueKey).
 */
export function resolveLiveChatChatSession(dir, {
  sessionId = null,
  harness = KUSA_HARNESS,
  queueKey = null,
} = {}) {
  if (!dir) return null;
  let id = typeof sessionId === 'string' ? sessionId.trim() : '';
  let lane = harness || KUSA_HARNESS;
  if ((!id || !readChatSession(dir, id, lane)) && typeof queueKey === 'string' && queueKey.includes(':')) {
    const prefix = queueKey.slice(0, queueKey.indexOf(':'));
    const rest = queueKey.slice(queueKey.indexOf(':') + 1);
    if (rest) {
      id = rest;
      lane = prefix || lane;
    }
  }
  if (!id) return null;
  let session = readChatSession(dir, id, lane);
  if (!session) {
    session = readChatSession(dir, id, null);
  }
  return session || null;
}

/**
 * Pack prior chat turns as OpenAI-style {role, content} for the live voice LLM.
 * Newest-preserving: drop oldest first when over message/char caps.
 */
export function liveChatHistoryMessages(dir, {
  sessionId = null,
  harness = KUSA_HARNESS,
  queueKey = null,
  maxMessages = LIVE_CHAT_HISTORY_MAX_MESSAGES,
  maxChars = LIVE_CHAT_HISTORY_MAX_CHARS,
} = {}) {
  const session = resolveLiveChatChatSession(dir, { sessionId, harness, queueKey });
  const raw = Array.isArray(session?.messages) ? session.messages : [];
  /** @type {Array<{ role: string, content: string }>} */
  const turns = [];
  for (const m of raw) {
    if (!m || typeof m.text !== 'string') continue;
    const text = m.text.trim();
    if (!text) continue;
    // Skip failed / stopped rows — they add noise without helping spoken context.
    if (m.error === true) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    turns.push({ role, content: text });
  }
  const msgCap = Math.max(1, Number(maxMessages) || LIVE_CHAT_HISTORY_MAX_MESSAGES);
  const charCap = Math.max(500, Number(maxChars) || LIVE_CHAT_HISTORY_MAX_CHARS);
  let sliced = turns.length > msgCap ? turns.slice(turns.length - msgCap) : turns;
  let total = sliced.reduce((n, t) => n + t.content.length, 0);
  while (sliced.length > 1 && total > charCap) {
    total -= sliced[0].content.length;
    sliced = sliced.slice(1);
  }
  if (sliced.length === 1 && sliced[0].content.length > charCap) {
    sliced = [{ ...sliced[0], content: sliced[0].content.slice(-charCap) }];
  }
  return sliced;
}

/**
 * Mint a voice session on the bot, injecting Kusă agent credentials from settings
 * and (when `dir` is set) prior chat turns so the voice LLM has session context.
 */
export async function createLiveChatSession({
  settings,
  dir = null,
  sessionId = null,
  queueKey = null,
  modelOverride = null,
  endpointIdOverride = null,
  transport = null,
  tts = null,
  baseUrl = null,
} = {}) {
  const prefs = normalizeLiveChatSettings(settings?.liveChat);
  const resolvedBase = baseUrl || resolveLiveChatBaseUrl(process.env, settings);
  const scoped = {
    ...settings,
    ...(modelOverride ? { agentModel: String(modelOverride).trim() } : {}),
    ...(endpointIdOverride != null
      ? { agentEndpointId: String(endpointIdOverride).trim() }
      : {}),
  };
  const endpoint = resolveAgentEndpoint(scoped);
  const history = dir
    ? liveChatHistoryMessages(dir, { sessionId, queueKey })
    : [];
  const body = {
    sessionId: sessionId || undefined,
    queueKey: queueKey || undefined,
    model: endpoint.model || undefined,
    baseUrl: endpoint.baseUrl || undefined,
    apiKey: endpoint.apiKey || undefined,
    transport: normalizeLiveChatTransport(transport || prefs.transport),
    tts: normalizeLiveChatTts(tts || prefs.tts),
    ...(history.length ? { messages: history } : {}),
  };
  const res = await liveChatFetch('/session', {
    baseUrl: resolvedBase,
    method: 'POST',
    body,
    timeoutMs: 15_000,
  });
  if (!res.ok) {
    const err = new Error(res.error || 'failed to mint live chat session');
    err.code = res.status === 0 ? 'ECONN' : 'EHTTP';
    err.status = res.status;
    throw err;
  }
  return {
    ...(res.data || {}),
    proxyWsPath: '/live-chat/ws',
    proxyRtcPath: '/live-chat/rtc',
    botBaseUrl: resolvedBase,
    transport: normalizeLiveChatTransport(res.data?.transport || body.transport),
    tts: normalizeLiveChatTts(res.data?.tts || body.tts),
    historyMessages: history.length,
  };
}

/**
 * Append a voice transcript turn into an existing chat session on disk.
 */
export function appendLiveChatTranscript(dir, {
  sessionId,
  harness = KUSA_HARNESS,
  queueKey = null,
  role = 'user',
  text = '',
  at = Date.now(),
} = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  const session = resolveLiveChatChatSession(dir, { sessionId, harness, queueKey });
  if (!session?.id) return null;
  const lane = session.harness || harness || KUSA_HARNESS;
  const id = session.id;
  const message = {
    id: `voice-${at}-${Math.random().toString(36).slice(2, 8)}`,
    role: role === 'assistant' ? 'assistant' : 'user',
    text: trimmed,
    at: Number.isFinite(at) ? at : Date.now(),
    backend: 'live-chat',
  };
  const messages = [...(session.messages || []), message];
  return writeChatSession(dir, {
    ...session,
    key: session.key || laneKey(lane, id),
    harness: lane,
    id,
    messages,
    status: 'idle',
  });
}

/** Forward an SDP offer to the bot's /rtc endpoint. */
export async function proxyLiveChatRtcOffer(body, { baseUrl = resolveLiveChatBaseUrl() } = {}) {
  return liveChatFetch('/rtc', {
    baseUrl,
    method: 'POST',
    body,
    timeoutMs: 30_000,
  });
}
