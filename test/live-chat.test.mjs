import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  collectLiveChatStatus,
  emptyLiveChatStatus,
  liveChatListenFromBaseUrl,
  normalizeLiveChatSettings,
  normalizeLiveChatTransport,
  normalizeLiveChatTts,
  probeLiveChatInstall,
  resolveLiveChatBaseUrl,
  resolveLiveChatExtRoot,
} from '../src/features/live-chat/index.mjs';
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

  it('normalizes transport and tts', () => {
    assert.equal(normalizeLiveChatTransport('WebRTC'), 'webrtc');
    assert.equal(normalizeLiveChatTransport('nope'), 'websocket');
    assert.equal(normalizeLiveChatTts('KOKORO'), 'kokoro');
    assert.equal(normalizeLiveChatTts(''), 'piper');
    assert.deepEqual(normalizeLiveChatSettings({ transport: 'webrtc', tts: 'kokoro' }), {
      transport: 'webrtc',
      tts: 'kokoro',
      baseUrl: '',
    });
  });

  it('empty status is not ok', () => {
    const status = emptyLiveChatStatus('down');
    assert.equal(status.ok, false);
    assert.equal(status.error, 'down');
    assert.equal(status.serverUp, false);
    assert.equal(status.installed, false);
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
    // Repo may or may not have .venv yet — only assert the probe shape.
    assert.equal(typeof install.installed, 'boolean');
  });

  it('persists liveChat in monitor settings and publicSettings', () => {
    const dir = tempDir();
    const saved = saveMonitorSettings(dir, {
      liveChat: { transport: 'webrtc', tts: 'kokoro', baseUrl: 'http://127.0.0.1:7861' },
    });
    assert.equal(saved.liveChat.transport, 'webrtc');
    assert.equal(saved.liveChat.tts, 'kokoro');
    assert.equal(saved.liveChat.baseUrl, 'http://127.0.0.1:7861');
    const loaded = loadMonitorSettings(dir);
    assert.equal(loaded.liveChat.tts, 'kokoro');
    const pub = publicSettings(loaded);
    assert.equal(pub.liveChat.transport, 'webrtc');
    assert.equal(pub.liveChat.tts, 'kokoro');
    assert.equal(pub.liveChat.baseUrl, 'http://127.0.0.1:7861');
  });
});

describe('live-chat status + serve', () => {
  it('collectLiveChatStatus reports server down when bot is unreachable', async () => {
    const status = await collectLiveChatStatus({
      force: true,
      baseUrl: 'http://127.0.0.1:1',
      settings: { liveChat: { transport: 'websocket', tts: 'piper' } },
    });
    assert.equal(status.ok, false);
    assert.equal(status.serverUp, false);
    assert.ok(status.error);
    assert.equal(status.transport, 'websocket');
    assert.equal(typeof status.installed, 'boolean');
    assert.ok(Array.isArray(status.steps));
  });

  it('GET /live-chat returns down status when bot is unreachable', async () => {
    const dir = tempDir();
    saveMonitorSettings(dir, {
      liveChat: { transport: 'websocket', tts: 'piper', baseUrl: 'http://127.0.0.1:1' },
    });
    const server = createMonitorServer({ dataDir: dir });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const res = await fetch(`${base}/live-chat`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.serverUp, false);
      assert.equal(body.ok, false);

      const settingsRes = await fetch(`${base}/live-chat/settings`);
      assert.equal(settingsRes.status, 200);
      const prefs = await settingsRes.json();
      assert.equal(prefs.transport, 'websocket');
      assert.equal(prefs.tts, 'piper');

      const putRes = await fetch(`${base}/live-chat/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transport: 'webrtc', tts: 'kokoro' }),
      });
      assert.equal(putRes.status, 200);
      const putBody = await putRes.json();
      assert.equal(putBody.transport, 'webrtc');
      assert.equal(putBody.tts, 'kokoro');

      const stopRes = await fetch(`${base}/live-chat/server/stop`, { method: 'POST' });
      assert.equal(stopRes.status, 200);
      const stopBody = await stopRes.json();
      assert.equal(stopBody.ok, true);
      assert.equal(stopBody.status?.serverUp, false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
