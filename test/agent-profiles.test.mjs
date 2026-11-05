import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  ensureAgentProfilesSeeded,
  listAgentProfiles,
  readAgentProfile,
  writeAgentProfile,
} from '#features/agent-profiles/store.mjs';
import {
  ensureWorkflowsSeeded,
  listWorkflows,
  PLAN_EXECUTE_WORKFLOW,
  readWorkflow,
  writeWorkflow,
} from '#features/workflows/store.mjs';

const temps = [];

afterEach(() => {
  while (temps.length) {
    const dir = temps.pop();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'kusa-agent-profiles-'));
  temps.push(dir);
  return dir;
}

describe('agent profiles store', () => {
  it('seeds plan-execute roles as profiles', () => {
    const dataDir = join(tempDir(), '.kusa');
    ensureAgentProfilesSeeded(dataDir);
    const profiles = listAgentProfiles(dataDir);
    assert.ok(profiles.some((p) => p.id === 'planner'));
    assert.ok(profiles.some((p) => p.id === 'executor'));
    const planner = readAgentProfile(dataDir, 'planner');
    assert.equal(planner.provider, 'cursor');
    assert.equal(planner.mode, 'plan');
  });

  it('plan-execute workflow resolves role configs from profiles', () => {
    const dataDir = join(tempDir(), '.kusa');
    ensureWorkflowsSeeded(dataDir);
    const wf = readWorkflow(dataDir, 'plan-execute');
    assert.ok(wf);
    assert.equal(wf.roles.orchestrator.provider, 'kusa');
    assert.equal(wf.roles.planner.provider, 'cursor');
    assert.equal(wf.roles.planner.mode, 'plan');
    assert.equal(wf.roles.executor.requiresPlanStatus, 'approved');
    assert.equal(PLAN_EXECUTE_WORKFLOW.roles.planner.profile, 'planner');
  });

  it('updating a profile updates resolved workflow roles', () => {
    const dataDir = join(tempDir(), '.kusa');
    ensureWorkflowsSeeded(dataDir);
    writeAgentProfile(dataDir, {
      id: 'planner',
      name: 'Planner',
      provider: 'kusa',
      mode: 'plan',
      rules: 'ask-allow',
      promptTemplate: 'UPDATED {{prompt}}',
    });
    const wf = listWorkflows(dataDir).find((w) => w.id === 'plan-execute');
    assert.equal(wf.roles.planner.provider, 'kusa');
    assert.equal(wf.roles.planner.rules, 'ask-allow');
    assert.match(wf.roles.planner.promptTemplate, /^UPDATED/);
  });

  it('writeWorkflow persists profile bindings', () => {
    const dataDir = join(tempDir(), '.kusa');
    ensureWorkflowsSeeded(dataDir);
    writeAgentProfile(dataDir, {
      id: 'custom_reviewer',
      name: 'Custom Reviewer',
      provider: 'kusa',
      mode: 'ask',
      promptTemplate: 'Review {{prompt}}',
    });
    writeWorkflow(dataDir, {
      id: 'plan-execute',
      name: 'Plan then Execute',
      runtime: 'langgraph',
      roles: {
        orchestrator: { profile: 'orchestrator' },
        planner: { profile: 'planner' },
        executor: { profile: 'executor' },
        reviewer: { profile: 'custom_reviewer' },
      },
    });
    const raw = JSON.parse(readFileSync(join(dataDir, 'workflows', 'plan-execute.json'), 'utf8'));
    assert.equal(raw.roles.reviewer.profile, 'custom_reviewer');
    const wf = readWorkflow(dataDir, 'plan-execute');
    assert.equal(wf.roles.reviewer.mode, 'ask');
    assert.match(wf.roles.reviewer.promptTemplate, /^Review/);
  });
});
