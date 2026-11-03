/**
 * Mock STT for tests and UI development — no microphone / model required.
 */

/** @typedef {import('../types.js').EngineStatus} EngineStatus */
/** @typedef {import('../types.js').STTConfig} STTConfig */

export class MockSTTProvider {
  constructor() {
    /** @type {EngineStatus} */
    this._status = 'idle';
    /** @type {((text: string) => void)|null} */
    this._onInterim = null;
    /** @type {((text: string) => void)|null} */
    this._onFinal = null;
    /** @type {((error: Error) => void)|null} */
    this._onError = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._timer = null;
    this._script = ['Hello from mock speech', 'This is a test transcript'];
    this._scriptIndex = 0;
    /** @type {Float32Array[]} */
    this._chunks = [];
  }

  /** @param {STTConfig} [_config] */
  async initialize(_config = {}) {
    this._status = 'ready';
  }

  async start() {
    this._status = 'running';
    this._chunks = [];
  }

  async stop() {
    this._status = 'ready';
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  async dispose() {
    await this.stop();
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
   * Optional: accumulate frames (ignored for mock).
   * @param {Float32Array} frame
   */
  pushAudio(frame) {
    if (this._status !== 'running') return;
    this._chunks.push(frame);
  }

  /**
   * Simulate a recognition turn (interim then final).
   * @param {string} [text]
   */
  simulateUtterance(text) {
    const finalText = String(text || this._script[this._scriptIndex % this._script.length] || '').trim();
    this._scriptIndex += 1;
    if (!finalText) return;
    const words = finalText.split(/\s+/);
    let partial = '';
    words.forEach((word, i) => {
      partial = partial ? `${partial} ${word}` : word;
      const snapshot = partial;
      setTimeout(() => {
        if (this._status !== 'running') return;
        this._onInterim?.(snapshot);
        if (i === words.length - 1) this._onFinal?.(snapshot);
      }, 20 * (i + 1));
    });
  }

  /** Finalize whatever was last simulated without more audio. */
  finishSpeech() {
    if (this._status !== 'running') return;
    // No-op: simulateUtterance already emits final.
  }
}
