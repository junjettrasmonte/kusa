/**
 * Independent STT / TTS / VAD provider registry.
 * Heavy offline engines (Whisper / Kokoro / Silero) load via dynamic import.
 */

import { MockSTTProvider } from './stt/MockSTTProvider.js';
import { WebSpeechProvider } from './stt/WebSpeechProvider.js';
import { MockTTSProvider } from './tts/MockTTSProvider.js';
import { BrowserSpeechProvider } from './tts/BrowserSpeechProvider.js';
import { EnergyVADProvider } from './vad/EnergyVADProvider.js';
import { MockVADProvider } from './vad/MockVADProvider.js';
import { providerMayUseNetwork } from './capabilities.js';

/** Sync / light providers available without async chunk load. */
const lightProviders = {
  stt: {
    webSpeech: WebSpeechProvider,
    mock: MockSTTProvider,
  },
  tts: {
    browserSpeech: BrowserSpeechProvider,
    mock: MockTTSProvider,
  },
  vad: {
    energy: EnergyVADProvider,
    mock: MockVADProvider,
  },
};

/**
 * Catalog of provider ids (including lazy offline engines).
 * Values are either a constructor or an async factory.
 */
export const voiceProviders = {
  stt: {
    whisper: null,
    webSpeech: WebSpeechProvider,
    mock: MockSTTProvider,
  },
  tts: {
    kokoro: null,
    browserSpeech: BrowserSpeechProvider,
    mock: MockTTSProvider,
  },
  vad: {
    silero: null,
    energy: EnergyVADProvider,
    mock: MockVADProvider,
  },
};

/**
 * @param {'stt'|'tts'|'vad'} kind
 * @returns {string[]}
 */
export function listProviderIds(kind) {
  return Object.keys(voiceProviders[kind] || {});
}

/**
 * @param {'stt'|'tts'|'vad'} kind
 * @param {string} id
 * @param {{ offlineOnly?: boolean }} [opts]
 */
export async function createProvider(kind, id, opts = {}) {
  const map = voiceProviders[kind];
  if (!map || !(id in map)) {
    throw new Error(`Unknown ${kind} provider: ${id}`);
  }
  if (opts.offlineOnly && providerMayUseNetwork(kind, id)) {
    throw new Error(
      `${id} is not available in offline-only mode (may use network processing)`,
    );
  }

  if (kind === 'stt' && id === 'whisper') {
    const { WhisperProvider } = await import('./stt/WhisperProvider.js');
    return new WhisperProvider();
  }
  if (kind === 'tts' && id === 'kokoro') {
    const { KokoroProvider } = await import('./tts/KokoroProvider.js');
    return new KokoroProvider();
  }
  if (kind === 'vad' && id === 'silero') {
    const { SileroVADProvider } = await import('./vad/SileroVADProvider.js');
    return new SileroVADProvider();
  }

  const Ctor = lightProviders[kind]?.[id] || map[id];
  if (typeof Ctor !== 'function') {
    throw new Error(`Unknown ${kind} provider: ${id}`);
  }
  return new Ctor();
}

/** Sync create for light/mock providers (tests). */
export function createProviderSync(kind, id, opts = {}) {
  if (opts.offlineOnly && providerMayUseNetwork(kind, id)) {
    throw new Error(
      `${id} is not available in offline-only mode (may use network processing)`,
    );
  }
  const Ctor = lightProviders[kind]?.[id];
  if (!Ctor) {
    throw new Error(`Provider ${kind}/${id} requires async createProvider()`);
  }
  return new Ctor();
}

export const PROVIDER_LABELS = {
  stt: {
    whisper: 'Whisper (local)',
    webSpeech: 'Web Speech API',
    mock: 'Mock STT',
  },
  tts: {
    kokoro: 'Kokoro (local)',
    browserSpeech: 'Browser SpeechSynthesis',
    mock: 'Mock TTS',
  },
  vad: {
    silero: 'Silero VAD (local)',
    energy: 'Energy VAD',
    mock: 'Mock VAD',
  },
};
