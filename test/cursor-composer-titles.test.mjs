import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  applyCursorComposerTitles,
  cursorComposerTitle,
  loadCursorComposerTitles,
  resetCursorComposerTitleCache,
  resolveCursorStateDb,
} from '#extensions/cursor-adapter/composer-titles.mjs';
import {
  listChatSessions,
  writeChatSession,
} from '#features/chat/data/chat-store.mjs';

function writeFixtureDb(dir, composers) {
  const dbPath = join(dir, 'state.vscdb');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY,
      workspaceId TEXT,
      createdAt INTEGER,
      lastUpdatedAt INTEGER,
      isArchived INTEGER,
      isSubagent INTEGER,
      recency INTEGER,
      checkpointAt INTEGER,
      subagentTypeName TEXT,
      value TEXT
    );
  `);
  const insert = db.prepare(`
    INSERT INTO composerHeaders (composerId, value) VALUES (?, ?)
  `);
  for (const row of composers) {
    insert.run(row.id, JSON.stringify({
      type: 'head',
      composerId: row.id,
      name: row.name,
      lastUpdatedAt: Date.now(),
    }));
  }
  db.close();
  return dbPath;
}

describe('cursor-composer-titles', () => {
  const root = mkdtempSync(join(tmpdir(), 'kusa-cursor-titles-'));
  const globalDir = join(root, 'globalStorage');
  let dbPath;
  const prevEnv = process.env.CURSOR_STATE_VSCDB;

  before(() => {
    mkdirSync(globalDir, { recursive: true });
    dbPath = writeFixtureDb(globalDir, [
      { id: 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'Cursor session title sync' },
      { id: 'bbbb2222-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'New Chat' },
      { id: 'cccc3333-bbbb-cccc-dddd-eeeeeeeeeeee', name: '' },
    ]);
    process.env.CURSOR_STATE_VSCDB = dbPath;
    resetCursorComposerTitleCache();
  });

  after(() => {
    if (prevEnv === undefined) delete process.env.CURSOR_STATE_VSCDB;
    else process.env.CURSOR_STATE_VSCDB = prevEnv;
    resetCursorComposerTitleCache();
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves the override DB path', () => {
    assert.equal(resolveCursorStateDb({ force: true }), dbPath);
  });

  it('loads generated titles and skips New Chat / empty', () => {
    const titles = loadCursorComposerTitles({ force: true });
    assert.equal(titles.get('aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee'), 'Cursor session title sync');
    assert.equal(titles.has('bbbb2222-bbbb-cccc-dddd-eeeeeeeeeeee'), false);
    assert.equal(titles.has('cccc3333-bbbb-cccc-dddd-eeeeeeeeeeee'), false);
    assert.equal(
      cursorComposerTitle('aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee'),
      'Cursor session title sync',
    );
  });

  it('overlays titles onto cursor session rows', () => {
    const rows = [
      { id: 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee', harness: 'cursor', title: 'first prompt snippet…' },
      { id: 'other', harness: 'kusa', title: 'keep me' },
    ];
    const n = applyCursorComposerTitles(rows, { force: true });
    assert.equal(n, 1);
    assert.equal(rows[0].title, 'Cursor session title sync');
    assert.equal(rows[1].title, 'keep me');
  });

  it('listChatSessions prefers the Cursor UI title for cursor harness chats', () => {
    const dataDir = mkdtempSync(join(root, 'data-'));
    writeChatSession(dataDir, {
      id: 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee',
      harness: 'cursor',
      provider: 'cursor',
      messages: [
        {
          id: 'm1',
          role: 'user',
          text: 'cursor ui chat sessions have generated titles in them can those be reflected',
          at: Date.now(),
        },
      ],
    });
    // Lane-only session (no chat sidecar) under the shared agents/ layout.
    const laneId = 'dddd4444-bbbb-cccc-dddd-eeeeeeeeeeee';
    const laneDir = join(dataDir, 'agents', laneId);
    mkdirSync(laneDir, { recursive: true });
    writeFileSync(
      join(laneDir, `${laneId}.json`),
      `${JSON.stringify({
        key: `cursor:${laneId}`,
        harness: 'cursor',
        id: laneId,
        prompts: [{ index: 1, text: 'only a prompt so far', atWall: Date.now() }],
        startedAtWall: Date.now(),
        active: true,
      }, null, 2)}\n`,
    );

    // Extend fixture with the lane id title.
    const db = new DatabaseSync(dbPath);
    db.prepare('INSERT OR REPLACE INTO composerHeaders (composerId, value) VALUES (?, ?)').run(
      laneId,
      JSON.stringify({
        type: 'head',
        composerId: laneId,
        name: 'Lane-only Cursor title',
      }),
    );
    db.close();
    resetCursorComposerTitleCache();

    const listed = listChatSessions(dataDir);
    const fromChat = listed.find((s) => s.id === 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee');
    const fromLane = listed.find((s) => s.id === laneId);
    assert.equal(fromChat?.title, 'Cursor session title sync');
    assert.equal(fromLane?.title, 'Lane-only Cursor title');
  });
});
