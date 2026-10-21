import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpencodeConfig,
  createFileTools,
  createKusaHookEmitter,
  createTrailAwareTools,
  DEFAULT_MAX_STEPS,
  resolveAgentEndpoint,
  resolveAgentMaxSteps,
  resolveTrailPolicy,
  trailNotReadyMessage,
  trailSystemPromptAddon,
} from '../src/agent/index.mjs';
import { laneKey, loadMonitorSettings, saveMonitorSettings } from '../src/lib.mjs';
import { callTool } from '../src/mcp/tools.mjs';

const dirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'kusa-agent-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('file tools', () => {
  it('reads and writes inside the workspace', () => {
    const root = tempDir();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.txt'), 'hello\nworld\n', 'utf8');
    const tools = createFileTools(root);

    const read = tools.readFile({ path: 'src/a.txt', offset: 2, limit: 1 });
    assert.equal(read.ok, true);
    assert.equal(read.content, 'world');

    const write = tools.writeFile({ path: 'src/b.txt', contents: 'new' });
    assert.equal(write.ok, true);
    assert.equal(readFileSync(join(root, 'src', 'b.txt'), 'utf8'), 'new');
  });

  it('rejects path escape', () => {
    const root = tempDir();
    const tools = createFileTools(root);
    assert.throws(() => tools.readFile({ path: '../secret' }), /escapes workspace/);
  });

  it('lists and greps', () => {
    const root = tempDir();
    writeFileSync(join(root, 'note.md'), 'alpha beta gamma', 'utf8');
    const tools = createFileTools(root);
    const list = tools.listDir({ path: '.' });
    assert.equal(list.ok, true);
    assert.ok(list.entries.some((e) => e === 'note.md'));

    const grep = tools.grep({ pattern: 'beta', path: '.' });
    assert.equal(grep.ok, true);
    assert.equal(grep.hits.length, 1);
    assert.equal(grep.hits[0].path, 'note.md');
  });

  it('deletes files and refuses protected paths', () => {
    const root = tempDir();
    writeFileSync(join(root, 'drop.txt'), 'bye', 'utf8');
    mkdirSync(join(root, 'tmpnest'), { recursive: true });
    writeFileSync(join(root, 'tmpnest', 'inner.txt'), 'x', 'utf8');
    mkdirSync(join(root, '.kusa'), { recursive: true });
    writeFileSync(join(root, '.kusa', 'settings.json'), '{}', 'utf8');
    const tools = createFileTools(root);

    const del = tools.deleteFile({ path: 'drop.txt' });
    assert.equal(del.ok, true);
    assert.equal(existsSync(join(root, 'drop.txt')), false);

    const dirNoFlag = tools.deleteFile({ path: 'tmpnest' });
    assert.equal(dirNoFlag.ok, false);

    const dirOk = tools.deleteFile({ path: 'tmpnest', recursive: true });
    assert.equal(dirOk.ok, true);
    assert.equal(existsSync(join(root, 'tmpnest')), false);

    const protectedPath = tools.deleteFile({ path: '.kusa/settings.json' });
    assert.equal(protectedPath.ok, false);
    assert.match(protectedPath.error, /protected/);
  });

  it('is callable through MCP handlers', async () => {
    const root = tempDir();
    writeFileSync(join(root, 'x.txt'), 'payload', 'utf8');
    const result = await callTool('kusa_read_file', { path: 'x.txt' }, root);
    assert.equal(result.isError, false);
    assert.match(result.text, /payload/);

    writeFileSync(join(root, 'y.txt'), 'gone', 'utf8');
    const del = await callTool('kusa_delete_file', { path: 'y.txt' }, root);
    assert.equal(del.isError, false);
    assert.match(del.text, /"ok": true/);
  });
});

describe('kusa agent hooks', () => {
  it('records session + tool counters under harness kusa', () => {
    const dir = tempDir();
    const sessionId = 'chat-hooks-1';
    const hooks = createKusaHookEmitter({
      dataDir: dir,
      sessionId,
      workspaceRoot: dir,
    });
    assert.equal(hooks.enabled, true);

    hooks.sessionStart();
    hooks.userPrompt('list files in src');
    hooks.preToolUse({
      name: 'kusa_list_dir',
      args: { path: 'src' },
      callId: 'call-1',
    });
    hooks.postToolUse({
      name: 'kusa_list_dir',
      args: { path: 'src' },
      callId: 'call-1',
      result: { ok: true, entries: ['a.js'] },
    });
    hooks.afterAgentResponse('Here are the files.');
    const state = hooks.agentStop();
    assert.ok(state);

    const key = laneKey('kusa', sessionId);
    const lane = state.sessions?.[key] || state.session;
    assert.equal(lane.harness, 'kusa');
    assert.equal(lane.id || sessionId, sessionId);
    assert.ok((lane.prompts || []).length >= 1);
    const tool = lane.tools?.kusa_list_dir || state.tools?.kusa_list_dir;
    assert.ok(tool, 'expected kusa_list_dir counter');
    assert.equal(tool.total, 1);
    assert.equal(tool.success, 1);
  });

  it('is a no-op without sessionId', () => {
    const hooks = createKusaHookEmitter({ dataDir: tempDir(), sessionId: '' });
    assert.equal(hooks.enabled, false);
    assert.doesNotThrow(() => hooks.userPrompt('x'));
  });
});

describe('trail enforcement', () => {
  it('gates file tools until kusa_trail_* succeeds when enforceTrail is on', async () => {
    const root = tempDir();
    writeFileSync(join(root, 'a.txt'), 'hi', 'utf8');
    const tools = createTrailAwareTools(root, { enforceTrail: true });
    assert.equal(tools.gate.consulted, false);

    const blocked = await tools.call('kusa_read_file', { path: 'a.txt' });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /Trail enforce/i);

    // Mark consulted without needing a real trail CLI.
    tools.gate.consulted = true;
    const ok = await tools.call('kusa_read_file', { path: 'a.txt' });
    assert.equal(ok.ok, true);
    assert.equal(ok.content, 'hi');
  });

  it('does not gate when enforceTrail is off', async () => {
    const root = tempDir();
    writeFileSync(join(root, 'a.txt'), 'hi', 'utf8');
    const tools = createTrailAwareTools(root, { enforceTrail: false });
    assert.equal(tools.gate.consulted, true);
    const ok = await tools.call('kusa_read_file', { path: 'a.txt' });
    assert.equal(ok.ok, true);
  });

  it('setMode switches Ask/Agent capability for the next tool call', async () => {
    const root = tempDir();
    const tools = createTrailAwareTools(root, { enforceTrail: false, mode: 'agent' });
    assert.equal(tools.mode, 'agent');
    const wrote = await tools.call('kusa_write_file', { path: 'out.txt', contents: 'x' });
    assert.equal(wrote.ok, true);

    assert.equal(tools.setMode('ask'), 'ask');
    assert.equal(tools.mode, 'ask');
    const blocked = await tools.call('kusa_write_file', { path: 'out.txt', contents: 'y' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'EMODE');
    assert.match(blocked.error, /ask mode cannot call/i);

    tools.setMode('agent');
    const again = await tools.call('kusa_write_file', { path: 'out.txt', contents: 'z' });
    assert.equal(again.ok, true);
  });

  it('resolveTrailPolicy respects detect/enforce and trailNotReadyMessage lists steps', () => {
    const root = tempDir();
    const off = resolveTrailPolicy({ detectTrail: false, enforceTrail: true }, root);
    assert.equal(off.detect, false);
    assert.equal(off.enforce, false);
    assert.equal(off.ready, true);

    const on = resolveTrailPolicy({ detectTrail: true, enforceTrail: true }, root);
    assert.equal(on.enforce, true);
    // Empty temp dir is not trail-initialized.
    assert.equal(on.ready, false);
    const msg = trailNotReadyMessage(on.status);
    assert.match(msg, /enforce Trail/i);
    assert.match(msg, /trail build|Install Trail/i);

    const addon = trailSystemPromptAddon({ detect: true, enforce: true, ready: true });
    assert.match(addon, /Trail enforcement is ON/i);
  });
});

describe('agent settings', () => {
  it('persists OpenAI endpoint and optional API key', () => {
    const dir = tempDir();
    const saved = saveMonitorSettings(dir, {
      agentBaseUrl: 'http://127.0.0.1:8080/v1',
      agentModel: 'local-model',
      agentMaxSteps: 50,
      agentAuthMode: 'apikey',
      agentApiKey: 'sk-123',
      agentBackend: 'opencode',
    });
    assert.equal(saved.agentBaseUrl, 'http://127.0.0.1:8080/v1');
    assert.equal(saved.agentModel, 'local-model');
    assert.equal(saved.agentMaxSteps, 50);
    assert.equal(saved.agentAuthMode, 'apikey');
    assert.equal(saved.agentApiKey, 'sk-123');
    assert.equal(saved.agentBackend, 'opencode');
    assert.equal(loadMonitorSettings(dir).agentAuthMode, 'apikey');
    assert.equal(loadMonitorSettings(dir).agentMaxSteps, 50);

    assert.equal(saveMonitorSettings(dir, { agentMaxSteps: 0 }).agentMaxSteps, 1);
    assert.equal(saveMonitorSettings(dir, { agentMaxSteps: 9999 }).agentMaxSteps, 1000);

    const none = saveMonitorSettings(dir, { agentAuthMode: 'none', agentApiKey: '' });
    assert.equal(none.agentAuthMode, 'none');

    // Legacy bearer / agentAuthToken still normalizes to apikey.
    const legacy = saveMonitorSettings(dir, {
      agentAuthMode: 'bearer',
      agentAuthToken: 'legacy-key',
    });
    assert.equal(legacy.agentAuthMode, 'apikey');
    assert.equal(legacy.agentApiKey, 'legacy-key');
  });

  it('resolveAgentMaxSteps defaults to 100 and clamps', () => {
    assert.equal(DEFAULT_MAX_STEPS, 100);
    assert.equal(resolveAgentMaxSteps({}), 100);
    assert.equal(resolveAgentMaxSteps({ agentMaxSteps: 42 }), 42);
    assert.equal(resolveAgentMaxSteps({ agentMaxSteps: 0 }), 1);
    assert.equal(resolveAgentMaxSteps({ agentMaxSteps: 5000 }), 1000);
  });

  it('resolveAgentEndpoint omits Authorization when auth is none', () => {
    const none = resolveAgentEndpoint({
      agentBaseUrl: 'http://localhost:1/v1',
      agentModel: 'm',
      agentAuthMode: 'none',
      agentApiKey: 'ignored',
    });
    assert.equal(none.headers.Authorization, undefined);

    const withKey = resolveAgentEndpoint({
      agentBaseUrl: 'http://localhost:1/v1',
      agentAuthMode: 'apikey',
      agentApiKey: 'abc',
    });
    assert.equal(withKey.headers.Authorization, 'Bearer abc');
    assert.equal(withKey.apiKey, 'abc');
  });

  it('buildOpencodeConfig wires openai-compatible provider', () => {
    const cfg = buildOpencodeConfig({
      agentBaseUrl: 'https://api.example.com/v1',
      agentModel: 'demo',
      agentAuthMode: 'none',
    });
    assert.equal(cfg.model, 'kusa-openai/demo');
    assert.equal(cfg.provider['kusa-openai'].options.baseURL, 'https://api.example.com/v1');
    assert.ok(Array.isArray(cfg.plugin) && cfg.plugin.length === 1);
  });
});
