import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agentToolGroups } from '#features/agent/index.mjs';
import {
  PLAN_TOOL_DEFS,
  createPlanTools,
  planToolSchemas,
  plansBlockingAgentDelete,
} from '#features/agent/plans.mjs';
import { writeSessionConfig } from '#features/chat/data/chat-store.mjs';
import {
  createPlan,
  deletePlan,
  listPlans,
  readPlan,
  updatePlan,
} from '#features/chat/data/plan-store.mjs';

const dirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'kusa-plans-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('kusa agent plan tools', () => {
  it('advertises plan_complete and plan_ingest with the rest of the plan family', () => {
    const names = planToolSchemas().map((schema) => schema.function.name);
    assert.deepEqual(names, PLAN_TOOL_DEFS.map((def) => def.name));
    for (const name of ['kusa_plan_complete', 'kusa_plan_ingest']) {
      assert.ok(names.includes(name));
      for (const mode of ['ask', 'plan', 'agent']) {
        const groups = agentToolGroups(mode);
        const planGroup = groups.find((entry) => entry.group === 'plan');
        assert.ok(planGroup, `${mode} mode must still see plan tools`);
        assert.ok(planGroup.schemas.some((s) => s.function.name === name));
      }
    }
  });

  it('marks an executing plan done and completes open todos', () => {
    const dir = tempDir();
    const plan = createPlan(dir, {
      name: 'Ship feature',
      body: '# Steps\n\n1. Do the thing',
      status: 'executing',
      todos: [
        { id: 'a', content: 'Do the thing', status: 'in_progress' },
        { id: 'b', content: 'Skip me', status: 'cancelled' },
      ],
    });
    const tools = createPlanTools({ dataDir: dir, sessionKey: 'kusa:executor-1' });

    const result = tools.complete({ planId: plan.id, summary: 'Shipped' });
    assert.equal(result.ok, true);
    assert.equal(result.plan.status, 'done');
    assert.equal(result.summary, 'Shipped');
    assert.equal(result.plan.todos[0].status, 'completed');
    assert.equal(result.plan.todos[1].status, 'cancelled');
    assert.equal(readPlan(dir, plan.id).status, 'done');

    const again = tools.complete({ planId: plan.id });
    assert.equal(again.ok, true);
    assert.equal(again.alreadyDone, true);
  });

  it('defaults planId from the assigned session config', () => {
    const dir = tempDir();
    const plan = createPlan(dir, {
      name: 'Bound plan',
      body: 'body',
      status: 'approved',
    });
    writeSessionConfig(dir, 'executor-1', { planId: plan.id });
    const tools = createPlanTools({ dataDir: dir, sessionKey: 'kusa:executor-1' });

    const result = tools.call('kusa_plan_complete', {});
    assert.equal(result.ok, true);
    assert.equal(result.plan.id, plan.id);
    assert.equal(result.plan.status, 'done');
  });

  it('refuses to complete draft or cancelled plans', () => {
    const dir = tempDir();
    const tools = createPlanTools({ dataDir: dir, sessionKey: 'kusa:agent' });
    const draft = createPlan(dir, { name: 'Draft', body: 'x', status: 'draft' });
    const cancelled = createPlan(dir, { name: 'Cancelled', body: 'x', status: 'cancelled' });

    const draftResult = tools.complete({ planId: draft.id });
    assert.equal(draftResult.ok, false);
    assert.equal(draftResult.code, 'EPLAN');

    const cancelledResult = tools.complete({ planId: cancelled.id });
    assert.equal(cancelledResult.ok, false);
    assert.equal(cancelledResult.code, 'EPLAN');
  });

  it('ingests a plan file into the Plan drawer', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'PLAN.md'), [
      '---',
      'name: Ship the CSV reader',
      'overview: Parse uploads without blocking the chat',
      'todos:',
      '  - id: parse',
      '    content: Tokenize the upload',
      '    status: in_progress',
      '  - id: wire',
      '    content: Hook it to the composer',
      '---',
      '# Steps',
      '',
      '1. Tokenize',
      '2. Wire',
    ].join('\n'));
    const tools = createPlanTools({ dataDir: dir, sessionKey: 'kusa:planner-1', workspaceRoot: dir });

    const result = tools.ingest({ path: 'PLAN.md' });
    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.equal(result.plan.name, 'Ship the CSV reader');
    assert.equal(result.plan.overview, 'Parse uploads without blocking the chat');
    assert.equal(result.plan.status, 'ready');
    assert.ok(result.plan.body.startsWith('# Steps'));
    assert.equal(result.plan.todos.length, 2);
    assert.equal(result.plan.todos[0].status, 'in_progress');
    assert.equal(listPlans(dir).length, 1);

    const stored = readPlan(dir, result.plan.id);
    assert.ok(stored.sourcePath.endsWith('PLAN.md'));

    // A second read of the same file refreshes the record it already made.
    const again = tools.ingest({ path: 'PLAN.md' });
    assert.equal(again.ok, true);
    assert.equal(again.updated, true);
    assert.equal(again.matchedBy, 'sourcePath');
    assert.equal(again.plan.id, result.plan.id);
    assert.equal(listPlans(dir).length, 1);

    // The file body is the source of truth, so an edit lands on the same plan.
    writeFileSync(join(dir, 'PLAN.md'), [
      '---',
      'name: Ship the CSV reader',
      'overview: Parse uploads without blocking the chat',
      '---',
      '# Steps (revised)',
    ].join('\n'));
    const edited = tools.ingest({ path: 'PLAN.md' });
    assert.equal(edited.ok, true);
    assert.ok(edited.plan.body.startsWith('# Steps (revised)'));
    // Todos the file stopped declaring stay, they were the agent's to keep.
    assert.equal(edited.plan.todos.length, 2);
  });

  it('falls back to the file name when a plan file has no frontmatter', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'refactor.plan.md'), '# Refactor\n\n1. Split the parser');
    const tools = createPlanTools({ dataDir: dir, sessionKey: 'kusa:agent', workspaceRoot: dir });

    const result = tools.ingest({ path: 'refactor.plan.md', name: 'Refactor the parser', status: 'draft' });
    assert.equal(result.ok, true);
    assert.equal(result.plan.name, 'Refactor the parser');
    assert.equal(result.plan.status, 'draft');
    assert.ok(result.plan.body.startsWith('# Refactor'));

    const unnamed = tools.ingest({ path: 'refactor.plan.md' });
    assert.equal(unnamed.ok, true);
    assert.equal(unnamed.plan.name, 'refactor.plan');
  });

  it('creates and updates a plan through the tool surface', () => {
    const dir = tempDir();
    const tools = createPlanTools({ dataDir: dir, sessionKey: 'kusa:planner-1' });

    const created = tools.create({
      name: 'Registration mockup',
      overview: 'A Tailwind name+address form',
      body: '# Steps\n\n1. Scaffold reg.html',
      todos: [{ content: 'Scaffold reg.html' }],
      status: 'ready',
    });
    assert.equal(created.ok, true);
    assert.equal(created.plan.name, 'Registration mockup');
    assert.equal(created.plan.status, 'ready');
    assert.equal(created.plan.createdByAgentId, 'planner-1');
    assert.equal(listPlans(dir).length, 1);

    const updated = tools.update({
      planId: created.plan.id,
      overview: 'Revised overview',
      body: '# Steps\n\n1. Scaffold\n2. Style',
      todos: [
        { id: 'a', content: 'Scaffold', status: 'completed' },
        { id: 'b', content: 'Style', status: 'pending' },
      ],
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.plan.overview, 'Revised overview');
    assert.equal(updated.plan.todos.length, 2);
    assert.ok(updated.plan.body.includes('2. Style'));

    const selfApprove = tools.update({ planId: created.plan.id, status: 'approved' });
    assert.equal(selfApprove.ok, false);
    assert.equal(selfApprove.code, 'EPERM');
  });

  it('refuses to duplicate or invent with mode create/update', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'plan.md'), '# Solo plan');
    writeFileSync(join(dir, 'other-plan.md'), '# Untracked plan file');
    const tools = createPlanTools({ dataDir: dir, sessionKey: 'kusa:agent', workspaceRoot: dir });

    const first = tools.ingest({ path: 'plan.md' });
    assert.equal(first.ok, true);

    const duplicate = tools.ingest({ path: 'plan.md', mode: 'create' });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.code, 'EEXISTS');

    // File exists but no workspace plan claims it yet — mode=update must refuse.
    const unseen = tools.ingest({ path: 'other-plan.md', mode: 'update' });
    assert.equal(unseen.ok, false);
    assert.equal(unseen.code, 'EPLAN');

    const missing = tools.ingest({ path: 'missing.md', mode: 'update' });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'ENOENT');
  });

  it('leaves an approved plan untouched when its file changes', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'PLAN.md'), '---\nname: Before\n---\nbody before');
    const tools = createPlanTools({ dataDir: dir, sessionKey: 'kusa:agent', workspaceRoot: dir });

    const created = tools.ingest({ path: 'PLAN.md' });
    assert.equal(created.ok, true);
    // Approval is a human Plan-drawer action — stamp it via the store, not the tool.
    updatePlan(dir, created.plan.id, { status: 'approved' });
    writeFileSync(join(dir, 'PLAN.md'), '---\nname: After\n---\nbody after');

    const result = tools.ingest({ path: 'PLAN.md' });
    assert.equal(result.ok, true);
    assert.equal(result.updated, true);
    assert.equal(result.plan.name, 'Before');
    assert.equal(result.plan.body, 'body before');
    assert.equal(result.plan.status, 'approved');
    assert.match(result.note, /content left untouched/);
  });

  it('ingests a .kusa/plans-style JSON record in place', () => {
    const dir = tempDir();
    const existing = createPlan(dir, { id: 'plan_imported', name: 'Imported', body: 'old body' });
    writeFileSync(join(dir, 'imported.json'), JSON.stringify({
      id: existing.id,
      name: 'Imported',
      overview: 'from a JSON file',
      body: 'new body',
      todos: [{ id: 'a', content: 'Do it', status: 'pending' }],
    }));
    const tools = createPlanTools({ dataDir: dir, sessionKey: 'kusa:agent', workspaceRoot: dir });

    const result = tools.ingest({ path: 'imported.json' });
    assert.equal(result.ok, true);
    assert.equal(result.updated, true);
    assert.equal(result.matchedBy, 'planId');
    assert.equal(result.plan.id, existing.id);
    assert.equal(result.plan.body, 'new body');
    assert.equal(readPlan(dir, existing.id).body, 'new body');
  });

  it('keeps an ingested plan inside the workspace', () => {
    const dir = tempDir();
    const tools = createPlanTools({ dataDir: dir, sessionKey: 'kusa:agent', workspaceRoot: dir });
    const escaped = tools.ingest({ path: '../outside.md' });
    assert.equal(escaped.ok, false);
    assert.equal(escaped.code, 'EPERM');
  });

  it('blocks agent delete while a plan locks the tree, and clears after deletePlan', () => {
    const dir = tempDir();
    const plan = createPlan(dir, {
      name: 'Locking plan',
      body: 'body',
      status: 'draft',
      createdByAgentId: 'orch-1',
    });
    const locked = plansBlockingAgentDelete(dir, ['kusa:orch-1']);
    assert.equal(locked.length, 1);
    assert.equal(locked[0].id, plan.id);

    assert.equal(deletePlan(dir, plan.id), true);
    assert.equal(plansBlockingAgentDelete(dir, ['kusa:orch-1']).length, 0);
    assert.equal(readPlan(dir, plan.id), null);
  });
});
