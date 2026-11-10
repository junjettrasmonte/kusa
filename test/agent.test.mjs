import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpencodeConfig,
  clearStrataDetectCache,
  createFileTools,
  createKusaHookEmitter,
  createTrailAwareTools,
  DEFAULT_ENDPOINT_LABEL,
  DEFAULT_MAX_STEPS,
  listAgentModelGroups,
  probeStrataMonitor,
  readStrataContext,
  strataLoadModel,
  strataSelfUpdate,
  strataUnloadModel,
  resolveAgentEndpoint,
  resolveAgentMaxSteps,
  resolveTrailPolicy,
  strataRootFromBaseUrl,
  trailNotReadyMessage,
  trailSystemPromptAddon,
  // Rule → OpenCode permission mapping (the OpenCode backend has no gate of its
  // own; the Rule IS its permission set).
  resolveApprovalRule,
  ruleClassOf,
  permissionForRule,
  agentToolFlags,
} from '#features/agent/index.mjs';
import {
  indexJsonPath,
  laneKey,
  loadMonitorSettings,
  refreshMonitorArtifacts,
  runHook,
  saveMonitorSettings,
} from '#features/monitor/lib.mjs';
import { publicSettings } from '#features/settings/secrets.mjs';
import { callTool } from '#features/mcp/tools.mjs';

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

  it('persists extra OpenAI-compatible endpoints with per-endpoint keys and comma models', () => {
    const dir = tempDir();
    const saved = saveMonitorSettings(dir, {
      agentBaseUrl: 'https://api.openai.com/v1',
      agentModel: 'gpt-4o-mini',
      agentModels: 'gpt-4o-mini, o3-mini',
      agentAuthMode: 'apikey',
      agentApiKey: 'sk-default',
      agentEndpoints: [
        {
          name: 'Acme Proxy',
          baseUrl: 'https://api.acme.test/v1',
          authMode: 'apikey',
          apiKey: 'sk-acme',
          models: 'acme-one, acme-two',
        },
        {
          name: 'Local Ollama',
          baseUrl: 'http://127.0.0.1:11434/v1',
          authMode: 'none',
          models: 'llama3.1',
        },
      ],
    });
    assert.equal(saved.agentModels.length, 2);
    assert.deepEqual(saved.agentModels, ['gpt-4o-mini', 'o3-mini']);
    assert.equal(saved.agentEndpoints.length, 2);
    assert.equal(saved.agentEndpoints[0].name, 'Acme Proxy');
    assert.equal(saved.agentEndpoints[0].apiKey, 'sk-acme');
    assert.deepEqual(saved.agentEndpoints[0].models, ['acme-one', 'acme-two']);
    assert.ok(saved.agentEndpoints[0].id);

    const reloaded = loadMonitorSettings(dir);
    assert.equal(reloaded.agentEndpoints[0].apiKey, 'sk-acme');
    assert.equal(reloaded.agentEndpoints[1].apiKey, '');
    assert.deepEqual(reloaded.agentEndpoints[1].models, ['llama3.1']);

    // Browser-safe projection never ships keys, only apiKeySet.
    const pub = publicSettings(reloaded);
    assert.equal(pub.agentApiKeySet, true);
    assert.equal(pub.agentEndpoints[0].apiKeySet, true);
    assert.equal(pub.agentEndpoints[1].apiKeySet, false);
    assert.equal(Object.hasOwn(pub.agentEndpoints[0], 'apiKey'), false);

    // A whole-list rewrite that omits apiKey keeps the stored key for that id.
    const kept = saveMonitorSettings(dir, {
      agentEndpoints: reloaded.agentEndpoints.map((entry) => ({
        id: entry.id,
        name: entry.name,
        baseUrl: entry.baseUrl,
        authMode: entry.authMode,
        models: entry.models,
      })),
    });
    assert.equal(kept.agentEndpoints[0].apiKey, 'sk-acme');
  });

  it('refreshMonitorArtifacts picks up endpoint edits from settings.json', () => {
    // Regression: POST /settings wrote settings.json but monitor-data.js kept the
    // prior snapshot until the next refresh — the console poll then reverted fields.
    const dir = tempDir();
    saveMonitorSettings(dir, {
      agentBaseUrl: 'https://api.openai.com/v1',
      agentModel: 'gpt-4o-mini',
      agentEndpoints: [
        {
          name: 'Acme',
          baseUrl: 'https://api.acme.test/v1',
          authMode: 'none',
          models: 'acme-one',
        },
      ],
    });
    const first = refreshMonitorArtifacts(dir, { origin: '' });
    assert.equal(first.settings.agentBaseUrl, 'https://api.openai.com/v1');
    assert.equal(first.settings.agentEndpoints.length, 1);
    assert.equal(first.settings.agentEndpoints[0].baseUrl, 'https://api.acme.test/v1');

    saveMonitorSettings(dir, {
      agentBaseUrl: 'https://proxy.example/v1',
      agentEndpoints: [
        {
          id: first.settings.agentEndpoints[0].id,
          name: 'Acme Renamed',
          baseUrl: 'https://api.acme.test/v2',
          authMode: 'none',
          models: 'acme-two',
        },
      ],
    });
    const second = refreshMonitorArtifacts(dir, { origin: '' });
    assert.equal(second.settings.agentBaseUrl, 'https://proxy.example/v1');
    assert.equal(second.settings.agentEndpoints[0].name, 'Acme Renamed');
    assert.equal(second.settings.agentEndpoints[0].baseUrl, 'https://api.acme.test/v2');
    assert.deepEqual(second.settings.agentEndpoints[0].models, ['acme-two']);

    // A later hook persist must not re-emit the pre-edit snapshot into the index.
    saveMonitorSettings(dir, { agentBaseUrl: 'https://after-hook.example/v1' });
    runHook({ dir, eventName: 'not-a-hook', stdinText: '{}', origin: '' });
    const index = JSON.parse(readFileSync(indexJsonPath(dir), 'utf8'));
    assert.equal(index.settings.agentBaseUrl, 'https://after-hook.example/v1');
  });

  it('resolveAgentEndpoint routes a pick to the endpoint that declared it', () => {
    const settings = {
      agentBaseUrl: 'https://api.openai.com/v1',
      agentModel: 'acme-one',
      agentAuthMode: 'apikey',
      agentApiKey: 'sk-default',
      agentEndpoints: [
        {
          id: 'acme',
          name: 'Acme',
          baseUrl: 'https://api.acme.test/v1',
          authMode: 'apikey',
          apiKey: 'sk-acme',
          models: ['acme-one', 'acme-two'],
        },
      ],
    };
    const hit = resolveAgentEndpoint(settings);
    assert.equal(hit.baseUrl, 'https://api.acme.test/v1');
    assert.equal(hit.apiKey, 'sk-acme');
    assert.equal(hit.headers.Authorization, 'Bearer sk-acme');

    const fallback = resolveAgentEndpoint({ ...settings, agentModel: 'gpt-4o-mini' });
    assert.equal(fallback.baseUrl, 'https://api.openai.com/v1');
    assert.equal(fallback.apiKey, 'sk-default');
  });

  it('resolveAgentEndpoint routes by agentEndpointId for probed-only picks', () => {
    // Google AI Studio (and similar) advertise models/… ids that were never
    // typed into the Models field — the composer sends the heading's endpoint
    // id so those picks do not fall through to Default.
    const settings = {
      agentBaseUrl: 'https://strata.example/v1',
      agentModel: 'models/gemini-flash-latest',
      agentAuthMode: 'apikey',
      agentApiKey: 'sk-default',
      agentEndpointId: 'google-ai-studio',
      agentEndpoints: [
        {
          id: 'google-ai-studio',
          name: 'Google AI Studio',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
          authMode: 'apikey',
          apiKey: 'sk-google',
          models: [],
        },
      ],
    };
    const hit = resolveAgentEndpoint(settings);
    assert.equal(hit.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
    assert.equal(hit.apiKey, 'sk-google');
    assert.equal(hit.model, 'models/gemini-flash-latest');

    const prefixed = resolveAgentEndpoint({
      ...settings,
      agentEndpointId: '',
      agentModel: 'models/gemini-flash-latest',
      agentEndpoints: [{
        ...settings.agentEndpoints[0],
        models: ['gemini-flash-latest'],
      }],
    });
    assert.equal(prefixed.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  });

  it('listAgentModelGroups lists models from every active endpoint, grouped by name', async () => {
    const listed = await listAgentModelGroups({
      agentBaseUrl: 'https://api.openai.com/v1',
      agentModel: 'gpt-4o-mini',
      agentModels: ['gpt-4o-mini', 'o3-mini'],
      agentAuthMode: 'none',
      agentEndpoints: [
        {
          id: 'acme-proxy',
          name: 'Acme Proxy',
          baseUrl: 'https://api.acme.test/v1',
          authMode: 'none',
          models: ['acme-one', 'acme-two'],
        },
        {
          id: 'local',
          name: 'Local',
          baseUrl: 'http://127.0.0.1:11434/v1',
          authMode: 'none',
          models: 'llama3.1, mistral',
        },
      ],
    });
    assert.equal(listed.default, 'gpt-4o-mini');
    const names = listed.groups.map((group) => group.name);
    assert.deepEqual(names, [DEFAULT_ENDPOINT_LABEL, 'Acme Proxy', 'Local']);
    assert.equal(listed.groups[0].endpointId, '');
    assert.equal(listed.groups[1].endpointId, 'acme-proxy');
    assert.equal(listed.groups[2].endpointId, 'local');
    assert.deepEqual(listed.groups[0].models, ['gpt-4o-mini', 'o3-mini']);
    assert.deepEqual(listed.groups[1].models, ['acme-one', 'acme-two']);
    assert.deepEqual(listed.groups[2].models, ['llama3.1', 'mistral']);
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

  it('the approval Rule maps onto OpenCode permissions, for every rule', () => {
    const settings = {
      agentBaseUrl: 'https://api.example.com/v1',
      agentModel: 'demo',
      agentAuthMode: 'none',
    };
    // ask-deny and ask-allow differ only in the timeout default the native gate
    // owns, so they share one class — switching between them must not restart
    // the cached OpenCode server, while allow/deny/ask must.
    assert.equal(ruleClassOf('ask-deny'), ruleClassOf('ask-allow'));
    assert.notEqual(ruleClassOf('allow'), ruleClassOf('deny'));
    for (const rule of ['allow', 'deny', 'ask-deny', 'ask-allow']) {
      const cfg = buildOpencodeConfig({ ...settings, agentApprovalMode: rule });
      const expected = permissionForRule(rule);
      assert.equal(cfg.permission.bash, expected);
      assert.equal(cfg.permission.webfetch, expected);
      assert.equal(cfg.agent.build.permission.bash, expected);
      // Only 'deny' takes the tool off; every other rule leaves it callable.
      assert.equal(cfg.agent.build.tools.bash, rule !== 'deny');
      assert.equal(cfg.agent.build.tools.webfetch, rule !== 'deny');
      // The same flags the prompt body re-sends per call, so a picker change
      // applies without rebuilding the server.
      assert.deepEqual(
        agentToolFlags({ writable: true, rule }),
        cfg.agent.build.tools,
      );
    }
    // The composer picker wins over Settings for the run it starts.
    assert.equal(resolveApprovalRule({ agentApprovalMode: 'deny' }, 'allow'), 'allow');
    assert.equal(resolveApprovalRule({ agentApprovalMode: 'deny' }, ''), 'deny');
  });

  it('strataRootFromBaseUrl strips a trailing /v1 for discovery endpoints', () => {
    assert.equal(strataRootFromBaseUrl('https://strata.example/v1'), 'https://strata.example');
    assert.equal(strataRootFromBaseUrl('https://strata.example/v1/'), 'https://strata.example');
    assert.equal(strataRootFromBaseUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  });

  it('readStrataContext reports live n_prompt_tokens / n_ctx when /health is Strata', async () => {
    clearStrataDetectCache();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.endsWith('/health')) {
        return new Response(JSON.stringify({
          status: 'ok',
          service: 'strata',
          max_context: 131072,
          model: 'demo',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (href.endsWith('/slots')) {
        return new Response(JSON.stringify([
          { id: 0, n_ctx: 131072, is_processing: false, n_prompt_tokens: 42000 },
        ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    };
    try {
      const ctx = await readStrataContext('https://strata.example/v1', {});
      assert.equal(ctx.strata, true);
      assert.equal(ctx.used, 42000);
      assert.equal(ctx.limit, 131072);
      assert.equal(ctx.model, 'demo');
    } finally {
      globalThis.fetch = originalFetch;
      clearStrataDetectCache();
    }
  });

  it('probeStrataMonitor draws metrics, status, slots, and props after Strata is confirmed', async () => {
    clearStrataDetectCache();
    const hits = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const href = String(url);
      hits.push(href);
      const json = (body) => new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
      if (href.endsWith('/health')) {
        return json({
          status: 'ok',
          service: 'strata',
          max_context: 131072,
          model: 'demo',
          loaded: true,
        });
      }
      if (href.endsWith('/update')) {
        return json({
          supported: true,
          state: 'idle',
          check: { engine: { status: 'current', installed: '0.1.47', offered: { version: '0.1.47' } } },
        });
      }
      if (href.endsWith('/metrics')) {
        return json({
          engine: { model: 'demo', max_context: 131072, images: false },
          live: {
            state: 'generating',
            queued: 1,
            phase: 'answering',
            prompt_tokens: 1000,
            generated: 40,
            max_tokens: 200,
            elapsed_s: 1.2,
            tok_s: 33.3,
            prefill_tok_s_mean: 900,
            slots: [{ slot: 0, state: 'decoding', generated: 40, tok_s: 33.3 }],
          },
          totals: {
            requests: 4,
            prompt_tokens: 8000,
            output_tokens: 900,
            reused: 100,
            prompt_ms: 400,
            decode_ms: 2000,
          },
          hardware: {
            gpu_util: 72,
            gpu_mem_used: 20 * 1024 ** 3,
            gpu_mem_total: 24 * 1024 ** 3,
            gpu_temp: 61,
            gpu_power: 180,
            cpu: 22,
            ram_used: 30 * 1024 ** 3,
            ram_total: 64 * 1024 ** 3,
          },
          hardware_static: { gpu_name: 'Test GPU', cpu_name: 'Test CPU' },
          history: { gpu_util: [10, 72], gpu_power: [80, 180], tok_s: [0, 33] },
          requests: [{
            finish: 'stop',
            prompt_tokens: 100,
            output_tokens: 20,
            decode_tok_s: 40,
            duration_s: 1,
            tail: 'secret answer',
          }],
        });
      }
      if (href.endsWith('/status')) {
        return json({
          busy: true,
          queued: 1,
          phase: 'answering',
          generated: 40,
          tokens_per_s: 33,
          elapsed_s: 1.2,
          tail: 'secret answer',
        });
      }
      if (href.endsWith('/slots')) {
        return json([{ id: 0, n_ctx: 131072, is_processing: true, n_prompt_tokens: 42000 }]);
      }
      if (href.endsWith('/props')) {
        return json({
          default_generation_settings: {
            n_ctx: 131072,
            params: { temperature: 0.6, top_p: 0.9, top_k: 40 },
          },
          total_slots: 2,
          model_alias: 'demo',
          model_path: '/models/demo.gguf',
          build_info: 'Strata 0.1',
          chat_template: 'HUGE TEMPLATE',
          modalities: { vision: false },
        });
      }
      return new Response('no', { status: 404 });
    };
    try {
      const view = await probeStrataMonitor('https://strata.example/v1', {});
      assert.equal(view.strata, true);
      assert.equal(view.model, 'demo');
      assert.equal(view.maxContext, 131072);
      assert.equal(view.slots[0].used, 42000);
      assert.equal(view.slots[0].processing, true);
      assert.equal(view.slots[0].state, 'decoding');
      assert.equal(view.slots[0].tokS, 33.3);
      assert.equal(view.live.state, 'generating');
      assert.equal(view.live.tokS, 33.3);
      assert.equal(view.live.prefillTokS, 900);
      assert.deepEqual(view.hardware.history.gpuPower, [80, 180]);
      assert.equal(view.live.queued, 1);
      assert.equal(view.props.temperature, 0.6);
      assert.equal(view.props.totalSlots, 2);
      assert.equal(view.hardware.gpuUtil, 72);
      assert.equal(view.hardware.gpuName, 'Test GPU');
      assert.equal(view.totals.requests, 4);
      assert.equal(view.requests[0].decodeTokS, 40);
      assert.equal(view.probes.metrics.ok, true);
      assert.equal(view.probes.slots.ok, true);
      assert.equal(view.loaded, true);
      assert.equal(view.update.supported, true);
      assert.equal(view.update.available, true);
      const packed = JSON.stringify(view);
      assert.equal(packed.includes('secret'), false);
      assert.equal(packed.includes('HUGE'), false);
      assert.equal(packed.includes('chat_template'), false);
      for (const path of ['/metrics', '/status', '/slots', '/props', '/update']) {
        assert.equal(hits.some((href) => href.endsWith(path)), true);
      }
    } finally {
      globalThis.fetch = originalFetch;
      clearStrataDetectCache();
    }
  });

  it('strataLoadModel and strataUnloadModel POST JSON only after Strata confirms', async () => {
    clearStrataDetectCache();
    const hits = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      hits.push({ href, method: String(init.method || 'GET').toUpperCase(), body: init.body || '' });
      const json = (body, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
      if (href.endsWith('/health')) {
        return json({ status: 'ok', service: 'strata', loaded: true, model: 'demo' });
      }
      if (href.endsWith('/load') || href.includes('/unload')) {
        return json({ ok: true });
      }
      return json({ error: 'no' }, 404);
    };
    try {
      const loaded = await strataLoadModel('https://strata.example/v1', { Authorization: 'Bearer x' }, { model: 'demo' });
      assert.equal(loaded.ok, true);
      assert.equal(loaded.strata, true);
      const loadHit = hits.find((row) => row.href.endsWith('/load'));
      assert.equal(loadHit?.method, 'POST');
      assert.equal(JSON.parse(loadHit.body).model, 'demo');

      const unloaded = await strataUnloadModel('https://strata.example/v1', {}, { wait: true });
      assert.equal(unloaded.ok, true);
      assert.equal(hits.some((row) => row.href.includes('/unload?wait=1') && row.method === 'POST'), true);
    } finally {
      globalThis.fetch = originalFetch;
      clearStrataDetectCache();
    }
  });

  it('strataSelfUpdate posts action check/install after Strata confirms', async () => {
    clearStrataDetectCache();
    const hits = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      hits.push({ href, method: String(init.method || 'GET').toUpperCase(), body: init.body || '' });
      const json = (body) => new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
      if (href.endsWith('/health')) {
        return json({ status: 'ok', service: 'strata', model: 'demo' });
      }
      if (href.endsWith('/update') && String(init.method || 'GET').toUpperCase() === 'POST') {
        return json({
          supported: true,
          state: 'idle',
          summary: 'Engine: 0.1.47 → 0.1.48',
        });
      }
      return json({ error: 'no' });
    };
    try {
      const checked = await strataSelfUpdate('https://strata.example/v1', {}, { action: 'check' });
      assert.equal(checked.ok, true);
      assert.equal(checked.action, 'check');
      assert.match(String(checked.update?.summary || ''), /0\.1\.48/);
      const post = hits.find((row) => row.href.endsWith('/update') && row.method === 'POST');
      assert.equal(JSON.parse(post.body).action, 'check');
    } finally {
      globalThis.fetch = originalFetch;
      clearStrataDetectCache();
    }
  });

  it('probeStrataMonitor marks /update unsupported when the route is missing', async () => {
    clearStrataDetectCache();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const href = String(url);
      const json = (body, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
      if (href.endsWith('/health')) {
        return json({ status: 'ok', service: 'strata', loaded: true, model: 'demo', max_context: 1024 });
      }
      if (href.endsWith('/update')) return json({ error: { message: 'not found' } }, 404);
      if (href.endsWith('/metrics')) return json({ live: { state: 'idle' }, hardware: {}, totals: {} });
      if (href.endsWith('/status')) return json({ busy: false });
      if (href.endsWith('/slots')) return json([]);
      if (href.endsWith('/props')) {
        return json({ default_generation_settings: { n_ctx: 1024 }, model_alias: 'demo' });
      }
      return json({ error: 'no' }, 404);
    };
    try {
      const view = await probeStrataMonitor('https://strata.example/v1', {});
      assert.equal(view.strata, true);
      assert.equal(view.update.supported, false);
      assert.equal(view.update.reason, 'not-found');
      assert.equal(view.live.state, 'idle');
    } finally {
      globalThis.fetch = originalFetch;
      clearStrataDetectCache();
    }
  });

  it('probeStrataMonitor skips the monitor endpoints until the host confirms as Strata', async () => {
    clearStrataDetectCache();
    const hits = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      hits.push(String(url));
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const view = await probeStrataMonitor('https://api.openai.com/v1', {});
      assert.equal(view.strata, false);
      assert.equal(view.live, undefined);
      assert.equal(hits.some((href) => href.endsWith('/metrics')), false);
      assert.equal(hits.some((href) => href.endsWith('/status')), false);
    } finally {
      globalThis.fetch = originalFetch;
      clearStrataDetectCache();
    }
  });

  it('readStrataContext returns strata:false for ordinary OpenAI hosts', async () => {
    clearStrataDetectCache();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
    try {
      const ctx = await readStrataContext('https://api.openai.com/v1', {});
      assert.equal(ctx.strata, false);
    } finally {
      globalThis.fetch = originalFetch;
      clearStrataDetectCache();
    }
  });
});
