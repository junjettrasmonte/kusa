#!/usr/bin/env node
/**
 * Copy committed hooks from .githooks/ into .git/hooks/ (no git config needed).
 * Runs from npm prepare so clones get:
 *   - pre-commit  — agent identity check + package.json patch bump
 *   - commit-msg  — strip Cursor / GitHub Copilot Co-authored-by trailers
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, '.githooks');
const destDir = join(root, '.git', 'hooks');

if (!existsSync(join(root, '.git')) || !existsSync(srcDir)) {
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });
for (const name of readdirSync(srcDir)) {
  if (name.startsWith('.')) continue;
  const from = join(srcDir, name);
  const to = join(destDir, name);
  copyFileSync(from, to);
  chmodSync(to, 0o755);
}
