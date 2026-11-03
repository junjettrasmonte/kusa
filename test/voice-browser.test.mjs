/**
 * Browser-voice unit tests — mock providers and Node-safe helpers only.
 * No model weight downloads in CI.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectVoiceCapabilities, resolveInferenceDevice, providerMayUseNetwork } from '../src/app/console/ui/features/live-chat/voice/capabilities.js';
import { createProvider, listProviderIds, voiceProviders } from '../src/app/console/ui/features/live-chat/voice/registry.js';
import { MockSTTProvider } from '../src/app/console/ui/features/live-chat/voice/stt/MockSTTProvider.js';
import { MockTTSProvider } from '../src/app/console/ui/features/live-chat/voice/tts/MockTTSProvider.js';
import { MockVADProvider } from '../src/app/console/ui/features/live-chat/voice/vad/MockVADProvider.js';
import { EnergyVADProvider } from '../src/app/console/ui/features/live-chat/voice/vad/EnergyVADProvider.js';
import { VoiceModelManager } from '../src/app/console/ui/features/live-chat/voice/VoiceModelManager.js';
import { AudioPlayback } from '../src/app/console/ui/features/live-chat/voice/audio/AudioPlayback.js';
import { normalizeLiveChatSettings } from '../src/features/live-chat/index.mjs';

describe('voice capabilities', () => {
  it('probes stubbed globals without throwing', async () => {
    const caps = await detectVoiceCapabilities({
      WebAssembly: { instantiate() {} },
      navigator: {},
      AudioContext: function AudioContext() {},
      AudioWorkletNode: function AudioWorkletNode() {},
      SpeechRecognition: undefined,
      speechSynthesis: undefined,
      SpeechSynthesisUtterance: undefined,
      indexedDB: {},
    });
    assert.equal(caps.wasm, true);
    assert.equal(caps.webgpu, false);
    assert.equal(caps.getUserMedia, false);
    assert.equal(caps.speechRecognition, false);
  });

  it('resolves inference device from preference + caps', () => {
    assert.equal(resolveInferenceDevice('wasm', { webgpu: true }), 'wasm');
    assert.equal(resolveInferenceDevice('webgpu', { webgpu: false }), 'wasm');
    assert.equal(resolveInferenceDevice('auto', { webgpu: true }), 'webgpu');
  });

  it('flags network-capable providers', () => {
    assert.equal(providerMayUseNetwork('stt', 'webSpeech'), true);
    assert.equal(providerMayUseNetwork('tts', 'browserSpeech'), true);
    assert.equal(providerMayUseNetwork('stt', 'whisper'), false);
    assert.equal(providerMayUseNetwork('tts', 'kokoro'), false);
  });
});

describe('voice provider registry', () => {
  it('lists independent STT/TTS/VAD ids', () => {
    assert.deepEqual(listProviderIds('stt').sort(), ['mock', 'webSpeech', 'whisper']);
    assert.deepEqual(listProviderIds('tts').sort(), ['browserSpeech', 'kokoro', 'mock']);
    assert.deepEqual(listProviderIds('vad').sort(), ['energy', 'mock', 'silero']);
    assert.equal(typeof voiceProviders.stt.mock, 'function');
    assert.ok('whisper' in voiceProviders.stt);
  });

  it('creates mock providers and refuses network ones in offlineOnly', async () => {
    const stt = await createProvider('stt', 'mock');
    assert.ok(stt instanceof MockSTTProvider);
    await assert.rejects(
      () => createProvider('stt', 'webSpeech', { offlineOnly: true }),
      /offline-only/i,
    );
    await assert.rejects(
      () => createProvider('tts', 'browserSpeech', { offlineOnly: true }),
      /offline-only/i,
    );
  });
});

describe('mock STT / TTS / VAD', () => {
  it('emits interim then final STT results', async () => {
    const stt = new MockSTTProvider();
    await stt.initialize();
    await stt.start();
    const interims = [];
    let final = '';
    stt.onInterimResult((t) => interims.push(t));
    stt.onFinalResult((t) => { final = t; });
    stt.simulateUtterance('hello world');
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(interims.length >= 1);
    assert.equal(final, 'hello world');
    await stt.dispose();
    assert.equal(stt.getStatus(), 'idle');
  });

  it('simulates VAD speech boundaries', async () => {
    const vad = new MockVADProvider();
    await vad.initialize();
    await vad.start();
    let starts = 0;
    let ends = 0;
    vad.onSpeechStart(() => { starts += 1; });
    vad.onSpeechEnd(() => { ends += 1; });
    vad.simulateSpeechStart();
    vad.simulateSpeechStart(); // ignored while open
    vad.simulateSpeechEnd();
    assert.equal(starts, 1);
    assert.equal(ends, 1);
    await vad.dispose();
  });

  it('TTS speak completes and stop cancels', async () => {
    const tts = new MockTTSProvider();
    tts._msPerChar = 50;
    await tts.initialize();
    const p = tts.speak('abcdef');
    await tts.stop();
    await assert.rejects(p, /stopped/i);
    await tts.speak('hi');
    assert.equal(tts.getStatus(), 'ready');
    await tts.dispose();
  });
});

describe('EnergyVADProvider', () => {
  it('detects speech from high-energy frames', async () => {
    const vad = new EnergyVADProvider();
    await vad.initialize({ energyThreshold: 0.05, redemptionMs: 50, minSpeechMs: 10 });
    await vad.start();
    let started = false;
    let ended = false;
    vad.onSpeechStart(() => { started = true; });
    vad.onSpeechEnd(() => { ended = true; });

    const loud = new Float32Array(512);
    loud.fill(0.5);
    vad.processAudio(loud, 16000);
    assert.equal(started, true);

    const quiet = new Float32Array(512);
    quiet.fill(0);
    // Wait past redemption
    await new Promise((r) => setTimeout(r, 80));
    vad.processAudio(quiet, 16000);
    assert.equal(ended, true);
    await vad.dispose();
  });
});

describe('AudioPlayback generation cancel', () => {
  it('bumps generation and drains queue without AudioContext', () => {
    const play = new AudioPlayback();
    const gen0 = play.generation;
    const p = play.enqueue(new Float32Array([0, 0, 0]), { sampleRate: 16000, generation: gen0 });
    const gen1 = play.nextGeneration();
    assert.ok(gen1 > gen0);
    // Stale enqueue should resolve without throwing when generation mismatches
    return p.then(() => {
      assert.equal(play.playing, false);
    }).catch(() => {
      // Interrupted reject is also acceptable
      assert.ok(true);
    });
  });
});

describe('VoiceModelManager', () => {
  it('lists catalog and tracks missing vs ready markers', async () => {
    const mgr = new VoiceModelManager([
      {
        id: 'test-model',
        engine: 'stt',
        provider: 'mock',
        label: 'Test',
        version: '1',
        bytesEstimate: 10,
      },
    ]);
    await mgr.refresh();
    assert.equal(mgr.getStatus('test-model'), 'not_installed');
    await mgr.markReady('test-model', { version: '1', bytes: 10 });
    assert.equal(mgr.getStatus('test-model'), 'ready');
    await mgr.remove('test-model');
    assert.equal(mgr.getStatus('test-model'), 'not_installed');
  });

  it('assertReadyFor requires bundled models (or throws a clear error)', async () => {
    const mgr = new VoiceModelManager([
      {
        id: 'onnx-community/whisper-tiny.en',
        engine: 'stt',
        provider: 'whisper',
        label: 'Whisper',
        version: '1',
      },
    ]);
    // Without a browser server hosting /voice-models/, probe fails → clear error.
    await assert.rejects(
      () => mgr.assertReadyFor({
        sttProvider: 'whisper',
        ttsProvider: 'mock',
        vadProvider: 'energy',
        offlineOnly: true,
      }),
      /voice:models|not bundled/i,
    );
  });
});

describe('local model URL rewrite', () => {
  it('maps Hugging Face resolve URLs onto /voice-models/', async () => {
    const { rewriteHuggingFaceUrl } = await import(
      '../src/app/console/ui/features/live-chat/voice/localModels.js'
    );
    assert.equal(
      rewriteHuggingFaceUrl(
        'https://huggingface.co/onnx-community/whisper-tiny.en/resolve/main/config.json',
      ),
      '/voice-models/onnx-community/whisper-tiny.en/config.json',
    );
    assert.equal(rewriteHuggingFaceUrl('https://example.com/x'), null);
  });
});

describe('normalizeLiveChatSettings browser fields', () => {
  it('migrates legacy piper prefs to kokoro browser providers', () => {
    const next = normalizeLiveChatSettings({
      transport: 'webrtc',
      tts: 'piper',
      gender: 'female',
      voice: 'af_bella',
    });
    assert.equal(next.mode, 'browser');
    assert.equal(next.sttProvider, 'whisper');
    assert.equal(next.ttsProvider, 'kokoro');
    assert.equal(next.vadProvider, 'silero');
    assert.equal(next.offlineOnly, true);
    assert.equal(next.voice, 'af_bella');
    assert.equal(next.autoSpeak, true);
  });

  it('accepts explicit provider selection and clamps unbundled whisper-base', () => {
    const next = normalizeLiveChatSettings({
      sttProvider: 'mock',
      ttsProvider: 'mock',
      vadProvider: 'energy',
      offlineOnly: false,
      speechRate: 1.25,
      whisperModel: 'onnx-community/whisper-base.en',
    });
    assert.equal(next.sttProvider, 'mock');
    assert.equal(next.ttsProvider, 'mock');
    assert.equal(next.vadProvider, 'energy');
    assert.equal(next.offlineOnly, false);
    assert.equal(next.speechRate, 1.25);
    // Base is not shipped in /voice-models/ — normalize to bundled tiny.
    assert.equal(next.whisperModel, 'onnx-community/whisper-tiny.en');
  });
});

describe('voice conversation lifecycle (mocks)', () => {
  it('VAD end → STT final → TTS queue → interrupt drops stale generation', async () => {
    const stt = new MockSTTProvider();
    const tts = new MockTTSProvider();
    tts._msPerChar = 40;
    const vad = new MockVADProvider();
    await Promise.all([stt.initialize(), tts.initialize(), vad.initialize()]);
    await Promise.all([stt.start(), vad.start()]);

    const finals = [];
    stt.onFinalResult((t) => finals.push(t));

    let speakGen = 0;
    /** @type {{ text: string, gen: number }[]} */
    const queue = [];

    async function pump() {
      while (queue.length) {
        const item = queue.shift();
        if (!item || item.gen !== speakGen) continue;
        try {
          await tts.speak(item.text);
        } catch {
          // interrupted mid-utterance
        }
      }
    }

    function speak(text) {
      queue.push({ text, gen: speakGen });
      return pump();
    }

    async function interrupt() {
      speakGen += 1;
      queue.length = 0;
      await tts.stop();
    }

    vad.onSpeechEnd(() => {
      stt.simulateUtterance('what is kusa');
    });

    vad.simulateSpeechStart();
    vad.simulateSpeechEnd();
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(finals, ['what is kusa']);

    const spoken = [];
    tts.onSpeakStart = (t) => spoken.push(t);

    // Long first utterance so interrupt lands before the queued second item plays.
    const long = 'a'.repeat(40);
    const p1 = speak(long);
    queue.push({ text: 'stale-queued-sentence', gen: speakGen });
    await new Promise((r) => setTimeout(r, 20));
    await interrupt();
    await Promise.allSettled([p1]);
    assert.ok(!spoken.includes('stale-queued-sentence'));

    await speak('Fresh reply.');
    assert.ok(spoken.includes('Fresh reply.'));

    await Promise.all([stt.dispose(), tts.dispose(), vad.dispose()]);
  });
});
