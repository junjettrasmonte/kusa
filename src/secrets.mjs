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
 * Browser-safe settings: never includes agentApiKey / agentApiKeyEnc.
 * Adds agentApiKeySet so the UI can show that a key is configured.
 */
export function publicSettings(settings = {}) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const hasKey = Boolean(
    (typeof s.agentApiKey === 'string' && s.agentApiKey.trim())
    || s.agentApiKeySet === true
    || isSecretEnvelope(s.agentApiKeyEnc),
  );
  return {
    sdkListenerEnabled: s.sdkListenerEnabled !== false,
    collectReasoningEvents: s.collectReasoningEvents !== false,
    persistReasoningText: s.persistReasoningText === true,
    detectTrail: s.detectTrail !== false,
    enforceTrail: s.enforceTrail !== false,
    detectGit: s.detectGit !== false,
    enforceGit: s.enforceGit !== false,
    agentBaseUrl: typeof s.agentBaseUrl === 'string' ? s.agentBaseUrl : '',
    agentModel: typeof s.agentModel === 'string' ? s.agentModel : 'gpt-4o-mini',
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
    agentApiKeySet: hasKey,
  };
}
