/**
 * Browser SpeechSynthesis fallback — not guaranteed offline.
 * Refused when offlineOnly is enabled.
 */

/** @typedef {import('../types.js').EngineStatus} EngineStatus */
/** @typedef {import('../types.js').TTSConfig} TTSConfig */

export function isBrowserSpeechSupported(g = globalThis) {
  return Boolean(g.speechSynthesis) && typeof g.SpeechSynthesisUtterance === 'function';
}

export class BrowserSpeechProvider {
  constructor() {
    /** @type {EngineStatus} */
    this._status = 'idle';
    this._voice = '';
    this._rate = 1;
    this._pitch = 1;
    this._volume = 1;
    this._offlineOnly = false;
    /** @type {SpeechSynthesisUtterance|null} */
    this._current = null;
  }

  /** @param {TTSConfig} [config] */
  async initialize(config = {}) {
    this._offlineOnly = config.offlineOnly === true;
    if (this._offlineOnly) {
      this._status = 'failed';
      throw new Error('BrowserSpeechProvider cannot run in offline-only mode');
    }
    if (!isBrowserSpeechSupported()) {
      this._status = 'failed';
      throw new Error('speechSynthesis is not available in this browser');
    }
    if (typeof config.voice === 'string') this._voice = config.voice;
    if (typeof config.rate === 'number') this._rate = config.rate;
    if (typeof config.pitch === 'number') this._pitch = config.pitch;
    if (typeof config.volume === 'number') this._volume = config.volume;
    // Chrome often populates voices asynchronously.
    try { speechSynthesis.getVoices(); } catch { /* ignore */ }
    this._status = 'ready';
  }

  listVoices() {
    if (!isBrowserSpeechSupported()) return [];
    return speechSynthesis.getVoices().map((v) => ({
      id: v.voiceURI || v.name,
      label: v.name,
      lang: v.lang,
      localService: v.localService === true,
    }));
  }

  /**
   * @param {string} text
   * @returns {Promise<void>}
   */
  speak(text) {
    if (this._offlineOnly) {
      return Promise.reject(new Error('BrowserSpeechProvider cannot run in offline-only mode'));
    }
    const cleaned = String(text || '').trim();
    if (!cleaned) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const utter = new SpeechSynthesisUtterance(cleaned);
      utter.rate = this._rate;
      utter.pitch = this._pitch;
      utter.volume = this._volume;
      const voices = speechSynthesis.getVoices();
      if (this._voice) {
        const match = voices.find((v) => v.voiceURI === this._voice || v.name === this._voice);
        if (match) utter.voice = match;
      }
      this._current = utter;
      this._status = 'running';
      utter.onend = () => {
        this._current = null;
        this._status = 'ready';
        resolve();
      };
      utter.onerror = (event) => {
        this._current = null;
        this._status = 'ready';
        reject(new Error(event?.error || 'speechSynthesis error'));
      };
      speechSynthesis.speak(utter);
    });
  }

  async stop() {
    try { speechSynthesis.cancel(); } catch { /* ignore */ }
    this._current = null;
    this._status = 'ready';
  }

  async pause() {
    try { speechSynthesis.pause(); } catch { /* ignore */ }
  }

  async resume() {
    try { speechSynthesis.resume(); } catch { /* ignore */ }
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
