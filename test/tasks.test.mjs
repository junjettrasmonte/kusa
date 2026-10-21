import { existsSync, mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_TOOL_DEFS,
  createTaskTools,
  taskToolSchemas,
  agentToolGroups,
  createKusaHookEmitter,
  createTrailAwareTools,
} from '../src/agent/index.mjs';
import { extractPlanTodo, runHook } from '../src/lib.mjs';
import { loadTasks, saveTasks, tasksFilePath } from '../src/task-store.mjs';

const dirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'kusa-tasks-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('kusa agent task tools', () => {
  it('advertises the task family to the model in every mode', async () => {
    const names = taskToolSchemas().map((schema) => schema.function.name);
    assert.deepEqual(names, TASK_TOOL_DEFS.map((def) => def.name));
    for (const mode of ['ask', 'plan', 'agent']) {
      const groups = agentToolGroups(mode);
      const taskGroup = groups.find((entry) => entry.group === 'task');
      assert.ok(taskGroup, `${mode} mode must still see the task list`);
      assert.deepEqual(taskGroup.schemas.map((s) => s.function.name), names);
    }
  });

  it('creates tasks and keeps them in the per-session sidecar', async () => {
    const dir = tempDir();
    const sessionKey = 'kusa:sess-1';
    const tasks = createTaskTools({ dataDir: dir, sessionKey });

    const added = await tasks.add({
      tasks: [{ content: 'Add the task tools' }, { content: 'Wire them into the agent' }],
    });
    assert.equal(added.ok, true);
    assert.equal(added.added.length, 2);
    // Omitted ids fall back to the content prefix — the same fallback task-store
    // uses, so the monitor and the tool never disagree about a row's id.
    assert.equal(added.added[0], 'Add the task tools');

    const stored = loadTasks(dir);
    assert.deepEqual(stored[sessionKey].todos.map((row) => row.content), [
      'Add the task tools',
      'Wire them into the agent',
    ]);
    assert.ok(existsSync(tasksFilePath(dir)));

    const listed = tasks.list();
    assert.equal(listed.total, 2);
    assert.equal(listed.summary, '2 tasks · 2 pending');
    assert.equal(listed.persisted, true);
  });

  it('flags a finished step completed and re-flagging it is a no-op, not a duplicate', async () => {
    const dir = tempDir();
    const sessionKey = 'kusa:sess-1';
    const tasks = createTaskTools({ dataDir: dir, sessionKey });
    await tasks.add({ tasks: [{ content: 'Ship the parser' }] });

    const done = tasks.update({ tasks: [{ id: 'Ship the parser', status: 'completed' }] });
    assert.equal(done.ok, true);
    assert.deepEqual(done.updated, ['Ship the parser']);
    assert.equal(done.tasks[0].status, 'completed');
    assert.equal(done.summary, '1 task · 1 done');

    // The model retried the step: already done, so nothing changes and nothing
    // fails — the row is reported unchanged instead of duplicated.
    const again = tasks.update({ tasks: [{ id: 'Ship', status: 'completed' }] });
    assert.equal(again.ok, true);
    assert.deepEqual(again.updated, []);
    assert.deepEqual(again.alreadyCompleted, ['Ship the parser']);
    assert.equal(again.tasks.length, 1);

    const unknown = tasks.update({ tasks: [{ id: 'Not a task', status: 'completed' }] });
    assert.deepEqual(unknown.notFound, ['Not a task']);
    assert.deepEqual(unknown.availableIds, ['Ship the parser']);
  });

  it('keeps the model list and the monitor lane in step (single writer)', async () => {
    const dir = tempDir();
    const hooks = createKusaHookEmitter({ dataDir: dir, sessionId: 'sess-1' });
    assert.equal(hooks.enabled, true);
    assert.equal(hooks.sessionKey, 'kusa:sess-1');

    // Same payload the emitter sends, so the state below is the real one.
    const kusaPayload = (extra = {}) => JSON.stringify({
      kusa_version: '1',
      harness: 'kusa',
      sessionId: 'sess-1',
      timestamp: Date.now(),
      cwd: dir,
      ...extra,
    });
    const feed = (eventName, extra = {}) => runHook({
      dir,
      eventName,
      stdinText: kusaPayload(extra),
      origin: 'kusa-agent',
    });

    feed('sessionStart', { source: 'new' });
    feed('beforeSubmitPrompt', { prompt: 'plan this out' });

    const tasks = createTaskTools({ dataDir: dir, sessionKey: hooks.sessionKey });
    await tasks.add({ tasks: [{ content: 'Read the store', status: 'in_progress' }] });
    // The tool is the only writer: the monitor does not parse these as a
    // TodoWrite update, so the rows cannot be applied twice.
    assert.equal(extractPlanTodo('kusa_task_add', { tasks: [{ content: 'x' }] }), null);
    const afterPrompt = loadTasks(dir);
    assert.equal(afterPrompt['kusa:sess-1'].todos[0].status, 'in_progress');

    // Any later hook event re-reads the state, and the sidecar rows hydrate onto
    // the lane — which is what the chat Task Stack renders.
    const state = feed('preToolUse', {
      toolName: 'kusa_read_file',
      toolArgs: { path: 'src/lib.mjs' },
    });
    assert.deepEqual(state.session.todos, [
      { id: 'Read the store', content: 'Read the store', status: 'in_progress' },
    ]);
    // The lane now owns the rows, so persisting keeps them (a serve bounce keeps
    // the list too).
    assert.deepEqual(loadTasks(dir)['kusa:sess-1'].todos, state.session.todos);

    tasks.update({ tasks: [{ id: 'Read the store', status: 'completed' }] });
    const closed = loadTasks(dir);
    assert.equal(closed['kusa:sess-1'].todos[0].status, 'completed');
  });

  it('pushes the rows to the monitor without another hook event (no page refresh)', async () => {
    const dir = tempDir();
    const hooks = createKusaHookEmitter({ dataDir: dir, sessionId: 'sess-live' });
    const payload = (extra = {}) => JSON.stringify({
      kusa_version: '1',
      harness: 'kusa',
      sessionId: 'sess-live',
      timestamp: Date.now(),
      cwd: dir,
      ...extra,
    });
    const feed = (eventName, extra = {}) => runHook({
      dir,
      eventName,
      stdinText: payload(extra),
      origin: 'kusa-agent',
    });

    feed('sessionStart', { source: 'new' });
    const tasks = createTaskTools({ dataDir: dir, sessionKey: hooks.sessionKey });
    await tasks.add({ tasks: [{ content: 'Appear without a refresh', status: 'in_progress' }] });

    // No second hook event was fed: the write re-rendered the monitor itself,
    // so the artifact the UI re-polls every second already carries the row on
    // the lane — which is what the chat Task Stack renders.
    const dataScript = readFileSync(join(dir, 'monitor-data.js'), 'utf8');
    assert.match(dataScript, /Appear without a refresh/);
    // Still one list, not a second copy: the sidecar and the lane agree.
    assert.deepEqual(
      loadTasks(dir)['kusa:sess-live'].todos.map((row) => `${row.id}:${row.status}`),
      ['Appear without a refresh:in_progress'],
    );

    // A status change propagates the same way, and a no-op write does not churn
    // the monitor at all (commit is skipped, so nothing is re-rendered).
    tasks.update({ tasks: [{ id: 'Appear', status: 'completed' }] });
    assert.match(readFileSync(join(dir, 'monitor-data.js'), 'utf8'), /"status":"completed"/);
    const before = statSync(join(dir, 'monitor-data.js')).mtimeMs;
    tasks.update({ tasks: [{ id: 'Appear', status: 'completed' }] });
    assert.equal(statSync(join(dir, 'monitor-data.js')).mtimeMs, before);
  });

  it('leaves other sessions alone when it writes the sidecar', async () => {
    const dir = tempDir();
    saveTasks(dir, {
      'github-copilot:other': {
        todos: [{ id: 'o1', content: 'Someone else task', status: 'pending' }],
      },
    });
    const tasks = createTaskTools({ dataDir: dir, sessionKey: 'kusa:mine' });
    await tasks.add({ tasks: [{ content: 'Mine' }] });
    const stored = loadTasks(dir);
    assert.deepEqual(Object.keys(stored).sort(), ['github-copilot:other', 'kusa:mine']);
    assert.equal(stored['github-copilot:other'].todos[0].content, 'Someone else task');
  });

  it('still works without a session to persist into', async () => {
    const tasks = createTaskTools();
    const added = await tasks.add({ tasks: [{ content: 'No monitor here' }] });
    assert.equal(added.ok, true);
    const done = tasks.update({ tasks: [{ id: 'No monitor here', status: 'completed' }] });
    assert.equal(done.tasks[0].status, 'completed');
    assert.equal(done.summary, '1 task · 1 done');
  });

  it('asks start-fresh or merge when a batch meets an existing list', async () => {
    const dir = tempDir();
    const asked = [];
    const tasks = createTaskTools({
      dataDir: dir,
      sessionKey: 'kusa:sess-1',
      ask: async (prompt, callId) => {
        asked.push({ prompt, callId });
        return { ok: true, answer: 'Start fresh', selected: { index: 0, label: 'Start fresh' } };
      },
    });

    // An empty list, and a single follow-up step, are not a conflict.
    const first = await tasks.add({
      tasks: [{ content: 'Old step' }, { content: 'Old follow-up' }],
    });
    assert.equal(first.ok, true);
    assert.equal(first.choice, undefined);
    assert.equal(asked.length, 0);

    await tasks.add({ tasks: [{ content: 'One more step' }] });
    assert.equal(asked.length, 0);
    assert.equal(tasks.list().total, 3);

    const replaced = await tasks.call(
      'kusa_task_add',
      { tasks: [{ content: 'New one' }, { content: 'New two' }] },
      'call-9',
    );
    assert.equal(asked.length, 1);
    assert.equal(asked[0].callId, 'call-9');
    assert.equal(asked[0].prompt.allowFreeText, false);
    assert.deepEqual(asked[0].prompt.options.map((option) => option.label), ['Start fresh', 'Merge']);
    assert.match(asked[0].prompt.question, /already has/);
    assert.equal(replaced.choice, 'fresh');
    assert.deepEqual(replaced.replaced, ['Old step', 'Old follow-up', 'One more step']);
    assert.deepEqual(replaced.tasks.map((row) => row.content), ['New one', 'New two']);
    assert.deepEqual(
      loadTasks(dir)['kusa:sess-1'].todos.map((row) => row.content),
      ['New one', 'New two'],
    );
  });

  it('merges the batch when the user says so, and when nobody answers', async () => {
    const dir = tempDir();
    const mergeTools = createTaskTools({
      dataDir: dir,
      sessionKey: 'kusa:merge',
      ask: async () => ({ ok: true, answer: 'Merge', selected: { index: 1, label: 'Merge' } }),
    });
    await mergeTools.add({ tasks: [{ content: 'Keep me', status: 'completed' }] });
    const merged = await mergeTools.add({
      tasks: [{ content: 'Keep me' }, { content: 'Add me' }],
    });
    assert.equal(merged.choice, 'merge');
    assert.equal(merged.assumed, undefined);
    assert.deepEqual(merged.duplicates, ['Keep me']);
    assert.deepEqual(merged.added, ['Add me']);
    assert.equal(merged.tasks[0].status, 'completed');
    assert.deepEqual(merged.tasks.map((row) => row.content), ['Keep me', 'Add me']);

    const quiet = createTaskTools({
      dataDir: dir,
      sessionKey: 'kusa:quiet',
      ask: async () => ({ ok: false, unanswered: true, reason: 'timeout' }),
    });
    await quiet.add({ tasks: [{ content: 'Already here' }] });
    const assumed = await quiet.add({
      tasks: [{ content: 'Batch A' }, { content: 'Batch B' }],
    });
    assert.equal(assumed.ok, true);
    assert.equal(assumed.choice, 'merge');
    assert.equal(assumed.assumed, true);
    assert.match(assumed.assumption, /merged/);
    assert.deepEqual(assumed.tasks.map((row) => row.content), ['Already here', 'Batch A', 'Batch B']);

    // No channel at all: same append as before, and the call does not claim a choice.
    const bare = createTaskTools({ dataDir: dir, sessionKey: 'kusa:bare' });
    await bare.add({ tasks: [{ content: 'Bare existing' }] });
    const appended = await bare.add({ tasks: [{ content: 'Bare A' }, { content: 'Bare B' }] });
    assert.equal(appended.choice, undefined);
    assert.equal(appended.tasks.length, 3);
  });

  it('leaves the list untouched when the fresh-or-merge question is aborted', async () => {
    const tasks = createTaskTools({
      ask: async () => {
        const err = new Error('aborted');
        err.code = 'ABORT';
        throw err;
      },
    });
    await tasks.add({ tasks: [{ content: 'Keep me' }] });
    await assert.rejects(
      () => tasks.add({ tasks: [{ content: 'A' }, { content: 'B' }] }),
      (err) => err.code === 'ABORT',
    );
    assert.deepEqual(tasks.list().tasks.map((row) => row.content), ['Keep me']);
  });

  it('routes the fresh-or-merge question through the agent ask channel', async () => {
    const dir = tempDir();
    let asks = 0;
    const tools = createTrailAwareTools(dir, {
      dataDir: dir,
      sessionKey: 'kusa:sess-wire',
      onAsk: (ask) => {
        asks += 1;
        assert.equal(ask.allowFreeText, false);
        assert.equal(ask.options[0].label, 'Start fresh');
        assert.equal(ask.options[1].label, 'Merge');
        return { optionIndex: 1 };
      },
    });

    const created = await tools.call('kusa_task_add', {
      tasks: [{ content: 'First' }, { content: 'Second' }],
    });
    assert.equal(created.ok, true);
    assert.equal(asks, 0);

    const merged = await tools.call('kusa_task_add', {
      tasks: [{ content: 'Third' }, { content: 'Fourth' }],
    });
    assert.equal(asks, 1);
    assert.equal(merged.choice, 'merge');
    assert.deepEqual(merged.tasks.map((row) => row.content), ['First', 'Second', 'Third', 'Fourth']);
  });
});
