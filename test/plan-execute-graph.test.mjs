import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { Command, MemorySaver } from '@langchain/langgraph';
import {
  compilePlanExecuteGraph,
  PLAN_EXECUTE_WORKFLOW_ID,
} from '#features/workflows/langgraph/plan-execute.mjs';
import {
  deleteRunMarker,
  hasRunMarker,
  resetMemorySavers,
  writeRunMarker,
} from '#features/workflows/langgraph/checkpointer.mjs';
import {
  normalizeWorkflow,
  PLAN_EXECUTE_WORKFLOW,
  ensureWorkflowsSeeded,
  listWorkflows,
} from '#features/workflows/store.mjs';
import { resetPlanExecuteGraphs } from '#features/workflows/langgraph/runtime.mjs';

const temps = [];

afterEach(() => {
  resetMemorySavers();
  resetPlanExecuteGraphs();
  while (temps.length) {
    const dir = temps.pop();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'kusa-plan-execute-'));
  temps.push(dir);
  return dir;
}

describe('plan-execute LangGraph wrap', () => {
  it('compiles and ends at done when no pending planId', async () => {
    const graph = compilePlanExecuteGraph({ checkpointer: new MemorySaver() });
    const out = await graph.invoke({
      sessionKey: 'kusa:orch-1',
      workflowId: PLAN_EXECUTE_WORKFLOW_ID,
      prompt: 'ship it',
      planId: '',
      phase: '',
    }, { configurable: { thread_id: 't-no-plan' } });
    assert.equal(out.phase, 'done');
    assert.equal(out.planId, '');
  });

  it('interrupts on await_approval then resumes ensure_executor', async () => {
    /** @type {object[]} */
    const calls = [];
    const graph = compilePlanExecuteGraph({
      checkpointer: new MemorySaver(),
      continueAfterApproval: async (args) => {
        calls.push(args);
        return { ok: true, planId: args.planId, assigned: true };
      },
    });
    const config = { configurable: { thread_id: 't-approve' } };

    const interrupted = await graph.invoke({
      sessionKey: 'kusa:orch-2',
      workflowId: PLAN_EXECUTE_WORKFLOW_ID,
      prompt: 'build feature',
      planId: 'plan-abc',
      phase: '',
    }, config);

    assert.ok(Array.isArray(interrupted.__interrupt__), 'expected __interrupt__');
    assert.equal(interrupted.__interrupt__[0]?.value?.planId, 'plan-abc');
    assert.equal(calls.length, 0, 'executor must not run before resume');

    const snap = await graph.getState(config);
    assert.ok(snap.tasks?.some((t) => t.interrupts?.length), 'pending interrupt in state');

    const resumed = await graph.invoke(
      new Command({ resume: { planId: 'plan-abc', approved: true } }),
      config,
    );

    assert.equal(resumed.phase, 'done');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].planId, 'plan-abc');
    assert.equal(calls[0].sessionKey, 'kusa:orch-2');
    assert.equal(resumed.continued?.ok, true);
    assert.equal(resumed.continued?.assigned, true);
  });

  it('run markers survive under workflows/runs', () => {
    const dataDir = tempDir();
    const threadId = 'plan-execute:kusa:orch-3';
    writeRunMarker(dataDir, threadId, {
      sessionKey: 'kusa:orch-3',
      planId: 'plan-xyz',
      phase: 'await_approval',
    });
    assert.equal(hasRunMarker(dataDir, threadId), true);
    deleteRunMarker(dataDir, threadId);
    assert.equal(hasRunMarker(dataDir, threadId), false);
  });

  it('normalizeWorkflow stamps runtime=langgraph for plan-execute', () => {
    const wf = normalizeWorkflow({
      id: 'plan-execute',
      name: 'Plan then Execute',
      roles: { orchestrator: { provider: 'kusa', mode: 'agent' } },
    });
    assert.equal(wf.runtime, 'langgraph');
    assert.equal(PLAN_EXECUTE_WORKFLOW.runtime, 'langgraph');
  });

  it('ensureWorkflowsSeeded adds runtime without clobbering roles', () => {
    const dataDir = join(tempDir(), '.kusa');
    const root = ensureWorkflowsSeeded(dataDir);
    const path = join(root, 'plan-execute.json');
    writeFileSync(path, `${JSON.stringify({
      id: 'plan-execute',
      name: 'Custom name',
      roles: {
        orchestrator: { provider: 'kusa', mode: 'agent', promptTemplate: 'CUSTOM' },
        planner: { provider: 'kusa', mode: 'plan' },
      },
    }, null, 2)}\n`);

    ensureWorkflowsSeeded(dataDir);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(raw.runtime, 'langgraph');
    assert.equal(raw.name, 'Custom name');
    assert.equal(raw.roles.orchestrator.promptTemplate, 'CUSTOM');

    const listed = listWorkflows(dataDir).find((w) => w.id === 'plan-execute');
    assert.equal(listed?.runtime, 'langgraph');
    assert.equal(listed?.roles?.orchestrator?.promptTemplate, 'CUSTOM');
  });
});
