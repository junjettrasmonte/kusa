import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  compileTicketFirstGraph,
  createJiraTools,
  ensureAtlassianWorkflowsSeeded,
  SESSION_TICKET_FILE,
  TICKET_FIRST_WORKFLOW,
  TICKET_FIRST_WORKFLOW_ID,
} from '#extensions/atlassian-adapter/index.mjs';
import { sessionMessagesHaveJiraTicket } from '#extensions/atlassian-adapter/ui/jiraAttachment.js';
// seedVersion is on the frozen workflow constant
import {
  loadExtensionToolModules,
  resetExtensionToolModules,
  createMergedExtensionTools,
} from '#features/agent/extension-tools.mjs';
import { agentToolGroups } from '#features/trail/agent/trail.mjs';
import { sessionAttachmentsDir } from '#features/chat/data/attachments.mjs';
import { drawableWorkflowGraph } from '#features/workflows/langgraph/index.mjs';
import { listWorkflows } from '#features/workflows/store.mjs';

const temps = [];

afterEach(() => {
  resetExtensionToolModules();
  while (temps.length) {
    const dir = temps.pop();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function tempDir(prefix = 'kusa-ticket-first-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

describe('atlassian jira tools', () => {
  it('get_issue returns ECONFIG without credentials', async () => {
    const dataDir = tempDir();
    const tools = createJiraTools({ dataDir, sessionKey: 'kusa:sess-1' });
    const out = await tools.call('kusa_jira_get_issue', { issueKey: 'ENG-1' });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'ECONFIG');
  });

  it('save_session_ticket writes attachments/ticket.json', () => {
    const dataDir = tempDir();
    const sessionId = 'sess-ticket-1';
    const tools = createJiraTools({ dataDir, sessionKey: `kusa:${sessionId}` });
    const issue = {
      key: 'ENG-42',
      summary: 'Ingest me',
      status: 'To Do',
      description: 'body',
    };
    const out = tools.saveSessionTicket({ issue });
    assert.equal(out.ok, true);
    assert.equal(out.issueKey, 'ENG-42');
    assert.equal(out.file, SESSION_TICKET_FILE);

    const folder = sessionAttachmentsDir(dataDir, sessionId, 'kusa');
    const path = join(folder, SESSION_TICKET_FILE);
    assert.equal(out.path, path);
    assert.ok(existsSync(path));
    const disk = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(disk.key, 'ENG-42');
    assert.equal(disk.summary, 'Ingest me');
    assert.ok(typeof disk.savedAt === 'number');
  });

  it('save_session_ticket overwrites ticket.json', () => {
    const dataDir = tempDir();
    const sessionId = 'sess-ticket-2';
    const tools = createJiraTools({ dataDir, sessionKey: `kusa:${sessionId}` });
    tools.saveSessionTicket({ issue: { key: 'ENG-1', summary: 'first' } });
    tools.saveSessionTicket({ issue: { key: 'ENG-2', summary: 'second' } });
    const path = join(sessionAttachmentsDir(dataDir, sessionId, 'kusa'), SESSION_TICKET_FILE);
    const disk = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(disk.key, 'ENG-2');
    assert.equal(disk.summary, 'second');
  });
});

describe('extension tool discovery', () => {
  it('loads atlassian tools.mjs into a jira group', async () => {
    const modules = await loadExtensionToolModules({ force: true });
    assert.ok(modules.some((m) => m.id === 'atlassian-adapter' && m.group === 'jira'));

    const merged = createMergedExtensionTools({ dataDir: '', sessionKey: '' });
    assert.ok(merged.names.has('kusa_jira_get_issue'));
    assert.ok(merged.names.has('kusa_jira_save_session_ticket'));

    const groups = agentToolGroups('agent');
    const jira = groups.find((g) => g.group === 'jira');
    assert.ok(jira, 'expected jira group in agentToolGroups');
    const names = jira.schemas.map((s) => s.function?.name);
    assert.ok(names.includes('kusa_jira_get_issue'));
    assert.ok(names.includes('kusa_jira_save_session_ticket'));
  });
});

describe('ticket-first workflow seed', () => {
  it('seeds ticket-first.json and refreshes stock seeds by seedVersion', () => {
    const dataDir = tempDir();
    ensureAtlassianWorkflowsSeeded(dataDir);
    const path = join(dataDir, 'workflows', `${TICKET_FIRST_WORKFLOW_ID}.json`);
    assert.ok(existsSync(path));
    const seeded = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(seeded.id, TICKET_FIRST_WORKFLOW.id);
    assert.equal(seeded.seededBy, 'atlassian-adapter');
    assert.equal(seeded.runtime, 'langgraph');
    assert.ok(seeded.roles?.orchestrator);
    assert.match(String(seeded.roles.orchestrator.promptTemplate || ''), /kusa_ask/);

    const listed = listWorkflows(dataDir);
    const listedTf = listed.find((w) => w.id === TICKET_FIRST_WORKFLOW_ID);
    assert.ok(listedTf);
    assert.equal(listedTf.runtime, 'langgraph');

    // Stock seed with older version refreshes.
    writeFileSync(path, `${JSON.stringify({
      ...seeded,
      seedVersion: 1,
      description: 'stale stock',
    }, null, 2)}\n`);
    ensureAtlassianWorkflowsSeeded(dataDir);
    const refreshed = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(refreshed.seedVersion, TICKET_FIRST_WORKFLOW.seedVersion);
    assert.equal(refreshed.runtime, 'langgraph');
    assert.notEqual(refreshed.description, 'stale stock');

    // User-edited copy (no seededBy) is left alone.
    writeFileSync(path, `${JSON.stringify({
      id: TICKET_FIRST_WORKFLOW_ID,
      name: 'Ticket First (custom)',
      description: 'user edited',
      roles: seeded.roles,
    }, null, 2)}\n`);
    ensureAtlassianWorkflowsSeeded(dataDir);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(after.name, 'Ticket First (custom)');
    assert.equal(after.description, 'user edited');
  });
});

describe('ticket-first langgraph', () => {
  it('compiles and exposes drawable nodes for the lifecycle graph', () => {
    const compiled = compileTicketFirstGraph();
    assert.ok(compiled);
    const drawable = compiled.getGraph();
    const json = typeof drawable?.toJSON === 'function'
      ? drawable.toJSON()
      : { nodes: [], edges: [] };
    const nodeIds = (Array.isArray(json.nodes) ? json.nodes : [])
      .map((n) => String(n?.id || n?.data?.id || ''))
      .filter(Boolean);
    assert.ok(nodeIds.some((id) => id.includes('ensure_ticket')), `nodes=${nodeIds.join(',')}`);
    assert.ok(nodeIds.some((id) => id.includes('await_direction')), `nodes=${nodeIds.join(',')}`);
    assert.ok(nodeIds.some((id) => id.includes('done')), `nodes=${nodeIds.join(',')}`);

    const fromCore = drawableWorkflowGraph(TICKET_FIRST_WORKFLOW_ID);
    assert.ok(fromCore);
    assert.equal(fromCore.workflowId, TICKET_FIRST_WORKFLOW_ID);
    const coreIds = (Array.isArray(fromCore.nodes) ? fromCore.nodes : [])
      .map((n) => String(n?.id || ''))
      .filter(Boolean);
    assert.ok(coreIds.some((id) => id.includes('ensure_ticket')));
    assert.ok(coreIds.some((id) => id.includes('await_direction')));
    assert.ok(coreIds.some((id) => id.includes('done')));
  });

  it('detects a Jira chip that already rode with a sent user prompt', () => {
    assert.equal(sessionMessagesHaveJiraTicket([], 'ABC-1'), false);
    assert.equal(sessionMessagesHaveJiraTicket([
      { role: 'user', text: 'go', attachments: [{ kind: 'jira', issueKey: 'ABC-1' }] },
    ], 'ABC-1'), true);
    assert.equal(sessionMessagesHaveJiraTicket([
      { role: 'user', text: 'go', attachments: [{ kind: 'jira', issueKey: 'ABC-2' }] },
    ], 'ABC-1'), false);
  });
});
