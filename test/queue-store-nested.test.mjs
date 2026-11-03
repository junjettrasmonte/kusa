import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadQueues, QUEUES_FILE } from '#features/chat/data/queue-store.mjs';
import { SUBAGENTS_DIR } from '#features/monitor/lib.mjs';

describe('queue-store nested Subagents', () => {
  it('loads held prompts from agents/<parent>/subagents/<child>/queues.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kusa-queue-nested-'));
    const parent = 'parent-agent-1';
    const child = 'child-sub-1';
    const nested = join(dir, 'agents', parent, SUBAGENTS_DIR, child);
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(nested, 'agent.json'),
      `${JSON.stringify({ provider: 'cursor', parentId: parent, role: 'planner' }, null, 2)}\n`,
    );
    writeFileSync(
      join(nested, 'chat.json'),
      `${JSON.stringify({
        key: `cursor:${child}`,
        id: child,
        harness: 'cursor',
        messages: [],
      }, null, 2)}\n`,
    );
    writeFileSync(
      join(nested, QUEUES_FILE),
      `${JSON.stringify({
        version: 1,
        key: `cursor:${child}`,
        queued: [{
          id: 'q_test_1',
          text: 'Plan the nested assign prompt',
          at: Date.now(),
          options: { mode: 'plan', model: '', approvalMode: '' },
        }],
        steering: [],
      }, null, 2)}\n`,
    );

    const { queued } = loadQueues(dir);
    const held = queued.get(`cursor:${child}`);
    assert.ok(held, 'nested Subagent queue key missing from loadQueues');
    assert.equal(held.length, 1);
    assert.equal(held[0].text, 'Plan the nested assign prompt');
  });
});
