import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createChatSession,
  deleteChatFiles,
  listChatSessions,
  readChatSession,
  readSessionConfig,
  writeChatSession,
  writeSessionConfig,
} from '#features/chat/data/chat-store.mjs';

describe('chat-store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kusa-chat-store-'));
  try {
    it('a pick is stored in its own file, never in the transcript', () => {
      const created = createChatSession(dir, { id: 'pick-1' });
      // A session that never picked has no settings file at all — that is how
      // "use Settings" stays different from "the user chose the default".
      assert.equal(readSessionConfig(dir, 'pick-1'), null);
      const written = writeChatSession(dir, {
        ...created,
        options: { mode: 'agent', rules: 'allow', model: '' },
      });
      assert.deepEqual(written.options, { mode: 'agent', rules: 'allow' });
      const transcript = JSON.parse(
        readFileSync(join(dir, 'kusa', 'pick-1.chat.json'), 'utf8'),
      );
      // The transcript stays a transcript: no picks inside it.
      assert.equal(Object.hasOwn(transcript, 'options'), false);
      assert.deepEqual(readSessionConfig(dir, 'pick-1'), { mode: 'agent', rules: 'allow' });
    });

    it('a turn write cannot clear a Rule the user picked', () => {
      // Exactly what persistTurnPrompt / persistTurnCompletion do: rebuild the
      // record with new messages and no knowledge of picks.
      const session = readChatSession(dir, 'pick-1');
      const afterTurn = writeChatSession(dir, {
        ...session,
        status: 'idle',
        live: null,
        messages: [{ id: 'm1', role: 'user', text: 'next step', at: Date.now() }],
      });
      assert.equal(afterTurn.options.rules, 'allow');
      assert.deepEqual(readSessionConfig(dir, 'pick-1'), { mode: 'agent', rules: 'allow' });
      // A refresh re-reads the same thing the dashboard serves.
      const listed = listChatSessions(dir).find((s) => s.id === 'pick-1');
      assert.equal(listed.options.rules, 'allow');
    });

    it('a partial pick keeps the other pickers', () => {
      const merged = writeSessionConfig(dir, 'pick-1', { model: 'gpt-test' });
      assert.deepEqual(merged, { mode: 'agent', rules: 'allow', model: 'gpt-test' });
      // An empty merge invents nothing and writes no file.
      assert.equal(writeSessionConfig(dir, 'never-picked', {}), null);
      assert.equal(readSessionConfig(dir, 'never-picked'), null);
    });

    it('a settings sidecar is never read as a monitor lane', () => {
      // A hand-edited sidecar that looks like a lane record (id + harness) must
      // not hydrate a row: listLaneFiles reads every other .json in the folder,
      // and a settings file carries no prompts.
      writeFileSync(
        join(dir, 'kusa', 'ghost.session.json'),
        JSON.stringify({ harness: 'kusa', id: 'ghost', rules: 'allow' }),
      );
      const listed = listChatSessions(dir);
      assert.deepEqual(listed.map((s) => s.id), ['pick-1']);
      assert.deepEqual(readSessionConfig(dir, 'ghost'), { rules: 'allow' });
    });

    it('an old transcript that kept picks inside it is migrated out', () => {
      const legacy = writeChatSession(dir, {
        id: 'legacy-1',
        key: 'kusa:legacy-1',
        status: 'idle',
        attempts: 0,
        createdAt: 1,
        messages: [],
        options: { rules: 'deny' },
      });
      assert.equal(legacy.options.rules, 'deny');
      assert.deepEqual(readSessionConfig(dir, 'legacy-1'), { rules: 'deny' });
      // The newer sidecar wins over anything still inside the transcript.
      const overridden = writeSessionConfig(dir, 'legacy-1', { rules: 'ask-allow' });
      assert.deepEqual(overridden, { rules: 'ask-allow' });
      assert.equal(readChatSession(dir, 'legacy-1').options.rules, 'ask-allow');
    });

    it('deleting a chat drops its settings too', () => {
      deleteChatFiles(dir, ['pick-1']);
      assert.equal(readSessionConfig(dir, 'pick-1'), null);
      // A lane can still hydrate a transcript-less session (unchanged behaviour)
      // — what must not come back is the Rule the deleted chat had picked.
      assert.equal(readChatSession(dir, 'pick-1')?.options, null);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
