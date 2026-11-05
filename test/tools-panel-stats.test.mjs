import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrchestratedToolStats } from '#ui/features/chat/orchestratedToolStats.js';

describe('buildOrchestratedToolStats', () => {
  it('groups tool rows by provider → role → tool and surfaces role rules', () => {
    const chatSession = {
      id: 'orch-1',
      key: 'kusa:orch-1',
      kind: 'orchestrated',
      provider: 'kusa',
      role: 'orchestrator',
      options: {
        workflowId: 'plan-execute',
        rules: 'ask-deny',
        role: 'orchestrator',
      },
    };
    const peerSessions = [
      {
        id: 'plan-1',
        key: 'kusa:plan-1',
        provider: 'kusa',
        role: 'planner',
        parentId: 'orch-1',
        options: { role: 'planner', rules: 'ask-allow', parentId: 'orch-1' },
      },
      {
        id: 'exec-1',
        key: 'cursor:exec-1',
        provider: 'cursor',
        role: 'executor',
        parentId: 'orch-1',
        options: { role: 'executor', parentId: 'orch-1' },
      },
    ];
    const lanes = {
      'kusa:orch-1': {
        rows: [
          { name: 'kusa_assign', depth: 0, total: 2, running: 0, success: 2, failed: 0, denied: 0, incomplete: 0, avg: 10, max: 12 },
        ],
        open: [],
      },
      'kusa:plan-1': {
        rows: [
          { name: 'kusa_plan_create', depth: 0, total: 1, running: 0, success: 1, failed: 0, denied: 0, incomplete: 0, avg: 5, max: 5 },
          { name: 'kusa_read_file', depth: 0, total: 3, running: 0, success: 3, failed: 0, denied: 0, incomplete: 0, avg: 2, max: 4 },
        ],
        open: [{ id: 'inv-1', toolName: 'kusa_read_file', startedWall: 1 }],
      },
      'cursor:exec-1': {
        rows: [
          { name: 'Shell', depth: 0, total: 4, running: 1, success: 2, failed: 1, denied: 0, incomplete: 0, avg: 20, max: 40 },
          { name: 'npm test', depth: 1, total: 2, running: 0, success: 1, failed: 1, denied: 0, incomplete: 0, avg: 30, max: 40, commands: ['npm test'] },
        ],
        open: [],
      },
    };
    const workflow = {
      id: 'plan-execute',
      name: 'Plan then Execute',
      roleConfigs: {
        orchestrator: { provider: 'kusa', rules: 'ask-deny' },
        planner: { provider: 'kusa', rules: 'deny' },
        executor: { provider: 'cursor', rules: 'allow' },
      },
    };

    const stats = buildOrchestratedToolStats({
      chatSession,
      peerSessions,
      lanes,
      workflow,
    });

    assert.deepEqual(stats.providers.map((p) => p.provider), ['cursor', 'kusa']);

    const kusa = stats.providers.find((p) => p.provider === 'kusa');
    assert.equal(kusa.roles[0].role, 'orchestrator');
    assert.equal(kusa.roles[0].rules, 'ask-deny');
    assert.equal(kusa.roles[0].toolGroups[0].row.name, 'kusa_assign');
    assert.equal(kusa.roles[0].toolGroups[0].row.total, 2);

    const planner = kusa.roles.find((r) => r.role === 'planner');
    // Live session rules win over the workflow default.
    assert.equal(planner.rules, 'ask-allow');
    assert.equal(planner.rulesLabel.includes('allow'), true);
    assert.equal(planner.toolGroups.length, 2);

    const cursor = stats.providers.find((p) => p.provider === 'cursor');
    const executor = cursor.roles.find((r) => r.role === 'executor');
    assert.equal(executor.rules, 'allow');
    assert.equal(executor.toolGroups[0].row.name, 'Shell');
    assert.equal(executor.toolGroups[0].children[0].name, 'npm test');

    assert.equal(stats.usedNames.has('kusa_assign'), true);
    assert.equal(stats.usedNames.has('Shell'), true);
    assert.equal(stats.open.length, 1);
    assert.equal(stats.open[0].role, 'planner');
    assert.equal(stats.open[0].provider, 'kusa');
  });

  it('merges duplicate provider/role lanes from multiple Subagents', () => {
    const chatSession = {
      id: 'orch',
      key: 'kusa:orch',
      kind: 'orchestrated',
      provider: 'kusa',
      role: 'orchestrator',
      options: { workflowId: 'plan-execute', role: 'orchestrator' },
    };
    const peerSessions = [
      { id: 'a', key: 'kusa:a', provider: 'kusa', role: 'tester', parentId: 'orch', options: { role: 'tester' } },
      { id: 'b', key: 'kusa:b', provider: 'kusa', role: 'tester', parentId: 'orch', options: { role: 'tester' } },
    ];
    const lanes = {
      'kusa:orch': { rows: [], open: [] },
      'kusa:a': {
        rows: [{ name: 'kusa_terminal', depth: 0, total: 1, running: 0, success: 1, failed: 0, denied: 0, incomplete: 0, avg: 10, max: 10 }],
        open: [],
      },
      'kusa:b': {
        rows: [{ name: 'kusa_terminal', depth: 0, total: 2, running: 0, success: 1, failed: 1, denied: 0, incomplete: 0, avg: 20, max: 30 }],
        open: [],
      },
    };
    const stats = buildOrchestratedToolStats({ chatSession, peerSessions, lanes, workflow: null });
    const tester = stats.providers[0].roles.find((r) => r.role === 'tester');
    assert.equal(tester.toolGroups.length, 1);
    assert.equal(tester.toolGroups[0].row.total, 3);
    assert.equal(tester.toolGroups[0].row.failed, 1);
    assert.equal(tester.toolGroups[0].row.avg, 50 / 3);
  });
});
