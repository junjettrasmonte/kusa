/**
 * Browser Kokoro TTS via kokoro-js (ONNX). WebGPU preferred, WASM fallback.
 */

import { DEFAULT_KOKORO_VOICE } from '../types.js';
import {
  detectVoiceCapabilities,
  resolveInferenceDevice,
} from '../capabilities.js';
import {
  BUNDLED_KOKORO_ID,
  configureTransformersLocalEnv,
  isBundledModelAvailable,
  installVoiceModelFetchRewrite,
} from '../localModels.js';

/**
 * Kokoro voice ids encode language in the first letter (a/b = English).
 * Force an English voice when the session language is English so TTS does not
 * switch to zh/ja/etc phonemization.
 * @param {string} voice
 * @param {string} [language]
 */
function resolveEnglishSafeVoice(voice, language = 'en') {
  const lang = String(language || 'en').toLowerCase().split('-')[0];
  const id = String(voice || '').trim() || DEFAULT_KOKORO_VOICE;
  if (lang !== 'en') return id;
  const prefix = id.charAt(0).toLowerCase();
  // a = en-us, b = en-gb — everything else (z/j/f/…) is non-English.
  if (prefix === 'a' || prefix === 'b') return id;
  return DEFAULT_KOKORO_VOICE;
}

/** @typedef {import('../types.js').EngineStatus} EngineStatus */
/** @typedef {import('../types.js').TTSConfig} TTSConfig */

export class KokoroProvider {
  constructor() {
    /** @type {EngineStatus} */
    this._status = 'idle';
    this._voice = DEFAULT_KOKORO_VOICE;
    this._rate = 1;
    this._device = 'wasm';
    /** @type {any} */
    this._tts = null;
    this._cancelled = false;
    /** @type {import('../audio/AudioPlayback.js').AudioPlayback|null} */
    this._playback = null;
    this._generation = 0;
  }

  /**
   * Optional shared playback sink (VoiceManager provides one).
   * @param {import('../audio/AudioPlayback.js').AudioPlayback} playback
   */
  setPlayback(playback) {
    this._playback = playback;
  }

  /** @param {TTSConfig & { language?: string }} [config] */
  async initialize(config = {}) {
    this._status = 'initializing';
    this._language = typeof config.language === 'string' && config.language.trim()
      ? config.language.trim()
      : 'en';
    if (typeof config.voice === 'string' && config.voice.trim()) {
      this._voice = resolveEnglishSafeVoice(config.voice, this._language);
    } else {
      this._voice = resolveEnglishSafeVoice(DEFAULT_KOKORO_VOICE, this._language);
    }
    if (typeof config.rate === 'number' && Number.isFinite(config.rate)) {
      this._rate = Math.min(2, Math.max(0.5, config.rate));
    }

    const caps = await detectVoiceCapabilities();
    if (!caps.wasm && !caps.webgpu) {
      this._status = 'failed';
      throw new Error('Kokoro requires WebAssembly or WebGPU');
    }
    this._device = resolveInferenceDevice(config.device || 'auto', caps);

    const offlineOnly = config.offlineOnly !== false;
    const bundled = await isBundledModelAvailable(BUNDLED_KOKORO_ID, 'onnx/model_quantized.onnx');
    if (offlineOnly || bundled) {
      if (!bundled) {
        this._status = 'not_installed';
        throw new Error('Kokoro model is not bundled. Run: npm run voice:models');
      }
    }

    installVoiceModelFetchRewrite();
    try {
      // kokoro-js uses @huggingface/transformers under the hood.
      const { env } = await import('@huggingface/transformers');
      configureTransformersLocalEnv(env, { offlineOnly });
    } catch { /* optional if nested dep resolves differently */ }

    try {
      const { KokoroTTS } = await import('kokoro-js');
      this._tts = await KokoroTTS.from_pretrained(BUNDLED_KOKORO_ID, {
        dtype: 'q8',
        device: this._device,
      });
      this._status = 'ready';
    } catch (err) {
      if (this._device === 'webgpu') {
        try {
          const { KokoroTTS } = await import('kokoro-js');
          this._device = 'wasm';
          this._tts = await KokoroTTS.from_pretrained(BUNDLED_KOKORO_ID, {
            dtype: 'q8',
            device: 'wasm',
          });
          this._status = 'ready';
          return;
        } catch (err2) {
          this._status = 'failed';
          throw err2 instanceof Error ? err2 : new Error(String(err2));
        }
      }
      this._status = 'failed';
      const wrapped = err instanceof Error ? err : new Error(String(err));
      if (/not.?found|404|403|forbidden|network|fetch/i.test(wrapped.message)) {
        this._status = 'not_installed';
        throw new Error('Kokoro model is not available. Run: npm run voice:models');
      }
      throw wrapped;
    }
  }

  listVoices() {
    try {
      const voices = this._tts?.voices;
      if (voices && typeof voices === 'object') {
        return Object.keys(voices).map((id) => ({ id, label: id }));
      }
    } catch { /* ignore */ }
    return [{ id: this._voice, label: this._voice }];
  }

  /**
   * @param {string} text
   * @returns {Promise<void>}
   */
  async speak(text) {
    const cleaned = String(text || '').trim();
    if (!cleaned) return;
    if (!this._tts) throw new Error('KokoroProvider not initialized');

    this._cancelled = false;
    this._status = 'running';
    const generation = this._playback?.generation ?? this._generation;

    try {
      const voice = resolveEnglishSafeVoice(this._voice, this._language);
      const result = await this._tts.generate(cleaned, {
        voice,
        speed: this._rate,
      });
      if (this._cancelled) return;
      if (this._playback && generation !== this._playback.generation) return;

      // kokoro-js returns an object with audio Float32Array + sampling_rate.
      const audio = result?.audio || result;
      const sampleRate = result?.sampling_rate || result?.sample_rate || 24000;

      if (this._playback) {
        let payload = audio;
        if (audio && typeof audio.getChannelData === 'function') {
          payload = audio.getChannelData(0);
        } else if (audio?.data instanceof Float32Array) {
          payload = audio.data;
        }
        await this._playback.enqueue(payload, { sampleRate, generation });
      } else if (typeof AudioContext !== 'undefined') {
        // Standalone path for tests without VoiceManager playback.
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const floats = audio?.data instanceof Float32Array
          ? audio.data
          : (audio instanceof Float32Array ? audio : null);
        if (!floats) {
          await ctx.close();
          return;
        }
        const buffer = ctx.createBuffer(1, floats.length, sampleRate);
        buffer.copyToChannel(floats, 0);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        await new Promise((resolve) => {
          src.onended = resolve;
          src.start();
        });
        await ctx.close();
      }
    } finally {
      this._status = 'ready';
    }
  }

  async stop() {
    this._cancelled = true;
    this._generation += 1;
    this._playback?.stopImmediate?.();
    this._status = 'ready';
  }

  async pause() {
    // Kokoro generates full utterances; pause maps to stop of active playback.
    this._playback?.stopImmediate?.();
  }

  async resume() {
    // No-op — interrupted sentences must be re-queued by VoiceManager.
  }

  async dispose() {
    await this.stop();
    this._tts = null;
    this._status = 'idle';
    this._playback = null;
  }

  /** @returns {EngineStatus} */
  getStatus() {
    return this._status;
  }
}
