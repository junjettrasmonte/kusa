import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTodos,
  classifyFailure,
  classifyFamily,
  classifyPromptRole,
  collectGitStatus,
  collectTrailStatus,
  collectWorkspaceReady,
  snapshotTrailStatus,
  commandNameOf,
  deleteSessions,
  isPlanExecutionPrompt,
  extractPlanTodo,
  fileLabelOf,
  formatDuration,
  trailSavingsFromTranscript,
  isFileTool,
  isTerminalTool,
  laneFiles,
  loadMonitorSettings,
  parseGitStatusPorcelain,
  parseTrailTurnSavings,
  parsePlanMarkdown,
  runHook,
  saveMonitorSettings,
  sumTrailFooters,
  todosFromTranscriptText,
} from '../src/lib.mjs';
import {
  chatFilePath,
  createChatSession,
  listChatSessions,
  migrateChatSessions,
  writeChatSession,
} from '../src/chat-store.mjs';
import { createMonitorServer, resolveServePort } from '../src/serve.mjs';
import { loadQueues, queuesFilePath, saveQueues, WORKSPACE_QUEUE_KEY } from '../src/queue-store.mjs';
import { loadTasks, tasksFilePath } from '../src/task-store.mjs';

const root = join(import.meta.dirname, '..');
const hookPath = join(root, 'src', 'hook.mjs');
const cliPath = join(root, 'src', 'cli', 'kusa.mjs');
const dirs = [];
const quiet = {
  toolDurationWarnMs: 1e12,
  repeatWindowMs: 1000,
  repeatCount: 1000,
  promptToolCountWarn: 1000,
  promptElapsedWarnMs: 1e12,
  sessionElapsedWarnMs: 1e12,
  maxEvents: 100,
};

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'kusa-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function feed(dir, eventName, payload, extra = {}) {
  const wall = extra.wall ?? payload.timestamp ?? 1_700_000_000_000;
  return runHook({
    dir,
    eventName,
    stdinText: extra.stdinText ?? JSON.stringify(payload),
    truncated: extra.truncated ?? false,
    nowWall: wall,
    nowMono: extra.mono ?? 0,
    bootId: extra.bootId ?? 'test-boot',
    config: extra.config ?? quiet,
    origin: extra.origin ?? 'hooks',
  });
}

/** The view inlined into the runtime dashboard.html. */
function bootstrap(dir) {
  const html = readFileSync(join(dir, 'dashboard.html'), 'utf8');
  const match = html.match(/<script id="monitor-bootstrap" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(match, 'bootstrap script present');
  return JSON.parse(match[1]);
}

/** Shared index + focused lane from the on-disk schema-3 layout. */
function readPersisted(dir) {
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  const rel = index.sessionFiles?.[index.focus];
  const lane = rel ? JSON.parse(readFileSync(join(dir, rel), 'utf8')) : null;
  return { index, lane };
}

/** Concatenate persisted text files so tests can assert secrets never landed on disk. */
function persistedText(dir) {
  const chunks = [];
  for (const name of ['index.json', 'dashboard.html', 'dashboard.md', 'monitor-data.js']) {
    chunks.push(readFileSync(join(dir, name), 'utf8'));
  }
  const { index } = readPersisted(dir);
  for (const rel of Object.values(index.sessionFiles || {})) {
    chunks.push(readFileSync(join(dir, rel), 'utf8'));
    const events = rel.replace(/\.json$/, '.events.jsonl');
    if (existsSync(join(dir, events))) chunks.push(readFileSync(join(dir, events), 'utf8'));
  }
  return chunks.join('\n');
}

function session(id = 'sess-1', timestamp = 1_700_000_000_000) {
  return { sessionId: id, timestamp, cwd: '/work', source: 'new' };
}

function tool(name, extra = {}) {
  return { sessionId: 'sess-1', timestamp: 1_700_000_000_000, cwd: '/work', toolName: name, ...extra };
}

describe('trail savings helpers', () => {
  it('parses footer and turn-tally savings and attributes them per prompt turn', () => {
    assert.equal(sumTrailFooters('[trail] tokens saved ≈ 1,234 (50%) — this pack'), 1234);
    assert.equal(sumTrailFooters('[graft] tokens saved ≈ 99 (legacy)'), 99);
    assert.equal(sumTrailFooters('no savings here'), 0);
    assert.equal(parseTrailTurnSavings('🌱 trail saved ~387,149 tokens this turn'), 387149);
    assert.equal(parseTrailTurnSavings('🌱 graft saved ~12 tokens this turn'), 12);
    assert.equal(parseTrailTurnSavings('nothing'), null);

    assert.equal(classifyPromptRole('<user_query>hello</user_query>'), 'user');
    assert.equal(classifyPromptRole('<system_reminder>be brief</system_reminder>'), 'system');
    assert.equal(classifyPromptRole('plain', 'system'), 'system');
    const planExec = 'Implement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.\n\nTo-do\'s from the plan have already been created.';
    assert.equal(isPlanExecutionPrompt(planExec), true);
    assert.equal(classifyPromptRole(`<user_query>\n${planExec}\n</user_query>`), 'plan');

    const transcript = [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>first</user_query>' }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [
        { type: 'text', text: '[trail] tokens saved ≈ 100 (10%) — x\n\nhello' },
        { type: 'text', text: 'done\n\n🌱 trail saved ~250 tokens this turn' },
      ] } }),
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<system_reminder>note</system_reminder>' }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: '[trail] tokens saved ≈ 40\nno tally' }] } }),
    ].join('\n');
    const turns = trailSavingsFromTranscript(transcript);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].savedTokens, 250);
    assert.equal(turns[0].role, 'user');
    assert.equal(turns[1].savedTokens, 40);
    assert.equal(turns[1].role, 'system');
  });
});

describe('Copilot feature parity', () => {
  it('attributes trail footers from Copilot postToolUse onto the open prompt', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', session());
    feed(dir, 'userPromptSubmitted', {
      sessionId: 'sess-1',
      timestamp: 1_700_000_000_100,
      cwd: '/work',
      prompt: 'run trail',
    }, { wall: 1_700_000_000_100, mono: 100 });
    feed(dir, 'preToolUse', tool('bash', {
      timestamp: 1_700_000_000_200,
      toolArgs: { command: 'trail ask x' },
    }), { wall: 1_700_000_000_200, mono: 200 });
    const state = feed(dir, 'postToolUse', tool('bash', {
      timestamp: 1_700_000_000_500,
      toolArgs: { command: 'trail ask x' },
      toolResult: {
        resultType: 'success',
        textResultForLlm: '[trail] tokens saved ≈ 12,345 (40%) — this pack\nok',
      },
    }), { wall: 1_700_000_000_500, mono: 500 });
    assert.equal(state.harness, 'github-copilot');
    assert.equal(state.session.prompts[0].trailSavedTokens, 12345);
    assert.equal(state.session.trail.savedTokens, 12345);
    assert.equal(state.recent[0].outcome, 'trail-saved');
  });

  it('stores Copilot transcriptPath and syncs todos from that file', () => {
    const dir = tempDir();
    const transcript = join(dir, 'copilot-transcript.jsonl');
    writeFileSync(transcript, [
      JSON.stringify({
        role: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            name: 'TodoWrite',
            input: {
              merge: false,
              todos: [
                { id: 'a', content: 'Ship Copilot parity', status: 'in_progress' },
                { id: 'b', content: 'Verify trail', status: 'pending' },
              ],
            },
          }],
        },
      }),
    ].join('\n'));
    feed(dir, 'sessionStart', session());
    feed(dir, 'userPromptSubmitted', {
      sessionId: 'sess-1',
      timestamp: 1_700_000_000_100,
      cwd: '/work',
      prompt: 'work the plan',
    }, { wall: 1_700_000_000_100, mono: 100 });
    const state = feed(dir, 'agentStop', {
      sessionId: 'sess-1',
      timestamp: 1_700_000_000_200,
      cwd: '/work',
      stopReason: 'end_turn',
      transcriptPath: transcript,
    }, { wall: 1_700_000_000_200, mono: 200 });
    assert.equal(state.session.transcriptPath, transcript);
    assert.equal(state.session.todos.length, 2);
    assert.equal(state.session.todos[0].content, 'Ship Copilot parity');
  });

  it('records Copilot TodoWrite from preToolUse like Cursor', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', session());
    feed(dir, 'userPromptSubmitted', {
      sessionId: 'sess-1',
      timestamp: 1_700_000_000_100,
      cwd: '/work',
      prompt: 'track work',
    }, { wall: 1_700_000_000_100, mono: 100 });
    const state = feed(dir, 'preToolUse', tool('TodoWrite', {
      timestamp: 1_700_000_000_200,
      toolArgs: {
        merge: false,
        todos: [{ id: 't1', content: 'Copilot todo', status: 'pending' }],
      },
    }), { wall: 1_700_000_000_200, mono: 200 });
    assert.equal(state.session.todos[0].content, 'Copilot todo');
    assert.equal(state.recent[0].outcome, 'todos');
    // Per-session sidecar — this lane's key only.
    assert.ok(existsSync(tasksFilePath(dir)));
    const stored = loadTasks(dir);
    assert.equal(stored['github-copilot:sess-1']?.todos[0].content, 'Copilot todo');
  });

  it('keeps task lists per session in tasks.json (prompts stay workspace-shared)', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', session('alpha'));
    feed(dir, 'preToolUse', tool('TodoWrite', {
      sessionId: 'alpha',
      timestamp: 1_700_000_000_200,
      toolArgs: {
        merge: false,
        todos: [
          { id: 't1', content: 'Alpha task', status: 'in_progress' },
          { id: 't2', content: 'Alpha later', status: 'pending' },
        ],
      },
    }), { wall: 1_700_000_000_200, mono: 200 });

    // A different session starts empty — tasks are not workspace-shared.
    const other = feed(dir, 'sessionStart', session('beta'), {
      wall: 1_700_000_000_300,
      mono: 300,
    });
    assert.equal(other.session.id, 'beta');
    assert.deepEqual(other.session.todos, []);
    assert.equal(other.sessions['github-copilot:alpha'].todos[0].content, 'Alpha task');

    feed(dir, 'preToolUse', tool('TodoWrite', {
      sessionId: 'beta',
      timestamp: 1_700_000_000_350,
      toolArgs: {
        merge: false,
        todos: [{ id: 'b1', content: 'Beta only', status: 'pending' }],
      },
    }), { wall: 1_700_000_000_350, mono: 350 });

    const stored = loadTasks(dir);
    assert.equal(stored['github-copilot:alpha']?.todos.length, 2);
    assert.equal(stored['github-copilot:beta']?.todos[0].content, 'Beta only');

    // Cold load: each session keeps its own list.
    const reloaded = feed(dir, 'sessionStart', session('gamma'), {
      wall: 1_700_000_000_400,
      mono: 400,
    });
    assert.deepEqual(reloaded.session.todos, []);
    assert.equal(reloaded.sessions['github-copilot:alpha'].todos[1].content, 'Alpha later');
    assert.equal(reloaded.sessions['github-copilot:beta'].todos[0].content, 'Beta only');
  });
});

describe('plan and todos helpers', () => {
  it('parses Plan Mode markdown frontmatter and replays transcript TodoWrite calls', () => {
    const parsed = parsePlanMarkdown(`---
name: Demo plan
overview: Do the thing
todos:
  - id: one
    content: First
    status: completed
  - id: two
    content: Second
    status: pending
---

# Body

Details here.
`);
    assert.equal(parsed.plan.name, 'Demo plan');
    assert.equal(parsed.todos.length, 2);
    assert.equal(parsed.todos[0].status, 'completed');
    assert.match(parsed.plan.body, /Details here/);

    const wrapped = extractPlanTodo('CallDynamicTool', {
      namespace: 'cursor',
      toolName: 'TodoWrite',
      arguments: { merge: false, todos: [{ id: 'x', content: 'X', status: 'pending' }] },
    });
    assert.equal(wrapped.kind, 'todos');
    assert.equal(wrapped.todos[0].id, 'x');

    const transcript = [
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'CallDynamicTool', input: { namespace: 'cursor', toolName: 'TodoWrite', arguments: { merge: false, todos: [{ id: '1', content: 'A', status: 'in_progress' }, { id: '2', content: 'B', status: 'pending' }] } } }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'CallDynamicTool', input: { namespace: 'cursor', toolName: 'TodoWrite', arguments: { merge: true, todos: [{ id: '1', status: 'completed' }] } } }] } }),
    ].join('\n');
    const todos = todosFromTranscriptText(transcript);
    assert.equal(todos.length, 2);
    assert.equal(todos.find((t) => t.id === '1').status, 'completed');
    assert.equal(todos.find((t) => t.id === '2').content, 'B');

    const lane = { todos: [] };
    applyTodos(lane, [{ id: 'z', content: 'Z', status: 'pending' }], false, 1);
    applyTodos(lane, [{ id: 'z', status: 'cancelled' }], true, 2);
    assert.equal(lane.todos[0].content, 'Z');
    assert.equal(lane.todos[0].status, 'cancelled');
  });
});

describe('payload classification', () => {
  it('separates Copilot camelCase payloads from Local harness payloads', () => {
    assert.equal(classifyFamily({ sessionId: 's', timestamp: 1, cwd: '/work', toolName: 'view' }), 'copilot');
    assert.equal(classifyFamily({
      hook_event_name: 'PreToolUse',
      session_id: 's',
      tool_name: 'read_file',
      tool_use_id: 'tool-1',
      timestamp: '2026-01-01T00:00:00.000Z',
    }), 'local');
    assert.equal(classifyFamily({
      hook_event_name: 'preToolUse',
      conversation_id: 'conv',
      generation_id: 'gen',
      cursor_version: '1.7.2',
      workspace_roots: ['/work'],
      tool_name: 'Shell',
      tool_input: { command: 'npm test' },
      tool_use_id: 'abc',
    }), 'cursor');
    assert.equal(classifyFamily({
      kusa_version: '1',
      sessionId: 'chat-1',
      timestamp: 1,
      cwd: '/work',
      toolName: 'kusa_read_file',
    }), 'kusa');
    assert.equal(classifyFamily({
      harness: 'kusa',
      sessionId: 'chat-1',
      timestamp: 1,
      cwd: '/work',
    }), 'kusa');
    assert.equal(isTerminalTool('Shell'), true);
  });

  it('classifies explicit permission-denial text and leaves other failures as failures', () => {
    assert.equal(classifyFailure('permission denied by policy'), 'denied');
    assert.equal(classifyFailure('ENOENT: missing file'), 'failed');
    assert.equal(classifyFailure('Command timed out', { failure_type: 'permission_denied' }), 'denied');
    assert.equal(classifyFailure('Command timed out', { failure_type: 'timeout' }), 'failed');
  });
});

describe('Cursor and Copilot share one dashboard', () => {
  function cursor(eventName, extra = {}) {
    return {
      conversation_id: extra.conversation_id || 'conv-1',
      generation_id: 'gen-1',
      model: 'test-model',
      hook_event_name: eventName,
      cursor_version: '1.7.2',
      workspace_roots: ['/work'],
      user_email: 'person@example.com',
      transcript_path: '/tmp/cursor-transcript.txt',
      ...extra,
    };
  }

  it('maps Cursor lifecycle events, nests the shell program name, and keeps Copilot rows', () => {
    const dir = tempDir();
    const secret = 'CURSOR_SECRET_ARG_44aa';
    feed(dir, 'sessionStart', session('copilot-sess'));
    feed(dir, 'preToolUse', tool('view', { sessionId: 'copilot-sess' }), { mono: 10 });
    feed(dir, 'postToolUse', tool('view', { sessionId: 'copilot-sess', timestamp: 1_700_000_000_400, toolResult: { resultType: 'success' } }), { wall: 1_700_000_000_400, mono: 400 });

    feed(dir, 'sessionStart', {}, { stdinText: JSON.stringify(cursor('sessionStart', { session_id: 'conv-1', composer_mode: 'agent' })), mono: 500 });
    feed(dir, 'beforeSubmitPrompt', {}, { stdinText: JSON.stringify(cursor('beforeSubmitPrompt', { prompt: 'please run the suite' })), wall: 1_700_000_000_600, mono: 600 });
    feed(dir, 'preToolUse', {}, { stdinText: JSON.stringify(cursor('preToolUse', { tool_name: 'Shell', tool_use_id: 'c1', tool_input: { command: `cd client && npm test -- --grep ${secret}`, working_directory: '/work' }, cwd: '/work' })), wall: 1_700_000_000_700, mono: 700 });
    feed(dir, 'postToolUse', {}, { stdinText: JSON.stringify(cursor('postToolUse', { tool_name: 'Shell', tool_use_id: 'c1', tool_input: { command: `cd client && npm test -- --grep ${secret}` }, tool_output: '{"exitCode":0}', cwd: '/work', duration: 250 })), wall: 1_700_000_000_950, mono: 950 });
    feed(dir, 'preToolUse', {}, { stdinText: JSON.stringify(cursor('preToolUse', { tool_name: 'Shell', tool_use_id: 'c2', tool_input: { command: 'git status' }, cwd: '/work' })), wall: 1_700_000_001_000, mono: 1000 });
    feed(dir, 'postToolUseFailure', {}, { stdinText: JSON.stringify(cursor('postToolUseFailure', { tool_name: 'Shell', tool_use_id: 'c2', tool_input: { command: 'git status' }, error_message: `blocked ${secret}`, failure_type: 'permission_denied', duration: 20, is_interrupt: false })), wall: 1_700_000_001_020, mono: 1020 });
    feed(dir, 'preToolUse', {}, { stdinText: JSON.stringify(cursor('preToolUse', { tool_name: 'Read', tool_use_id: 'c3', tool_input: { file_path: '/work/src/index.ts', explanation: secret }, cwd: '/work' })), wall: 1_700_000_001_100, mono: 1100 });
    feed(dir, 'subagentStart', {}, { stdinText: JSON.stringify(cursor('subagentStart', { subagent_id: 'sub-1', subagent_type: 'explore', task: secret, parent_conversation_id: 'conv-1', tool_call_id: 'tc-1' })), wall: 1_700_000_001_150, mono: 1150 });
    let state = feed(dir, 'stop', {}, { stdinText: JSON.stringify(cursor('stop', {
      status: 'completed',
      loop_count: 0,
      input_tokens: 1000,
      output_tokens: 50,
      cache_read_tokens: 800,
      cache_write_tokens: 100,
    })), wall: 1_700_000_001_400, mono: 1400 });

    // The top-level fields mirror the lane of the last event: the Cursor conversation.
    assert.equal(state.harness, 'cursor');
    assert.equal(state.focus, 'cursor:conv-1');
    assert.equal(state.session.id, 'conv-1');
    assert.equal(state.session.promptIndex, 1);
    assert.equal(state.session.turnOpen, false);
    assert.equal(state.session.tokens.input, 1000);
    assert.equal(state.session.tokens.output, 50);
    assert.equal(state.session.tokens.cacheRead, 800);
    assert.equal(state.session.tokens.cacheWrite, 100);
    assert.equal(state.session.tokens.turns, 1);
    assert.equal(state.session.tokenTurns[0].uncached, 100);
    assert.equal(state.session.source, 'agent');
    assert.equal(state.tools.Shell.total, 2);
    assert.equal(state.tools.Shell.success, 1);
    assert.equal(state.tools.Shell.denied, 1);
    assert.equal(state.tools.Shell.children.npm.success, 1);
    assert.equal(state.tools.Shell.children.git.denied, 1);
    assert.equal(state.tools.Read.incomplete, 1);
    assert.equal(state.tools.Read.running, 0);
    assert.equal(state.tools.Read.children['src/index.ts'].incomplete, 1);
    assert.equal(state.subagents.started, 1);
    assert.equal(state.summary.attempts, 3, 'two shell calls and one read in the Cursor lane');
    const shellRow = state.recent.find((entry) => entry.event === 'postToolUse' && entry.toolName === 'Shell');
    assert.equal(shellRow.correlation, 'call-id');
    assert.equal(shellRow.subName, 'npm');
    // The Copilot lane is untouched and still available.
    const copilotLane = state.sessions['github-copilot:copilot-sess'];
    assert.equal(copilotLane.id, 'copilot-sess');
    assert.equal(copilotLane.tools.view.success, 1);
    assert.equal(copilotLane.summary.attempts, 1);
    assert.equal(copilotLane.tools.Shell, undefined);

    const files = ['dashboard.html', 'dashboard.md', 'monitor-data.js']
      .map((name) => readFileSync(join(dir, name), 'utf8')).join('\n');
    assert.equal(files.includes(`cd client && npm test -- --grep ${secret}`), true);
    assert.equal(files.includes(`blocked ${secret}`), false);
    assert.equal(files.includes('person@example.com'), false);
    assert.equal(files.includes('cursor-transcript'), false);
    const markdown = readFileSync(join(dir, 'dashboard.md'), 'utf8');
    assert.match(markdown, /GitHub Copilot › `copilot-sess` · idle · 1 tool calls/);
    assert.match(markdown, /Cursor › `conv-1` · idle · 3 tool calls ← latest/);
    assert.match(markdown, /\| Shell \| 2 \|/);

    state = feed(dir, 'sessionStart', {}, { stdinText: JSON.stringify(cursor('sessionStart', { conversation_id: 'conv-2', session_id: 'conv-2', composer_mode: 'agent' })), wall: 1_700_000_002_000, mono: 2000 });
    assert.equal(state.session.id, 'conv-2');
    assert.deepEqual(state.tools, {});
    assert.equal(state.sessions['cursor:conv-1'].tools.Shell.total, 2, 'the earlier Cursor conversation is kept for the tree');
    assert.equal(state.sessions['github-copilot:copilot-sess'].tools.view.success, 1, 'a new Cursor conversation does not clear Copilot rows');
    assert.equal(state.current.cursor, 'cursor:conv-2');
    assert.equal(state.current['github-copilot'], 'github-copilot:copilot-sess');
  });

  it('tracks plan markdown and todo lists from TodoWrite and CreatePlan tool args', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', {}, { stdinText: JSON.stringify(cursor('sessionStart', { session_id: 'conv-plan' })), mono: 0 });
    feed(dir, 'beforeSubmitPrompt', {}, { stdinText: JSON.stringify(cursor('beforeSubmitPrompt', {
      conversation_id: 'conv-plan',
      generation_id: 'gen-plan-1',
      prompt: 'make a plan for the tabs',
    })), wall: 1_700_000_000_050, mono: 50 });
    feed(dir, 'preToolUse', {}, { stdinText: JSON.stringify(cursor('preToolUse', {
      conversation_id: 'conv-plan',
      tool_name: 'TodoWrite',
      tool_use_id: 'td-1',
      tool_input: {
        merge: false,
        todos: [
          { id: 'a', content: 'First item', status: 'in_progress' },
          { id: 'b', content: 'Second item', status: 'pending' },
        ],
      },
    })), wall: 1_700_000_000_100, mono: 100 });
    let state = feed(dir, 'preToolUse', {}, { stdinText: JSON.stringify(cursor('preToolUse', {
      conversation_id: 'conv-plan',
      tool_name: 'CallDynamicTool',
      tool_use_id: 'td-2',
      tool_input: {
        namespace: 'cursor',
        toolName: 'TodoWrite',
        arguments: { merge: true, todos: [{ id: 'a', status: 'completed' }, { id: 'c', content: 'Third', status: 'pending' }] },
      },
    })), wall: 1_700_000_000_200, mono: 200 });
    assert.equal(state.session.todos.length, 3);
    assert.equal(state.session.todos.find((t) => t.id === 'a').status, 'completed');
    assert.equal(state.session.todos.find((t) => t.id === 'c').content, 'Third');

    state = feed(dir, 'preToolUse', {}, { stdinText: JSON.stringify(cursor('preToolUse', {
      conversation_id: 'conv-plan',
      tool_name: 'CreatePlan',
      tool_use_id: 'pl-1',
      tool_input: {
        name: 'Ship tabs',
        overview: 'Add a Plan tab',
        plan: '# Ship tabs\n\n1. Capture todos\n2. Render them\n',
        todos: [
          { id: 'p1', content: 'Capture', status: 'completed' },
          { id: 'p2', content: 'Render', status: 'in_progress' },
        ],
      },
    })), wall: 1_700_000_000_300, mono: 300 });
    assert.equal(state.session.plan.name, 'Ship tabs');
    assert.match(state.session.plan.body, /Capture todos/);
    assert.equal(state.session.todos[0].id, 'p1');
    assert.equal(state.session.prompts[0].plan.name, 'Ship tabs');
    assert.match(state.session.prompts[0].plan.body, /Capture todos/);
    assert.equal(state.session.prompts[0].todos.length, 2);
    assert.equal(state.session.prompts[0].todos[0].id, 'p1');
    const view = bootstrap(dir);
    assert.equal(view.plan.name, 'Ship tabs');
    assert.equal(view.todos.length, 2);
    assert.equal(view.prompts[0].plan.name, 'Ship tabs');
    assert.equal(view.prompts[0].todos.length, 2);
  });

  it('records Cursor token usage once per generation_id across stop and afterAgentResponse', () => {
    const dir = tempDir();
    const tokens = {
      input_tokens: 5000,
      output_tokens: 120,
      cache_read_tokens: 4000,
      cache_write_tokens: 500,
      model: 'cursor-test-model',
    };
    feed(dir, 'sessionStart', {}, { stdinText: JSON.stringify(cursor('sessionStart', { session_id: 'conv-tok' })), mono: 0 });
    feed(dir, 'beforeSubmitPrompt', {}, { stdinText: JSON.stringify(cursor('beforeSubmitPrompt', {
      conversation_id: 'conv-tok',
      generation_id: 'gen-tok-1',
      prompt: 'count my tokens',
    })), wall: 1_700_000_000_100, mono: 100 });
    feed(dir, 'afterAgentResponse', {}, { stdinText: JSON.stringify(cursor('afterAgentResponse', {
      conversation_id: 'conv-tok',
      generation_id: 'gen-tok-1',
      text: 'done',
      ...tokens,
    })), wall: 1_700_000_000_200, mono: 200 });
    let state = feed(dir, 'stop', {}, { stdinText: JSON.stringify(cursor('stop', {
      conversation_id: 'conv-tok',
      generation_id: 'gen-tok-1',
      status: 'completed',
      ...tokens,
    })), wall: 1_700_000_000_300, mono: 300 });
    assert.equal(state.session.tokens.turns, 1, 'same generation_id must not double-count');
    assert.equal(state.session.tokens.input, 5000);
    assert.equal(state.session.tokens.output, 120);
    assert.equal(state.session.tokenTurns.length, 1);
    assert.equal(state.session.tokenTurns[0].model, 'cursor-test-model');
    assert.equal(state.session.prompts[0].tokens.input, 5000);
    assert.equal(state.session.prompts[0].response, 'done');
    assert.equal(state.session.prompts[0].responseChars, 4);
    const replyView = bootstrap(dir);
    assert.equal(replyView.prompts[0].response, 'done');

    state = feed(dir, 'beforeSubmitPrompt', {}, { stdinText: JSON.stringify(cursor('beforeSubmitPrompt', {
      conversation_id: 'conv-tok',
      generation_id: 'gen-tok-2',
      prompt: 'second turn',
    })), wall: 1_700_000_000_400, mono: 400 });
    state = feed(dir, 'stop', {}, { stdinText: JSON.stringify(cursor('stop', {
      conversation_id: 'conv-tok',
      generation_id: 'gen-tok-2',
      status: 'completed',
      input_tokens: 200,
      output_tokens: 10,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      model: 'cursor-test-model',
    })), wall: 1_700_000_000_500, mono: 500 });
    assert.equal(state.session.tokens.turns, 2);
    assert.equal(state.session.tokens.input, 5200);
    assert.equal(state.session.tokens.output, 130);
    const view = bootstrap(dir);
    assert.equal(view.tokens.input, 5200);
    assert.equal(view.tokens.uncached, 700);
    assert.equal(view.tokenTurns.length, 2);
  });

  it('builds a harness > session tree with a status per session and figures per lane', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', session('cp-1'));
    feed(dir, 'userPromptSubmitted', { sessionId: 'cp-1', timestamp: 1_700_000_000_100, cwd: '/work', prompt: 'go' }, { wall: 1_700_000_000_100, mono: 100 });
    feed(dir, 'preToolUse', tool('view', { sessionId: 'cp-1', timestamp: 1_700_000_000_200 }), { wall: 1_700_000_000_200, mono: 200 });
    // busy: prompt open and a tool in flight
    feed(dir, 'sessionStart', {}, { stdinText: JSON.stringify(cursor('sessionStart', { session_id: 'conv-1' })), wall: 1_700_000_000_300, mono: 300 });
    feed(dir, 'beforeSubmitPrompt', {}, { stdinText: JSON.stringify(cursor('beforeSubmitPrompt', { prompt: 'x' })), wall: 1_700_000_000_400, mono: 400 });
    // thinking: prompt open, nothing in flight
    feed(dir, 'sessionStart', {}, { stdinText: JSON.stringify(cursor('sessionStart', { conversation_id: 'conv-0', session_id: 'conv-0' })), wall: 1_700_000_000_500, mono: 500 });
    let state = feed(dir, 'sessionEnd', {}, { stdinText: JSON.stringify(cursor('sessionEnd', { conversation_id: 'conv-0', session_id: 'conv-0', reason: 'user_close', duration_ms: 10 })), wall: 1_700_000_000_600, mono: 600 });
    // ended

    let received = null;
    new Function('window', readFileSync(join(dir, 'monitor-data.js'), 'utf8'))({ kusaUpdate: (view) => { received = view; } });
    assert.deepEqual(received.harnesses.map((h) => h.harness), ['cursor', 'github-copilot']);
    const cursorNode = received.harnesses.find((h) => h.harness === 'cursor');
    assert.equal(cursorNode.label, 'Cursor');
    assert.equal(cursorNode.current, 'cursor:conv-0');
    assert.deepEqual(cursorNode.sessions.map((s) => [s.id, s.status]), [['conv-0', 'ended'], ['conv-1', 'thinking']]);
    const copilotNode = received.harnesses.find((h) => h.harness === 'github-copilot');
    assert.deepEqual(copilotNode.sessions.map((s) => [s.id, s.status, s.running, s.attempts]), [['cp-1', 'busy', 1, 1]]);
    assert.equal(received.focus, 'cursor:conv-0');
    assert.equal(received.lanes['github-copilot:cp-1'].rows[0].name, 'view');
    assert.equal(received.lanes['github-copilot:cp-1'].open.length, 1);
    assert.equal(received.lanes['cursor:conv-1'].rows.length, 0);
    assert.equal(received.lanes['cursor:conv-1'].session.turnOpen, true);
    assert.equal(received.lanes['cursor:conv-0'].session.endReason, 'user_close');
    assert.equal(received.session.id, 'conv-0', 'top-level mirrors the focused lane');

    // Closing the Copilot call flips its status; other lanes are unaffected.
    state = feed(dir, 'postToolUse', tool('view', { sessionId: 'cp-1', timestamp: 1_700_000_000_700, toolResult: { resultType: 'success' } }), { wall: 1_700_000_000_700, mono: 700 });
    assert.equal(state.focus, 'github-copilot:cp-1');
    new Function('window', readFileSync(join(dir, 'monitor-data.js'), 'utf8'))({ kusaUpdate: (view) => { received = view; } });
    assert.equal(received.harnesses.find((h) => h.harness === 'github-copilot').sessions[0].status, 'thinking');
    assert.equal(received.lanes['cursor:conv-1'].session.turnOpen, true);

    // The runtime page is the React shell with the view inlined as bootstrap data.
    const html = readFileSync(join(dir, 'dashboard.html'), 'utf8');
    assert.match(html, /href="\.\/dashboard\.css"/);
    assert.match(html, /src="\.\/dashboard\.js"/);
    assert.match(html, /id="root"/);
    assert.match(html, /id="monitor-bootstrap" type="application\/json">\{"origin":"hooks"/);
    assert.ok(readFileSync(join(dir, 'dashboard.css'), 'utf8').includes('animate-pulse'));
    assert.ok(readFileSync(join(dir, 'dashboard.js'), 'utf8').includes('kusaUpdate'));
  });

  it('keeps at most eight sessions per harness and drops the oldest finished ones', () => {
    const dir = tempDir();
    for (let index = 0; index < 11; index += 1) {
      const wall = 1_700_000_000_000 + index * 1000;
      feed(dir, 'sessionStart', session(`s-${index}`, wall), { wall, mono: index * 1000 });
    }
    const state = feed(dir, 'preToolUse', tool('view', { sessionId: 's-10', timestamp: 1_700_000_020_000 }), { wall: 1_700_000_020_000, mono: 20_000 });
    const ids = Object.values(state.sessions).map((lane) => lane.id).sort();
    assert.equal(ids.length, 8);
    assert.ok(ids.includes('s-10'));
    assert.ok(!ids.includes('s-0'));
    assert.ok(!ids.includes('s-2'));
    assert.ok(ids.includes('s-3'));
  });
});

describe('tool counters', () => {
  it('counts repeated calls to the same tool without treating a pre-tool event as success', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', session());
    for (let index = 0; index < 3; index += 1) {
      const wall = 1_700_000_000_000 + index * 1000;
      feed(dir, 'preToolUse', tool('view', { timestamp: wall, toolArgs: { path: `f${index}` } }), { wall, mono: index * 1000 });
      let state = feed(dir, 'postToolUse', tool('view', { timestamp: wall + 400, toolArgs: { path: `f${index}` }, toolResult: { resultType: 'success', textResultForLlm: 'ok' } }), { wall: wall + 400, mono: index * 1000 + 400 });
      assert.equal(state.tools.view.total, index + 1);
      assert.equal(state.tools.view.success, index + 1);
      assert.equal(state.tools.view.running, 0);
    }
    const done = readPersisted(dir).lane;
    assert.equal(done.tools.view.total, 3);
    assert.equal(done.tools.view.success, 3);
    assert.equal(done.tools.view.durationMsSum, 1200);
    assert.equal(done.summary.distinct, 1);
  });

  it('counts different tools separately', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', session());
    feed(dir, 'preToolUse', tool('view'), { mono: 10 });
    feed(dir, 'preToolUse', tool('bash', { toolArgs: { command: 'true' } }), { wall: 1_700_000_000_100, mono: 20 });
    const state = feed(dir, 'postToolUse', tool('view', { toolResult: { resultType: 'success', textResultForLlm: 'x' } }), { wall: 1_700_000_000_200, mono: 120 });
    assert.equal(state.tools.view.success, 1);
    assert.equal(state.tools.view.running, 0);
    assert.equal(state.tools.bash.total, 1);
    assert.equal(state.tools.bash.running, 1);
    assert.equal(state.tools.bash.success, 0);
    assert.equal(state.summary.distinct, 2);
    assert.equal(state.recent.find((entry) => entry.toolName === 'view' && entry.outcome === 'success').correlation, 'fifo-unique');
  });

  it('counts failed and denied completions separately', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', session());
    feed(dir, 'preToolUse', tool('bash', { timestamp: 1_700_000_000_000 }), { mono: 0 });
    let state = feed(dir, 'postToolUseFailure', tool('bash', { timestamp: 1_700_000_000_100, error: 'ENOENT: missing file' }), { wall: 1_700_000_000_100, mono: 100 });
    assert.equal(state.tools.bash.failed, 1);
    assert.equal(state.tools.bash.denied, 0);
    assert.equal(state.tools.bash.success, 0);
    feed(dir, 'preToolUse', tool('bash', { timestamp: 1_700_000_000_200 }), { wall: 1_700_000_000_200, mono: 200 });
    state = feed(dir, 'postToolUseFailure', tool('bash', { timestamp: 1_700_000_000_300, error: 'permission denied by policy' }), { wall: 1_700_000_000_300, mono: 300 });
    assert.equal(state.tools.bash.failed, 1);
    assert.equal(state.tools.bash.denied, 1);
    assert.equal(state.tools.bash.total, 2);
  });

  it('does not count a permission request as a denied call', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', session());
    const state = feed(dir, 'permissionRequest', tool('bash', { toolCallId: 'call-9' }));
    assert.equal(state.summary.denied, 0);
    assert.equal(state.summary.attempts, 0);
    assert.equal(state.recent[0].outcome, 'permission-requested');
  });

  it('keeps agent errors out of tool failure counts', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', session());
    const state = feed(dir, 'errorOccurred', {
      sessionId: 'sess-1',
      timestamp: 1_700_000_000_100,
      cwd: '/work',
      error: { message: 'socket hang up SECRET_ERR', name: 'Error' },
      errorContext: 'model_call',
      recoverable: true,
    }, { wall: 1_700_000_000_100 });
    assert.equal(state.agentErrors, 1);
    assert.equal(state.summary.failed, 0);
    assert.equal(JSON.stringify(state).includes('SECRET_ERR'), false);
  });
});

describe('terminal command children', () => {
  it('reduces a command line to the program name only', () => {
    assert.equal(commandNameOf('npm test -- --watch'), 'npm');
    assert.equal(commandNameOf('cd client && npm run build'), 'npm');
    assert.equal(commandNameOf('FOO=1 BAR="x y" sudo -E /usr/bin/node script.mjs'), 'node');
    assert.equal(commandNameOf('git status | head -5'), 'git');
    assert.equal(commandNameOf('  ls -la ; echo done'), 'ls');
    assert.equal(commandNameOf('"C:\\Program Files\\nodejs\\node.exe" -v'), 'node');
    assert.equal(commandNameOf('& "C:\\tools\\pwsh.exe" -File build.ps1'), 'pwsh');
    assert.equal(commandNameOf('./gradlew build'), 'gradlew');
    assert.equal(commandNameOf('cd /tmp'), 'cd');
    assert.equal(commandNameOf(''), '');
    assert.equal(commandNameOf(undefined), '');
    assert.equal(commandNameOf('$(whoami)'), 'whoami');
    assert.equal(commandNameOf('"" --flag'), '(other)');
    assert.equal(isTerminalTool('run_in_terminal'), true);
    assert.equal(isTerminalTool('bash'), true);
    assert.equal(isTerminalTool('read_file'), false);
  });

  it('nests per-command counters under the terminal tool and keeps the full command', () => {
    const dir = tempDir();
    const secret = 'SUPER_SECRET_FLAG_7c1e';
    const local = (hookEvent, extra) => JSON.stringify({ hook_event_name: hookEvent, session_id: 'local-sess', cwd: '/work', ...extra });
    feed(dir, 'sessionStart', {}, { stdinText: local('SessionStart', { source: 'new', timestamp: '2026-01-01T00:00:00.000Z' }), mono: 0 });
    feed(dir, 'preToolUse', {}, { stdinText: local('PreToolUse', { tool_name: 'run_in_terminal', tool_use_id: 't1', tool_input: { command: `npm test -- --grep ${secret}` }, timestamp: '2026-01-01T00:00:00.100Z' }), mono: 100 });
    feed(dir, 'postToolUse', {}, { stdinText: local('PostToolUse', { tool_name: 'run_in_terminal', tool_use_id: 't1', tool_input: { command: `npm test -- --grep ${secret}` }, tool_response: 'ok', timestamp: '2026-01-01T00:00:01.100Z' }), mono: 1100 });
    feed(dir, 'preToolUse', {}, { stdinText: local('PreToolUse', { tool_name: 'run_in_terminal', tool_use_id: 't2', tool_input: { command: 'cd client && npm run build' }, timestamp: '2026-01-01T00:00:01.200Z' }), mono: 1200 });
    feed(dir, 'postToolUse', {}, { stdinText: local('PostToolUse', { tool_name: 'run_in_terminal', tool_use_id: 't2', tool_input: { command: 'cd client && npm run build' }, tool_response: 'ok', timestamp: '2026-01-01T00:00:01.700Z' }), mono: 1700 });
    feed(dir, 'preToolUse', {}, { stdinText: local('PreToolUse', { tool_name: 'run_in_terminal', tool_use_id: 't3', tool_input: { command: 'git status' }, timestamp: '2026-01-01T00:00:02.000Z' }), mono: 2000 });
    // Copilot camelCase shape with a bash tool also lands under its own terminal parent.
    feed(dir, 'preToolUse', tool('bash', { sessionId: 'local-sess', timestamp: 1_767_225_603_000, toolArgs: { command: 'ls -la' } }), { wall: 1_767_225_603_000, mono: 3000 });
    let state = feed(dir, 'postToolUseFailure', tool('bash', { sessionId: 'local-sess', timestamp: 1_767_225_603_200, toolArgs: { command: 'ls -la' }, error: 'exit 2' }), { wall: 1_767_225_603_200, mono: 3200 });

    // Local and Copilot keep separate lanes for the same session id; read each harness.
    const localLane = state.sessions['vscode-local:local-sess'];
    const copilotLane = state.sessions['github-copilot:local-sess'];
    const term = localLane.tools.run_in_terminal;
    assert.equal(term.total, 3);
    assert.deepEqual(Object.keys(term.children).sort(), ['git', 'npm']);
    assert.equal(term.children.npm.total, 2);
    assert.equal(term.children.npm.success, 2);
    assert.equal(term.children.npm.durationMsSum, 1500);
    assert.equal(term.children.npm.maxDurationMs, 1000);
    assert.equal(term.children.git.total, 1);
    assert.equal(term.children.git.running, 1);
    assert.equal(term.children.git.success, 0);
    assert.equal(copilotLane.tools.bash.children.ls.failed, 1);
    assert.equal(localLane.summary.attempts + copilotLane.summary.attempts, 4, 'children do not double count attempts');
    assert.equal(localLane.summary.distinct + copilotLane.summary.distinct, 2);

    // Agent stop closes the open git call as incomplete on the child too.
    state = feed(dir, 'agentStop', {}, { stdinText: local('Stop', { stop_hook_active: false, timestamp: '2026-01-01T00:00:05.000Z' }), mono: 5000 });
    assert.equal(state.sessions['vscode-local:local-sess'].tools.run_in_terminal.children.git.incomplete, 1);
    assert.equal(state.sessions['vscode-local:local-sess'].tools.run_in_terminal.children.git.running, 0);

    const files = persistedText(dir);
    assert.equal(files.includes(secret), true);
    assert.equal(files.includes('--grep'), true);
    const markdown = readFileSync(join(dir, 'dashboard.md'), 'utf8');
    assert.match(markdown, /\| run_in_terminal \| 3 \|/);
    assert.match(markdown, /↳ `npm` \| 2 \| 0 \| 2 \|/);
    assert.match(markdown, /↳ `git` \| 1 \| 0 \| 0 \| 0 \| 0 \| 1 \|/);
    let received = null;
    new Function('window', readFileSync(join(dir, 'monitor-data.js'), 'utf8'))({ kusaUpdate: (view) => { received = view; } });
    const npmRow = received.rows.find((row) => row.name === 'npm');
    assert.equal(npmRow.depth, 1);
    assert.deepEqual(npmRow.commands, [
      `npm test -- --grep ${secret}`,
      'cd client && npm run build',
    ]);
    assert.deepEqual(received.rows.find((row) => row.name === 'git').commands, ['git status']);
    assert.equal(received.rows.indexOf(npmRow), received.rows.findIndex((row) => row.name === 'run_in_terminal') + 1);
  });
});

describe('file children', () => {
  it('reduces a file argument to a workspace-relative path', () => {
    assert.equal(fileLabelOf('/work/src/app.ts', ['/work']), 'src/app.ts');
    assert.equal(fileLabelOf('/work/', ['/work']), '.');
    assert.equal(fileLabelOf('src/app.ts', ['/work']), 'src/app.ts');
    assert.equal(fileLabelOf('./src/app.ts', ['/work']), 'src/app.ts');
    assert.equal(fileLabelOf('file:///work/src/app.ts', ['/work']), 'src/app.ts');
    assert.equal(fileLabelOf('C:\\Repo\\Src\\App.ts', ['c:/repo']), 'Src/App.ts');
    assert.equal(fileLabelOf('/home/person/.ssh/id_rsa', ['/work']), '…/id_rsa');
    assert.equal(fileLabelOf('~/.npmrc', ['/work']), '…/.npmrc');
    assert.equal(fileLabelOf(`/work/${'x'.repeat(100)}.ts`, ['/work']).length, 80);
    assert.equal(fileLabelOf('', ['/work']), '');
    assert.equal(fileLabelOf(undefined, ['/work']), '');
    for (const name of ['view', 'edit', 'create', 'read_file', 'create_file', 'replace_string_in_file', 'Read', 'Write', 'StrReplace', 'Delete']) {
      assert.equal(isFileTool(name), true, name);
    }
    for (const name of ['grep', 'Grep', 'Glob', 'file_search', 'list_dir', 'bash', 'run_in_terminal', 'fetch_webpage', 'semantic_search']) {
      assert.equal(isFileTool(name), false, name);
    }
  });

  it('nests per-file counters under the file tool', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', session());
    const edit = (path, timestamp) => tool('edit', { timestamp, toolArgs: { path, oldStr: 'SECRET_OLD', newStr: 'SECRET_NEW' } });
    feed(dir, 'preToolUse', edit('/work/src/a.ts', 1_700_000_000_010), { wall: 1_700_000_000_010, mono: 10 });
    feed(dir, 'postToolUse', { ...edit('/work/src/a.ts', 1_700_000_000_210), toolResult: { resultType: 'success' } }, { wall: 1_700_000_000_210, mono: 210 });
    feed(dir, 'preToolUse', edit('/work/src/a.ts', 1_700_000_000_300), { wall: 1_700_000_000_300, mono: 300 });
    feed(dir, 'postToolUseFailure', { ...edit('/work/src/a.ts', 1_700_000_000_400), error: 'no match' }, { wall: 1_700_000_000_400, mono: 400 });
    feed(dir, 'preToolUse', edit('src/b.ts', 1_700_000_000_500), { wall: 1_700_000_000_500, mono: 500 });
    let state = feed(dir, 'postToolUse', { ...edit('src/b.ts', 1_700_000_000_550), toolResult: { resultType: 'success' } }, { wall: 1_700_000_000_550, mono: 550 });
    assert.equal(state.tools.edit.total, 3);
    assert.deepEqual(Object.keys(state.tools.edit.children).sort(), ['src/a.ts', 'src/b.ts']);
    assert.equal(state.tools.edit.children['src/a.ts'].success, 1);
    assert.equal(state.tools.edit.children['src/a.ts'].failed, 1);
    assert.equal(state.tools.edit.children['src/a.ts'].durationMsSum, 300);
    assert.equal(state.tools.edit.children['src/b.ts'].success, 1);
    assert.equal(state.summary.attempts, 3);

    const files = persistedText(dir);
    assert.equal(files.includes('SECRET_OLD'), false);
    assert.equal(files.includes('SECRET_NEW'), false);
    assert.match(readFileSync(join(dir, 'dashboard.md'), 'utf8'), /↳ `src\/a\.ts` \| 2 \| 0 \| 1 \| 1 \|/);
    assert.match(readFileSync(join(dir, 'dashboard.md'), 'utf8'), /or files \(path relative to the workspace\)/);

    // Child maps are capped; the overflow folds into "(other)".
    for (let index = 0; index < 70; index += 1) {
      const wall = 1_700_000_001_000 + index;
      state = feed(dir, 'preToolUse', tool('view', { timestamp: wall, toolArgs: { path: `/work/gen/file-${index}.ts` } }), { wall, mono: 1000 + index });
    }
    const keys = Object.keys(state.tools.view.children);
    assert.equal(keys.length, 61);
    assert.equal(state.tools.view.children['(other)'].total, 10);
    assert.equal(state.tools.view.total, 70);
  });
});

describe('correlation and durations', () => {
  it('uses a call id when one is present and otherwise marks ambiguous fifo matches', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', session());
    feed(dir, 'preToolUse', tool('bash', { toolUseId: 'call-a' }), { mono: 0 });
    feed(dir, 'preToolUse', tool('bash', { toolUseId: 'call-b' }), { wall: 1_700_000_000_010, mono: 10 });
    let state = feed(dir, 'postToolUse', tool('bash', { toolUseId: 'call-b', toolResult: { resultType: 'success', textResultForLlm: 'b' } }), { wall: 1_700_000_009_999, mono: 30 });
    const matchedB = state.recent.find((entry) => entry.outcome === 'success');
    assert.equal(matchedB.correlation, 'call-id');
    assert.equal(matchedB.invocationId, 'call-b');
    assert.equal(matchedB.durationMs, 20);
    assert.equal(matchedB.durationSource, 'monotonic');
    state = feed(dir, 'postToolUse', tool('bash', { toolUseId: 'call-a', toolResult: { resultType: 'success', textResultForLlm: 'a' } }), { wall: 1_700_000_000_050, mono: 40 });
    assert.equal(state.tools.bash.success, 2);
    assert.equal(state.tools.bash.running, 0);
    assert.equal(state.summary.uncertain, 0);

    const other = tempDir();
    feed(other, 'sessionStart', session());
    feed(other, 'preToolUse', tool('grep', { timestamp: 1_700_000_000_000, toolArgs: { q: 'same' } }), { mono: 0 });
    feed(other, 'preToolUse', tool('grep', { timestamp: 1_700_000_000_010, toolArgs: { q: 'same' } }), { wall: 1_700_000_000_010, mono: 10 });
    state = feed(other, 'postToolUse', tool('grep', { timestamp: 1_700_000_000_050, toolArgs: { q: 'same' }, toolResult: { resultType: 'success', textResultForLlm: 'x' } }), { wall: 1_700_000_000_050, mono: 50 });
    assert.equal(state.recent[0].correlation, 'fifo-ambiguous');
    assert.equal(state.summary.uncertain, 1);
    assert.equal(state.tools.grep.running, 1);
  });

  it('prefers the monotonic clock when the harness wall clock jumps', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', session(), { mono: 0 });
    feed(dir, 'preToolUse', tool('view'), { mono: 1000 });
    const state = feed(dir, 'postToolUse', tool('view', {
      timestamp: 1_700_000_099_999,
      toolResult: { resultType: 'success', textResultForLlm: 'body' },
    }), { wall: 1_700_000_099_999, mono: 3400 });
    assert.equal(state.tools.view.durationMsSum, 2400);
    assert.equal(formatDuration(2400), '2.4 s');
    const markdown = readFileSync(join(dir, 'dashboard.md'), 'utf8');
    assert.match(markdown, /\| view \| 1 \| 0 \| 1 \| 0 \| 0 \| 0 \| 2\.4 s \|/);
    assert.equal(bootstrap(dir).rows[0].avg, 2400);
  });

  it('records a completion that has no pre-tool event as unmatched', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', session());
    const state = feed(dir, 'postToolUse', tool('view', { toolResult: { resultType: 'success', textResultForLlm: 'x' } }), { mono: 50 });
    assert.equal(state.tools.view.total, 0);
    assert.equal(state.tools.view.success, 1);
    assert.equal(state.tools.view.unmatched, 1);
    assert.equal(state.recent[0].correlation, 'missing-pre');
    assert.equal(state.recent[0].durationMs, null);
  });

  it('leaves a pre-tool event running when no post-tool event arrives', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', session());
    const state = feed(dir, 'preToolUse', tool('view'), { mono: 10 });
    assert.equal(state.tools.view.total, 1);
    assert.equal(state.tools.view.success, 0);
    assert.equal(state.tools.view.running, 1);
    assert.match(readFileSync(join(dir, 'dashboard.md'), 'utf8'), /missing post-tool event is not counted as success/);
  });

  it('marks still-open calls incomplete at session end', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', session(), { mono: 0 });
    feed(dir, 'preToolUse', tool('bash'), { mono: 100 });
    const state = feed(dir, 'sessionEnd', { sessionId: 'sess-1', timestamp: 1_700_000_000_500, cwd: '/work', reason: 'complete' }, { wall: 1_700_000_000_500, mono: 500 });
    assert.equal(state.session.active, false);
    assert.equal(state.session.endReason, 'complete');
    assert.equal(state.tools.bash.incomplete, 1);
    assert.equal(state.tools.bash.running, 0);
    assert.equal(state.tools.bash.success, 0);
    assert.equal(state.summary.running, 0);
  });
});

describe('sessions, prompts, and warnings', () => {
  it('resets counters for a new session and tracks multiple prompts', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', session('sess-a'));
    feed(dir, 'userPromptSubmitted', { sessionId: 'sess-a', timestamp: 1_700_000_000_100, cwd: '/work', prompt: 'first' }, { wall: 1_700_000_000_100, mono: 100 });
    feed(dir, 'preToolUse', tool('view', { sessionId: 'sess-a' }), { wall: 1_700_000_000_150, mono: 150 });
    let state = feed(dir, 'userPromptSubmitted', { sessionId: 'sess-a', timestamp: 1_700_000_000_200, cwd: '/work', prompt: 'second' }, { wall: 1_700_000_000_200, mono: 200 });
    assert.equal(state.session.promptIndex, 2);
    assert.equal(state.session.promptToolAttempts, 0);
    assert.equal(state.tools.view.total, 1);
    state = feed(dir, 'sessionStart', session('sess-b', 1_700_000_000_300), { wall: 1_700_000_000_300, mono: 300 });
    assert.equal(state.session.id, 'sess-b');
    assert.equal(state.summary.attempts, 0);
    assert.equal(state.session.promptIndex, 0);
    assert.deepEqual(state.tools, {});
  });

  it('warns for long-running calls, repeated calls, and elapsed thresholds without blocking', () => {
    const dir = tempDir();
    const config = {
      ...quiet,
      toolDurationWarnMs: 1000,
      repeatWindowMs: 5000,
      repeatCount: 3,
      promptToolCountWarn: 3,
      promptElapsedWarnMs: 4000,
      sessionElapsedWarnMs: 8000,
    };
    feed(dir, 'sessionStart', session(), { mono: 0, config });
    feed(dir, 'userPromptSubmitted', { sessionId: 'sess-1', timestamp: 1_700_000_000_000, cwd: '/work', prompt: 'go' }, { mono: 0, config });
    feed(dir, 'preToolUse', tool('bash', { toolArgs: { n: 1 } }), { mono: 10, config });
    feed(dir, 'preToolUse', tool('bash', { timestamp: 1_700_000_000_020, toolArgs: { n: 2 } }), { wall: 1_700_000_000_020, mono: 20, config });
    let state = feed(dir, 'preToolUse', tool('bash', { timestamp: 1_700_000_000_030, toolArgs: { n: 3 } }), { wall: 1_700_000_000_030, mono: 30, config });
    assert.ok(state.warnings.some((warning) => warning.code === 'repeated-call'));
    assert.ok(state.warnings.some((warning) => warning.code === 'prompt-tool-count'));
    state = feed(dir, 'notification', {
      sessionId: 'sess-1',
      timestamp: 1_700_000_004_500,
      cwd: '/work',
      hook_event_name: 'Notification',
      notification_type: 'agent_idle',
      message: 'idle text that is not stored',
    }, { wall: 1_700_000_004_500, mono: 4500, config });
    assert.equal(state.session.notificationWaiting, true);
    assert.ok(state.warnings.some((warning) => warning.code === 'prompt-elapsed'));
    assert.ok(state.warnings.some((warning) => warning.message.startsWith('long-running warning:')));
    state = feed(dir, 'agentStop', { sessionId: 'sess-1', timestamp: 1_700_000_009_000, cwd: '/work', stopReason: 'end_turn' }, { wall: 1_700_000_009_000, mono: 9000, config });
    assert.equal(state.session.turnOpen, false);
    assert.ok(state.warnings.some((warning) => warning.code === 'session-elapsed'));
    const html = readFileSync(join(dir, 'dashboard.html'), 'utf8');
    assert.match(html, /repeated-call warning/);
    assert.match(html, /long-running/);
    assert.doesNotMatch(html, /permissionDecision/);
    assert.ok(bootstrap(dir).warnings.some((warning) => warning.code === 'session-elapsed'));
    assert.equal(JSON.stringify(state).includes('idle text that is not stored'), false);
  });

  it('tracks subagent start and stop', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', session());
    feed(dir, 'subagentStart', { sessionId: 'sess-1', timestamp: 1_700_000_000_100, cwd: '/work', agentName: 'explore', agentId: 'sub-1' }, { wall: 1_700_000_000_100 });
    const state = feed(dir, 'subagentStop', { sessionId: 'sess-1', timestamp: 1_700_000_000_200, cwd: '/work', agentName: 'explore', agentId: 'sub-1', response: 'SECRET_SUBAGENT', stopReason: 'end_turn' }, { wall: 1_700_000_000_200 });
    assert.equal(state.subagents.started, 1);
    assert.equal(state.subagents.stopped, 1);
    assert.equal(JSON.stringify(state).includes('SECRET_SUBAGENT'), false);
  });
});

describe('reliability', () => {
  it('ignores duplicate events and malformed input', () => {
    const dir = tempDir();
    const payload = tool('view');
    feed(dir, 'sessionStart', session());
    feed(dir, 'preToolUse', payload, { mono: 5 });
    let state = feed(dir, 'preToolUse', payload, { mono: 5 });
    assert.equal(state.tools.view.total, 1);
    assert.equal(state.duplicates, 1);
    state = feed(dir, 'preToolUse', {}, { stdinText: '{', wall: 1_700_000_000_100, mono: 6 });
    assert.equal(state.tools.view.total, 1);
    assert.ok(state.monitoringErrors.some((error) => error.message === 'malformed hook input'));
    state = runHook({
      dir,
      eventName: 'preToolUse',
      stdinText: 'null',
      nowWall: 1_700_000_000_200,
      nowMono: 7,
      bootId: 'test-boot',
      config: quiet,
    });
    assert.equal(state.summary.attempts, 1);
    assert.ok(state.monitoringErrors.some((error) => error.message === 'malformed hook input'));
  });

  it('stores prompt text for the Prompts tab but never tool arguments', () => {
    const dir = tempDir();
    const prompt = 'SUPER_SECRET_PROMPT_9f3a';
    const arg = 'SUPER_SECRET_ARG_9f3a';
    feed(dir, 'sessionStart', { ...session(), initialPrompt: prompt });
    feed(dir, 'userPromptSubmitted', { sessionId: 'sess-1', timestamp: 1_700_000_000_100, cwd: '/work', prompt }, { wall: 1_700_000_000_100, mono: 100 });
    // Terminal tools keep the full command so the dashboard can reveal it.
    const command = `curl -H "Authorization: ${arg}" https://example.test/hook`;
    feed(dir, 'preToolUse', tool('bash', { toolArgs: { command } }), { wall: 1_700_000_000_150, mono: 150 });
    feed(dir, 'postToolUse', tool('bash', { toolArgs: { command }, toolResult: { resultType: 'success', textResultForLlm: 'ok' } }), { wall: 1_700_000_000_400, mono: 400 });
    // Non-file, non-terminal tools store nothing from their arguments.
    feed(dir, 'preToolUse', tool('grep', { timestamp: 1_700_000_000_500, toolArgs: { pattern: 'SUPER_SECRET_GREP_9f3a', path: '/work' } }), { wall: 1_700_000_000_500, mono: 500 });
    // File tools store the workspace-relative path only; a path outside the workspace keeps its last name only.
    feed(dir, 'preToolUse', tool('view', { timestamp: 1_700_000_000_600, toolArgs: { path: '/home/someone/SUPER_SECRET_PATH_9f3a/notes.md' } }), { wall: 1_700_000_000_600, mono: 600 });
    const view = bootstrap(dir);
    assert.equal(view.prompts.length, 1);
    assert.equal(view.prompts[0].text, prompt);
    assert.equal(view.prompts[0].chars, prompt.length);
    assert.equal(view.prompts[0].role, 'user');
    assert.equal(view.prompts[0].toolAttempts, 3);
    assert.equal(view.prompts[0].open, true);
    const files = ['dashboard.md', 'monitor-data.js'].map((name) => readFileSync(join(dir, name), 'utf8')).join('\n');
    // Prompt text is intentionally kept for the Prompts tab (gitignored data dir).
    assert.equal(files.includes(prompt), true);
    assert.match(files, /"curl"/);
    assert.match(files, /…\/notes\.md/);
    assert.deepEqual(view.rows.find((row) => row.name === 'curl').commands, [command]);
    assert.equal(files.includes('/home/someone'), false);
    assert.equal(files.includes('SUPER_SECRET_GREP_9f3a'), false);
    assert.equal(files.includes('SUPER_SECRET_PATH_9f3a'), false);
  });

  it('maps Local harness payloads, correlates by tool_use_id, and labels the harness', () => {
    const dir = tempDir();
    const local = (hookEvent, extra) => JSON.stringify({
      hook_event_name: hookEvent,
      session_id: 'local-sess',
      cwd: '/work',
      transcript_path: '/tmp/transcript.json',
      ...extra,
    });
    feed(dir, 'sessionStart', {}, { stdinText: local('SessionStart', { source: 'new', timestamp: '2026-01-01T00:00:00.000Z' }), mono: 0 });
    feed(dir, 'userPromptSubmitted', {}, { stdinText: local('UserPromptSubmit', { prompt: 'SUPER_SECRET_PROMPT_LOCAL', timestamp: '2026-01-01T00:00:00.100Z' }), mono: 100 });
    feed(dir, 'preToolUse', {}, { stdinText: local('PreToolUse', { tool_name: 'read_file', tool_use_id: 'tool-1', tool_input: { filePath: '/work/src/a.ts', explanation: 'SUPER_SECRET_LOCAL_9f3a' }, timestamp: '2026-01-01T00:00:00.200Z' }), mono: 200 });
    feed(dir, 'preToolUse', {}, { stdinText: local('PreToolUse', { tool_name: 'read_file', tool_use_id: 'tool-2', tool_input: { path: 'b' }, timestamp: '2026-01-01T00:00:00.210Z' }), mono: 210 });
    feed(dir, 'preToolUse', {}, { stdinText: local('PreToolUse', { tool_name: 'run_in_terminal', tool_use_id: 'tool-3', tool_input: { command: 'false' }, timestamp: '2026-01-01T00:00:00.220Z' }), mono: 220 });
    let state = feed(dir, 'postToolUse', {}, { stdinText: local('PostToolUse', { tool_name: 'read_file', tool_use_id: 'tool-2', tool_input: { path: 'b' }, tool_response: 'body', timestamp: '2026-01-01T00:00:00.500Z' }), mono: 500 });
    const matched = state.recent.find((entry) => entry.event === 'postToolUse');
    assert.equal(state.harness, 'vscode-local');
    assert.equal(state.session.id, 'local-sess');
    assert.equal(state.session.promptIndex, 1);
    assert.equal(matched.invocationId, 'tool-2');
    assert.equal(matched.correlation, 'call-id');
    assert.equal(matched.durationMs, 290);
    assert.equal(state.tools.read_file.running, 1);
    state = feed(dir, 'postToolUse', {}, { stdinText: local('PostToolUse', { tool_name: 'read_file', tool_use_id: 'tool-1', tool_input: { filePath: '/work/src/a.ts', explanation: 'SUPER_SECRET_LOCAL_9f3a' }, tool_response: 'body', timestamp: '2026-01-01T00:00:00.600Z' }), mono: 600 });
    state = feed(dir, 'agentStop', {}, { stdinText: local('Stop', { stop_hook_active: false, timestamp: '2026-01-01T00:00:01.000Z' }), mono: 1000 });
    assert.equal(state.tools.read_file.success, 2);
    assert.equal(state.tools.read_file.children['src/a.ts'].success, 1);
    assert.equal(state.tools.read_file.children.b.success, 1);
    assert.equal(state.tools.run_in_terminal.success, 0);
    assert.equal(state.tools.run_in_terminal.incomplete, 1);
    assert.equal(state.summary.running, 0);
    assert.equal(state.summary.uncertain, 0);
    assert.equal(state.session.turnOpen, false);
    assert.equal(state.nonCopilotPayloads, 0);
    assert.equal(state.session.prompts[0].text, 'SUPER_SECRET_PROMPT_LOCAL');
    assert.equal(state.session.prompts[0].open, false);
    const files = ['dashboard.md', 'monitor-data.js']
      .map((name) => readFileSync(join(dir, name), 'utf8')).join('\n');
    // Tool argument secrets stay out; prompt text is kept for the Prompts tab.
    assert.equal(files.includes('SUPER_SECRET_LOCAL_9f3a'), false);
    assert.equal(files.includes('SUPER_SECRET_PROMPT_LOCAL'), true);
  });

  it('writes a data script the action dashboard can load', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', session());
    feed(dir, 'preToolUse', tool('</script><b>x'), { mono: 1 });
    const script = readFileSync(join(dir, 'monitor-data.js'), 'utf8');
    assert.match(script, /^\(window\.kusaUpdate\|\|window\.copilotMonitorUpdate\)&&\(window\.kusaUpdate\|\|window\.copilotMonitorUpdate\)\(/);
    assert.doesNotMatch(script, /<\/script>/);
    let received = null;
    new Function('window', script)({ kusaUpdate: (view) => { received = view; } });
    assert.equal(received.summary.attempts, 1);
    assert.equal(received.rows[0].name, '</script><b>x');
    assert.equal(received.session.id, 'sess-1');
  });

  it('recovers from a corrupt state file and still records the new event', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'state.json'), '{');
    const state = feed(dir, 'sessionStart', session());
    assert.equal(state.session.id, 'sess-1');
    assert.ok(state.monitoringErrors.some((error) => /corrupt/i.test(error.message)));
    assert.equal(readPersisted(dir).lane.id, 'sess-1');
    assert.ok(existsSync(join(dir, 'state.corrupt.json')) || existsSync(join(dir, 'state.json.corrupt')));
  });

  it('replaces a stale lock left by a dead process', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'monitor.lock'), '99999999\n');
    utimesSync(join(dir, 'monitor.lock'), 1, 1);
    const state = feed(dir, 'sessionStart', session());
    assert.equal(state.session.id, 'sess-1');
  });

  it('escapes tool names in the dashboard', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', session());
    feed(dir, 'preToolUse', tool('<script>alert(1)</script>'), { mono: 1 });
    const html = readFileSync(join(dir, 'dashboard.html'), 'utf8');
    // The name is inlined as JSON bootstrap data; `<` is escaped so it cannot close the script tag.
    assert.match(html, /\\u003cscript>alert\(1\)\\u003c\/script>/);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.equal(bootstrap(dir).rows[0].name, '<script>alert(1)</script>');
  });
});

describe('hook command', () => {
  function init(dir, ...args) {
    return spawnSync(process.execPath, [cliPath, 'init', ...args, dir], {
      encoding: 'utf8',
    });
  }

  it('installs both hook sets and package scripts when no harness marker exists', () => {
    const dir = tempDir();
    const result = init(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /installing both hook sets/);

    const cursor = JSON.parse(readFileSync(join(dir, '.cursor', 'hooks.json'), 'utf8'));
    assert.equal(cursor.hooks.preToolUse[0].command, 'node .cursor/hooks/kusa.cjs preToolUse');
    assert.equal(cursor.hooks.sessionStart.length, 1);
    assert.equal(cursor.hooks.sessionStart[0].command, 'node .cursor/hooks/kusa.cjs sessionStart');
    const script = readFileSync(join(dir, '.cursor', 'hooks', 'kusa.cjs'), 'utf8');
    assert.match(script, /require\('node:child_process'\)/);
    assert.match(script, /\['hook', event, '--cursor'\]/);
    assert.match(script, /\['open', '--cursor'\]/);
    assert.equal(existsSync(join(dir, '.cursor', 'hooks', 'kusa.sh')), false);

    const copilot = JSON.parse(readFileSync(join(dir, '.github', 'hooks', 'copilot-runtime-monitor.json'), 'utf8'));
    assert.match(copilot.hooks.preToolUse[0].bash, /kusa hook preToolUse/);
    assert.match(copilot.hooks.preToolUse[0].powershell, /kusa hook preToolUse/);

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.private, true);
    assert.equal(pkg.scripts['kusa:serve'], 'kusa serve');

    const generated = [
      JSON.stringify(cursor),
      JSON.stringify(copilot),
      readFileSync(join(dir, '.github', 'extensions', 'kusa-session-listener', 'extension.mjs'), 'utf8'),
    ].join('\n');
    assert.doesNotMatch(generated, /node_modules\/kusa/);
  });

  it('writes only the hooks for the harnesses present in the target repo', () => {
    const cursorDir = tempDir();
    mkdirSync(join(cursorDir, '.cursor'));
    const cursorResult = init(cursorDir);
    assert.equal(cursorResult.status, 0, cursorResult.stderr);
    assert.equal(existsSync(join(cursorDir, '.cursor', 'hooks.json')), true);
    assert.equal(existsSync(join(cursorDir, '.github', 'hooks', 'copilot-runtime-monitor.json')), false);

    const copilotDir = tempDir();
    mkdirSync(join(copilotDir, '.github', 'agents'), { recursive: true });
    const copilotResult = init(copilotDir);
    assert.equal(copilotResult.status, 0, copilotResult.stderr);
    assert.equal(existsSync(join(copilotDir, '.cursor', 'hooks.json')), false);
    assert.equal(existsSync(join(copilotDir, '.github', 'hooks', 'copilot-runtime-monitor.json')), true);
    assert.equal(existsSync(join(copilotDir, '.github', 'extensions', 'kusa-session-listener', 'extension.mjs')), true);

    const bothDir = tempDir();
    mkdirSync(join(bothDir, '.cursor'));
    mkdirSync(join(bothDir, '.github'));
    writeFileSync(join(bothDir, '.github', 'copilot-instructions.md'), '# Copilot\n');
    const bothResult = init(bothDir);
    assert.equal(bothResult.status, 0, bothResult.stderr);
    assert.match(bothResult.stderr, /detected Cursor/);
    assert.match(bothResult.stderr, /detected GitHub Copilot/);
    assert.equal(existsSync(join(bothDir, '.cursor', 'hooks.json')), true);
    assert.equal(existsSync(join(bothDir, '.github', 'hooks', 'copilot-runtime-monitor.json')), true);
  });

  it('adds kusa commands to an existing Cursor hooks file', () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.cursor'));
    writeFileSync(join(dir, '.cursor', 'hooks.json'), `${JSON.stringify({
      version: 1,
      hooks: {
        preToolUse: [
          { command: 'echo other', timeout: 5 },
          { command: '.cursor/hooks/kusa.sh preToolUse', timeout: 10 },
        ],
        sessionStart: [
          { command: 'kusa hook sessionStart --cursor', timeout: 10 },
          { command: 'kusa open --cursor', timeout: 10 },
        ],
      },
    }, null, 2)}\n`);
    mkdirSync(join(dir, '.github', 'hooks'), { recursive: true });

    const result = init(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /detected Cursor/);
    assert.match(result.stderr, /detected GitHub Copilot/);
    assert.match(result.stderr, /updated .*[/\\]\.cursor[/\\]hooks\.json/);

    const cursor = JSON.parse(readFileSync(join(dir, '.cursor', 'hooks.json'), 'utf8'));
    assert.deepEqual(cursor.hooks.preToolUse.map((entry) => entry.command), [
      'echo other',
      'node .cursor/hooks/kusa.cjs preToolUse',
    ]);
    assert.deepEqual(cursor.hooks.sessionStart.map((entry) => entry.command), [
      'node .cursor/hooks/kusa.cjs sessionStart',
    ]);
    assert.equal(existsSync(join(dir, '.cursor', 'hooks', 'kusa.cjs')), true);
    assert.equal(existsSync(join(dir, '.github', 'hooks', 'copilot-runtime-monitor.json')), true);

    const again = init(dir);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stderr, /keep existing .*[/\\]\.cursor[/\\]hooks\.json/);
    const reread = JSON.parse(readFileSync(join(dir, '.cursor', 'hooks.json'), 'utf8'));
    assert.equal(reread.hooks.preToolUse.length, 2);
  });

  it('merges dashboard scripts into an existing package.json without replacing other scripts', () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.cursor'));
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
      name: 'demo',
      scripts: {
        test: 'node --test',
        'kusa:serve': 'echo custom',
      },
    }, null, 2)}\n`);

    const result = init(dir, '--cursor');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /keep existing script kusa:serve/);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'demo');
    assert.equal(pkg.scripts.test, 'node --test');
    assert.equal(pkg.scripts['kusa:serve'], 'echo custom');
    assert.equal(existsSync(join(dir, '.github', 'hooks', 'copilot-runtime-monitor.json')), false);
  });

  it('matches the Copilot camelCase event set and exits 0 with empty JSON', () => {
    const config = JSON.parse(readFileSync(join(root, '.github/hooks/copilot-runtime-monitor.json'), 'utf8'));
    assert.equal(config.version, 1);
    assert.deepEqual(Object.keys(config.hooks).sort(), [
      'agentStop',
      'errorOccurred',
      'notification',
      'permissionRequest',
      'postToolUse',
      'postToolUseFailure',
      'preToolUse',
      'sessionEnd',
      'sessionStart',
      'subagentStart',
      'subagentStop',
      'userPromptSubmitted',
    ]);
    for (const [eventName, entries] of Object.entries(config.hooks)) {
      assert.match(entries[0].bash, new RegExp(`kusa hook ${eventName}(;|$)`));
      assert.match(entries[0].powershell, new RegExp(`kusa hook ${eventName}( |$)`));
    }

    const dir = tempDir();
    const malformed = spawnSync('bash', ['-c', config.hooks.preToolUse[0].bash], {
      cwd: root,
      input: '{',
      encoding: 'utf8',
      env: { ...process.env, KUSA_DIR: dir },
    });
    assert.equal(malformed.status, 0);
    assert.equal(malformed.stdout.trim(), '{}');
    assert.doesNotMatch(malformed.stdout, /permissionDecision/);

    const started = spawnSync('bash', ['-c', config.hooks.sessionStart[0].bash], {
      cwd: root,
      input: JSON.stringify(session('from-hook')),
      encoding: 'utf8',
      env: { ...process.env, KUSA_DIR: dir },
    });
    assert.equal(started.status, 0);
    assert.equal(started.stdout.trim(), '{}');
    const { index, lane } = readPersisted(dir);
    assert.equal(lane.id, 'from-hook');
    assert.equal(index.liveSessionVerified, false);
    assert.equal(bootstrap(dir).session.id, 'from-hook');
  });

  it('counts overlapping hook processes', async () => {
    const dir = tempDir();
    const runs = Array.from({ length: 8 }, (_, index) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [hookPath, 'preToolUse'], {
        env: { ...process.env, KUSA_DIR: dir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify(tool('view', {
        timestamp: 1_700_000_000_000 + index,
        toolArgs: { path: `parallel-${index}` },
      })));
    }));
    const results = await Promise.all(runs);
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.trim(), '{}');
    }
    const { index, lane } = readPersisted(dir);
    assert.equal(lane.tools.view.total, 8);
    assert.equal(lane.tools.view.running, 8);
    assert.equal(lane.tools.view.success, 0);
    assert.equal(index.open.length, 8);
  });
});

describe('delete sessions', () => {
  it('removes session files, index entries, and rewrites the dashboard view', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', session('keep-me'), { wall: 1_700_000_000_000, mono: 0 });
    feed(dir, 'sessionStart', session('drop-me'), { wall: 1_700_000_000_100, mono: 100 });
    feed(dir, 'sessionEnd', { sessionId: 'drop-me', timestamp: 1_700_000_000_200, cwd: '/work', reason: 'done' }, { wall: 1_700_000_000_200, mono: 200 });
    const dropFiles = laneFiles(dir, { harness: 'github-copilot', id: 'drop-me' });
    assert.equal(existsSync(dropFiles.json), true);

    const result = deleteSessions(dir, ['github-copilot:drop-me', 'github-copilot:missing'], { nowWall: 1_700_000_000_300 });
    assert.deepEqual(result.deleted, ['github-copilot:drop-me']);
    assert.deepEqual(result.missing, ['github-copilot:missing']);
    assert.equal(existsSync(dropFiles.json), false);
    assert.equal(existsSync(dropFiles.events), false);

    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    assert.equal(index.focus, 'github-copilot:keep-me');
    assert.equal(index.sessionFiles['github-copilot:drop-me'], undefined);
    assert.ok(index.sessionFiles['github-copilot:keep-me']);

    const view = bootstrap(dir);
    assert.equal(view.focus, 'github-copilot:keep-me');
    assert.equal(view.lanes['github-copilot:drop-me'], undefined);
    assert.equal(view.harnesses[0].sessions.map((s) => s.id).join(','), 'keep-me');
  });
});

describe('git working copy', () => {
  it('parses porcelain -b status into staged / unstaged / untracked / conflicted', () => {
    const parsed = parseGitStatusPorcelain([
      '## feature...origin/feature [ahead 2, behind 1]',
      'M  staged.txt',
      ' M unstaged.txt',
      'MM both.txt',
      '?? loose.txt',
      'UU conflict.txt',
      'R  old.txt -> renamed.txt',
    ].join('\n'));
    assert.equal(parsed.branch, 'feature');
    assert.equal(parsed.upstream, 'origin/feature');
    assert.equal(parsed.ahead, 2);
    assert.equal(parsed.behind, 1);
    assert.deepEqual(parsed.staged.map((r) => `${r.code}:${r.path}`), [
      'M:staged.txt',
      'M:both.txt',
      'R:renamed.txt',
    ]);
    assert.deepEqual(parsed.unstaged.map((r) => `${r.code}:${r.path}`), [
      'M:unstaged.txt',
      'M:both.txt',
    ]);
    assert.deepEqual(parsed.untracked.map((r) => r.path), ['loose.txt']);
    assert.deepEqual(parsed.conflicted.map((r) => r.path), ['conflict.txt']);
  });

  it('collects status for this repository', () => {
    const git = collectGitStatus(root, { force: true });
    assert.equal(git.ok, true);
    assert.equal(git.installed, true);
    assert.equal(git.initialized, true);
    assert.ok(git.branch || git.detached);
    assert.ok(git.head);
    assert.equal(typeof git.clean, 'boolean');
    assert.deepEqual(git.steps, []);
    // -uall must expand untracked dirs to files (never only `?? .ai/`).
    for (const row of git.untracked) {
      assert.ok(!row.path.endsWith('/'), `expected file path, got directory entry: ${row.path}`);
    }
  });

  it('reports guidance when the path is not a git repository', () => {
    const dir = tempDir();
    const git = collectGitStatus(dir, { force: true });
    assert.equal(git.ok, false);
    assert.equal(git.installed, true);
    assert.equal(git.initialized, false);
    assert.ok(git.steps.some((s) => /git init/i.test(s)));
  });
});

describe('workspace tool settings', () => {
  it('defaults detect+enforce on and clears enforce when detect is off', () => {
    const dir = tempDir();
    const defaults = loadMonitorSettings(dir);
    assert.equal(defaults.detectTrail, true);
    assert.equal(defaults.enforceTrail, true);
    assert.equal(defaults.detectGit, true);
    assert.equal(defaults.enforceGit, true);
    assert.equal(defaults.agentBackend, 'native');
    assert.equal(defaults.agentAuthMode, 'none');
    assert.equal(defaults.agentApiKey, '');
    assert.equal(defaults.agentBaseUrl, '');
    assert.equal(defaults.agentMaxSteps, 100);

    const saved = saveMonitorSettings(dir, { detectTrail: false, enforceTrail: true });
    assert.equal(saved.detectTrail, false);
    assert.equal(saved.enforceTrail, false);
    assert.equal(loadMonitorSettings(dir).enforceTrail, false);

    const gitOff = saveMonitorSettings(dir, { detectGit: false });
    assert.equal(gitOff.detectGit, false);
    assert.equal(gitOff.enforceGit, false);
  });
});

describe('trail readiness', () => {
  it('detects installed CLI and initialized .trail/cache/ in this repository', () => {
    const trail = collectTrailStatus(root, { force: true });
    assert.equal(trail.ok, true);
    assert.equal(trail.installed, true);
    assert.equal(trail.cli, 'trail');
    assert.equal(trail.needsUpgrade, false);
    assert.equal(trail.initialized, true);
    assert.ok(trail.version);
    assert.deepEqual(trail.steps, []);
  });

  it('reports init steps when .trail/cache is missing', () => {
    const dir = tempDir();
    const trail = collectTrailStatus(dir, { force: true });
    assert.equal(trail.ok, false);
    assert.equal(trail.installed, true);
    assert.equal(trail.cli, 'trail');
    assert.equal(trail.initialized, false);
    assert.ok(trail.steps.some((s) => /trail build/i.test(s)));
  });

  it('instructs upgrade when only the legacy graft context CLI is on PATH', () => {
    const dir = tempDir();
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    // Fake Graft context CLI (has ask); no trail binary on this PATH.
    const graftBin = join(bin, 'graft');
    writeFileSync(graftBin, `#!/bin/sh
if [ "$1" = "-v" ] || [ "$1" = "version" ]; then echo "graft 0.22.0"; exit 0; fi
if [ "$1" = "ask" ]; then echo "Usage: graft ask <query>"; exit 0; fi
exit 1
`);
    chmodSync(graftBin, 0o755);
    const status = collectTrailStatus(dir, {
      force: true,
      env: { ...process.env, PATH: bin },
    });
    assert.equal(status.ok, false);
    assert.equal(status.installed, false);
    assert.equal(status.cli, 'graft');
    assert.equal(status.needsUpgrade, true);
    assert.match(status.error || '', /upgrade to Trail/i);
    assert.ok(status.steps.some((s) => /uninstall -g @nanonets\/graft/i.test(s)));
    assert.ok(status.steps.some((s) => /@trailhq\/trail-code/i.test(s)));
  });

  it('instructs install when neither trail nor graft context CLI is on PATH', () => {
    const dir = tempDir();
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const status = collectTrailStatus(dir, {
      force: true,
      env: { ...process.env, PATH: bin },
    });
    assert.equal(status.ok, false);
    assert.equal(status.installed, false);
    assert.equal(status.cli, null);
    assert.equal(status.needsUpgrade, false);
    assert.match(status.error || '', /not found/i);
    assert.ok(status.steps.some((s) => /@trailhq\/trail-code/i.test(s)));
    assert.ok(!status.steps.some((s) => /uninstall -g @nanonets\/graft/i.test(s)));
  });

  it('snapshot flags legacy graft/ graph as needing upgrade', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'graft'), { recursive: true });
    writeFileSync(join(dir, 'graft', 'INDEX.md'), '# Graft\n');
    const status = snapshotTrailStatus(dir);
    assert.equal(status.ok, false);
    assert.equal(status.needsUpgrade, true);
    assert.equal(status.cli, 'graft');
    assert.ok(status.steps.some((s) => /@trailhq\/trail-code/i.test(s)));
  });

  it('bundles git + trail on collectWorkspaceReady', () => {
    const ready = collectWorkspaceReady(root, { force: true });
    assert.equal(ready.git.ok, true);
    assert.equal(ready.trail.ok, true);
  });
});

describe('local http server', () => {
  it('lets --port override the default and KUSA_PORT', () => {
    assert.equal(resolveServePort([], {}), 1424);
    assert.equal(resolveServePort([], { KUSA_PORT: '4000' }), 4000);
    assert.equal(resolveServePort(['--port', '4100'], { KUSA_PORT: '4000' }), 4100);
    assert.equal(resolveServePort(['-p', '4101'], { COPILOT_MONITOR_PORT: '9' }), 4101);
    assert.equal(resolveServePort(['--port=4102'], {}), 4102);
    assert.throws(() => resolveServePort(['--port'], {}), /requires a port number/);
    assert.throws(() => resolveServePort(['--port', '0'], {}), /invalid port/);
    assert.throws(() => resolveServePort(['--listen'], {}), /unknown serve option/);
  });

  it('serves the page and the data folder from one origin, no-cache, and deletes sessions', async () => {
    const dir = tempDir();
    const server = createMonitorServer({ dataDir: dir });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      // Before any hook event: page exists, data does not.
      let res = await fetch(`${base}/dashboard.html`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/html/);
      assert.match(res.headers.get('cache-control'), /no-store/);
      assert.match(await res.text(), /monitor-bootstrap/);
      res = await fetch(`${base}/dashboard.js`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /javascript/);
      assert.match(await res.text(), /kusaUpdate/);
      res = await fetch(`${base}/git`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /application\/json/);
      const git = await res.json();
      assert.equal(git.ok, true);
      assert.ok(git.branch || git.detached);
      res = await fetch(`${base}/trail`);
      assert.equal(res.status, 200);
      const trailStatus = await res.json();
      assert.equal(trailStatus.ok, true);
      assert.equal(trailStatus.installed, true);
      res = await fetch(`${base}/ready`);
      assert.equal(res.status, 200);
      const ready = await res.json();
      assert.equal(ready.git.ok, true);
      assert.equal(ready.trail.ok, true);
      // createMonitorServer refreshes artifacts on boot, so monitor-data.js exists
      // even before the first hook event (empty bootstrap view).
      res = await fetch(`${base}/monitor-data.js`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /kusaUpdate|copilotMonitorUpdate/);

      feed(dir, 'sessionStart', session());
      feed(dir, 'preToolUse', tool('view'), { mono: 1 });
      feed(dir, 'sessionStart', session('sess-2'), { wall: 1_700_000_000_050, mono: 50 });
      res = await fetch(`${base}/monitor-data.js`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /javascript/);
      assert.match(await res.text(), /"attempts":1/);
      res = await fetch(`${base}/index.json`);
      assert.equal((await res.json()).focus, 'github-copilot:sess-2');

      res = await fetch(`${base}/`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/dashboard.html');
      res = await fetch(`${base}/../../package.json`);
      assert.equal(res.status, 404);
      res = await fetch(`${base}/lib.mjs`);
      assert.equal(res.status, 404);
      res = await fetch(`${base}/index.json`, { method: 'POST' });
      assert.equal(res.status, 405);

      res = await fetch(`${base}/sessions`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: ['github-copilot:sess-1', 'github-copilot:sess-2'] }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        deleted: ['github-copilot:sess-1', 'github-copilot:sess-2'],
        missing: [],
      });
      assert.equal(existsSync(laneFiles(dir, { harness: 'github-copilot', id: 'sess-1' }).json), false);
      res = await fetch(`${base}/monitor-data.js`);
      assert.match(await res.text(), /"harnesses":\[\]/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('queues prompts for a running turn — send now steers, edit rewrites, remove drops', async () => {
    const dir = tempDir();
    const server = createMonitorServer({ dataDir: dir });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const queue = async (payload) => {
      const res = await fetch(`${base}/kusa/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      return { status: res.status, body: await res.json() };
    };
    try {
      let res = await queue({ queueKey: 'kusa:q1', text: 'hold this' });
      assert.equal(res.status, 200);
      assert.equal(res.body.queued.length, 1);
      const held = res.body.queued[0];
      assert.equal(held.text, 'hold this');
      // The composer pickers travel with the prompt so a later flush behaves
      // exactly like pressing Send at that moment.
      assert.deepEqual(held.options, { mode: '', model: '', approvalMode: '' });

      // Held prompts are session-bound: enqueue from another session stays there.
      res = await queue({ queueKey: 'kusa:other', text: 'different session' });
      assert.equal(res.status, 200);
      assert.equal(res.body.queued.length, 1);
      const otherHeld = res.body.queued[0];
      assert.equal(otherHeld.text, 'different session');
      // q1 still only sees its own held prompt.
      const fromQ1 = await (await fetch(`${base}/kusa/queue?queueKey=${encodeURIComponent('kusa:q1')}`)).json();
      assert.deepEqual(fromQ1.queued.map((e) => e.text), ['hold this']);

      // "Edit": rewrite a held prompt in place. The id, the slot and the carried
      // options stay, so a later flush still sends it in order with the pickers
      // it was queued with — the user is fixing the prompt, not replacing it.
      res = await queue({ queueKey: 'kusa:other', action: 'edit', id: otherHeld.id, text: '  corrected wording  ' });
      assert.equal(res.status, 200);
      assert.equal(res.body.queued.length, 1);
      const edited = res.body.queued.find((e) => e.id === otherHeld.id);
      assert.equal(edited.id, otherHeld.id);
      assert.equal(edited.at, otherHeld.at);
      assert.equal(edited.text, 'corrected wording');
      assert.deepEqual(edited.options, otherHeld.options);

      // An empty edit is not a delete — Remove already covers that, so the card
      // can never be edited into nothing.
      res = await queue({ queueKey: 'kusa:other', action: 'edit', id: otherHeld.id, text: '   ' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'text is required');

      // "Send now": out of this session's held list, into *this* session's steering.
      res = await queue({ queueKey: 'kusa:q1', action: 'send', id: held.id });
      assert.equal(res.status, 200);
      assert.equal(res.body.queued.length, 0);
      assert.equal(res.body.steering.length, 1);
      assert.equal(res.body.steering[0].text, 'hold this');
      // Steering stays on q1; other session still only sees its own held.
      const otherSnap = await (await fetch(`${base}/kusa/queue?queueKey=${encodeURIComponent('kusa:other')}`)).json();
      assert.equal(otherSnap.queued.length, 1);
      assert.deepEqual(otherSnap.steering, []);

      // An unknown id is a 404 with the snapshot, so a double-click cannot drop
      // the wrong message.
      res = await queue({ queueKey: 'kusa:other', action: 'remove', id: 'nope' });
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'not in the queued list');
      assert.equal(res.body.queued.length, 1);

      res = await queue({ queueKey: 'kusa:other', action: 'take', id: otherHeld.id });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.queued, []);
      assert.deepEqual(res.body.steering, []);

      res = await queue({ queueKey: 'kusa:other', action: 'bogus' });
      assert.equal(res.status, 404);
      assert.match(res.body.error, /unknown action/);

      // Reorder: drag-and-drop sets held order from a full id permutation.
      res = await queue({ queueKey: 'kusa:ord', text: 'first' });
      const a = res.body.queued[0];
      res = await queue({ queueKey: 'kusa:ord', text: 'second' });
      const b = res.body.queued[1];
      res = await queue({ queueKey: 'kusa:ord', text: 'third' });
      const c = res.body.queued[2];
      assert.deepEqual(res.body.queued.map((e) => e.text), ['first', 'second', 'third']);
      res = await queue({
        queueKey: 'kusa:ord',
        action: 'reorder',
        ids: [c.id, a.id, b.id],
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.queued.map((e) => e.text), ['third', 'first', 'second']);
      // Incomplete / unknown ids are rejected so a stale client cannot drop rows.
      res = await queue({
        queueKey: 'kusa:ord',
        action: 'reorder',
        ids: [a.id, b.id],
      });
      assert.equal(res.status, 404);
      assert.match(res.body.error, /every queued entry/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('persists the composer queue across serve restarts', async () => {
    const dir = tempDir();
    const queue = async (base, payload) => {
      const res = await fetch(`${base}/kusa/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      return { status: res.status, body: await res.json() };
    };

    const server1 = createMonitorServer({ dataDir: dir });
    await new Promise((resolve) => server1.listen(0, '127.0.0.1', resolve));
    const base1 = `http://127.0.0.1:${server1.address().port}`;
    let heldId;
    let parkedId;
    try {
      let res = await queue(base1, {
        queueKey: 'kusa:persist',
        text: 'survive restart',
        options: { mode: 'agent', model: 'gpt-test', approvalMode: 'run' },
      });
      assert.equal(res.status, 200);
      heldId = res.body.queued[0].id;
      res = await queue(base1, { queueKey: 'kusa:persist', text: 'parked across bounce' });
      parkedId = res.body.queued[1].id;
      res = await queue(base1, {
        queueKey: 'kusa:persist',
        action: 'pause',
        id: parkedId,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.queued.find((e) => e.id === parkedId)?.paused, true);
      // "Send now" is on disk as steering; a cold boot folds it back into held.
      res = await queue(base1, { queueKey: 'kusa:persist', action: 'send', id: heldId });
      assert.equal(res.status, 200);
      assert.equal(res.body.steering.length, 1);
      assert.ok(existsSync(queuesFilePath(dir)));
    } finally {
      await new Promise((resolve) => server1.close(resolve));
    }

    const server2 = createMonitorServer({ dataDir: dir });
    await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));
    const base2 = `http://127.0.0.1:${server2.address().port}`;
    try {
      const snap = await (await fetch(
        `${base2}/kusa/queue?queueKey=${encodeURIComponent('kusa:persist')}`,
      )).json();
      assert.deepEqual(snap.steering, []);
      assert.equal(snap.queued.length, 2);
      const texts = snap.queued.map((e) => e.text);
      assert.ok(texts.includes('parked across bounce'));
      assert.ok(texts.includes('survive restart'));
      const parked = snap.queued.find((e) => e.id === parkedId);
      assert.equal(parked?.paused, true);
      const revived = snap.queued.find((e) => e.id === heldId);
      assert.deepEqual(revived?.options, {
        mode: 'agent',
        model: 'gpt-test',
        approvalMode: 'run',
      });
    } finally {
      await new Promise((resolve) => server2.close(resolve));
    }
  });

  it('queue-store keeps held per-session, parks workspace rows, folds steering once', () => {
    const dir = tempDir();
    const queued = new Map([
      ['kusa:a', [{ id: 'q1', text: 'held-a', at: 1, options: {} }]],
      [WORKSPACE_QUEUE_KEY, [
        { id: 'q2', text: 'parked-b', at: 2, options: {}, paused: true },
        { id: 'q3', text: 'legacy-shared', at: 3, options: {} },
      ]],
    ]);
    const steering = new Map([['kusa:a', [{ id: 's1', text: 'steer', at: 4, options: {} }]]]);
    saveQueues(dir, queued, steering);
    const first = loadQueues(dir);
    assert.equal(first.steering.size, 0);
    assert.ok(first.queued.has('kusa:a'));
    assert.equal(first.queued.get('kusa:a')?.length, 2);
    assert.ok(first.queued.get('kusa:a').some((e) => e.id === 's1'));
    assert.ok(first.queued.get('kusa:a').some((e) => e.id === 'q1' && !e.paused));
    const parked = first.queued.get(WORKSPACE_QUEUE_KEY) || [];
    assert.equal(parked.length, 2);
    assert.ok(parked.every((e) => e.paused === true));
    assert.ok(parked.some((e) => e.id === 'q3'));
    const second = loadQueues(dir);
    assert.equal(second.queued.get('kusa:a')?.length, 2);
    assert.equal(second.queued.get(WORKSPACE_QUEUE_KEY)?.length, 2);
  });

  it('only parked prompts are visible and claimable from another session', async () => {
    const dir = tempDir();
    const server = createMonitorServer({ dataDir: dir });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const queue = async (payload) => {
      const res = await fetch(`${base}/kusa/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      return { status: res.status, body: await res.json() };
    };
    try {
      let res = await queue({ queueKey: 'kusa:alpha', text: 'session held only' });
      const heldId = res.body.queued[0].id;
      res = await queue({ queueKey: 'kusa:alpha', text: 'parked for later' });
      const parkedId = res.body.queued[1].id;
      res = await queue({ queueKey: 'kusa:alpha', action: 'pause', id: parkedId });
      assert.equal(res.status, 200);
      assert.equal(res.body.queued.find((e) => e.id === parkedId)?.paused, true);
      assert.equal(res.body.queued.find((e) => e.id === heldId)?.paused, undefined);

      // Beta sees parked, not alpha's unparked held.
      const betaView = await (await fetch(`${base}/kusa/queue?queueKey=${encodeURIComponent('kusa:beta')}`)).json();
      assert.deepEqual(betaView.queued.map((e) => e.text), ['parked for later']);
      assert.equal(betaView.queued[0].paused, true);

      // Beta cannot take alpha's session-bound held.
      res = await queue({ queueKey: 'kusa:beta', action: 'take', id: heldId });
      assert.equal(res.status, 404);

      // Beta resumes parked onto its own held list, then takes it.
      res = await queue({ queueKey: 'kusa:beta', action: 'resume', id: parkedId });
      assert.equal(res.status, 200);
      assert.equal(res.body.queued.length, 1);
      assert.equal(res.body.queued[0].paused, undefined);
      assert.equal(res.body.queued[0].text, 'parked for later');
      res = await queue({ queueKey: 'kusa:beta', action: 'take', id: parkedId });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.queued, []);

      const alpha = await (await fetch(`${base}/kusa/queue?queueKey=${encodeURIComponent('kusa:alpha')}`)).json();
      assert.deepEqual(alpha.queued.map((e) => e.text), ['session held only']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('Stop ends a running turn mid-stream and hands back the held prompts', async () => {
    const dir = tempDir();
    // Stub OpenAI-compatible endpoint: streams a reply, then keeps the stream
    // open with SSE comments for ~2s. Nothing ever sends a terminal frame early,
    // so the only way the turn ends before 2s is the Stop request below.
    const stub = createServer((req, res) => {
      const started = Date.now();
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write('data: {"choices":[{"delta":{"content":"first half"}}]}\n\n');
      const ticker = setInterval(() => {
        if (Date.now() - started > 2000) {
          res.write('data: [DONE]\n\n');
          res.end();
          clearInterval(ticker);
          return;
        }
        res.write(': keep-alive\n\n');
      }, 200);
    });
    await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const stubBase = `http://127.0.0.1:${stub.address().port}/v1`;
    saveMonitorSettings(dir, { agentBaseUrl: stubBase, agentModel: 'stub-model', detectTrail: false });
    const server = createMonitorServer({ dataDir: dir });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      // Hold a prompt first: after the stop, that is what gets sent next.
      const held = await (await fetch(`${base}/kusa/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ queueKey: 'kusa:stop-1', text: 'next queued prompt' }),
      })).json();
      assert.equal(held.queued.length, 1);

      const chatPromise = (async () => {
        const res = await fetch(`${base}/kusa/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({ prompt: 'start a long run', stream: true, sessionId: 'stop-1', queueKey: 'kusa:stop-1' }),
        });
        return await res.text();
      })();

      await new Promise((resolve) => setTimeout(resolve, 300));
      const stopRes = await fetch(`${base}/kusa/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ queueKey: 'kusa:stop-1' }),
      });
      assert.equal(stopRes.status, 200);
      const stopBody = await stopRes.json();
      // The turn was running, so the abort really was taken — and the held
      // prompts come back so the client can send the next one immediately.
      assert.equal(stopBody.stopped, true);
      assert.equal(stopBody.queued.length, 1);

      const sse = await chatPromise;
      assert.match(sse, /event: stopped/);
      assert.match(sse, /"reason":"user_stop"/);
      // The partial reply survives the abort, so stopping is not losing work.
      assert.match(sse, /first half/);
      assert.doesNotMatch(sse, /event: done/);

      // Stop with nothing running is a no-op that still reports the queue, so
      // the client behaves the same whether or not a turn was mid-flight.
      const idle = await (await fetch(`${base}/kusa/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ queueKey: 'kusa:nothing' }),
      })).json();
      assert.equal(idle.stopped, false);
      assert.deepEqual(idle.queued, []);

      const missing = await fetch(`${base}/kusa/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(missing.status, 400);
      assert.match((await missing.json()).error, /queueKey is required/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => stub.close(resolve));
    }
  });

  it('mid-turn Mode / Rules POST updates the live turn options', async () => {
    const dir = tempDir();
    const stub = createServer((req, res) => {
      const started = Date.now();
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write('data: {"choices":[{"delta":{"content":"working"}}]}\n\n');
      const ticker = setInterval(() => {
        if (Date.now() - started > 2000) {
          res.write('data: [DONE]\n\n');
          res.end();
          clearInterval(ticker);
          return;
        }
        res.write(': keep-alive\n\n');
      }, 200);
    });
    await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const stubBase = `http://127.0.0.1:${stub.address().port}/v1`;
    saveMonitorSettings(dir, { agentBaseUrl: stubBase, agentModel: 'stub-model', detectTrail: false });
    const server = createMonitorServer({ dataDir: dir });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const chatPromise = (async () => {
        const res = await fetch(`${base}/kusa/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({
            prompt: 'long run',
            stream: true,
            sessionId: 'opts-1',
            queueKey: 'kusa:opts-1',
            mode: 'agent',
            approvalMode: 'ask-deny',
          }),
        });
        return await res.text();
      })();

      await new Promise((resolve) => setTimeout(resolve, 300));
      const optRes = await fetch(`${base}/kusa/chat/options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          queueKey: 'kusa:opts-1',
          mode: 'ask',
          approvalMode: 'allow',
        }),
      });
      assert.equal(optRes.status, 200);
      const optBody = await optRes.json();
      assert.equal(optBody.ok, true);
      assert.equal(optBody.options.mode, 'ask');
      assert.equal(optBody.options.approvalMode, 'allow');

      const idle = await fetch(`${base}/kusa/chat/options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ queueKey: 'kusa:nobody', mode: 'plan' }),
      });
      assert.equal(idle.status, 404);

      await fetch(`${base}/kusa/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ queueKey: 'kusa:opts-1' }),
      });
      await chatPromise;
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => stub.close(resolve));
    }
  });
});

describe('kusa chat persistence', () => {
  it('writes chat sidecars under .kusa/kusa and lists them', () => {
    const dir = tempDir();
    const created = createChatSession(dir, { id: 'chat-1', workspaceRoot: dir });
    assert.equal(created.id, 'chat-1');
    assert.equal(created.key, 'kusa:chat-1');
    assert.equal(existsSync(chatFilePath(dir, 'chat-1')), true);
    assert.equal(existsSync(laneFiles(dir, { harness: 'kusa', id: 'chat-1' }).json), true);

    writeChatSession(dir, {
      ...created,
      messages: [{ id: 'm1', role: 'user', text: 'hello', at: 1 }],
    });
    const listed = listChatSessions(dir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].messages[0].text, 'hello');
  });

  it('hydrates chats from monitor lanes when no sidecar exists', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', {
      sessionId: 'legacy-1',
      timestamp: 1_700_000_000_000,
      cwd: dir,
      kusa_version: '1',
      harness: 'kusa',
    }, { wall: 1_700_000_000_000, mono: 0, origin: 'kusa-agent' });
    feed(dir, 'beforeSubmitPrompt', {
      sessionId: 'legacy-1',
      timestamp: 1_700_000_000_010,
      cwd: dir,
      prompt: 'from hooks',
      kusa_version: '1',
      harness: 'kusa',
    }, { wall: 1_700_000_000_010, mono: 10, origin: 'kusa-agent' });
    feed(dir, 'afterAgentResponse', {
      sessionId: 'legacy-1',
      timestamp: 1_700_000_000_020,
      cwd: dir,
      text: 'hook reply',
      kusa_version: '1',
      harness: 'kusa',
    }, { wall: 1_700_000_000_020, mono: 20, origin: 'kusa-agent' });

    assert.equal(existsSync(chatFilePath(dir, 'legacy-1')), false);
    const listed = listChatSessions(dir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, 'legacy-1');
    assert.equal(listed[0].messages.length, 2);
    assert.equal(listed[0].messages[0].text, 'from hooks');
    assert.equal(listed[0].messages[1].text, 'hook reply');
  });

  it('migrates legacy browser sessions and deletes chat on DELETE /sessions', async () => {
    const dir = tempDir();
    const migrated = migrateChatSessions(dir, [{
      key: 'kusa:mig-1',
      id: 'mig-1',
      status: 'idle',
      createdAt: 100,
      messages: [{ id: 'm1', role: 'user', text: 'legacy', at: 100 }],
    }], { workspaceRoot: dir });
    assert.deepEqual(migrated.imported, ['mig-1']);
    assert.equal(existsSync(chatFilePath(dir, 'mig-1')), true);

    const server = createMonitorServer({ dataDir: dir, workspaceRoot: dir });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    try {
      let res = await fetch(`${base}/kusa/sessions`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.sessions.length, 1);
      assert.equal(body.sessions[0].messages[0].text, 'legacy');

      res = await fetch(`${base}/kusa/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'mig-2' }),
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).session.id, 'mig-2');

      res = await fetch(`${base}/sessions`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: ['kusa:mig-1', 'kusa:mig-2'] }),
      });
      assert.equal(res.status, 200);
      const del = await res.json();
      assert.ok(del.deleted.includes('kusa:mig-1'));
      assert.ok(del.deleted.includes('kusa:mig-2'));
      assert.equal(existsSync(chatFilePath(dir, 'mig-1')), false);
      assert.equal(existsSync(chatFilePath(dir, 'mig-2')), false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('derives a concise chat title from the first user prompt', () => {
    const dir = tempDir();
    const created = createChatSession(dir, { id: 'title-1', workspaceRoot: dir });
    assert.equal(created.title, null);

    // Assistant-only transcripts have nothing to name the chat from.
    writeChatSession(dir, {
      ...created,
      messages: [{ id: 'm1', role: 'assistant', text: 'no prompt yet', at: 1 }],
    });
    assert.equal(listChatSessions(dir)[0].title, null);

    // Markdown headings make good titles; decoration is stripped.
    writeChatSession(dir, {
      ...created,
      messages: [{
        id: 'm1',
        role: 'user',
        text: '## Rename sessions in the sidebar\n\nStrip markdown noise and keep it short.',
        at: 1,
      }],
    });
    assert.equal(listChatSessions(dir)[0].title, 'Rename sessions in the sidebar');

    // Long single-line prompts clip on a word boundary with an ellipsis.
    const clipped = writeChatSession(dir, {
      ...created,
      messages: [{
        id: 'm1',
        role: 'user',
        text: 'Refactor the sidebar so every chat is labelled with a concise summary title instead of a raw session identifier, and keep the id available on hover for debugging.',
        at: 1,
      }],
    });
    assert.ok(clipped.title.endsWith('…'));
    assert.ok(clipped.title.length <= 72);
    assert.ok(clipped.title.startsWith('Refactor the sidebar'));

    // An explicit title always wins over the derived one.
    const renamed = writeChatSession(dir, {
      ...created,
      title: 'Parser hotfix',
      messages: [{ id: 'm1', role: 'user', text: 'ignored', at: 1 }],
    });
    assert.equal(renamed.title, 'Parser hotfix');
  });
});

describe('dashboard demonstration', () => {
  it('renders collected events into the html and markdown dashboards', () => {
    const dir = tempDir();
    feed(dir, 'sessionStart', session(), { mono: 0, origin: 'synthetic-demo' });
    feed(dir, 'userPromptSubmitted', { sessionId: 'sess-1', timestamp: 1_700_000_000_020, cwd: '/work', prompt: 'do not store' }, { wall: 1_700_000_000_020, mono: 20, origin: 'synthetic-demo' });
    feed(dir, 'preToolUse', tool('view'), { wall: 1_700_000_000_050, mono: 50, origin: 'synthetic-demo' });
    const state = feed(dir, 'postToolUse', tool('view', { toolResult: { resultType: 'success', textResultForLlm: 'file body' } }), { wall: 1_700_000_002_450, mono: 2450, origin: 'synthetic-demo' });
    assert.equal(state.origin, 'synthetic-demo');
    assert.equal(state.tools.view.durationMsSum, 2400);
    const html = readFileSync(join(dir, 'dashboard.html'), 'utf8');
    const markdown = readFileSync(join(dir, 'dashboard.md'), 'utf8');
    const boot = bootstrap(dir);
    assert.equal(boot.origin, 'synthetic-demo');
    assert.equal(boot.rows[0].name, 'view');
    assert.equal(boot.rows[0].avg, 2400);
    assert.match(html, /"origin":"synthetic-demo"/);
    assert.match(readFileSync(join(root, 'src', 'dashboard.js'), 'utf8'), /synthetic demo data/);
    assert.match(markdown, /Synthetic demonstration data/);
    assert.match(markdown, /\| view \| 1 \| 0 \| 1 \|/);
    assert.match(markdown, /## Git/);
    assert.equal(typeof boot.git?.ok, 'boolean');
    assert.equal(typeof boot.trailStatus?.ok, 'boolean');
    assert.equal(html.includes('file body'), false);
    // Prompt text is inlined in the bootstrap view for the Prompts tab.
    assert.equal(boot.prompts[0].text, 'do not store');
    assert.equal(html.includes('do not store'), true);
  });
});
