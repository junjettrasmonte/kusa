/**
 * Offline model catalog, download progress, and OPFS/IndexedDB cache checks.
 */

import {
  DEFAULT_WHISPER_MODEL,
  WHISPER_BASE_MODEL,
} from './types.js';
import {
  BUNDLED_KOKORO_ID,
  BUNDLED_WHISPER_ID,
  isBundledModelAvailable,
  probeBundledVoiceModels,
} from './localModels.js';

const DB_NAME = 'kusa-voice-models';
const DB_STORE = 'assets';
const DB_VERSION = 1;
const META_KEY = 'kusa-voice-model-meta';

/** @type {import('./types.js').ModelAsset[]} */
export const VOICE_MODEL_CATALOG = [
  {
    id: DEFAULT_WHISPER_MODEL,
    engine: 'stt',
    provider: 'whisper',
    label: 'Whisper Tiny EN',
    version: '1.0',
    bytesEstimate: 40_000_000,
  },
  {
    id: WHISPER_BASE_MODEL,
    engine: 'stt',
    provider: 'whisper',
    label: 'Whisper Base EN',
    version: '1.0',
    bytesEstimate: 80_000_000,
  },
  {
    id: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    engine: 'tts',
    provider: 'kokoro',
    label: 'Kokoro 82M',
    version: '1.0',
    bytesEstimate: 90_000_000,
  },
  {
    id: 'silero-vad',
    engine: 'vad',
    provider: 'silero',
    label: 'Silero VAD',
    version: '1.0',
    bytesEstimate: 2_000_000,
  },
];

/**
 * @returns {Promise<IDBDatabase|null>}
 */
function openDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => resolve(null);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
    } catch {
      resolve(null);
    }
  });
}

function readLocalMeta() {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(META_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeLocalMeta(meta) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch { /* ignore quota */ }
}

export class VoiceModelManager {
  constructor(catalog = VOICE_MODEL_CATALOG) {
    this._catalog = catalog.slice();
    /** @type {Map<string, import('./types.js').ModelLifecycleStatus>} */
    this._status = new Map();
    /** @type {Map<string, number>} */
    this._progress = new Map();
    /** @type {((info: { id: string, status: string, progress: number, error?: string }) => void)|null} */
    this.onChange = null;
    for (const asset of this._catalog) {
      this._status.set(asset.id, 'not_installed');
      this._progress.set(asset.id, 0);
    }
  }

  listModels() {
    return this._catalog.map((asset) => ({
      ...asset,
      status: this._status.get(asset.id) || 'not_installed',
      progress: this._progress.get(asset.id) || 0,
    }));
  }

  /**
   * @param {string} id
   * @returns {import('./types.js').ModelLifecycleStatus}
   */
  getStatus(id) {
    return this._status.get(id) || 'not_installed';
  }

  /**
   * Refresh installed flags from bundled /voice-models/ (+ legacy meta markers).
   */
  async refresh() {
    const bundled = await probeBundledVoiceModels();
    const meta = readLocalMeta();

    for (const asset of this._catalog) {
      let ready = Boolean(meta[asset.id]?.ready);
      if (asset.id === BUNDLED_WHISPER_ID || asset.id === DEFAULT_WHISPER_MODEL) {
        ready = bundled.whisper || ready;
      } else if (asset.id === WHISPER_BASE_MODEL) {
        ready = await isBundledModelAvailable(WHISPER_BASE_MODEL) || ready;
      } else if (asset.id === BUNDLED_KOKORO_ID || asset.provider === 'kokoro') {
        ready = bundled.kokoro || ready;
      } else if (asset.provider === 'silero' || asset.id === 'silero-vad') {
        ready = bundled.silero || ready;
      }
      this._set(asset.id, ready ? 'ready' : 'not_installed', ready ? 1 : 0);
    }
  }

  /**
   * Mark a model ready after a successful provider initialize (lazy download).
   * @param {string} id
   * @param {{ version?: string, bytes?: number }} [info]
   */
  async markReady(id, info = {}) {
    const meta = readLocalMeta();
    meta[id] = {
      ready: true,
      version: info.version || this._catalog.find((a) => a.id === id)?.version || '1.0',
      bytes: info.bytes || 0,
      at: Date.now(),
    };
    writeLocalMeta(meta);

    const db = await openDb();
    if (db) {
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(DB_STORE, 'readwrite');
          tx.objectStore(DB_STORE).put({ id, ready: true, ...meta[id] });
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    }
    this._set(id, 'ready', 1);
  }

  /**
   * Best-effort download using fetch into IndexedDB when URLs are known.
   * For transformers/kokoro models, prefer provider initialize (which caches itself);
   * this method records progress hooks for UI while a warm-up fetch runs.
   * @param {string} id
   * @param {{ signal?: AbortSignal }} [opts]
   */
  async download(id, _opts = {}) {
    const asset = this._catalog.find((a) => a.id === id);
    if (!asset) throw new Error(`Unknown model: ${id}`);
    if (this._status.get(id) === 'downloading') return;

    this._set(id, 'downloading', 0.2);
    try {
      // Models are predownloaded into the PWA (`npm run voice:models`), not fetched
      // from Hugging Face in the browser (HF often returns 403 to localhost).
      await this.refresh();
      if (this.getStatus(id) === 'ready') {
        await this.markReady(id, { version: asset.version, bytes: asset.bytesEstimate });
        return;
      }
      this._set(id, 'failed', 0, 'not_bundled');
      throw new Error(
        `Model "${id}" is not bundled in /voice-models/. From the repo root run: npm run voice:models`,
      );
    } catch (err) {
      if (this.getStatus(id) !== 'failed') {
        this._set(id, 'failed', 0, err instanceof Error ? err.message : String(err));
      }
      throw err;
    }
  }

  /**
   * @param {string} id
   */
  async remove(id) {
    const meta = readLocalMeta();
    delete meta[id];
    writeLocalMeta(meta);
    const db = await openDb();
    if (db) {
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(DB_STORE, 'readwrite');
          tx.objectStore(DB_STORE).delete(id);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    }
    this._set(id, 'not_installed', 0);
  }

  /**
   * Ensure required models for a provider set are ready (or throw a clear error).
   * @param {{ sttProvider: string, ttsProvider: string, vadProvider: string, whisperModel?: string, offlineOnly?: boolean }} config
   */
  async assertReadyFor(config) {
    await this.refresh();
    const needed = [];
    if (config.sttProvider === 'whisper') {
      needed.push(config.whisperModel || DEFAULT_WHISPER_MODEL);
    }
    if (config.ttsProvider === 'kokoro') {
      needed.push(BUNDLED_KOKORO_ID);
    }
    if (config.vadProvider === 'silero') {
      needed.push('silero-vad');
    }

    const missing = needed.filter((id) => {
      if (this.getStatus(id) === 'ready') return false;
      // Bundled tiny whisper satisfies the default whisper id.
      if (
        (id === DEFAULT_WHISPER_MODEL || id === BUNDLED_WHISPER_ID)
        && this.getStatus(BUNDLED_WHISPER_ID) === 'ready'
      ) {
        return false;
      }
      return true;
    });
    if (missing.length) {
      throw new Error(
        `Voice models not bundled (${missing.join(', ')}). Run: npm run voice:models`,
      );
    }
    return { needed, missing };
  }

  /**
   * @param {string} id
   * @param {import('./types.js').ModelLifecycleStatus} status
   * @param {number} progress
   * @param {string} [error]
   */
  _set(id, status, progress, error) {
    this._status.set(id, status);
    this._progress.set(id, progress);
    this.onChange?.({ id, status, progress, error });
  }
}
