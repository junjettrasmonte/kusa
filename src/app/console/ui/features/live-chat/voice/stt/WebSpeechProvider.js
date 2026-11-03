/**
 * Optional browser SpeechRecognition — may use cloud backends.
 * Refused when offlineOnly is enabled.
 */

/** @typedef {import('../types.js').EngineStatus} EngineStatus */
/** @typedef {import('../types.js').STTConfig} STTConfig */

function getSpeechRecognitionCtor(g = globalThis) {
  return g.SpeechRecognition || g.webkitSpeechRecognition || null;
}

export function isWebSpeechSupported(g = globalThis) {
  return typeof getSpeechRecognitionCtor(g) === 'function';
}

export class WebSpeechProvider {
  constructor() {
    /** @type {EngineStatus} */
    this._status = 'idle';
    /** @type {((text: string) => void)|null} */
    this._onInterim = null;
    /** @type {((text: string) => void)|null} */
    this._onFinal = null;
    /** @type {((error: Error) => void)|null} */
    this._onError = null;
    /** @type {SpeechRecognition|null} */
    this._rec = null;
    this._language = 'en-US';
    this._offlineOnly = false;
    this._wantRunning = false;
  }

  /** @param {STTConfig} [config] */
  async initialize(config = {}) {
    this._offlineOnly = config.offlineOnly === true;
    if (this._offlineOnly) {
      this._status = 'failed';
      throw new Error('WebSpeechProvider cannot run in offline-only mode (may use remote recognition)');
    }
    if (!isWebSpeechSupported()) {
      this._status = 'failed';
      throw new Error('SpeechRecognition is not available in this browser');
    }
    if (typeof config.language === 'string' && config.language.trim()) {
      this._language = config.language.trim();
    }
    this._status = 'ready';
  }

  async start() {
    if (this._offlineOnly) {
      throw new Error('WebSpeechProvider cannot run in offline-only mode');
    }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) throw new Error('SpeechRecognition unavailable');

    this._wantRunning = true;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this._language;
    rec.onresult = (event) => {
      let interim = '';
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result?.[0]?.transcript || '';
        if (result.isFinal) finalText += text;
        else interim += text;
      }
      if (interim.trim()) this._onInterim?.(interim.trim());
      if (finalText.trim()) this._onFinal?.(finalText.trim());
    };
    rec.onerror = (event) => {
      const err = new Error(event?.error || 'SpeechRecognition error');
      this._onError?.(err);
    };
    rec.onend = () => {
      if (this._wantRunning) {
        try { rec.start(); } catch { /* ignore restart races */ }
      }
    };
    this._rec = rec;
    this._status = 'running';
    rec.start();
  }

  async stop() {
    this._wantRunning = false;
    try { this._rec?.stop?.(); } catch { /* ignore */ }
    try { this._rec?.abort?.(); } catch { /* ignore */ }
    this._rec = null;
    this._status = 'ready';
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

  /** WebSpeech uses its own mic — frames ignored. */
  pushAudio() {}

  finishSpeech() {}
}
