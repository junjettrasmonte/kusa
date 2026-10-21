import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadMonitorSettings,
  runHook,
  saveMonitorSettings,
} from '../src/lib.mjs';
import {
  SessionListener,
  SimulatedSdkSession,
  normalizeSdkEvent,
  SDK_JOIN_TARGETS,
} from '../src/sdk-listener.mjs';

const dirs = [];
const quiet = {
  toolDurationWarnMs: 1e12,
  repeatWindowMs: 1000,
  repeatCount: 1000,
  promptToolCountWarn: 1000,
  promptElapsedWarnMs: 1e12,
  sessionElapsedWarnMs: 1e12,
  maxEvents: 100,
};

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'kusa-sdk-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function sdkEvent(type, data = {}, extra = {}) {
  return {
    id: extra.id || `evt-${type}-${extra.n || 1}`,
    type,
    timestamp: extra.timestamp || new Date(extra.wall || 1_700_000_000_000).toISOString(),
    data,
    agentId: extra.agentId,
  };
}

async function flush(listener) {
  await listener._queue;
}

describe('SDK normalize', () => {
  it('maps turn, tool, usage, and reasoning without inventing text by default', () => {
    const turn = normalizeSdkEvent(sdkEvent('assistant.turn_start', { turnId: 't1', model: 'gpt-test' }), {
      sessionId: 's1',
    });
    assert.equal(turn.turnId, 't1');
    assert.equal(turn.sessionId, 's1');
    assert.equal(turn.source, 'sdk');

    const reasoning = normalizeSdkEvent(
      sdkEvent('assistant.reasoning', { reasoningId: 'r1', content: 'secret thoughts' }),
      { sessionId: 's1' },
    );
    assert.equal(reasoning.reasoning.hasText, true);
    assert.equal(reasoning.reasoning.text, '');

    const persisted = normalizeSdkEvent(
      sdkEvent('assistant.reasoning', { reasoningId: 'r1', content: 'secret thoughts' }),
      { sessionId: 's1', persistReasoningText: true },
    );
    assert.equal(persisted.reasoning.text, 'secret thoughts');

    const skipped = normalizeSdkEvent(
      sdkEvent('assistant.reasoning_delta', { reasoningId: 'r1', deltaContent: 'x' }),
      { collectReasoningEvents: false },
    );
    assert.equal(skipped, null);

    const usage = normalizeSdkEvent(
      sdkEvent('assistant.usage', {
        apiCallId: 'call-1',
        inputTokens: 10,
        outputTokens: 5,
        duration: 42,
      }),
    );
    assert.equal(usage.durationMs, 42);
    assert.equal(usage.usage.inputTokens, 10);

    assert.equal(normalizeSdkEvent({ type: 'session.unknown' }), null);
  });

  it('documents which targets joinSession can observe', () => {
    assert.equal(SDK_JOIN_TARGETS['copilot-cli'].supported, true);
    assert.equal(SDK_JOIN_TARGETS['vscode-copilot-chat'].supported, false);
    assert.equal(SDK_JOIN_TARGETS.cursor.supported, false);
  });
});

describe('SDK session listener', () => {
  it('records turn start and completion', async () => {
    const dir = tempDir();
    const session = new SimulatedSdkSession('cli-sess');
    const listener = new SessionListener({ dir, target: 'copilot-cli', sessionId: 'cli-sess' });
    listener.start(session);
    assert.equal(listener.status, 'connected');

    session.emit(sdkEvent('assistant.turn_start', { turnId: '1' }, { wall: 1_700_000_000_000, n: 1 }));
    session.emit(sdkEvent('assistant.turn_end', { turnId: '1' }, { wall: 1_700_000_000_500, n: 2 }));
    await flush(listener);

    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    const rel = index.sessionFiles[index.focus];
    const lane = JSON.parse(readFileSync(join(dir, rel), 'utf8'));
    assert.equal(lane.turnCount, 1);
    assert.equal(lane.currentTurnId, '1');
    assert.ok(lane.turnStartedAtWall);
    assert.ok(lane.turnEndedAtWall);
    assert.equal(lane.turnEndedAtWall - lane.turnStartedAtWall, 500);
  });

  it('counts tool start/complete, failures, and concurrent calls', async () => {
    const dir = tempDir();
    const session = new SimulatedSdkSession('cli-sess');
    const listener = new SessionListener({ dir, target: 'copilot-cli', sessionId: 'cli-sess' });
    listener.start(session);

    session.emit(sdkEvent('tool.execution_start', { toolCallId: 'a', toolName: 'bash' }, { wall: 1_700_000_000_100, n: 1 }));
    session.emit(sdkEvent('tool.execution_start', { toolCallId: 'b', toolName: 'view' }, { wall: 1_700_000_000_110, n: 2 }));
    session.emit(sdkEvent('tool.execution_complete', { toolCallId: 'a', toolName: 'bash', success: true }, { wall: 1_700_000_000_200, n: 3 }));
    session.emit(sdkEvent('tool.execution_complete', {
      toolCallId: 'b',
      toolName: 'view',
      success: false,
      error: { message: 'denied' },
    }, { wall: 1_700_000_000_250, n: 4 }));
    await flush(listener);

    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    const lane = JSON.parse(readFileSync(join(dir, index.sessionFiles[index.focus]), 'utf8'));
    assert.equal(lane.tools.bash.total, 1);
    assert.equal(lane.tools.bash.success, 1);
    assert.equal(lane.tools.view.total, 1);
    assert.equal(lane.tools.view.failed, 1);
    assert.equal(lane.summary.running, 0);
  });

  it('records usage durations and reasoning status without raw text', async () => {
    const dir = tempDir();
    const session = new SimulatedSdkSession('cli-sess');
    const listener = new SessionListener({ dir, target: 'copilot-cli', sessionId: 'cli-sess' });
    listener.start(session);

    session.emit(sdkEvent('assistant.turn_start', { turnId: '1' }, { wall: 1_700_000_000_000, n: 1 }));
    session.emit(sdkEvent('assistant.reasoning_delta', {
      reasoningId: 'r1',
      deltaContent: 'should not land on disk',
    }, { wall: 1_700_000_000_050, n: 2 }));
    session.emit(sdkEvent('assistant.reasoning', {
      reasoningId: 'r1',
      content: 'should not land on disk either',
    }, { wall: 1_700_000_000_080, n: 3 }));
    session.emit(sdkEvent('assistant.usage', {
      apiCallId: 'u1',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      duration: 77,
      model: 'test-model',
    }, { wall: 1_700_000_000_100, n: 4 }));
    await flush(listener);

    const disk = readFileSync(join(dir, 'index.json'), 'utf8')
      + readFileSync(join(dir, JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).sessionFiles[
        JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).focus
      ]), 'utf8');
    assert.equal(disk.includes('should not land on disk'), false);

    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    const lane = JSON.parse(readFileSync(join(dir, index.sessionFiles[index.focus]), 'utf8'));
    assert.equal(lane.reasoning.seen, true);
    assert.equal(lane.reasoning.blocks, 1);
    assert.equal(lane.apiCallDurationCount, 1);
    assert.equal(lane.apiCallDurationMsSum, 77);
    assert.equal(lane.tokens.input, 100);
    assert.equal(lane.tokens.output, 20);
  });

  it('handles missing session ids and duplicate events', async () => {
    const dir = tempDir();
    const session = new SimulatedSdkSession(null);
    const listener = new SessionListener({ dir, target: 'copilot-cli', sessionId: null });
    listener.start(session);

    const evt = sdkEvent('assistant.intent', { intent: 'inspect repo' }, { id: 'same-id', wall: 1_700_000_000_000 });
    session.emit(evt);
    session.emit(evt);
    await flush(listener);

    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    assert.ok(index.focus);
    assert.ok(index.duplicates >= 1);
    const lane = JSON.parse(readFileSync(join(dir, index.sessionFiles[index.focus]), 'utf8'));
    assert.equal(lane.currentIntent, 'inspect repo');
  });

  it('dedupes hook and SDK tool events that share a call id', async () => {
    const dir = tempDir();
    const session = new SimulatedSdkSession('cli-sess');
    const listener = new SessionListener({ dir, target: 'copilot-cli', sessionId: 'cli-sess' });
    listener.start(session);

    session.emit(sdkEvent('tool.execution_start', { toolCallId: 'shared-1', toolName: 'bash' }, { wall: 1_700_000_000_100, n: 1 }));
    await flush(listener);

    runHook({
      dir,
      eventName: 'preToolUse',
      stdinText: JSON.stringify({
        sessionId: 'cli-sess',
        timestamp: 1_700_000_000_110,
        cwd: '/work',
        toolName: 'bash',
        toolUseId: 'shared-1',
      }),
      nowWall: 1_700_000_000_110,
      nowMono: 110,
      bootId: 'test-boot',
      config: quiet,
    });

    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    const lane = JSON.parse(readFileSync(join(dir, index.sessionFiles[index.focus]), 'utf8'));
    assert.equal(lane.tools.bash.total, 1);
    assert.ok(index.duplicates >= 1);
  });

  it('marks unsupported session targets without inventing a session', async () => {
    const dir = tempDir();
    const listener = new SessionListener({ dir, target: 'vscode-copilot-chat' });
    listener.start({ on() { return () => {}; } });
    assert.equal(listener.status, 'unsupported');
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    assert.equal(index.sdkListener.status, 'unsupported');
    assert.equal(Object.keys(index.sessionFiles || {}).length, 0);
  });

  it('records disconnect and ignores events after stop', async () => {
    const dir = tempDir();
    const session = new SimulatedSdkSession('cli-sess');
    const listener = new SessionListener({ dir, target: 'copilot-cli', sessionId: 'cli-sess' });
    listener.start(session);
    listener.stop({ reason: 'test-stop' });
    assert.equal(listener.status, 'disconnected');

    session.emit(sdkEvent('assistant.intent', { intent: 'after stop' }, { wall: 1_700_000_000_200, n: 9 }));
    await flush(listener);

    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    assert.equal(index.sdkListener.status, 'disconnected');
    // No lane should have picked up the post-stop intent.
    for (const rel of Object.values(index.sessionFiles || {})) {
      const lane = JSON.parse(readFileSync(join(dir, rel), 'utf8'));
      assert.notEqual(lane.currentIntent, 'after stop');
    }
  });

  it('respects settings that disable reasoning collection', async () => {
    const dir = tempDir();
    saveMonitorSettings(dir, { collectReasoningEvents: false });
    assert.equal(loadMonitorSettings(dir).collectReasoningEvents, false);

    const session = new SimulatedSdkSession('cli-sess');
    const listener = new SessionListener({ dir, target: 'copilot-cli', sessionId: 'cli-sess' });
    listener.start(session);
    session.emit(sdkEvent('assistant.reasoning', {
      reasoningId: 'r1',
      content: 'hidden',
    }, { wall: 1_700_000_000_000, n: 1 }));
    session.emit(sdkEvent('assistant.intent', { intent: 'still works' }, { wall: 1_700_000_000_010, n: 2 }));
    await flush(listener);

    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    const lane = JSON.parse(readFileSync(join(dir, index.sessionFiles[index.focus]), 'utf8'));
    assert.equal(lane.reasoning?.seen || false, false);
    assert.equal(lane.currentIntent, 'still works');
  });
});
