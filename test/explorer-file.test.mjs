import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  readWorkspaceFile,
  writeWorkspaceFile,
} from '#features/explorer/file.mjs';

function tempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'kusa-explorer-file-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'hello.js'), 'export const n = 1;\n', 'utf8');
  return root;
}

test('readWorkspaceFile returns UTF-8 content for a relative path', () => {
  const root = tempWorkspace();
  const result = readWorkspaceFile(root, 'src/hello.js');
  assert.equal(result.ok, true);
  assert.equal(result.path, 'src/hello.js');
  assert.match(result.content, /export const n = 1/);
});

test('readWorkspaceFile rejects path escape', () => {
  const root = tempWorkspace();
  const result = readWorkspaceFile(root, '../outside.txt');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EPERM');
});

test('readWorkspaceFile rejects missing files', () => {
  const root = tempWorkspace();
  const result = readWorkspaceFile(root, 'src/missing.js');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ENOENT');
});

test('readWorkspaceFile rejects binary content', () => {
  const root = tempWorkspace();
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]));
  const result = readWorkspaceFile(root, 'blob.bin');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EBINARY');
});

test('writeWorkspaceFile creates and overwrites files', () => {
  const root = tempWorkspace();
  const created = writeWorkspaceFile(root, 'src/new.js', 'console.log(2);\n');
  assert.equal(created.ok, true);
  assert.equal(readFileSync(join(root, 'src', 'new.js'), 'utf8'), 'console.log(2);\n');

  const updated = writeWorkspaceFile(root, 'src/hello.js', 'export const n = 2;\n');
  assert.equal(updated.ok, true);
  assert.equal(readFileSync(join(root, 'src', 'hello.js'), 'utf8'), 'export const n = 2;\n');
});

test('writeWorkspaceFile rejects path escape', () => {
  const root = tempWorkspace();
  const result = writeWorkspaceFile(root, '../evil.js', 'nope');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EPERM');
});
