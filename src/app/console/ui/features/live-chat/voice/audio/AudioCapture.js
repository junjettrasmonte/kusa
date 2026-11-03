/**
 * Microphone capture via getUserMedia + Web Audio API.
 * Delivers Float32 mono frames to VAD/STT consumers.
 */

const DEFAULT_SAMPLE_RATE = 16000;

/**
 * @typedef {object} AudioCaptureOptions
 * @property {number} [sampleRate]
 * @property {(frame: Float32Array, sampleRate: number) => void} [onFrame]
 * @property {(err: Error) => void} [onError]
 * @property {(stream: MediaStream) => void} [onStream]
 */

export class AudioCapture {
  /** @param {AudioCaptureOptions} [opts] */
  constructor(opts = {}) {
    this.sampleRate = opts.sampleRate || DEFAULT_SAMPLE_RATE;
    this.onFrame = opts.onFrame || null;
    this.onError = opts.onError || null;
    this.onStream = opts.onStream || null;
    /** @type {MediaStream|null} */
    this._stream = null;
    /** @type {AudioContext|null} */
    this._ctx = null;
    /** @type {MediaStreamAudioSourceNode|null} */
    this._source = null;
    /** @type {ScriptProcessorNode|AudioWorkletNode|null} */
    this._processor = null;
    /** @type {AnalyserNode|null} */
    this._analyser = null;
    /** @type {GainNode|null} */
    this._silent = null;
    this._running = false;
    this._enabled = true;
  }

  get running() {
    return this._running;
  }

  /** @returns {AnalyserNode|null} */
  getAnalyser() {
    return this._analyser;
  }

  /** @returns {MediaStream|null} */
  getStream() {
    return this._stream;
  }

  /**
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this._enabled = Boolean(enabled);
    if (this._stream) {
      for (const track of this._stream.getAudioTracks()) {
        track.enabled = this._enabled;
      }
    }
  }

  async start() {
    if (this._running) return;
    if (!navigator?.mediaDevices?.getUserMedia) {
      const err = new Error('Microphone capture is not available in this browser');
      this.onError?.(err);
      throw err;
    }

    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      if (wrapped.name === 'NotAllowedError' || /permission/i.test(wrapped.message)) {
        wrapped.message = 'Microphone permission denied';
      }
      this.onError?.(wrapped);
      throw wrapped;
    }

    for (const track of this._stream.getAudioTracks()) {
      track.enabled = this._enabled;
      track.addEventListener('ended', () => {
        this.onError?.(new Error('Microphone disconnected'));
      });
    }

    this.onStream?.(this._stream);

    const Ctx = window.AudioContext || window.webkitAudioContext;
    this._ctx = new Ctx({ sampleRate: this.sampleRate });
    if (this._ctx.state === 'suspended') {
      await this._ctx.resume();
    }

    this._source = this._ctx.createMediaStreamSource(this._stream);
    this._analyser = this._ctx.createAnalyser();
    this._analyser.fftSize = 512;
    this._analyser.smoothingTimeConstant = 0.5;
    this._analyser.minDecibels = -90;
    this._analyser.maxDecibels = -20;
    this._source.connect(this._analyser);

    // ScriptProcessor keeps a broad browser surface without AudioWorklet bundling.
    const bufferSize = 4096;
    const processor = this._ctx.createScriptProcessor(bufferSize, 1, 1);
    processor.onaudioprocess = (event) => {
      if (!this._running || !this._enabled) return;
      const input = event.inputBuffer.getChannelData(0);
      const frame = new Float32Array(input.length);
      frame.set(input);
      this.onFrame?.(frame, this._ctx?.sampleRate || this.sampleRate);
    };
    this._processor = processor;
    this._silent = this._ctx.createGain();
    this._silent.gain.value = 0;
    // Keep analyser in the active graph (some browsers freeze idle taps).
    this._analyser.connect(this._silent);
    this._source.connect(processor);
    processor.connect(this._silent);
    this._silent.connect(this._ctx.destination);

    this._running = true;
  }

  async stop() {
    this._running = false;
    try {
      if (this._processor) {
        this._processor.onaudioprocess = null;
        this._processor.disconnect();
      }
    } catch { /* ignore */ }
    try { this._source?.disconnect(); } catch { /* ignore */ }
    try { this._analyser?.disconnect(); } catch { /* ignore */ }
    try { this._silent?.disconnect(); } catch { /* ignore */ }
    this._processor = null;
    this._source = null;
    this._analyser = null;
    this._silent = null;

    if (this._stream) {
      for (const track of this._stream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
      this._stream = null;
    }
    if (this._ctx) {
      try { await this._ctx.close(); } catch { /* ignore */ }
      this._ctx = null;
    }
  }

  async dispose() {
    await this.stop();
  }
}
