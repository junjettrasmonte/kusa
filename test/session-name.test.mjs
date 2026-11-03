import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_NAME_TOOL_DEFS,
  createSessionNameTools,
  requestSessionName,
  sessionNameToolSchemas,
  agentToolGroups,
  createTrailAwareTools,
} from '#features/agent/index.mjs';
import {
  createChatSession,
  listChatSessions,
  readChatSession,
  writeChatSession,
} from '#features/chat/data/chat-store.mjs';

const dirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'kusa-name-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

/** A session whose only name would be its rambling first prompt. */
function seedSession(dir, id) {
  createChatSession(dir, { id, workspaceRoot: dir });
  return writeChatSession(dir, {
    key: `kusa:${id}`,
    id,
    harness: 'kusa',
    provider: 'kusa',
    kind: 'standard',
    external: false,
    status: 'idle',
    attempts: 0,
    createdAt: Date.now(),
    messages: [
      {
        id: 'm1',
        role: 'user',
        text: 'ok so basically the parser is slow because it re-reads the whole file on every single request and I do not know why',
      },
    ],
  });
}

describe('kusa agent session naming', () => {
  it('advertises the name tool to the model in every mode', async () => {
    const names = sessionNameToolSchemas().map((schema) => schema.function.name);
    assert.deepEqual(names, SESSION_NAME_TOOL_DEFS.map((def) => def.name));
    for (const mode of ['ask', 'plan', 'agent']) {
      const group = agentToolGroups(mode).find((entry) => entry.group === 'session');
      assert.ok(group, `${mode} mode must still be able to name its own session`);
      assert.deepEqual(group.schemas.map((s) => s.function.name), names);
    }
  });

  it('names a session and the sidebar title follows it', async () => {
    const dir = tempDir();
    const sessionKey = 'kusa:sess-1';
    seedSession(dir, 'sess-1');

    // With no authored name the row is labelled by the first prompt verbatim.
    const derived = readChatSession(dir, sessionKey);
    assert.equal(derived.title.startsWith('ok so basically'), true);

    const tool = createSessionNameTools({ dataDir: dir, sessionKey });
    const named = await tool.call('kusa_name_session', { name: 'Fix the slow CSV parser' });
    assert.equal(named.ok, true);
    assert.equal(named.name, 'Fix the slow CSV parser');
    assert.equal(named.previous, null);

    // The name is not turn data: it lives in the settings sidecar, and
    // normalizeChatSession prefers it over anything the transcript suggests.
    const sidecar = readFileSync(join(dir, 'agents', 'sess-1', 'agent.json'), 'utf8');
    assert.match(sidecar, /"name": "Fix the slow CSV parser"/);
    const renamed = readChatSession(dir, sessionKey);
    assert.equal(renamed.title, 'Fix the slow CSV parser');
    assert.equal(
      listChatSessions(dir).find((s) => s.key === sessionKey)?.title,
      'Fix the slow CSV parser',
    );
  });

  it('renaming replaces the name and reports the previous one', async () => {
    const dir = tempDir();
    const sessionKey = 'kusa:sess-1';
    seedSession(dir, 'sess-1');
    const tool = createSessionNameTools({ dataDir: dir, sessionKey });

    const first = await tool.call('kusa_name_session', { name: 'Fix the slow CSV parser' });
    const second = await tool.call('rename_session', { name: 'Profile the parser hot loop' });
    assert.equal(second.ok, true);
    assert.equal(second.name, 'Profile the parser hot loop');
    assert.equal(second.previous, 'Fix the slow CSV parser');
    // Renaming is not an error — the model retried, so the call is unchanged.
    const retry = await tool.call('kusa_name_session', { name: 'Profile the parser hot loop' });
    assert.equal(retry.ok, true);
    assert.equal(retry.unchanged, true);
    assert.equal(readChatSession(dir, sessionKey).title, 'Profile the parser hot loop');
  });

  it('an empty name clears it and the first prompt titles the row again', async () => {
    const dir = tempDir();
    const sessionKey = 'kusa:sess-1';
    seedSession(dir, 'sess-1');
    const tool = createSessionNameTools({ dataDir: dir, sessionKey });

    await tool.call('kusa_name_session', { name: 'Fix the slow CSV parser' });
    const cleared = await tool.call('kusa_name_session', { name: '' });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.cleared, true);
    assert.equal(cleared.name, null);
    const derived = readChatSession(dir, sessionKey);
    assert.equal(derived.title.startsWith('ok so basically'), true);
  });

  it('a name is clamped to one line, like a derived title', async () => {
    const dir = tempDir();
    const sessionKey = 'kusa:sess-1';
    seedSession(dir, 'sess-1');
    const tool = createSessionNameTools({ dataDir: dir, sessionKey });

    const applied = await tool.call('kusa_name_session', {
      name: '\n\n"# CSV parser"\nre-reads the whole file every request — ',
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.name, '"# CSV parser" re-reads the whole file every request');
    assert.equal(
      readChatSession(dir, sessionKey).title,
      '"# CSV parser" re-reads the whole file every request',
    );
  });

  it('agent-owned sessions keep that agent’s own title', async () => {
    const dir = tempDir();
    const tool = createSessionNameTools({ dataDir: dir, sessionKey: 'cursor:sess-9' });
    const refused = await tool.call('kusa_name_session', { name: 'Anything at all' });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'EFOREIGN');
    assert.match(refused.error, /keep that agent's own title/);
  });

  it('without a session to persist into the name is refused, not invented', async () => {
    const tool = createSessionNameTools({});
    const applied = await tool.call('kusa_name_session', { name: 'Orphan name' });
    assert.equal(applied.ok, false);
    assert.match(applied.error, /no session to name/);
  });

  it('names only a session that exists on disk', async () => {
    const dir = tempDir();
    const tool = createSessionNameTools({ dataDir: dir, sessionKey: 'kusa:ghost-1' });
    const applied = await tool.call('kusa_name_session', { name: 'Phantom' });
    assert.equal(applied.ok, false);
    assert.match(applied.error, /no session ghost-1 to name/);
    assert.equal(existsSync(join(dir, 'agents', 'ghost-1')), false);
  });

  it('the agent loop dispatches the tool through the session family', async () => {
    const dir = tempDir();
    const sessionKey = 'kusa:sess-2';
    seedSession(dir, 'sess-2');
    const tools = createTrailAwareTools(dir, { dataDir: dir, sessionKey, enforceTrail: false });
    assert.ok(tools.defs.some((def) => def.name === 'kusa_name_session'));
    const called = await tools.call('kusa_name_session', { name: 'Wire the name tool' }, 'call-1');
    assert.equal(called.ok, true);
    assert.equal(readChatSession(dir, sessionKey).title, 'Wire the name tool');
  });

  it('the automatic titling call is best-effort and never throws', async () => {
    // No endpoint configured: nothing to ask, so the first-prompt title stays.
    const titled = await requestSessionName({ settings: {}, prompt: 'Fix the parser' });
    assert.equal(titled, null);
    // A prompt with no words at all cannot be titled.
    assert.equal(await requestSessionName({ settings: {}, prompt: '   ' }), null);
  });
});
