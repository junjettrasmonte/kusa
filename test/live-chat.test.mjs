import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  collectLiveChatStatus,
  emptyLiveChatStatus,
  liveChatHistoryMessages,
  liveChatListenFromBaseUrl,
  normalizeLiveChatSettings,
  normalizeLiveChatTransport,
  normalizeLiveChatTts,
  probeLiveChatInstall,
  resolveLiveChatBaseUrl,
  resolveLiveChatExtRoot,
} from '../src/features/live-chat/index.mjs';
import {
  createChatSession,
  writeChatSession,
} from '../src/features/chat/data/chat-store.mjs';
import {
  loadMonitorSettings,
  saveMonitorSettings,
} from '../src/features/monitor/lib.mjs';
import { publicSettings } from '../src/features/settings/secrets.mjs';
import { createMonitorServer } from '../src/app/console/serve.mjs';

const temps = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'kusa-live-chat-'));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('live-chat settings helpers', () => {
  it('resolves base URL from env and settings', () => {
    assert.equal(resolveLiveChatBaseUrl({}), 'http://127.0.0.1:7860');
    assert.equal(
      resolveLiveChatBaseUrl({ LIVE_CHAT_BASE_URL: 'http://127.0.0.1:9000/' }),
      'http://127.0.0.1:9000',
    );
    assert.equal(
      resolveLiveChatBaseUrl({}, { liveChat: { baseUrl: 'http://10.0.0.2:7860/' } }),
      'http://10.0.0.2:7860',
    );
  });

  it('normalizes transport and tts (legacy) plus browser providers', () => {
    assert.equal(normalizeLiveChatTransport('WebRTC'), 'webrtc');
    assert.equal(normalizeLiveChatTransport('nope'), 'websocket');
    assert.equal(normalizeLiveChatTts('KOKORO'), 'kokoro');
    assert.equal(normalizeLiveChatTts(''), 'piper');
    const next = normalizeLiveChatSettings({ transport: 'webrtc', tts: 'kokoro' });
    assert.equal(next.transport, 'webrtc');
    assert.equal(next.tts, 'kokoro');
    assert.equal(next.ttsProvider, 'kokoro');
    assert.equal(next.sttProvider, 'whisper');
    assert.equal(next.vadProvider, 'silero');
    assert.equal(next.mode, 'browser');
    assert.equal(next.voice, 'af_heart');
    assert.equal(next.offlineOnly, true);
  });

  it('empty status reflects error argument', () => {
    const status = emptyLiveChatStatus('down');
    assert.equal(status.ok, false);
    assert.equal(status.error, 'down');
    assert.equal(status.serverUp, false);
    assert.equal(status.mode, 'browser');
  });

  it('parses listen host/port and detects the shipped extension tree', () => {
    assert.deepEqual(liveChatListenFromBaseUrl('http://127.0.0.1:7860'), {
      host: '127.0.0.1',
      port: 7860,
    });
    const root = resolveLiveChatExtRoot();
    assert.ok(root);
    assert.match(root, /extensions[/\\]live-chat$/);
    const install = probeLiveChatInstall();
    assert.equal(install.root, root);
    assert.equal(typeof install.installed, 'boolean');
  });

  it('persists liveChat browser prefs in monitor settings and publicSettings', () => {
    const dir = tempDir();
    const saved = saveMonitorSettings(dir, {
      liveChat: {
        sttProvider: 'whisper',
        ttsProvider: 'kokoro',
        vadProvider: 'energy',
        offlineOnly: true,
        gender: 'female',
        voice: 'af_bella',
        expressiveness: 'expressive',
        speechRate: 1.1,
      },
    });
    assert.equal(saved.liveChat.ttsProvider, 'kokoro');
    assert.equal(saved.liveChat.sttProvider, 'whisper');
    assert.equal(saved.liveChat.vadProvider, 'energy');
    assert.equal(saved.liveChat.gender, 'female');
    assert.equal(saved.liveChat.voice, 'af_bella');
    assert.equal(saved.liveChat.mode, 'browser');
    const loaded = loadMonitorSettings(dir);
    assert.equal(loaded.liveChat.ttsProvider, 'kokoro');
    assert.equal(loaded.liveChat.voice, 'af_bella');
    const pub = publicSettings(loaded);
    assert.equal(pub.liveChat.mode, 'browser');
    assert.equal(pub.liveChat.ttsProvider, 'kokoro');
    assert.equal(pub.liveChat.vadProvider, 'energy');
    assert.equal(pub.liveChat.gender, 'female');
    assert.equal(pub.liveChat.offlineOnly, true);
  });
});

describe('live-chat history packaging', () => {
  it('packs prior turns as OpenAI-style messages and drops oldest under caps', () => {
    const dir = tempDir();
    const created = createChatSession(dir, { id: 'voice-hist-1' });
    writeChatSession(dir, {
      ...created,
      messages: [
        { id: 'm1', role: 'user', text: 'remember the project is called kusa', at: 1 },
        { id: 'm2', role: 'assistant', text: 'Got it — Kusă.', at: 2 },
        { id: 'm3', role: 'user', text: 'what is the project called?', at: 3 },
        { id: 'm4', role: 'assistant', text: 'Kusă.', at: 4, error: true },
        { id: 'm5', role: 'user', text: '   ', at: 5 },
      ],
    });
    const history = liveChatHistoryMessages(dir, { sessionId: 'voice-hist-1' });
    assert.deepEqual(history, [
      { role: 'user', content: 'remember the project is called kusa' },
      { role: 'assistant', content: 'Got it — Kusă.' },
      { role: 'user', content: 'what is the project called?' },
    ]);

    const capped = liveChatHistoryMessages(dir, {
      sessionId: 'voice-hist-1',
      maxMessages: 1,
    });
    assert.deepEqual(capped, [
      { role: 'user', content: 'what is the project called?' },
    ]);

    const viaKey = liveChatHistoryMessages(dir, {
      queueKey: `kusa:voice-hist-1`,
    });
    assert.equal(viaKey.length, 3);
  });
});

describe('live-chat status + serve (browser mode)', () => {
  it('collectLiveChatStatus reports browser mode up without a Pipecat bot', async () => {
    const status = await collectLiveChatStatus({
      force: true,
      baseUrl: 'http://127.0.0.1:1',
      settings: { liveChat: { ttsProvider: 'kokoro', sttProvider: 'whisper' } },
    });
    assert.equal(status.ok, true);
    assert.equal(status.serverUp, true);
    assert.equal(status.mode, 'browser');
    assert.equal(status.ttsProvider, 'kokoro');
    assert.ok(Array.isArray(status.steps));
  });

  it('GET /live-chat returns browser-up status; settings round-trip; bot routes are 410', async () => {
    const dir = tempDir();
    saveMonitorSettings(dir, {
      liveChat: { ttsProvider: 'kokoro', sttProvider: 'whisper', vadProvider: 'silero' },
    });
    const server = createMonitorServer({ dataDir: dir });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const res = await fetch(`${base}/live-chat`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.serverUp, true);
      assert.equal(body.ok, true);
      assert.equal(body.mode, 'browser');

      const settingsRes = await fetch(`${base}/live-chat/settings`);
      assert.equal(settingsRes.status, 200);
      const prefs = await settingsRes.json();
      assert.equal(prefs.ttsProvider, 'kokoro');
      assert.equal(prefs.sttProvider, 'whisper');

      const putRes = await fetch(`${base}/live-chat/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ttsProvider: 'mock',
          sttProvider: 'mock',
          vadProvider: 'energy',
          offlineOnly: false,
        }),
      });
      assert.equal(putRes.status, 200);
      const putBody = await putRes.json();
      assert.equal(putBody.ttsProvider, 'mock');
      assert.equal(putBody.sttProvider, 'mock');
      assert.equal(putBody.vadProvider, 'energy');
      assert.equal(putBody.offlineOnly, false);

      const stopRes = await fetch(`${base}/live-chat/server/stop`, { method: 'POST' });
      assert.equal(stopRes.status, 410);
      const stopBody = await stopRes.json();
      assert.equal(stopBody.retired, true);

      const sessionRes = await fetch(`${base}/live-chat/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(sessionRes.status, 410);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
