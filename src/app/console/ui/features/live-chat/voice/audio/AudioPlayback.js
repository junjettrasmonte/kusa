/**
 * Queued PCM / AudioBuffer playback with immediate stop and generation ids.
 */

/**
 * @typedef {object} PlaybackItem
 * @property {number} generation
 * @property {AudioBuffer|Float32Array|ArrayBuffer} audio
 * @property {number} [sampleRate]
 * @property {() => void} [resolve]
 * @property {(err: Error) => void} [reject]
 */

export class AudioPlayback {
  constructor() {
    /** @type {AudioContext|null} */
    this._ctx = null;
    /** @type {AnalyserNode|null} */
    this._analyser = null;
    /** @type {GainNode|null} */
    this._gain = null;
    /** @type {AudioBufferSourceNode|null} */
    this._current = null;
    /** @type {PlaybackItem[]} */
    this._queue = [];
    this._playing = false;
    this._generation = 0;
    this._playCursor = 0;
    /** @type {((playing: boolean) => void)|null} */
    this.onPlayingChange = null;
  }

  /** Bump generation and drop queued/stale audio. */
  nextGeneration() {
    this._generation += 1;
    this._drainQueue(new Error('Playback interrupted'));
    this.stopImmediate();
    return this._generation;
  }

  get generation() {
    return this._generation;
  }

  get playing() {
    return this._playing;
  }

  /** @returns {AnalyserNode|null} */
  getAnalyser() {
    return this._analyser;
  }

  async ensureContext() {
    if (this._ctx && this._ctx.state !== 'closed') {
      if (this._ctx.state === 'suspended') await this._ctx.resume();
      return this._ctx;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this._ctx = new Ctx();
    this._analyser = this._ctx.createAnalyser();
    this._analyser.fftSize = 256;
    this._analyser.smoothingTimeConstant = 0.65;
    this._gain = this._ctx.createGain();
    this._gain.gain.value = 1;
    this._gain.connect(this._analyser);
    this._analyser.connect(this._ctx.destination);
    if (this._ctx.state === 'suspended') await this._ctx.resume();
    this._playCursor = this._ctx.currentTime;
    return this._ctx;
  }

  /**
   * Enqueue PCM float mono, Int16 ArrayBuffer, or AudioBuffer for a generation.
   * @param {AudioBuffer|Float32Array|ArrayBuffer|Int16Array} audio
   * @param {{ sampleRate?: number, generation?: number }} [opts]
   * @returns {Promise<void>}
   */
  enqueue(audio, opts = {}) {
    const generation = opts.generation ?? this._generation;
    if (generation !== this._generation) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this._queue.push({
        generation,
        audio,
        sampleRate: opts.sampleRate,
        resolve,
        reject,
      });
      void this._pump();
    });
  }

  stopImmediate() {
    try {
      this._current?.stop?.(0);
    } catch { /* ignore */ }
    this._current = null;
    this._playing = false;
    this.onPlayingChange?.(false);
    if (this._ctx) {
      this._playCursor = this._ctx.currentTime;
    }
  }

  async stop() {
    this.nextGeneration();
  }

  async dispose() {
    this.nextGeneration();
    if (this._ctx) {
      try { await this._ctx.close(); } catch { /* ignore */ }
    }
    this._ctx = null;
    this._analyser = null;
    this._gain = null;
  }

  /**
   * @param {Error} [err]
   */
  _drainQueue(err) {
    const leftover = this._queue.splice(0);
    for (const item of leftover) {
      if (err) item.reject?.(err);
      else item.resolve?.();
    }
  }

  async _pump() {
    if (this._playing) return;
    const next = this._queue.shift();
    if (!next) return;
    if (next.generation !== this._generation) {
      next.resolve?.();
      return this._pump();
    }

    try {
      const ctx = await this.ensureContext();
      const buffer = await this._toAudioBuffer(ctx, next.audio, next.sampleRate);
      if (next.generation !== this._generation) {
        next.resolve?.();
        return this._pump();
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this._gain || ctx.destination);
      const startAt = Math.max(ctx.currentTime, this._playCursor);
      this._playing = true;
      this.onPlayingChange?.(true);
      this._current = source;

      await new Promise((resolve, reject) => {
        source.onended = () => resolve();
        try {
          source.start(startAt);
          this._playCursor = startAt + buffer.duration;
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });

      next.resolve?.();
    } catch (err) {
      next.reject?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this._current = null;
      this._playing = this._queue.some((q) => q.generation === this._generation);
      if (!this._playing) this.onPlayingChange?.(false);
      void this._pump();
    }
  }

  /**
   * @param {AudioContext} ctx
   * @param {AudioBuffer|Float32Array|ArrayBuffer|Int16Array} audio
   * @param {number} [sampleRate]
   */
  async _toAudioBuffer(ctx, audio, sampleRate) {
    if (audio instanceof AudioBuffer) return audio;

    if (audio instanceof Float32Array) {
      const rate = sampleRate || ctx.sampleRate;
      const buffer = ctx.createBuffer(1, audio.length, rate);
      buffer.copyToChannel(audio, 0);
      return buffer;
    }

    if (audio instanceof Int16Array) {
      const floats = new Float32Array(audio.length);
      for (let i = 0; i < audio.length; i += 1) {
        floats[i] = audio[i] / 32768;
      }
      return this._toAudioBuffer(ctx, floats, sampleRate);
    }

    if (audio instanceof ArrayBuffer) {
      // Assume PCM16 LE mono when sampleRate provided; else decode as encoded audio.
      if (sampleRate) {
        const view = new Int16Array(audio);
        return this._toAudioBuffer(ctx, view, sampleRate);
      }
      return ctx.decodeAudioData(audio.slice(0));
    }

    throw new Error('Unsupported audio payload for playback');
  }
}

/**
 * Read analyser bands + RMS for spectrum UI.
 * LiveVoiceSpectrum expects `{ bands, rms }` under speak/listen.
 * @param {AnalyserNode|null|undefined} analyser
 * @param {number} [bandCount]
 * @returns {{ bands: number[], peak: number, rms: number }|null}
 */
export function readAnalyserLevels(analyser, bandCount = 32) {
  if (!analyser) return null;
  const bins = analyser.frequencyBinCount;
  const data = new Uint8Array(bins);
  analyser.getByteFrequencyData(data);
  const bands = [];
  const step = Math.max(1, Math.floor(bins / bandCount));
  let peak = 0;
  for (let i = 0; i < bandCount; i += 1) {
    let sum = 0;
    const start = i * step;
    const end = Math.min(bins, start + step);
    for (let j = start; j < end; j += 1) sum += data[j];
    const v = (sum / Math.max(1, end - start)) / 255;
    bands.push(v);
    if (v > peak) peak = v;
  }

  // Time-domain RMS so listening reacts even when frequency bins are quiet.
  const td = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(td);
  let acc = 0;
  for (let i = 0; i < td.length; i += 1) {
    const centered = (td[i] - 128) / 128;
    acc += centered * centered;
  }
  const rms = Math.min(1, Math.sqrt(acc / Math.max(1, td.length)) * 2.2);
  if (rms > peak) peak = rms;
  // Lift flat frequency bands with RMS so the ring still moves with voice.
  if (peak > 0.02 && bands.every((b) => b < 0.02)) {
    for (let i = 0; i < bands.length; i += 1) {
      bands[i] = rms * (0.35 + 0.65 * ((i % 7) / 6));
    }
  }
  return { bands, peak, rms: Math.max(peak * 0.85, rms) };
}
