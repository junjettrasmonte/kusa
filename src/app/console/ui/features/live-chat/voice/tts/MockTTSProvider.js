/**
 * Mock TTS — resolves after a short delay without producing audio.
 */

/** @typedef {import('../types.js').EngineStatus} EngineStatus */
/** @typedef {import('../types.js').TTSConfig} TTSConfig */

export class MockTTSProvider {
  constructor() {
    /** @type {EngineStatus} */
    this._status = 'idle';
    this._paused = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._timer = null;
    /** @type {((text: string) => void)|null} */
    this.onSpeakStart = null;
    /** @type {((text: string) => void)|null} */
    this.onSpeakEnd = null;
    this._msPerChar = 8;
  }

  /** @param {TTSConfig} [_config] */
  async initialize(_config = {}) {
    this._status = 'ready';
  }

  /**
   * @param {string} text
   * @returns {Promise<void>}
   */
  speak(text) {
    const cleaned = String(text || '').trim();
    if (!cleaned) return Promise.resolve();
    this._status = 'running';
    this.onSpeakStart?.(cleaned);
    const delay = Math.min(2000, Math.max(80, cleaned.length * this._msPerChar));
    return new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      const wait = () => {
        if (this._paused) {
          this._timer = setTimeout(wait, 40);
          return;
        }
        this._timer = setTimeout(() => {
          this._timer = null;
          this._status = 'ready';
          this._resolve = null;
          this._reject = null;
          this.onSpeakEnd?.(cleaned);
          resolve();
        }, delay);
      };
      wait();
    });
  }

  async stop() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const reject = this._reject;
    this._resolve = null;
    this._reject = null;
    this._paused = false;
    this._status = 'ready';
    reject?.(new Error('TTS stopped'));
  }

  async pause() {
    this._paused = true;
  }

  async resume() {
    this._paused = false;
  }

  async dispose() {
    await this.stop();
    this._status = 'idle';
  }

  /** @returns {EngineStatus} */
  getStatus() {
    return this._status;
  }
}
