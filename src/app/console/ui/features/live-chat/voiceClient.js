/**
 * Browser-native Live voice session adapter.
 * Preserves the SessionChat handle API previously backed by the Pipecat bot:
 *   startLiveVoiceSession → { stop, speak, getAudioLevels, setAgentBusy }
 *
 * Audio stays in the browser. Text turns still go through /kusa/chat via onTranscript.
 */

import { VoiceManager } from './voice/VoiceManager.js';
import { DEFAULT_VOICE_MANAGER_CONFIG } from './voice/types.js';

/**
 * @typedef {'idle'|'connecting'|'listening'|'thinking'|'speaking'|'error'} VoicePhase
 */

/**
 * Load Live Chat prefs from the console settings API (browser voice fields).
 * @returns {Promise<import('./voice/types.js').VoiceManagerConfig>}
 */
async function loadVoicePrefs() {
  try {
    const res = await fetch('/live-chat/settings', { headers: { Accept: 'application/json' } });
    if (!res.ok) return { ...DEFAULT_VOICE_MANAGER_CONFIG };
    const body = await res.json();
    return {
      ...DEFAULT_VOICE_MANAGER_CONFIG,
      sttProvider: body.sttProvider || DEFAULT_VOICE_MANAGER_CONFIG.sttProvider,
      ttsProvider: body.ttsProvider || DEFAULT_VOICE_MANAGER_CONFIG.ttsProvider,
      vadProvider: body.vadProvider || DEFAULT_VOICE_MANAGER_CONFIG.vadProvider,
      offlineOnly: body.offlineOnly !== false,
      language: body.language || 'en',
      autoSpeak: body.autoSpeak !== false,
      interruptible: body.interruptible !== false,
      voice: body.voice || DEFAULT_VOICE_MANAGER_CONFIG.voice,
      speechRate: typeof body.speechRate === 'number' ? body.speechRate : 1,
      whisperModel: (body.whisperModel && !String(body.whisperModel).includes('whisper-base'))
        ? body.whisperModel
        : DEFAULT_VOICE_MANAGER_CONFIG.whisperModel,
    };
  } catch {
    return { ...DEFAULT_VOICE_MANAGER_CONFIG };
  }
}

/**
 * Start an in-browser voice session (no WebRTC / Pipecat bot).
 *
 * @param {object} [opts]
 * @param {string} [opts.sessionId]  unused by audio path; kept for API compat
 * @param {string|null} [opts.queueKey]
 * @param {string|null} [opts.model]
 * @param {string|null} [opts.endpointId]
 * @param {(phase: VoicePhase, detail?: string) => void} [opts.onPhase]
 * @param {(err: Error) => void} [opts.onError]
 * @param {() => void} [opts.onEnded]
 * @param {(msg: { role: string, text: string, interim?: boolean }) => void} [opts.onTranscript]
 * @param {import('./voice/types.js').VoiceManagerConfig} [opts.config]
 */
export async function startLiveVoiceSession(opts = {}) {
  const {
    onPhase = null,
    onError = null,
    onEnded = null,
    onTranscript = null,
    config: configOverride = null,
  } = opts;

  onPhase?.('connecting');

  const prefs = configOverride || await loadVoicePrefs();
  const manager = new VoiceManager();
  manager.onPhase = (phase, detail) => onPhase?.(/** @type {VoicePhase} */ (phase), detail);
  manager.onError = (err) => onError?.(err);
  manager.onEnded = () => onEnded?.();
  manager.onTranscript = (info) => {
    // SessionChat only sends finals to /kusa/chat; pass interim through for UI.
    if (info.interim) {
      onTranscript?.({ role: 'user', text: info.text, interim: true });
      return;
    }
    onTranscript?.({ role: 'user', text: info.text });
  };

  let closed = false;

  try {
    await manager.initialize(prefs);
    await manager.startSession();
  } catch (err) {
    const wrapped = err instanceof Error ? err : new Error(String(err));
    onPhase?.('error', wrapped.message);
    onError?.(wrapped);
    try { await manager.dispose(); } catch { /* ignore */ }
    throw wrapped;
  }

  return {
    async stop() {
      if (closed) return;
      closed = true;
      try { await manager.dispose(); } catch { /* ignore */ }
      onPhase?.('idle');
      onEnded?.();
    },
    /**
     * @param {string} text
     */
    speak(text) {
      if (closed) return;
      void manager.speak(text);
    },
    /**
     * @param {number} [bandCount]
     */
    getAudioLevels(bandCount = 32) {
      return manager.getAudioLevels(bandCount);
    },
    /**
     * @param {boolean} busy
     */
    setAgentBusy(busy) {
      manager.setAgentBusy(busy);
    },
    /** @returns {VoiceManager} */
    getManager() {
      return manager;
    },
  };
}

export { VoiceManager } from './voice/VoiceManager.js';
export { detectVoiceCapabilities } from './voice/capabilities.js';
export { voiceProviders, listProviderIds, PROVIDER_LABELS } from './voice/registry.js';
export { VoiceModelManager, VOICE_MODEL_CATALOG } from './voice/VoiceModelManager.js';
export {
  DEFAULT_VOICE_MANAGER_CONFIG,
  DEFAULT_WHISPER_MODEL,
  DEFAULT_KOKORO_VOICE,
} from './voice/types.js';
