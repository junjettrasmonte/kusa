/**
 * Silero VAD via @ricky0123/vad-web (ONNX Runtime Web).
 * Prefers WebGPU when the runtime supports it; WASM otherwise.
 */

/** @typedef {import('../types.js').EngineStatus} EngineStatus */
/** @typedef {import('../types.js').VADConfig} VADConfig */

export class SileroVADProvider {
  constructor() {
    /** @type {EngineStatus} */
    this._status = 'idle';
    /** @type {(() => void)|null} */
    this._onStart = null;
    /** @type {(() => void)|null} */
    this._onEnd = null;
    /** @type {any} */
    this._micVad = null;
    this._positive = 0.5;
    this._negative = 0.35;
    this._redemptionMs = 400;
    this._minSpeechMs = 120;
    this._offlineOnly = true;
    this._device = 'auto';
    /** @type {MediaStream|null} */
    this._externalStream = null;
    this._useFramePath = false;
    /** Frame-path energy fallback if MicVAD cannot bind an external stream. */
    this._energy = null;
  }

  /** @param {VADConfig & { mediaStream?: MediaStream }} [config] */
  async initialize(config = {}) {
    this._status = 'initializing';
    this._offlineOnly = config.offlineOnly !== false;
    this._device = config.device || 'auto';
    if (typeof config.positiveSpeechThreshold === 'number') {
      this._positive = config.positiveSpeechThreshold;
    }
    if (typeof config.negativeSpeechThreshold === 'number') {
      this._negative = config.negativeSpeechThreshold;
    }
    if (typeof config.redemptionMs === 'number') {
      this._redemptionMs = config.redemptionMs;
    }
    if (typeof config.minSpeechMs === 'number') {
      this._minSpeechMs = config.minSpeechMs;
    }
    if (config.mediaStream) this._externalStream = config.mediaStream;

    try {
      await import('@ricky0123/vad-web');
      this._status = 'ready';
    } catch (err) {
      // Fall back to energy VAD path when the package is unavailable in tests.
      const { EnergyVADProvider } = await import('./EnergyVADProvider.js');
      this._energy = new EnergyVADProvider();
      await this._energy.initialize({
        energyThreshold: 0.015,
        redemptionMs: this._redemptionMs,
        minSpeechMs: this._minSpeechMs,
      });
      this._useFramePath = true;
      this._status = 'ready';
      this._initError = err instanceof Error ? err : new Error(String(err));
    }
  }

  /** Bundled Silero + ORT WASM paths under /voice-models/. */
  _bundledVadOptions() {
    return {
      baseAssetPath: '/voice-models/silero/',
      onnxWASMBasePath: '/voice-models/ort/',
      model: 'v5',
      // MicVAD maps model id → silero_vad_v5.onnx under baseAssetPath.
    };
  }

  /**
   * Bind an existing mic stream (from AudioCapture) before start().
   * @param {MediaStream} stream
   */
  setMediaStream(stream) {
    this._externalStream = stream;
  }

  async start() {
    if (this._useFramePath && this._energy) {
      this._energy.onSpeechStart(() => this._onStart?.());
      this._energy.onSpeechEnd(() => this._onEnd?.());
      await this._energy.start();
      this._status = 'running';
      return;
    }

    const vadMod = await import('@ricky0123/vad-web');
    const MicVAD = vadMod.MicVAD;
    if (!MicVAD) {
      throw new Error('Silero MicVAD unavailable');
    }

    const opts = {
      ...this._bundledVadOptions(),
      positiveSpeechThreshold: this._positive,
      negativeSpeechThreshold: this._negative,
      redemptionFrames: Math.max(1, Math.round(this._redemptionMs / 32)),
      minSpeechFrames: Math.max(1, Math.round(this._minSpeechMs / 32)),
      onSpeechStart: () => this._onStart?.(),
      onSpeechEnd: () => this._onEnd?.(),
    };

    // getStream lets us reuse AudioCapture's permissioned track when present.
    if (this._externalStream) {
      opts.getStream = async () => this._externalStream;
      opts.pauseStream = async () => {};
      opts.resumeStream = async (s) => s;
    }

    this._micVad = await MicVAD.new(opts);
    await this._micVad.start();
    this._status = 'running';
  }

  async stop() {
    if (this._energy) {
      await this._energy.stop();
    }
    try {
      await this._micVad?.pause?.();
    } catch { /* ignore */ }
    try {
      this._micVad?.destroy?.();
    } catch { /* ignore */ }
    this._micVad = null;
    this._status = 'ready';
  }

  async dispose() {
    await this.stop();
    if (this._energy) await this._energy.dispose();
    this._energy = null;
    this._status = 'idle';
    this._onStart = null;
    this._onEnd = null;
    this._externalStream = null;
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
   * Used when MicVAD owns the mic separately — still accept frames for energy fallback.
   * @param {Float32Array} frame
   * @param {number} [sampleRate]
   */
  processAudio(frame, sampleRate) {
    if (this._useFramePath && this._energy) {
      this._energy.processAudio(frame, sampleRate);
    }
  }
}
