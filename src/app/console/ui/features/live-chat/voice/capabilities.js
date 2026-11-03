/**
 * Progressive capability probes for browser-native voice.
 * Never assumes WebGPU from the host GPU vendor alone.
 */

/**
 * @typedef {object} VoiceCapabilities
 * @property {boolean} webgpu
 * @property {boolean} wasm
 * @property {boolean} audioWorklet
 * @property {boolean} getUserMedia
 * @property {boolean} speechRecognition
 * @property {boolean} speechSynthesis
 * @property {boolean} opfs
 * @property {boolean} indexedDB
 * @property {string} [webgpuError]
 */

/**
 * @param {typeof globalThis} [g]
 * @returns {Promise<VoiceCapabilities>}
 */
export async function detectVoiceCapabilities(g = globalThis) {
  const wasm = typeof g.WebAssembly === 'object'
    && typeof g.WebAssembly.instantiate === 'function';

  let webgpu = false;
  let webgpuError = '';
  try {
    const gpu = g.navigator?.gpu;
    if (gpu && typeof gpu.requestAdapter === 'function') {
      const adapter = await gpu.requestAdapter();
      webgpu = Boolean(adapter);
      if (!adapter) webgpuError = 'No WebGPU adapter';
    } else {
      webgpuError = 'navigator.gpu unavailable';
    }
  } catch (err) {
    webgpuError = err?.message || String(err);
  }

  let audioWorklet = false;
  try {
    audioWorklet = typeof g.AudioWorkletNode === 'function'
      && typeof g.AudioContext === 'function';
  } catch {
    audioWorklet = false;
  }

  const getUserMedia = Boolean(
    g.navigator?.mediaDevices
    && typeof g.navigator.mediaDevices.getUserMedia === 'function',
  );

  const SpeechRecognition = g.SpeechRecognition || g.webkitSpeechRecognition;
  const speechRecognition = typeof SpeechRecognition === 'function';
  const speechSynthesis = Boolean(g.speechSynthesis)
    && typeof g.SpeechSynthesisUtterance === 'function';

  let opfs = false;
  try {
    opfs = Boolean(g.navigator?.storage?.getDirectory);
  } catch {
    opfs = false;
  }

  let indexedDB = false;
  try {
    indexedDB = typeof g.indexedDB === 'object' && g.indexedDB != null;
  } catch {
    indexedDB = false;
  }

  return {
    webgpu,
    wasm,
    audioWorklet,
    getUserMedia,
    speechRecognition,
    speechSynthesis,
    opfs,
    indexedDB,
    webgpuError: webgpu ? '' : webgpuError,
  };
}

/**
 * Resolve preferred inference device given caps + user preference.
 * @param {'webgpu'|'wasm'|'auto'} [preference]
 * @param {VoiceCapabilities} caps
 * @returns {'webgpu'|'wasm'}
 */
export function resolveInferenceDevice(preference = 'auto', caps) {
  if (preference === 'wasm') return 'wasm';
  if (preference === 'webgpu') return caps.webgpu ? 'webgpu' : 'wasm';
  return caps.webgpu ? 'webgpu' : 'wasm';
}

/**
 * Providers that may use remote/cloud recognition or synthesis.
 * @param {string} kind  stt|tts
 * @param {string} providerId
 * @returns {boolean}
 */
export function providerMayUseNetwork(kind, providerId) {
  if (kind === 'stt' && providerId === 'webSpeech') return true;
  if (kind === 'tts' && providerId === 'browserSpeech') return true;
  return false;
}
