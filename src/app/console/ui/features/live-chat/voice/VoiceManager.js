/**
 * Coordinates AudioCapture, VAD, STT, TTS, and playback without owning chat history.
 */

import { AudioCapture } from './audio/AudioCapture.js';
import { AudioPlayback, readAnalyserLevels } from './audio/AudioPlayback.js';
import { createProvider } from './registry.js';
import { VoiceModelManager } from './VoiceModelManager.js';
import { DEFAULT_VOICE_MANAGER_CONFIG, DEFAULT_WHISPER_MODEL } from './types.js';
import { detectVoiceCapabilities } from './capabilities.js';

/** @typedef {import('./types.js').VoiceManagerConfig} VoiceManagerConfig */
/** @typedef {import('./types.js').EngineStatus} EngineStatus */

export class VoiceManager {
  constructor() {
    /** @type {VoiceManagerConfig} */
    this._config = { ...DEFAULT_VOICE_MANAGER_CONFIG };
    this._models = new VoiceModelManager();
    this._capture = new AudioCapture({
      onFrame: (frame, rate) => this._onAudioFrame(frame, rate),
      onError: (err) => this._emitError(err),
    });
    this._playback = new AudioPlayback();
    this._playback.onPlayingChange = (playing) => {
      if (playing) this._setPhase('speaking');
      else if (this._listening && !this._agentBusy) this._setPhase('listening');
    };

    /** @type {any} */
    this._stt = null;
    /** @type {any} */
    this._tts = null;
    /** @type {any} */
    this._vad = null;

    this._listening = false;
    this._agentBusy = false;
    this._speechOpen = false;
    /** @type {Float32Array[]} */
    this._utterance = [];
    this._phase = 'idle';
    this._speakGeneration = 0;
    /** @type {string[]} */
    this._speakQueue = [];
    this._speakPumping = false;

    /** @type {((phase: string, detail?: string) => void)|null} */
    this.onPhase = null;
    /** @type {((err: Error) => void)|null} */
    this.onError = null;
    /** @type {((info: { role: string, text: string, interim?: boolean }) => void)|null} */
    this.onTranscript = null;
    /** @type {(() => void)|null} */
    this.onEnded = null;
  }

  get modelManager() {
    return this._models;
  }

  get config() {
    return { ...this._config };
  }

  /**
   * @param {VoiceManagerConfig} [config]
   */
  async initialize(config = {}) {
    this._setPhase('connecting');
    this._config = {
      ...DEFAULT_VOICE_MANAGER_CONFIG,
      ...config,
    };

    const caps = await detectVoiceCapabilities();
    if (!caps.getUserMedia) {
      throw new Error('Microphone capture is not available in this browser');
    }

    await this._models.assertReadyFor({
      sttProvider: this._config.sttProvider,
      ttsProvider: this._config.ttsProvider,
      vadProvider: this._config.vadProvider,
      whisperModel: this._config.whisperModel,
      offlineOnly: this._config.offlineOnly,
    });

    this._stt = await createProvider('stt', this._config.sttProvider, {
      offlineOnly: this._config.offlineOnly,
    });
    this._tts = await createProvider('tts', this._config.ttsProvider, {
      offlineOnly: this._config.offlineOnly,
    });
    this._vad = await createProvider('vad', this._config.vadProvider, {
      offlineOnly: this._config.offlineOnly,
    });

    this._stt.onInterimResult?.((text) => {
      this.onTranscript?.({ role: 'user', text, interim: true });
    });
    this._stt.onFinalResult?.((text) => {
      const trimmed = String(text || '').trim();
      if (!trimmed) return;
      this.onTranscript?.({ role: 'user', text: trimmed, interim: false });
    });
    this._stt.onError?.((err) => this._emitError(err));

    this._vad.onSpeechStart?.(() => {
      this._speechOpen = true;
      this._utterance = [];
      this._stt?.markSpeechStart?.();
      if (this._config.interruptible && (this._playback.playing || this._speakQueue.length)) {
        void this.stopSpeaking();
      }
      if (!this._agentBusy) this._setPhase('listening');
    });
    this._vad.onSpeechEnd?.(() => {
      this._speechOpen = false;
      void this._finalizeUtterance();
    });

    if (typeof this._tts.setPlayback === 'function') {
      this._tts.setPlayback(this._playback);
    }

    try {
      await this._stt.initialize({
        language: this._config.language,
        modelId: this._config.whisperModel || DEFAULT_WHISPER_MODEL,
        offlineOnly: this._config.offlineOnly,
        device: this._config.device,
      });
      if (this._config.sttProvider === 'whisper') {
        await this._models.markReady(this._config.whisperModel || DEFAULT_WHISPER_MODEL);
      }
    } catch (err) {
      this._setPhase('error', err instanceof Error ? err.message : String(err));
      throw err;
    }

    try {
      await this._tts.initialize({
        voice: this._config.voice,
        rate: this._config.speechRate,
        language: this._config.language || 'en',
        offlineOnly: this._config.offlineOnly,
        device: this._config.device,
      });
      if (this._config.ttsProvider === 'kokoro') {
        await this._models.markReady('onnx-community/Kokoro-82M-v1.0-ONNX');
      }
    } catch (err) {
      this._setPhase('error', err instanceof Error ? err.message : String(err));
      throw err;
    }

    try {
      await this._vad.initialize({
        offlineOnly: this._config.offlineOnly,
        device: this._config.device,
      });
      if (this._config.vadProvider === 'silero') {
        await this._models.markReady('silero-vad');
      }
    } catch (err) {
      this._setPhase('error', err instanceof Error ? err.message : String(err));
      throw err;
    }

    this._setPhase('idle');
  }

  async startSession() {
    await this.startListening();
  }

  async endSession() {
    await this.stopListening();
    await this.stopSpeaking();
    this._setPhase('idle');
    this.onEnded?.();
  }

  async startListening() {
    if (this._listening) return;
    await this._capture.start();
    const stream = this._capture.getStream();
    if (stream && typeof this._vad.setMediaStream === 'function') {
      this._vad.setMediaStream(stream);
    }
    await this._stt.start();
    await this._vad.start();
    this._listening = true;
    this._capture.setEnabled(!this._agentBusy);
    this._setPhase(this._agentBusy ? 'thinking' : 'listening');
  }

  async stopListening() {
    this._listening = false;
    try { await this._vad?.stop?.(); } catch { /* ignore */ }
    try { await this._stt?.stop?.(); } catch { /* ignore */ }
    try { await this._capture.stop(); } catch { /* ignore */ }
  }

  /**
   * Queue text for TTS (sentence-level from SessionChat).
   * @param {string} text
   */
  async speak(text) {
    if (!this._config.autoSpeak) return;
    const cleaned = String(text || '').trim();
    if (!cleaned) return;
    const generation = this._speakGeneration;
    this._speakQueue.push(cleaned);
    await this._pumpSpeakQueue(generation);
  }

  async stopSpeaking() {
    this._speakGeneration += 1;
    this._speakQueue = [];
    this._speakPumping = false;
    try { await this._tts?.stop?.(); } catch { /* ignore */ }
    this._playback.nextGeneration();
    if (this._listening && !this._agentBusy) this._setPhase('listening');
  }

  /**
   * @param {boolean} busy
   */
  setAgentBusy(busy) {
    this._agentBusy = Boolean(busy);
    // Mute mic while tools/thinking to reduce false barge-ins; still allow
    // interruptible TTS when speech starts if interruptible is on.
    this._capture.setEnabled(!this._agentBusy || this._config.interruptible);
    if (this._agentBusy && this._listening && !this._playback.playing) {
      this._setPhase('thinking');
    } else if (!this._agentBusy && this._listening && !this._playback.playing) {
      this._setPhase('listening');
    }
  }

  /**
   * Spectrum levels for LiveVoiceSpectrum (`speak` / `listen` rings).
   * @param {number} [bandCount]
   */
  getAudioLevels(bandCount = 32) {
    const mic = readAnalyserLevels(this._capture.getAnalyser(), bandCount);
    const play = readAnalyserLevels(this._playback.getAnalyser(), bandCount);
    const empty = Array(bandCount).fill(0);
    return {
      // Shape expected by LiveVoiceSpectrum.jsx
      listen: {
        bands: mic?.bands || empty,
        rms: mic?.rms || 0,
      },
      speak: {
        bands: play?.bands || empty,
        rms: play?.rms || 0,
      },
      // Legacy aliases
      mic: mic?.bands || empty,
      play: play?.bands || empty,
      micPeak: mic?.peak || 0,
      playPeak: play?.peak || 0,
      bands: mic?.bands || play?.bands || empty,
      rms: Math.max(mic?.rms || 0, play?.rms || 0),
    };
  }

  async dispose() {
    await this.endSession();
    try { await this._stt?.dispose?.(); } catch { /* ignore */ }
    try { await this._tts?.dispose?.(); } catch { /* ignore */ }
    try { await this._vad?.dispose?.(); } catch { /* ignore */ }
    try { await this._capture.dispose(); } catch { /* ignore */ }
    try { await this._playback.dispose(); } catch { /* ignore */ }
    this._stt = null;
    this._tts = null;
    this._vad = null;
  }

  /**
   * @param {Float32Array} frame
   * @param {number} sampleRate
   */
  _onAudioFrame(frame, sampleRate) {
    if (!this._listening) return;
    this._vad?.processAudio?.(frame, sampleRate);
    if (this._speechOpen) {
      this._utterance.push(frame);
      this._stt?.pushAudio?.(frame, sampleRate);
    }
  }

  async _finalizeUtterance() {
    if (typeof this._stt.finishSpeech === 'function') {
      await this._stt.finishSpeech();
      return;
    }
    // Mock / providers without finishSpeech: if they expose simulate, skip.
  }

  /**
   * @param {number} generation
   */
  async _pumpSpeakQueue(generation) {
    if (this._speakPumping) return;
    this._speakPumping = true;
    try {
      while (this._speakQueue.length && generation === this._speakGeneration) {
        const next = this._speakQueue.shift();
        if (!next) continue;
        this._setPhase('speaking');
        try {
          await this._tts.speak(next);
        } catch (err) {
          this._emitError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    } finally {
      this._speakPumping = false;
      if (generation === this._speakGeneration && this._listening && !this._agentBusy) {
        this._setPhase('listening');
      }
    }
  }

  /**
   * @param {string} phase
   * @param {string} [detail]
   */
  _setPhase(phase, detail) {
    this._phase = phase;
    this.onPhase?.(phase, detail);
  }

  /** @param {Error} err */
  _emitError(err) {
    this.onError?.(err);
    this._setPhase('error', err.message);
  }
}
