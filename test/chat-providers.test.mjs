import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  createChatSession,
  isExternalChatSession,
  listChatSessions,
  readChatSession,
} from '#features/chat/data/chat-store.mjs';
import '#features/chat/data/load-builtin-adapters.mjs';
import {
  CHAT_HARNESSES,
  harnessForProvider,
  isCaoChatProvider,
  isExternalOwnedHarness,
  resolveChatProvider,
  SESSION_KIND_ORCHESTRATED,
} from '#features/chat/data/providers.mjs';

describe('chat providers', () => {
  it('maps UI providers to harness and CAO ids', () => {
    assert.equal(harnessForProvider('kusa'), 'kusa');
    assert.equal(harnessForProvider('cursor'), 'cursor');
    assert.equal(harnessForProvider('copilot'), 'github-copilot');
    assert.equal(resolveChatProvider('cursor_cli')?.id, 'cursor');
    assert.equal(resolveChatProvider('copilot_cli')?.id, 'copilot');
    assert.equal(isCaoChatProvider('kusa'), false);
    assert.equal(isCaoChatProvider('cursor'), true);
    assert.equal(isCaoChatProvider('copilot'), true);
    assert.equal(isExternalOwnedHarness('cursor'), true);
    assert.equal(isExternalOwnedHarness('copilot'), false);
    assert.equal(isExternalOwnedHarness('kusa'), false);
    assert.equal(typeof resolveChatProvider('cursor')?.runTurn, 'function');
    assert.equal(typeof resolveChatProvider('copilot')?.runTurn, 'function');
    assert.equal(resolveChatProvider('cursor')?.ownsModels, true);
    assert.equal(resolveChatProvider('cursor')?.models?.path, '/adapters/cursor/models');
    assert.equal(resolveChatProvider('cursor')?.workspaceTrust?.path, '/adapters/cursor/trust');
    assert.equal(resolveChatProvider('copilot')?.ownsModels, undefined);
    assert.equal(resolveChatProvider('copilot')?.workspaceTrust, undefined);
    assert.deepEqual([...CHAT_HARNESSES].sort(), ['cursor', 'github-copilot', 'kusa']);
  });

  it('creates chat sessions under the shared agents folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kusa-providers-'));
    try {
      const kusa = createChatSession(dir, { id: 'k1', provider: 'kusa' });
      const cursor = createChatSession(dir, { id: 'c1', provider: 'cursor' });
      const orch = createChatSession(dir, {
        id: 'o1',
        provider: 'copilot',
        kind: SESSION_KIND_ORCHESTRATED,
        workflowId: 'demo-flow',
      });

      assert.equal(kusa.key, 'kusa:k1');
      assert.equal(kusa.provider, 'kusa');
      assert.equal(kusa.harness, 'kusa');
      assert.equal(kusa.external, false);
      assert.equal(cursor.key, 'cursor:c1');
      assert.equal(cursor.harness, 'cursor');
      // Kusă-created Cursor CLI sessions are not external IDE chats.
      assert.equal(cursor.external, false);
      assert.equal(cursor.cliBacked, true);
      assert.equal(cursor.ownsModels, true);
      assert.equal(cursor.modelsPath, '/adapters/cursor/models');
      assert.equal(cursor.workspaceTrust?.path, '/adapters/cursor/trust');
      assert.equal(isExternalChatSession(cursor), false);
      assert.equal(orch.key, 'github-copilot:o1');
      assert.equal(orch.kind, 'orchestrated');
      assert.equal(orch.cliBacked, true);
      assert.equal(orch.ownsModels, false);
      assert.equal(orch.workspaceTrust, null);
      assert.equal(orch.options?.workflowId, 'demo-flow');
      assert.equal(kusa.cliBacked, false);

      assert.equal(existsSync(join(dir, 'agents', 'k1', 'chat.json')), true);
      assert.equal(existsSync(join(dir, 'agents', 'c1', 'chat.json')), true);
      assert.equal(existsSync(join(dir, 'agents', 'o1', 'chat.json')), true);

      const listed = listChatSessions(dir);
      assert.equal(listed.length, 3);
      assert.ok(listed.some((s) => s.key === 'cursor:c1'));
      assert.equal(readChatSession(dir, 'c1', 'cursor')?.provider, 'cursor');
      assert.equal(readChatSession(dir, 'c1', 'cursor')?.external, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks lane-only Cursor sessions as external (Cursor UI)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kusa-external-cursor-'));
    try {
      const id = 'ui-cursor-1';
      mkdirSync(join(dir, 'agents', id), { recursive: true });
      writeFileSync(
        join(dir, 'agents', id, `${id}.json`),
        JSON.stringify({
          key: `cursor:${id}`,
          harness: 'cursor',
          id,
          active: true,
          startedAtWall: 1,
          promptIndex: 1,
          prompts: [{ index: 1, text: 'hello from Cursor UI', atWall: 1, response: 'hi' }],
        }),
      );
      const session = readChatSession(dir, id, 'cursor');
      assert.equal(session?.harness, 'cursor');
      assert.equal(session?.external, true);
      assert.equal(isExternalChatSession(session), true);
      assert.equal(session.messages?.length, 2);

      const listed = listChatSessions(dir).find((s) => s.id === id);
      assert.equal(listed?.external, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not list prompt-less Cursor lane ghosts in Agents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kusa-cursor-ghost-'));
    try {
      const ghostId = 'tool-only-ghost';
      const realId = 'real-cursor-chat';
      mkdirSync(join(dir, 'agents', ghostId), { recursive: true });
      mkdirSync(join(dir, 'agents', realId), { recursive: true });
      writeFileSync(
        join(dir, 'agents', ghostId, `${ghostId}.json`),
        JSON.stringify({
          key: `cursor:${ghostId}`,
          harness: 'cursor',
          id: ghostId,
          active: true,
          promptIndex: 0,
          prompts: [],
          startedAtWall: 1,
        }),
      );
      writeFileSync(
        join(dir, 'agents', realId, `${realId}.json`),
        JSON.stringify({
          key: `cursor:${realId}`,
          harness: 'cursor',
          id: realId,
          active: true,
          promptIndex: 1,
          prompts: [{ index: 1, text: 'hi', atWall: 1 }],
          startedAtWall: 2,
        }),
      );
      const listed = listChatSessions(dir);
      assert.deepEqual(listed.map((s) => s.id).sort(), [realId]);
      assert.equal(listed[0].external, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('collapses the same session id across provider folders into one listed row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kusa-providers-dedupe-'));
    try {
      // Cursor owns the real chat; a kusa shadow of the same id must not also
      // show up once Agents is a single consolidated list.
      createChatSession(dir, { id: 'shared-1', provider: 'cursor' });
      createChatSession(dir, { id: 'shared-1', provider: 'kusa' });

      const listed = listChatSessions(dir);
      const shared = listed.filter((s) => s.id === 'shared-1');
      assert.equal(shared.length, 1);
      assert.equal(shared[0].harness, 'cursor');
      assert.equal(shared[0].provider, 'cursor');
      assert.equal(listed.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
