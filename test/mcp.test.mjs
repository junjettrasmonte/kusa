import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createMonitorServer } from '../src/serve.mjs';
import {
  addLearning,
  advertisedTools,
  callTool,
  getMcpStatus,
  listLearnings,
  mcpEndpointUrl,
  mcpRpcPath,
  mcpServerKey,
  saveMcpState,
  setMcpEnabled,
  workspaceMcpSlug,
} from '../src/mcp/index.mjs';
import { ensureSkillsInitialized } from '../src/skills/index.mjs';

function tempRoot(prefix = 'kusa-mcp-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('mcp config + learnings', () => {
  const roots = [];
  after(() => {
    for (const root of roots) {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('registers localhost URL in .cursor/mcp.json when enabled', () => {
    const root = tempRoot();
    roots.push(root);
    const dataDir = join(root, '.kusa');
    mkdirSync(join(root, '.cursor'), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(root, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: { trail: { command: 'trail', args: ['mcp'] } },
    }, null, 2));

    const on = setMcpEnabled(root, dataDir, true, { port: 1424 });
    assert.equal(on.registered, true);
    assert.ok(on.authToken);
    const key = mcpServerKey(root);
    const raw = JSON.parse(readFileSync(join(root, '.cursor', 'mcp.json'), 'utf8'));
    assert.equal(raw.mcpServers[key].url, mcpEndpointUrl(1424, root));
    assert.match(raw.mcpServers[key].url, /\/mcp\/.+\/rpc$/);
    assert.match(raw.mcpServers[key].headers.Authorization, /^Bearer /);
    assert.equal(raw.mcpServers.trail.command, 'trail');
    assert.equal(raw.mcpServers.kusa, undefined);

    const off = setMcpEnabled(root, dataDir, false, { port: 1424 });
    assert.equal(off.registered, false);
    const afterOff = JSON.parse(readFileSync(join(root, '.cursor', 'mcp.json'), 'utf8'));
    assert.equal(afterOff.mcpServers[key], undefined);
    assert.equal(afterOff.mcpServers.trail.command, 'trail');
  });

  it('builds a stable per-workspace slug and rpc path', () => {
    const root = join(tmpdir(), `kusa-slug-My App-${process.pid}`);
    mkdirSync(root, { recursive: true });
    roots.push(root);
    const slug = workspaceMcpSlug(root);
    assert.match(slug, /^kusa-slug-my-app-\d+-[a-f0-9]{8}$/);
    assert.equal(mcpRpcPath(root), `/mcp/${slug}/rpc`);
    assert.equal(workspaceMcpSlug(root), slug);
  });

  it('lists and adds learnings under .trail/learnings', () => {
    const root = tempRoot();
    roots.push(root);
    const added = addLearning(root, {
      title: 'Prefer MCP toggle via mcp.json',
      body: 'Enable kusa by writing .cursor/mcp.json; Cursor reloads on new chat.',
    });
    assert.equal(added.ok, true);
    assert.equal(added.learning.title, 'Prefer MCP toggle via mcp.json');
    const listed = listLearnings(root);
    assert.equal(listed.learnings.length, 1);
    assert.match(listed.learnings[0].body, /Enable kusa/);
  });

  it('filters advertised tools from mcp state', () => {
    const root = tempRoot();
    roots.push(root);
    const dataDir = join(root, '.kusa');
    mkdirSync(dataDir, { recursive: true });
    saveMcpState(dataDir, { tools: { kusa_get_session: false } });
    const tools = advertisedTools(dataDir);
    assert.ok(tools.some((t) => t.name === 'kusa_list_skills'));
    assert.ok(!tools.some((t) => t.name === 'kusa_get_session'));
  });

  it('callTool lists skills after seed', async () => {
    const root = tempRoot();
    roots.push(root);
    const dataDir = join(root, '.kusa');
    mkdirSync(dataDir, { recursive: true });
    ensureSkillsInitialized(dataDir);
    const result = await callTool('kusa_list_skills', {}, root);
    assert.equal(result.isError, false);
    const parsed = JSON.parse(result.text);
    assert.ok(Array.isArray(parsed.skills));
    assert.ok(parsed.skills.length >= 1);
  });
});

describe('mcp HTTP API', () => {
  it('serves localhost /mcp/rpc when enabled and enforces bearer auth', async () => {
    const root = tempRoot('kusa-mcp-http-');
    const dataDir = join(root, '.kusa');
    mkdirSync(join(root, '.cursor'), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(root, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2));

    const server = createMonitorServer({
      dataDir,
      workspaceRoot: root,
      pageDir: join(root, 'empty-pages'),
      mcpPort: 0,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    server.setMcpPort(port);
    const base = `http://127.0.0.1:${port}`;

    try {
      const rpcPath = mcpRpcPath(root);
      const offRpc = await fetch(`${base}${rpcPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      assert.equal(offRpc.status, 404);

      const enableRes = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, tools: { kusa_add_learning: false } }),
      });
      assert.equal(enableRes.status, 200);
      const enabled = await enableRes.json();
      assert.equal(enabled.enabled, true);
      assert.equal(enabled.endpoint, mcpEndpointUrl(port, root));
      assert.equal(enabled.rpcPath, rpcPath);
      assert.ok(enabled.slug);
      assert.ok(enabled.authToken);
      assert.equal(enabled.tools.find((t) => t.name === 'kusa_add_learning')?.enabled, false);

      const wrongSlug = await fetch(`${base}/mcp/other-project-deadbeef/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      assert.equal(wrongSlug.status, 404);

      const noAuth = await fetch(`${base}${rpcPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      assert.equal(noAuth.status, 401);

      const ok = await fetch(`${base}${rpcPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${enabled.authToken}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      assert.equal(ok.status, 200);
      const init = await ok.json();
      assert.equal(init.result.serverInfo.name, 'kusa');

      const list = await fetch(`${base}${rpcPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${enabled.authToken}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      const listed = await list.json();
      assert.ok(listed.result.tools.some((t) => t.name === 'kusa_list_skills'));
      assert.ok(!listed.result.tools.some((t) => t.name === 'kusa_add_learning'));

      const addRes = await fetch(`${base}/learnings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'HTTP learning', body: 'Added through the monitor API.' }),
      });
      assert.equal(addRes.status, 200);

      const notes = await (await fetch(`${base}/learnings`)).json();
      assert.ok(notes.learnings.some((l) => l.title === 'HTTP learning'));

      assert.equal(getMcpStatus(root, dataDir, { port }).enabled, true);

      const createTool = await fetch(`${base}/mcp/tools`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'kusa_project_notes',
          description: 'Return project notes for a topic',
          inputSchema: {
            type: 'object',
            properties: { topic: { type: 'string' } },
            required: ['topic'],
          },
          body: 'Notes about {{topic}}',
        }),
      });
      assert.equal(createTool.status, 201);
      const created = await createTool.json();
      assert.equal(created.name, 'kusa_project_notes');
      assert.equal(created.builtin, false);

      const toolsList = await (await fetch(`${base}/mcp/tools`)).json();
      assert.ok(toolsList.tools.some((t) => t.name === 'kusa_project_notes'));
      assert.ok(toolsList.tools.some((t) => t.name === 'kusa_list_skills' && t.builtin));

      const callCustom = await fetch(`${base}${rpcPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${enabled.authToken}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'kusa_project_notes', arguments: { topic: 'MCP' } },
        }),
      });
      const called = await callCustom.json();
      assert.match(called.result?.content?.[0]?.text || '', /Notes about MCP/);

      const del = await fetch(`${base}/mcp/tools/kusa_project_notes`, { method: 'DELETE' });
      assert.equal(del.status, 200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
