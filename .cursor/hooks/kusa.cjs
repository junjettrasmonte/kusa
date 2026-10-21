#!/usr/bin/env node
// Kusă project hook. .cursor/hooks.json registers this file once per event.
'use strict';

const { spawnSync } = require('node:child_process');

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const payload = Buffer.concat(chunks).toString('utf8');
  let event = process.argv[2] || '';
  if (!event) {
    try { event = JSON.parse(payload).hook_event_name || ''; } catch { event = ''; }
  }

  const run = (args, capture) => spawnSync('kusa', args, {
    input: payload,
    encoding: 'utf8',
    stdio: ['pipe', capture ? 'pipe' : 'ignore', 'ignore'],
    shell: process.platform === 'win32',
    windowsHide: true,
  });

  const hook = run(['hook', event, '--cursor'], true);
  if (event === 'sessionStart') run(['open', '--cursor'], false);

  const output = !hook.error && hook.status === 0 ? String(hook.stdout || '').trim() : '';
  process.stdout.write(`${output || '{}'}\n`);
});
