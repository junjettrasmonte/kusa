/**
 * Lightweight energy-threshold VAD using Web Audio frames (no model).
 */

/** @typedef {import('../types.js').EngineStatus} EngineStatus */
/** @typedef {import('../types.js').VADConfig} VADConfig */

export class EnergyVADProvider {
  constructor() {
    /** @type {EngineStatus} */
    this._status = 'idle';
    /** @type {(() => void)|null} */
    this._onStart = null;
    /** @type {(() => void)|null} */
    this._onEnd = null;
    this._threshold = 0.015;
    this._redemptionMs = 400;
    this._minSpeechMs = 120;
    this._inSpeech = false;
    this._speechStartedAt = 0;
    this._lastVoiceAt = 0;
    this._sampleRate = 16000;
  }

  /** @param {VADConfig} [config] */
  async initialize(config = {}) {
    if (typeof config.energyThreshold === 'number' && Number.isFinite(config.energyThreshold)) {
      this._threshold = Math.max(0.001, config.energyThreshold);
    }
    if (typeof config.redemptionMs === 'number' && Number.isFinite(config.redemptionMs)) {
      this._redemptionMs = Math.max(50, config.redemptionMs);
    }
    if (typeof config.minSpeechMs === 'number' && Number.isFinite(config.minSpeechMs)) {
      this._minSpeechMs = Math.max(40, config.minSpeechMs);
    }
    this._status = 'ready';
  }

  async start() {
    this._status = 'running';
    this._inSpeech = false;
    this._speechStartedAt = 0;
    this._lastVoiceAt = 0;
  }

  async stop() {
    if (this._inSpeech) {
      this._inSpeech = false;
      this._onEnd?.();
    }
    this._status = 'ready';
  }

  async dispose() {
    await this.stop();
    this._status = 'idle';
    this._onStart = null;
    this._onEnd = null;
  }

  /** @param {() => void} callback */
  onSpeechStart(callback) {
    this._onStart = callback;
  }

  /** @param {() => void} callback */
  onSpeechEnd(callback) {
    this._onEnd = callback;
  }

  /** @returns {EngineStatus} */
  getStatus() {
    return this._status;
  }

  /**
   * @param {Float32Array} frame
   * @param {number} [sampleRate]
   */
  processAudio(frame, sampleRate) {
    if (this._status !== 'running' || !frame?.length) return;
    if (sampleRate) this._sampleRate = sampleRate;

    let sum = 0;
    for (let i = 0; i < frame.length; i += 1) {
      const s = frame[i];
      sum += s * s;
    }
    const rms = Math.sqrt(sum / frame.length);
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const voiced = rms >= this._threshold;

    if (voiced) {
      this._lastVoiceAt = now;
      if (!this._inSpeech) {
        this._inSpeech = true;
        this._speechStartedAt = now;
        this._onStart?.();
      }
      return;
    }

    if (!this._inSpeech) return;
    if (now - this._lastVoiceAt < this._redemptionMs) return;
    if (now - this._speechStartedAt < this._minSpeechMs) return;
    this._inSpeech = false;
    this._onEnd?.();
  }
}
