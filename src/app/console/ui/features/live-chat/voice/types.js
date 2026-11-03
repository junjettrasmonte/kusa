/**
 * Shared typedefs for browser-native voice engines.
 * @module
 */

/**
 * @typedef {'idle'|'initializing'|'ready'|'running'|'stopping'|'error'|'not_installed'|'downloading'|'failed'} EngineStatus
 */

/**
 * @typedef {object} STTConfig
 * @property {string} [language]
 * @property {string} [modelId]
 * @property {boolean} [offlineOnly]
 * @property {'webgpu'|'wasm'|'auto'} [device]
 */

/**
 * @typedef {object} TTSConfig
 * @property {string} [voice]
 * @property {number} [rate]
 * @property {number} [pitch]
 * @property {number} [volume]
 * @property {boolean} [offlineOnly]
 * @property {'webgpu'|'wasm'|'auto'} [device]
 */

/**
 * @typedef {object} VADConfig
 * @property {number} [positiveSpeechThreshold]
 * @property {number} [negativeSpeechThreshold]
 * @property {number} [redemptionMs]
 * @property {number} [minSpeechMs]
 * @property {number} [energyThreshold]
 * @property {boolean} [offlineOnly]
 * @property {'webgpu'|'wasm'|'auto'} [device]
 */

/**
 * @typedef {object} VoiceManagerConfig
 * @property {string} [sttProvider]
 * @property {string} [ttsProvider]
 * @property {string} [vadProvider]
 * @property {boolean} [offlineOnly]
 * @property {string} [language]
 * @property {boolean} [autoSpeak]
 * @property {boolean} [interruptible]
 * @property {string} [voice]
 * @property {number} [speechRate]
 * @property {string} [whisperModel]
 * @property {'webgpu'|'wasm'|'auto'} [device]
 */

/**
 * @typedef {object} ModelAsset
 * @property {string} id
 * @property {string} engine  stt|tts|vad
 * @property {string} provider
 * @property {string} label
 * @property {string} version
 * @property {number} [bytesEstimate]
 * @property {string[]} [urls]
 * @property {string} [checksum]
 */

/**
 * @typedef {'not_installed'|'downloading'|'ready'|'initializing'|'running'|'failed'} ModelLifecycleStatus
 */

export const ENGINE_STATUSES = Object.freeze([
  'idle',
  'initializing',
  'ready',
  'running',
  'stopping',
  'error',
  'not_installed',
  'downloading',
  'failed',
]);

export const MODEL_LIFECYCLE = Object.freeze([
  'not_installed',
  'downloading',
  'ready',
  'initializing',
  'running',
  'failed',
]);

/** Default Whisper model (Transformers.js / ONNX community). */
export const DEFAULT_WHISPER_MODEL = 'onnx-community/whisper-tiny.en';

/** Optional larger Whisper model. */
export const WHISPER_BASE_MODEL = 'onnx-community/whisper-base.en';

/** Default Kokoro voice. */
export const DEFAULT_KOKORO_VOICE = 'af_heart';

export const DEFAULT_VOICE_MANAGER_CONFIG = Object.freeze({
  sttProvider: 'whisper',
  ttsProvider: 'kokoro',
  vadProvider: 'silero',
  offlineOnly: true,
  language: 'en',
  autoSpeak: true,
  interruptible: true,
  voice: DEFAULT_KOKORO_VOICE,
  speechRate: 1,
  whisperModel: DEFAULT_WHISPER_MODEL,
  device: 'auto',
});
