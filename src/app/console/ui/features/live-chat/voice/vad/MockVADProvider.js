/**
 * Mock VAD — call simulateSpeechStart/End from tests or UI.
 */

/** @typedef {import('../types.js').EngineStatus} EngineStatus */
/** @typedef {import('../types.js').VADConfig} VADConfig */

export class MockVADProvider {
  constructor() {
    /** @type {EngineStatus} */
    this._status = 'idle';
    /** @type {(() => void)|null} */
    this._onStart = null;
    /** @type {(() => void)|null} */
    this._onEnd = null;
    this._inSpeech = false;
  }

  /** @param {VADConfig} [_config] */
  async initialize(_config = {}) {
    this._status = 'ready';
  }

  async start() {
    this._status = 'running';
  }

  async stop() {
    this._status = 'ready';
    this._inSpeech = false;
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

  /** @param {Float32Array} [_frame] */
  processAudio(_frame) {
    // no-op
  }

  simulateSpeechStart() {
    if (this._status !== 'running' || this._inSpeech) return;
    this._inSpeech = true;
    this._onStart?.();
  }

  simulateSpeechEnd() {
    if (this._status !== 'running' || !this._inSpeech) return;
    this._inSpeech = false;
    this._onEnd?.();
  }
}
