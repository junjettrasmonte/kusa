#!/usr/bin/env node
/**
 * Build the Agentic Development Console UI with Vite + Tailwind.
 * Prefer `npm run build` or `kusa build`.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const result = spawnSync(
  'npx',
  ['vite', 'build', '--config', resolve(here, 'vite.config.mjs')],
  { cwd: here, stdio: 'inherit', shell: process.platform === 'win32' },
);
process.exit(result.status ?? 1);
