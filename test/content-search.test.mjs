import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  replaceWorkspaceContent,
  searchWorkspaceContent,
} from '#features/explorer/content-search.mjs';

function tempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'kusa-content-search-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.js'), 'const hello = 1;\nconst HELLO = 2;\n', 'utf8');
  writeFileSync(join(root, 'src', 'b.js'), 'function greet() { return "hello"; }\n', 'utf8');
  writeFileSync(join(root, 'README.md'), '# hello world\n', 'utf8');
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'hello from deps\n', 'utf8');
  return root;
}

test('searchWorkspaceContent finds lines and skips node_modules', () => {
  const root = tempWorkspace();
  const result = searchWorkspaceContent(root, { query: 'hello' });
  assert.equal(result.ok, true);
  assert.ok(result.matchCount >= 2);
  const paths = result.files.map((f) => f.path);
  assert.ok(paths.includes('src/a.js'));
  assert.ok(paths.includes('src/b.js') || paths.includes('README.md'));
  assert.ok(!paths.some((p) => p.startsWith('node_modules/')));
});

test('searchWorkspaceContent respects matchCase and include glob', () => {
  const root = tempWorkspace();
  const cased = searchWorkspaceContent(root, { query: 'HELLO', matchCase: true });
  assert.equal(cased.ok, true);
  assert.equal(cased.matchCount, 1);
  assert.equal(cased.files[0].path, 'src/a.js');

  const onlyMd = searchWorkspaceContent(root, { query: 'hello', include: '*.md' });
  assert.equal(onlyMd.ok, true);
  assert.deepEqual(onlyMd.files.map((f) => f.path), ['README.md']);
});

test('replaceWorkspaceContent dryRun does not write; live replace does', () => {
  const root = tempWorkspace();
  const dry = replaceWorkspaceContent(root, {
    query: 'hello',
    replacement: 'hola',
    matchCase: true,
    include: 'src/**',
    dryRun: true,
  });
  assert.equal(dry.ok, true);
  assert.ok(dry.replacements >= 1);
  assert.match(readFileSync(join(root, 'src', 'b.js'), 'utf8'), /hello/);

  const live = replaceWorkspaceContent(root, {
    query: 'hello',
    replacement: 'hola',
    matchCase: true,
    include: 'src/**',
    dryRun: false,
  });
  assert.equal(live.ok, true);
  assert.ok(live.changedFiles >= 1);
  assert.match(readFileSync(join(root, 'src', 'b.js'), 'utf8'), /hola/);
  assert.doesNotMatch(readFileSync(join(root, 'src', 'b.js'), 'utf8'), /hello/);
});
