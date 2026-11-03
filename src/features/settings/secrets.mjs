/**
 * At-rest encryption for Kusă settings secrets (agent API key).
 *
 * Ciphertext lives in the workspace `.kusa/settings.json`.
 * The master key lives outside the workspace (or in KUSA_SECRETS_KEY).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { publicAuthSettings } from '#features/auth/shape.mjs';

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = 1;

/** User-local master key (not in the workspace). */
export function defaultMasterKeyPath() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg ? join(xdg, 'kusa') : join(homedir(), '.config', 'kusa');
  return join(base, 'master.key');
}

/** Pre-rename config dir (`kusari` → `kusa`). */
function legacyMasterKeyPath() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg ? join(xdg, 'kusari') : join(homedir(), '.config', 'kusari');
  return join(base, 'master.key');
}

/**
 * Resolve the 32-byte AES key.
 * Prefer KUSA_SECRETS_KEY (base64 or 64-char hex); else ~/.config/kusa/master.key.
 * If the new path is missing, adopts ~/.config/kusari/master.key once (rename migrate).
 */
export function ensureMasterKey() {
  const fromEnv = parseEnvKey(process.env.KUSA_SECRETS_KEY);
  if (fromEnv) return fromEnv;

  const path = defaultMasterKeyPath();
  if (existsSync(path)) {
    const raw = readFileSync(path);
    if (raw.length === KEY_BYTES) return raw;
    // Corrupt / wrong size — replace.
  }

  // One-shot migrate from the pre-rename location so encrypted settings still open.
  const legacy = legacyMasterKeyPath();
  if (existsSync(legacy)) {
    try {
      const raw = readFileSync(legacy);
      if (raw.length === KEY_BYTES) {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tmp, raw, { mode: 0o600 });
        renameSync(tmp, path);
        try { chmodSync(path, 0o600); } catch { /* best effort */ }
        return raw;
      }
    } catch { /* fall through and mint a new key */ }
  }

  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(KEY_BYTES);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, key, { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  return key;
}

function parseEnvKey(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  try {
    const buf = Buffer.from(trimmed, 'base64');
    if (buf.length === KEY_BYTES) return buf;
  } catch { /* ignore */ }
  return null;
}

/** @returns {{ v: number, iv: string, tag: string, ct: string }} */
export function encryptSecret(plaintext, key = ensureMasterKey()) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([
    cipher.update(String(plaintext ?? ''), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    v: VERSION,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
}

/** @returns {string} */
export function decryptSecret(envelope, key = ensureMasterKey()) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('invalid secret envelope');
  }
  if (envelope.v !== VERSION) {
    throw new Error(`unsupported secret envelope version: ${envelope.v}`);
  }
  const iv = Buffer.from(String(envelope.iv || ''), 'base64');
  const tag = Buffer.from(String(envelope.tag || ''), 'base64');
  const ct = Buffer.from(String(envelope.ct || ''), 'base64');
  if (iv.length !== IV_BYTES || !tag.length || !ct.length) {
    throw new Error('corrupt secret envelope');
  }
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function isSecretEnvelope(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.v === VERSION
    && typeof value.iv === 'string'
    && typeof value.tag === 'string'
    && typeof value.ct === 'string',
  );
}

/**
 * Browser-safe settings: never includes agentApiKey / agentApiKeyEnc. Adds
 * agentApiKeySet (and agentEndpoints[].apiKeySet) so the UI can show that a
 * credential is configured without ever shipping one. Auth secrets stay out —
 * only publicAuthSettings flags are merged in.
 */
export function publicSettings(settings = {}) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const hasKey = Boolean(
    (typeof s.agentApiKey === 'string' && s.agentApiKey.trim())
    || s.agentApiKeySet === true
    || isSecretEnvelope(s.agentApiKeyEnc),
  );
  const authPublic = publicAuthSettings(s.auth);
  return {
    detectTrail: s.detectTrail !== false,
    enforceTrail: s.enforceTrail !== false,
    detectGit: s.detectGit !== false,
    enforceGit: s.enforceGit !== false,
    agentBaseUrl: typeof s.agentBaseUrl === 'string' ? s.agentBaseUrl : '',
    agentModel: typeof s.agentModel === 'string' ? s.agentModel : 'gpt-4o-mini',
    // Declared model ids for the Default endpoint. The UI needs them to group its
    // model picker, so they stay browser-safe — they are ids, not secrets.
    agentModels: publicModelList(s.agentModels),
    agentEndpoints: publicAgentEndpoints(s.agentEndpoints),
    agentMaxSteps: (() => {
      const n = Number(s.agentMaxSteps);
      if (!Number.isFinite(n)) return 100;
      return Math.min(1000, Math.max(1, Math.floor(n)));
    })(),
    agentAuthMode: (s.agentAuthMode === 'apikey' || s.agentAuthMode === 'bearer')
      ? 'apikey'
      : 'none',
    agentBackend: s.agentBackend === 'opencode' ? 'opencode' : 'native',
    agentApprovalMode: (() => {
      const mode = String(s.agentApprovalMode ?? '').trim().toLowerCase();
      if (mode === 'allow' || mode === 'deny' || mode === 'ask-allow') return mode;
      return 'ask-deny';
    })(),
    agentApprovalTimeoutMinutes: (() => {
      const n = Number(s.agentApprovalTimeoutMinutes);
      if (!Number.isFinite(n)) return 2;
      return Math.min(60, Math.max(1, Math.floor(n)));
    })(),
    agentAllowDenyRevertMinutes: (() => {
      const n = Number(s.agentAllowDenyRevertMinutes);
      if (!Number.isFinite(n)) return 15;
      return Math.min(240, Math.max(1, Math.floor(n)));
    })(),
    // Small image data URL for Live voice spectrum center (Settings → Agent).
    agentAvatar: (() => {
      const value = typeof s.agentAvatar === 'string' ? s.agentAvatar.trim() : '';
      if (!value || value.length > 48_000) return '';
      if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(value)) return '';
      return value;
    })(),
    agentApiKeySet: hasKey,
    authMode: authPublic.authMode,
    authConfigured: authPublic.authConfigured,
    totpEnabled: authPublic.totpEnabled,
    authUsername: authPublic.authUsername,
    authOidc: authPublic.oidc,
    authSaml: authPublic.saml,
    liveChat: publicLiveChat(s.liveChat),
  };
}

/** Browser-safe Live Chat prefs (no secrets). */
function publicLiveChat(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const sttAllowed = ['whisper', 'webSpeech', 'mock'];
  const ttsAllowed = ['kokoro', 'browserSpeech', 'mock'];
  const vadAllowed = ['silero', 'energy', 'mock'];
  const ttsProvider = ttsAllowed.includes(String(src.ttsProvider ?? '').trim())
    ? String(src.ttsProvider).trim()
    : 'kokoro';
  const sttProvider = sttAllowed.includes(String(src.sttProvider ?? '').trim())
    ? String(src.sttProvider).trim()
    : 'whisper';
  const vadProvider = vadAllowed.includes(String(src.vadProvider ?? '').trim())
    ? String(src.vadProvider).trim()
    : 'silero';
  const genderRaw = String(src.gender ?? '').trim().toLowerCase();
  const gender = genderRaw === 'female' || genderRaw === 'male' ? genderRaw : 'any';
  const expressRaw = String(src.expressiveness ?? '').trim().toLowerCase();
  const expressiveness = (
    expressRaw === 'calm' || expressRaw === 'expressive' ? expressRaw : 'balanced'
  );
  const preferred = typeof src.voice === 'string' ? src.voice.trim() : '';
  const fallback = gender === 'male' ? 'am_adam' : 'af_heart';
  const rate = Number(src.speechRate);
  return {
    transport: 'browser',
    tts: ttsProvider === 'kokoro' ? 'kokoro' : 'kokoro',
    baseUrl: typeof src.baseUrl === 'string' ? src.baseUrl.trim().replace(/\/+$/, '') : '',
    gender,
    voice: preferred || fallback,
    expressiveness,
    sttProvider,
    ttsProvider,
    vadProvider,
    offlineOnly: src.offlineOnly !== false,
    language: typeof src.language === 'string' && src.language.trim() ? src.language.trim() : 'en',
    autoSpeak: src.autoSpeak !== false,
    interruptible: src.interruptible !== false,
    speechRate: Number.isFinite(rate) ? Math.min(2, Math.max(0.5, rate)) : 1,
    whisperModel: (() => {
      const raw = typeof src.whisperModel === 'string' ? src.whisperModel.trim() : '';
      if (!raw || raw.includes('whisper-base')) return 'onnx-community/whisper-tiny.en';
      return raw;
    })(),
    mode: 'browser',
  };
}

/**
 * Model ids the Default endpoint declares, from the comma-delimited Settings
 * field or an array. Mirrors monitor lib.mjs normalizeModelList — the two must
 * agree or a saved list would round-trip differently than the UI reads it.
 */
function publicModelList(raw) {
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' ? raw.split(/[,;\n]/) : []);
  const ids = list.map((value) => String(value ?? '').trim()).filter(Boolean);
  return [...new Set(ids)].slice(0, 60).map((id) => id.slice(0, 200));
}

/**
 * Extra endpoints for the UI: name, base URL, auth class, declared models, and
 * whether a key exists — never the key itself.
 */
function publicAgentEndpoints(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : '';
    if (!baseUrl) continue;
    if (out.length >= 12) break;
    out.push({
      id: typeof entry.id === 'string' ? entry.id.trim() : '',
      name: String(entry.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
      baseUrl,
      authMode: (entry.authMode === 'apikey' || entry.authMode === 'bearer') ? 'apikey' : 'none',
      apiKeySet: Boolean(
        (typeof entry.apiKey === 'string' && entry.apiKey.trim())
        || entry.apiKeySet === true
        || isSecretEnvelope(entry?.apiKeyEnc),
      ),
      models: publicModelList(entry?.models),
    });
  }
  return out;
}
