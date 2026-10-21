import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatSession, readChatSession, writeChatSession } from '../src/chat-store.mjs';
import {
  createTurnJob,
  ingestTurnEvent,
  persistTurnCompletion,
  persistTurnPrompt,
  sessionsWithActiveTurns,
  subscribeTurn,
} from '../src/chat-turn.mjs';

describe('chat-turn', () => {
  it('overlays busy live onto listed sessions', () => {
    const job = createTurnJob({ queueKey: 'kusa:abc', sessionId: 'abc' });
    ingestTurnEvent(job, { type: 'content', text: 'hello' });
    const jobs = new Map([['kusa:abc', job]]);
    const sessions = sessionsWithActiveTurns(
      [{ key: 'kusa:abc', id: 'abc', status: 'idle', messages: [] }],
      jobs,
    );
    assert.equal(sessions[0].status, 'busy');
    assert.equal(sessions[0].live.text, 'hello');
  });

  it('snapshot then terminal on late subscribe', () => {
    const job = createTurnJob({ queueKey: 'kusa:x', sessionId: 'x' });
    ingestTurnEvent(job, { type: 'thinking', text: 'hmm' });
    job.terminal = { type: 'done', text: 'done', turnId: job.turnId };
    const seen = [];
    subscribeTurn(job, (type, data) => seen.push({ type, data }));
    assert.equal(seen[0].type, 'snapshot');
    assert.equal(seen[0].data.live.thinking, 'hmm');
    assert.equal(seen[1].type, 'done');
    assert.equal(seen[1].data.text, 'done');
  });

  it('persists assistant reply idempotently by turnId', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kusa-turn-'));
    try {
      const session = createChatSession(dir, { id: 'sess1', workspaceRoot: dir });
      writeChatSession(dir, {
        ...session,
        messages: [{ id: 'u1', role: 'user', text: 'hi', at: Date.now() }],
      });

      const job = createTurnJob({ queueKey: 'kusa:sess1', sessionId: 'sess1', prompt: 'hi' });
      ingestTurnEvent(job, { type: 'content', text: 'reply' });
      const terminal = { type: 'done', text: 'reply', turnId: job.turnId };
      persistTurnCompletion(dir, job, terminal);
      persistTurnCompletion(dir, job, terminal);
      const saved = readChatSession(dir, 'sess1');
      const assistants = saved.messages.filter((m) => m.role === 'assistant');
      assert.equal(assistants.length, 1);
      assert.equal(assistants[0].text, 'reply');
      assert.equal(assistants[0].turnId, job.turnId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists the opening user prompt when disk is missing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kusa-turn-prompt-'));
    try {
      createChatSession(dir, { id: 'sess2', workspaceRoot: dir });
      const job = createTurnJob({
        queueKey: 'kusa:sess2',
        sessionId: 'sess2',
        prompt: 'remember me',
        promptMessageId: 'user-msg-1',
      });
      persistTurnPrompt(dir, job);
      persistTurnPrompt(dir, job);
      const saved = readChatSession(dir, 'sess2');
      const users = saved.messages.filter((m) => m.role === 'user');
      assert.equal(users.length, 1);
      assert.equal(users[0].text, 'remember me');
      assert.equal(users[0].id, 'user-msg-1');

      const overlaid = sessionsWithActiveTurns(
        [{ key: 'kusa:sess2', id: 'sess2', status: 'idle', messages: [] }],
        new Map([['kusa:sess2', job]]),
      );
      assert.equal(overlaid[0].messages[0].text, 'remember me');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
