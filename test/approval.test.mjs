import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createApprovalGate,
  APPROVAL_GATED_TOOLS,
  APPROVAL_TIMEOUT_MS,
  resolveApprovalTimeoutMs,
  approvalModeLabel,
  approvalSystemPromptAddon,
  normalizeApprovalMode,
  createTerminalTools,
  TERMINAL_TOOL_DEFS,
  createBrowserTools,
  BROWSER_TOOL_DEFS,
  createTrailAwareTools,
  openaiToolSchemasWithTrail,
} from '../src/agent/index.mjs';

const dirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'kusa-approval-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('approval gate', () => {
  it('settles a gated tool outright when no approver is wired', async () => {
    const gate = createApprovalGate();
    const root = tempDir();
    const terminal = createTerminalTools(root, { approval: gate });

    const result = await terminal.call('kusa_terminal', { command: 'echo hi' });
    // No pending state: the rule's default settles the call and says so.
    assert.equal(result.ok, false);
    assert.equal(result.denied, true);
    assert.equal(result.needsApproval, undefined);
    assert.match(result.error, /DENIED before running/);
    assert.equal(result.approval.unattended, true);
    assert.equal(result.approval.decision, 'ask-deny-default');
    assert.equal(gate.requests.length, 1);
    assert.equal(gate.mode, 'ask-deny');
    assert.equal(gate.timeoutAllows, false);
  });

  it('runs after the user approves, and remembers the answer', async () => {
    let asked = 0;
    const gate = createApprovalGate({
      onApprove: () => {
        asked += 1;
        return { allowed: true, remember: asked === 1 };
      },
    });
    const root = tempDir();
    const terminal = createTerminalTools(root, { approval: gate });

    const first = await terminal.call('kusa_terminal', { command: 'echo one' });
    assert.equal(first.ok, true);
    assert.match(first.stdout, /one/);
    assert.equal(asked, 1);

    const second = await terminal.call('kusa_terminal', { command: 'echo two' });
    assert.equal(second.ok, true);
    assert.match(second.stdout, /two/);
    // Remembered allow: no second prompt.
    assert.equal(asked, 1);
    assert.equal(gate.remembered.get('kusa_terminal'), 'allow');
  });

  it('a denial never runs the command', async () => {
    const gate = createApprovalGate({ onApprove: () => false });
    const root = tempDir();
    const marker = join(root, 'touched.txt');
    const terminal = createTerminalTools(root, { approval: gate });

    const result = await terminal.call('kusa_terminal', { command: 'echo hi > touched.txt' });
    assert.equal(result.ok, false);
    assert.equal(result.denied, true);
    assert.match(result.error, /DENIED by the user/);
    assert.equal(existsSync(marker), false);
  });

  it('Composer Stop aborts a pending ask instead of waiting for the timeout', async () => {
    const controller = new AbortController();
    const gate = createApprovalGate({
      timeoutMs: 60_000,
      signal: controller.signal,
      // Never answers — same shape as serve's waitForApproval.
      onApprove: () => new Promise(() => {}),
    });
    const root = tempDir();
    const terminal = createTerminalTools(root, { approval: gate });

    const pending = terminal.call('kusa_terminal', { command: 'echo should-not-run' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();

    await assert.rejects(pending, (err) => err?.code === 'ABORT');
  });

  it('mode deny blocks and mode allow skips the prompt', async () => {
    const root = tempDir();
    const blocked = await createTerminalTools(root, {
      approval: createApprovalGate({ mode: 'deny' }),
    }).call('kusa_terminal', { command: 'echo nope' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.denied, true);

    const passed = await createTerminalTools(root, {
      approval: createApprovalGate({ mode: 'allow' }),
    }).call('kusa_terminal', { command: 'echo ok' });
    assert.equal(passed.ok, true);
    assert.match(passed.stdout, /ok/);
  });

  it('setMode switches the rule for the next gated call', async () => {
    const root = tempDir();
    const gate = createApprovalGate({ mode: 'deny' });
    const terminal = createTerminalTools(root, { approval: gate });
    const blocked = await terminal.call('kusa_terminal', { command: 'echo nope' });
    assert.equal(blocked.ok, false);

    assert.equal(gate.setMode('allow'), 'allow');
    assert.equal(gate.mode, 'allow');
    assert.equal(gate.timeoutAllows, false);
    const passed = await terminal.call('kusa_terminal', { command: 'echo ok' });
    assert.equal(passed.ok, true);
    assert.match(passed.stdout, /ok/);

    gate.setMode('ask-allow');
    assert.equal(gate.mode, 'ask-allow');
    assert.equal(gate.timeoutAllows, true);
  });

  it('non-gated tools pass straight through', async () => {
    const gate = createApprovalGate();
    const verdict = await gate.request({ name: 'kusa_read_file', args: { path: 'a' } });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.decision, 'not-gated');
    assert.equal(APPROVAL_GATED_TOOLS.has('kusa_read_file'), false);
  });

  it('legacy ask normalizes to the safe ask-deny rule', () => {
    assert.equal(normalizeApprovalMode('ask'), 'ask-deny');
    assert.equal(normalizeApprovalMode(' ASK-ALLOW '), 'ask-allow');
    assert.equal(normalizeApprovalMode('nope'), 'ask-deny');
    assert.equal(approvalModeLabel('ask-allow'), 'Ask · allow on timeout');
  });

  it('approval timeout resolves from settings minutes and caps extremes', () => {
    assert.equal(resolveApprovalTimeoutMs(null), APPROVAL_TIMEOUT_MS);
    assert.equal(resolveApprovalTimeoutMs(5 * 60_000), 5 * 60_000);
    assert.equal(resolveApprovalTimeoutMs(0), APPROVAL_TIMEOUT_MS);
    assert.equal(resolveApprovalTimeoutMs(99 * 60_000), 60 * 60_000);
  });

  it('each ask rule carries its own timeout default to the caller and the UI', async () => {
    const emitted = [];
    const gate = createApprovalGate({
      mode: 'ask-allow',
      emit: (ask) => emitted.push(ask),
      onApprove: () => ({ allowed: true }),
    });
    assert.equal(gate.mode, 'ask-allow');
    assert.equal(gate.timeoutAllows, true);
    assert.equal(gate.timeoutMs, APPROVAL_TIMEOUT_MS);

    const verdict = await gate.request({ name: 'kusa_terminal', args: { command: 'ls' }, callId: 'c1' });
    assert.equal(verdict.allowed, true);
    assert.equal(emitted.length, 2);
    // First emit: the pending ask, carrying the contract the UI countdown reads.
    assert.equal(emitted[0].status, 'pending');
    assert.equal(emitted[0].timeoutMs, APPROVAL_TIMEOUT_MS);
    assert.equal(emitted[0].timeoutDecision, 'allow');
    assert.equal(emitted[0].timeoutDefaultAllowed, true);
    // Second emit: the settled row, so the countdown cannot stay stuck at zero.
    assert.equal(emitted[1].status, 'allowed');
    assert.equal(emitted[1].autoSettled, false);
  });

  it('the gate owns the timeout: an unanswered ask settles with the rule default', async () => {
    const emitted = [];
    const gate = createApprovalGate({
      mode: 'ask-deny',
      timeoutMs: 2_000,
      emit: (ask) => emitted.push(ask),
      // A resolver that never gets a human answer — serve's waitForApproval is
      // exactly this: it only resolves on POST /kusa/approval.
      onApprove: () => new Promise(() => {}),
    });
    assert.equal(gate.timeoutMs, 2_000);

    const verdict = await gate.request({ name: 'kusa_terminal', args: { command: 'ls' }, callId: 'c2' });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.decision, 'ask-deny-default');
    assert.match(verdict.reason, /no decision within 2s — denied by the ask-deny rule/);
    assert.equal(emitted.length, 2);
    // The pending ask ships the gate's own clock so the UI cannot invent another.
    assert.equal(emitted[0].status, 'pending');
    assert.equal(emitted[0].timeoutMs, 2_000);
    assert.equal(Number(emitted[0].timeoutStartsAt) > 0, true);
    // The settled row replaces it, so the countdown cannot stay stuck at zero.
    assert.equal(emitted[1].status, 'denied');
    assert.equal(emitted[1].autoSettled, true);
    assert.equal(emitted[1].timeoutStartsAt, emitted[0].timeoutStartsAt);
  });

  it('ask-allow runs the call when nobody answers in time', async () => {
    const root = tempDir();
    const terminal = createTerminalTools(root, {
      approval: createApprovalGate({
        mode: 'ask-allow',
        timeoutMs: 20,
        onApprove: () => new Promise(() => {}),
      }),
    });
    const marker = join(root, 'ran.txt');
    const result = await terminal.call('kusa_terminal', { command: 'printf hi > ran.txt' });
    assert.equal(result.ok, true);
    assert.equal(existsSync(marker), true);
  });

  it('prompt addon tells the model the outcome is always settled', () => {
    assert.match(approvalSystemPromptAddon('ask'), /never see a pending/);
    assert.match(approvalSystemPromptAddon('ask'), /DENIED automatically/);
    assert.match(approvalSystemPromptAddon('deny'), /disabled for this run/);
    assert.equal(approvalSystemPromptAddon('allow').includes('pre-approved'), true);
    assert.match(approvalSystemPromptAddon('ask-allow'), /ALLOWED automatically/);
    assert.match(approvalSystemPromptAddon('ask-deny', 5 * 60_000), /within 5 minutes/);
  });
});

describe('terminal tool', () => {
  it('runs inside the workspace and caps output', async () => {
    const root = tempDir();
    const gate = createApprovalGate({ mode: 'allow' });
    const terminal = createTerminalTools(root, { approval: gate });

    const ok = await terminal.call('kusa_terminal', { command: "printf 'a\\nb'" });
    assert.equal(ok.ok, true);
    assert.equal(ok.stdout, 'a\nb');
    assert.equal(ok.cwd, '.');

    const failed = await terminal.call('kusa_terminal', { command: 'exit 3' });
    assert.equal(failed.ok, false);
    assert.equal(failed.exitCode, 3);
    assert.match(failed.error, /command exited 3/);

    const escaped = await terminal.call('kusa_terminal', { command: 'id', cwd: '../../etc' });
    assert.equal(escaped.ok, false);
    assert.match(escaped.error, /cwd escapes workspace/);

    const secret = await terminal.call('kusa_terminal', { command: "printf '%s' --api-key=hunter2hunter2" });
    assert.equal(secret.ok, true);
    assert.equal(secret.stdout.includes('hunter2'), false);
    assert.match(secret.stdout, /\[redacted\]/);
  });

  it('refuses interactive commands instead of hanging', async () => {
    const root = tempDir();
    const terminal = createTerminalTools(root, { approval: createApprovalGate({ mode: 'allow' }) });
    const refused = await terminal.call('kusa_terminal', { command: 'vim notes.md' });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /interactive command refused/);
  });

  it('is registered as a terminal tool for the dashboard', () => {
    assert.equal(TERMINAL_TOOL_DEFS[0].name, 'kusa_terminal');
    const schemas = openaiToolSchemasWithTrail();
    const names = schemas.map((s) => s.function.name);
    assert.ok(names.includes('kusa_terminal'));
    assert.ok(names.includes('kusa_browse'));
    assert.ok(names.includes('kusa_trail_ask'));
  });
});

describe('browser tool', () => {
  it('rejects non-http protocols without fetching', async () => {
    const browser = createBrowserTools({ approval: createApprovalGate({ mode: 'allow' }) });
    const bad = await browser.call('kusa_browse', { url: 'file:///etc/hosts' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /only http\(s\) allowed/);
  });

  it('refuses outright before fetching when nobody can approve', async () => {
    const browser = createBrowserTools();
    const result = await browser.call('kusa_browse', { url: 'https://example.com/' });
    assert.equal(result.ok, false);
    assert.equal(result.denied, true);
    assert.match(result.error, /DENIED before fetching/);
    assert.equal(result.approval.unattended, true);
  });

  it('extracts title, text, and links from a local page', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<html><head><title>Kusă Docs</title><style>p{color:red}</style></head>'
        + '<body><h1>Install</h1><p>Run <code>trail build</code> first.</p>'
        + '<p>Skip the pager step.</p><a href="/skills">Skills</a><a href="/mcp">MCP</a></body></html>',
      );
    });
    server.listen(0);
    const port = server.address().port;
    const browser = createBrowserTools({ approval: createApprovalGate({ mode: 'allow' }) });

    try {
      const page = await browser.call('kusa_browse', { url: `http://127.0.0.1:${port}/docs` });
      assert.equal(page.ok, true);
      assert.equal(page.title, 'Kusă Docs');
      assert.match(page.text, /trail build/);
      assert.equal(page.links.length, 2);
      assert.equal(page.links[0].href, '/skills');

      const filtered = await browser.call('kusa_browse', {
        url: `http://127.0.0.1:${port}/docs`,
        query: 'pager',
      });
      assert.equal(filtered.ok, true);
      assert.equal(filtered.filtered, true);
      assert.match(filtered.text, /pager/);
      assert.equal(filtered.text.includes('trail build'), false);
    } finally {
      server.close();
    }
  });
});

describe('trail-aware composition', () => {
  it('exposes the gated tools through the single dispatcher', async () => {
    const root = tempDir();
    const asked = [];
    const tools = createTrailAwareTools(root, {
      onApprove: (ask) => {
        asked.push(ask.summary);
        return false;
      },
    });
    assert.ok(tools.defs.some((d) => d.name === 'kusa_terminal'));
    assert.ok(tools.defs.some((d) => d.name === 'kusa_browse'));

    const denied = await tools.call('kusa_terminal', { command: 'ls' });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /DENIED by the user/);
    assert.equal(asked.length, 1);
    assert.match(asked[0], /command=ls/);
  });
});
