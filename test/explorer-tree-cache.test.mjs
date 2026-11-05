import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

import { writeWorkspaceFile } from '#features/explorer/file.mjs';
import {
  bumpWorkspaceTreeRev,
  getWorkspaceTreeRev,
  resetWorkspaceTreeRev,
} from '#features/explorer/tree-rev.mjs';

test('tree rev bumps on create, not on overwrite', () => {
  resetWorkspaceTreeRev(1);
  const root = mkdtempSync(join(tmpdir(), 'kusa-tree-rev-'));
  const before = getWorkspaceTreeRev().rev;

  const created = writeWorkspaceFile(root, 'a.js', 'one\n');
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(getWorkspaceTreeRev().rev, before + 1);

  const mid = getWorkspaceTreeRev().rev;
  const updated = writeWorkspaceFile(root, 'a.js', 'two\n');
  assert.equal(updated.ok, true);
  assert.equal(updated.created, false);
  assert.equal(getWorkspaceTreeRev().rev, mid);
});

test('bumpWorkspaceTreeRev advances monotonically', () => {
  resetWorkspaceTreeRev(5);
  assert.equal(getWorkspaceTreeRev().rev, 5);
  bumpWorkspaceTreeRev('test');
  assert.equal(getWorkspaceTreeRev().rev, 6);
});

test('explorer session cache set / invalidate / clear', async () => {
  const cacheUrl = pathToFileURL(
    join(process.cwd(), 'src/app/console/ui/features/explorer/tree-cache.js'),
  ).href;
  const cache = await import(cacheUrl);
  cache.resetExplorerCache();

  const events = [];
  const unsub = cache.subscribeExplorerCache((e) => events.push(e.type));

  assert.equal(cache.getExplorerCache(), null);
  cache.setExplorerCache({
    payload: { tree: { name: 'ws', children: [] }, counts: { files: 0, dirs: 0 } },
    loaded: { src: [] },
    rev: 3,
  });
  const snap = cache.getExplorerCache();
  assert.ok(snap);
  assert.equal(snap.rev, 3);
  assert.equal(snap.stale, false);
  assert.deepEqual(snap.loaded.src, []);

  cache.invalidateExplorerCache('test');
  assert.equal(cache.getExplorerCache()?.stale, true);

  cache.invalidateExplorerCache('manual', { clear: true });
  assert.equal(cache.getExplorerCache(), null);

  unsub();
  assert.ok(events.includes('set'));
  assert.ok(events.includes('invalidate'));
});
