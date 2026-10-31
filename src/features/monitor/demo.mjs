/**
 * Replay synthetic hook payloads and write an Agentic Development Console
 * dashboard. This does not talk to any live agent harness.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from './lib.mjs';

const dir = mkdtempSync(join(tmpdir(), 'kusa-demo-'));

const config = {
  toolDurationWarnMs: 3000,
  repeatWindowMs: 10000,
  repeatCount: 5,
  promptToolCountWarn: 20,
  promptElapsedWarnMs: 600000,
  sessionElapsedWarnMs: 1800000,
  maxEvents: 100,
};
const bootId = 'demo-boot';
let wall = 1_760_000_000_000;
let mono = 10_000;

function emit(eventName, payload, gapMs = 0) {
  wall += gapMs;
  mono += gapMs;
  return runHook({
    dir,
    eventName,
    stdinText: JSON.stringify({ sessionId: 'demo-session', timestamp: wall, cwd: '/work', ...payload }),
    nowWall: wall,
    nowMono: mono,
    bootId,
    config,
    origin: 'synthetic-demo',
  });
}

emit('sessionStart', { source: 'new' });
emit('userPromptSubmitted', { prompt: 'synthetic prompt text that must not be stored' }, 20);
emit('preToolUse', { toolName: 'view', toolArgs: { path: 'README.md' } }, 30);
emit('postToolUse', { toolName: 'view', toolArgs: { path: 'README.md' }, toolResult: { resultType: 'success', textResultForLlm: 'secret file body' } }, 2400);
emit('preToolUse', { toolName: 'view', toolArgs: { path: 'package.json' } }, 40);
emit('postToolUse', { toolName: 'view', toolArgs: { path: 'package.json' }, toolResult: { resultType: 'success', textResultForLlm: 'ok' } }, 300);
emit('preToolUse', { toolName: 'bash', toolArgs: { command: 'npm test' } }, 50);
emit('preToolUse', { toolName: 'grep', toolArgs: { pattern: 'hook' } }, 20);
emit('postToolUse', { toolName: 'grep', toolArgs: { pattern: 'hook' }, toolResult: { resultType: 'success', textResultForLlm: 'match' } }, 180);
emit('postToolUseFailure', { toolName: 'bash', toolArgs: { command: 'npm test' }, error: 'ENOENT: npm' }, 900);
emit('preToolUse', { toolName: 'bash', toolArgs: { command: 'true' } }, 30);
emit('postToolUseFailure', { toolName: 'bash', toolArgs: { command: 'true' }, error: 'permission denied by policy' }, 80);
emit('subagentStart', { agentName: 'explore', agentId: 'sub-1' }, 15);
emit('subagentStop', { agentName: 'explore', agentId: 'sub-1', stopReason: 'end_turn' }, 400);
emit('agentStop', { stopReason: 'end_turn' }, 25);

const state = emit('sessionEnd', { reason: 'complete' }, 10);
const view = state.tools.view;
console.log(`Wrote ${join(dir, 'dashboard.html')}`);
console.log(`view attempts=${view.total} success=${view.success} avgMs=${Math.round(view.durationMsSum / view.durationCount)}`);
console.log(`bash success=${state.tools.bash.success} failed=${state.tools.bash.failed} denied=${state.tools.bash.denied}`);
console.log('Synthetic data only. A live agent session has not been verified.');
