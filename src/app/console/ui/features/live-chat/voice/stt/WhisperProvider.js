/**
 * Offline Whisper STT via @huggingface/transformers (WebGPU preferred, WASM fallback).
 */

import {
  DEFAULT_WHISPER_MODEL,
} from '../types.js';
import {
  detectVoiceCapabilities,
  resolveInferenceDevice,
} from '../capabilities.js';
import {
  BUNDLED_WHISPER_ID,
  configureTransformersLocalEnv,
  isBundledModelAvailable,
} from '../localModels.js';

/** @typedef {import('../types.js').EngineStatus} EngineStatus */
/** @typedef {import('../types.js').STTConfig} STTConfig */

function resampleLinear(input, inRate, outRate) {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const t = src - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

export class WhisperProvider {
  constructor() {
    /** @type {EngineStatus} */
    this._status = 'idle';
    /** @type {((text: string) => void)|null} */
    this._onInterim = null;
    /** @type {((text: string) => void)|null} */
    this._onFinal = null;
    /** @type {((error: Error) => void)|null} */
    this._onError = null;
    this._modelId = DEFAULT_WHISPER_MODEL;
    this._language = 'en';
    this._device = 'wasm';
    /** @type {any} */
    this._transcriber = null;
    /** @type {Float32Array[]} */
    this._buffer = [];
    this._bufferSamples = 0;
    this._sampleRate = 16000;
    this._busy = false;
    this._speechActive = false;
  }

  /** @param {STTConfig} [config] */
  async initialize(config = {}) {
    this._status = 'initializing';
    this._modelId = config.modelId || DEFAULT_WHISPER_MODEL;
    if (typeof config.language === 'string' && config.language.trim()) {
      this._language = config.language.trim().split('-')[0] || 'en';
    }

    const caps = await detectVoiceCapabilities();
    if (!caps.wasm && !caps.webgpu) {
      this._status = 'failed';
      throw new Error('Whisper requires WebAssembly or WebGPU');
    }
    this._device = resolveInferenceDevice(config.device || 'auto', caps);

    const offlineOnly = config.offlineOnly !== false;
    // Only whisper-tiny.en is shipped under /voice-models/. Missing ids (e.g.
    // whisper-base.en) must not hit Vite's SPA HTML fallback — that yields
    // "Unexpected token '<' … is not valid JSON".
    const wantOk = await isBundledModelAvailable(this._modelId);
    if (!wantOk) {
      const tinyOk = await isBundledModelAvailable(BUNDLED_WHISPER_ID);
      if (tinyOk) this._modelId = BUNDLED_WHISPER_ID;
    }
    const bundled = await isBundledModelAvailable(this._modelId);
    if (!bundled) {
      this._status = 'not_installed';
      throw new Error(
        `Whisper model "${this._modelId}" is not bundled. Run: npm run voice:models`,
      );
    }

    try {
      const { pipeline, env } = await import('@huggingface/transformers');
      configureTransformersLocalEnv(env, { offlineOnly });

      this._transcriber = await pipeline(
        'automatic-speech-recognition',
        this._modelId,
        {
          device: this._device,
          // Bundled weights are quantized (q8); keep dtype aligned.
          dtype: 'q8',
          local_files_only: offlineOnly || bundled,
        },
      );
      this._status = 'ready';
    } catch (err) {
      // Retry WASM if WebGPU init failed.
      if (this._device === 'webgpu') {
        try {
          const { pipeline, env } = await import('@huggingface/transformers');
          configureTransformersLocalEnv(env, { offlineOnly });
          this._device = 'wasm';
          this._transcriber = await pipeline(
            'automatic-speech-recognition',
            this._modelId,
            { device: 'wasm', dtype: 'q8', local_files_only: offlineOnly || bundled },
          );
          this._status = 'ready';
          return;
        } catch (err2) {
          this._status = 'failed';
          const wrapped = err2 instanceof Error ? err2 : new Error(String(err2));
          this._onError?.(wrapped);
          throw wrapped;
        }
      }
      this._status = 'failed';
      const wrapped = err instanceof Error ? err : new Error(String(err));
      if (/not.?found|404|403|forbidden|network|fetch/i.test(wrapped.message)) {
        this._status = 'not_installed';
        throw new Error(
          `Whisper model "${this._modelId}" is not available. Run: npm run voice:models`,
        );
      }
      this._onError?.(wrapped);
      throw wrapped;
    }
  }

  async start() {
    if (!this._transcriber) throw new Error('WhisperProvider not initialized');
    this._buffer = [];
    this._bufferSamples = 0;
    this._speechActive = false;
    this._status = 'running';
  }

  async stop() {
    this._status = 'ready';
    this._buffer = [];
    this._bufferSamples = 0;
    this._speechActive = false;
  }

  async dispose() {
    await this.stop();
    this._transcriber = null;
    this._status = 'idle';
    this._onInterim = null;
    this._onFinal = null;
    this._onError = null;
  }

  /** @param {(text: string) => void} callback */
  onInterimResult(callback) {
    this._onInterim = callback;
  }

  /** @param {(text: string) => void} callback */
  onFinalResult(callback) {
    this._onFinal = callback;
  }

  /** @param {(error: Error) => void} callback */
  onError(callback) {
    this._onError = callback;
  }

  /** @returns {EngineStatus} */
  getStatus() {
    return this._status;
  }

  /**
   * @param {Float32Array} frame
   * @param {number} [sampleRate]
   */
  pushAudio(frame, sampleRate) {
    if (this._status !== 'running' || !frame?.length) return;
    if (sampleRate) this._sampleRate = sampleRate;
    if (!this._speechActive) return;
    this._buffer.push(frame);
    this._bufferSamples += frame.length;

    // Periodic interim transcription on ~1.2s of audio when practical.
    const target = Math.floor(this._sampleRate * 1.2);
    if (!this._busy && this._bufferSamples >= target) {
      void this._transcribe(false);
    }
  }

  markSpeechStart() {
    this._speechActive = true;
    this._buffer = [];
    this._bufferSamples = 0;
  }

  async finishSpeech() {
    this._speechActive = false;
    await this._transcribe(true);
  }

  /**
   * @param {boolean} isFinal
   */
  async _transcribe(isFinal) {
    if (!this._transcriber || this._busy) return;
    if (!this._bufferSamples) {
      if (isFinal) this._onFinal?.('');
      return;
    }

    this._busy = true;
    try {
      const merged = new Float32Array(this._bufferSamples);
      let offset = 0;
      for (const chunk of this._buffer) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      if (isFinal) {
        this._buffer = [];
        this._bufferSamples = 0;
      }

      const audio = resampleLinear(merged, this._sampleRate, 16000);
      // English-only checkpoints (*.en) reject `language` / `task` — they are
      // fixed to English transcription. Multilingual models accept both.
      const englishOnly = /\.en$/i.test(String(this._modelId || ''))
        || String(this._modelId || '').includes('whisper-tiny.en')
        || String(this._modelId || '').includes('whisper-base.en');
      const genOpts = englishOnly
        ? { return_timestamps: false }
        : {
          language: this._language,
          task: 'transcribe',
          return_timestamps: false,
        };
      const result = await this._transcriber(audio, genOpts);
      const text = String(result?.text || '').trim();
      if (!text) return;
      if (isFinal) this._onFinal?.(text);
      else this._onInterim?.(text);
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      this._onError?.(wrapped);
    } finally {
      this._busy = false;
    }
  }
}
