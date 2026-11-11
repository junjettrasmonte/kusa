import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_GATED_TOOLS,
  ESCALATE_CANCEL_LABEL,
  ESCALATE_TOOL_DEFS,
  agentToolGroups,
  createEscalateTools,
  createTrailAwareTools,
  escalateProviderOptions,
  escalateSystemPromptAddon,
  escalateToolSchemas,
  isOrchestratedSessionKey,
  openaiToolSchemasWithTrail,
  providerFromEscalateAsk,
} from '#features/agent/index.mjs';
import {
  createChatSession,
  createSubagent,
  listChatSessions,
  readSessionConfig,
} from '#features/chat/data/chat-store.mjs';
import { SESSION_KIND_ORCHESTRATED } from '#features/chat/data/providers.mjs';
import { SUBAGENTS_DIR, findNestedSubagentFiles } from '#features/monitor/lib.mjs';
import '#features/chat/data/load-builtin-adapters.mjs';

const dirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'kusa-escalate-'));
  dirs.push(dir);
  return dir;
}

/** Auto-pick a provider option (or cancel) for ask-gated call() tests. */
function askPick({ providerId = 'kusa', cancel = false } = {}) {
  return async (prompt) => {
    const options = Array.isArray(prompt?.options) ? prompt.options : [];
    if (cancel) {
      const idx = options.findIndex(
        (o) => String(o?.label || '').toLowerCase() === ESCALATE_CANCEL_LABEL.toLowerCase(),
      );
      assert.ok(idx >= 0, 'cancel option should be present');
      return {
        ok: true,
        selected: { index: idx, label: options[idx].label, detail: options[idx].detail || '' },
        answer: options[idx].label,
      };
    }
    const idx = options.findIndex(
      (o) => String(o?.detail || '').toLowerCase() === providerId
        || String(o?.label || '').toLowerCase() === providerId,
    );
    assert.ok(idx >= 0, `provider option "${providerId}" should be listed`);
    return {
      ok: true,
      selected: { index: idx, label: options[idx].label, detail: options[idx].detail || '' },
      answer: options[idx].label,
    };
  };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('kusa_escalate', () => {
  it('advertises the tool only when orchestrated schemas are requested', () => {
    const names = escalateToolSchemas().map((schema) => schema.function.name);
    assert.deepEqual(names, ESCALATE_TOOL_DEFS.map((def) => def.name));

    const plain = agentToolGroups('agent');
    assert.equal(plain.some((g) => g.group === 'escalate'), false);
    assert.equal(
      openaiToolSchemasWithTrail('agent').some((s) => s.function?.name === 'kusa_escalate'),
      false,
    );

    const orch = agentToolGroups('agent', { orchestrated: true });
    assert.ok(orch.find((g) => g.group === 'escalate'));
    assert.ok(
      openaiToolSchemasWithTrail('agent', { orchestrated: true })
        .some((s) => s.function?.name === 'kusa_escalate'),
    );
  });

  it('refuses outside orchestrated sessions', async () => {
    const dir = tempDir();
    createChatSession(dir, { id: 'std-1', workspaceRoot: dir });
    const tools = createEscalateTools({
      dataDir: dir,
      sessionKey: 'kusa:std-1',
      workspaceRoot: dir,
      ask: askPick(),
      runTurn: async () => ({ ok: true, text: 'should not run' }),
    });
    const result = await tools.call('kusa_escalate', {
      action: 'fix the flaky test',
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EORCH');
    assert.match(result.error, /orchestrated/i);
    assert.equal(escalateSystemPromptAddon({ dataDir: dir, sessionKey: 'kusa:std-1' }), '');
  });

  it('awaits one provider turn and returns control with the result', async () => {
    const dir = tempDir();
    createChatSession(dir, {
      id: 'orch-1',
      workspaceRoot: dir,
      kind: SESSION_KIND_ORCHESTRATED,
      workflowId: 'plan-execute',
    });
    assert.equal(isOrchestratedSessionKey(dir, 'kusa:orch-1'), true);

    const addon = escalateSystemPromptAddon({ dataDir: dir, sessionKey: 'kusa:orch-1' });
    assert.match(addon, /kusa_escalate/);
    assert.match(addon, /no timer/i);
    assert.match(addon, /fresh ask/i);

    const calls = [];
    const tools = createEscalateTools({
      dataDir: dir,
      sessionKey: 'kusa:orch-1',
      workspaceRoot: dir,
      runTurn: async (opts) => {
        calls.push(opts);
        assert.equal(opts.awaitCompletion, true);
        assert.equal(opts.provider, 'kusa');
        assert.match(opts.prompt, /Action:/);
        assert.match(opts.prompt, /patch the flaky assertion/);
        assert.match(opts.prompt, /stuck on a race/);
        return {
          ok: true,
          type: 'done',
          text: 'Patched assert.equal → assert.deepEqual',
          turnId: 'turn-esc-1',
        };
      },
    });

    const result = await tools.escalate({
      provider: 'kusa',
      action: 'patch the flaky assertion',
      reason: 'stuck on a race',
    });

    assert.equal(result.ok, true);
    assert.equal(result.provider, 'kusa');
    assert.equal(result.text, 'Patched assert.equal → assert.deepEqual');
    assert.equal(result.subagent?.role, 'escalation');
    assert.equal(result.subagent?.parentId, 'orch-1');
    assert.equal(calls.length, 1);
    assert.match(result.message, /one turn/i);

    // Nested Subagents are indexed on the parent Agent's sidecar.
    const parentCfg = readSessionConfig(dir, 'orch-1');
    const listed = (parentCfg?.subagents || [])
      .find((row) => row?.id === result.subagent.id);
    assert.equal(listed?.role, 'escalation');
    assert.ok(listChatSessions(dir).some((s) => s.id === result.subagent.id && s.role === 'escalation'));
  });

  it('rejects unknown providers and missing runners', async () => {
    const dir = tempDir();
    createChatSession(dir, {
      id: 'orch-2',
      workspaceRoot: dir,
      kind: SESSION_KIND_ORCHESTRATED,
      workflowId: 'plan-execute',
    });

    const noRunner = createEscalateTools({
      dataDir: dir,
      sessionKey: 'kusa:orch-2',
      workspaceRoot: dir,
    });
    const missing = await noRunner.escalate({
      provider: 'kusa',
      action: 'do the thing',
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'ENOENT');

    const bad = createEscalateTools({
      dataDir: dir,
      sessionKey: 'kusa:orch-2',
      workspaceRoot: dir,
      runTurn: async () => ({ ok: true, text: 'nope' }),
    });
    const unknown = await bad.escalate({
      provider: 'not-a-provider',
      action: 'do the thing',
    });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, 'EINVAL');
    assert.match(unknown.error, /Unknown provider/);
  });

  it('wires through trail-aware tools only for orchestrated sessions', async () => {
    const dir = tempDir();
    createChatSession(dir, { id: 'std', workspaceRoot: dir });
    createChatSession(dir, {
      id: 'orch',
      workspaceRoot: dir,
      kind: SESSION_KIND_ORCHESTRATED,
      workflowId: 'plan-execute',
    });

    const stdTools = createTrailAwareTools(dir, {
      dataDir: dir,
      sessionKey: 'kusa:std',
      onAsk: () => ({ optionIndex: 0 }),
      onEscalateTurn: async () => ({ ok: true, text: 'x' }),
    });
    assert.equal(stdTools.defs.some((d) => d.name === 'kusa_escalate'), false);
    const stdCall = await stdTools.call('kusa_escalate', {
      action: 'blocked step',
    });
    assert.equal(stdCall.ok, false);
    assert.equal(stdCall.code, 'EORCH');

    const orchTools = createTrailAwareTools(dir, {
      dataDir: dir,
      sessionKey: 'kusa:orch',
      // Ask channel picks the first listed provider (ranked preference / id order).
      onAsk: (ask) => {
        const options = Array.isArray(ask?.options) ? ask.options : [];
        const idx = options.findIndex(
          (o) => String(o?.detail || '').toLowerCase() === 'kusa',
        );
        return { optionIndex: idx >= 0 ? idx : 0 };
      },
      onEscalateTurn: async () => ({
        ok: true,
        type: 'done',
        text: 'unblocked',
        turnId: 't1',
      }),
    });
    assert.ok(orchTools.defs.some((d) => d.name === 'kusa_escalate'));
    const orchCall = await orchTools.call('kusa_escalate', {
      action: 'blocked step',
      provider: 'kusa',
    });
    assert.equal(orchCall.ok, true);
    assert.equal(orchCall.text, 'unblocked');
  });

  it('is ask-gated (no timer): lists providers and refuses without a channel', async () => {
    assert.equal(APPROVAL_GATED_TOOLS.has('kusa_escalate'), false);
    const options = escalateProviderOptions({ preferredId: 'kusa' });
    assert.ok(options.some((o) => o.detail === 'kusa'));
    assert.equal(options[options.length - 1].label, ESCALATE_CANCEL_LABEL);

    const dir = tempDir();
    createChatSession(dir, {
      id: 'orch-gate',
      workspaceRoot: dir,
      kind: SESSION_KIND_ORCHESTRATED,
      workflowId: 'plan-execute',
    });
    let ran = 0;
    const tools = createEscalateTools({
      dataDir: dir,
      sessionKey: 'kusa:orch-gate',
      workspaceRoot: dir,
      runTurn: async () => {
        ran += 1;
        return { ok: true, text: 'should not run' };
      },
    });
    const denied = await tools.call('kusa_escalate', {
      action: 'handoff a blocked write',
      reason: 'need cursor',
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.unanswered, true);
    assert.match(denied.error, /interactive ask channel/i);
    assert.equal(ran, 0);

    const addon = escalateSystemPromptAddon({ dataDir: dir, sessionKey: 'kusa:orch-gate' });
    assert.match(addon, /asks the user/i);
    assert.doesNotMatch(addon, /approval-gated/i);
  });

  it('is ask-gated: provider pick runs one turn; cancel refuses', async () => {
    const dir = tempDir();
    createChatSession(dir, {
      id: 'orch-allow',
      workspaceRoot: dir,
      kind: SESSION_KIND_ORCHESTRATED,
      workflowId: 'plan-execute',
    });
    const asks = [];
    const tools = createEscalateTools({
      dataDir: dir,
      sessionKey: 'kusa:orch-allow',
      workspaceRoot: dir,
      ask: async (prompt, callId) => {
        asks.push({ prompt, callId });
        return askPick({ providerId: 'kusa' })(prompt);
      },
      runTurn: async () => ({ ok: true, type: 'done', text: 'allowed handoff', turnId: 't-allow' }),
    });
    const allowed = await tools.call('kusa_escalate', {
      action: 'finish the blocked step',
    });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.text, 'allowed handoff');
    assert.equal(asks.length, 1);
    assert.equal(asks[0].prompt.allowFreeText, false);
    assert.ok(asks[0].prompt.options.some((o) => o.label === ESCALATE_CANCEL_LABEL));

    // A second escalate prompts another ask — nothing sticky from the first pick.
    const tools2 = createEscalateTools({
      dataDir: dir,
      sessionKey: 'kusa:orch-allow',
      workspaceRoot: dir,
      ask: askPick({ cancel: true }),
      runTurn: async () => ({ ok: true, text: 'should not run' }),
    });
    const cancelled = await tools2.call('kusa_escalate', {
      action: 'try again',
    });
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.cancelled, true);
    assert.match(cancelled.error, /cancelled/i);

    const mapped = providerFromEscalateAsk({
      ok: true,
      selected: { label: ESCALATE_CANCEL_LABEL },
      answer: ESCALATE_CANCEL_LABEL,
    });
    assert.equal(mapped.cancelled, true);
  });

  it('nests under the escalating Subagent folder like assign delegation', async () => {
    const dir = tempDir();
    createChatSession(dir, {
      id: 'orch-nest',
      workspaceRoot: dir,
      kind: SESSION_KIND_ORCHESTRATED,
      workflowId: 'plan-execute',
    });
    const executor = createSubagent(dir, {
      parentId: 'orch-nest',
      workspaceRoot: dir,
      provider: 'kusa',
      role: 'executor',
      workflowId: 'plan-execute',
      mode: 'agent',
    });
    assert.ok(
      existsSync(join(dir, 'agents', 'orch-nest', SUBAGENTS_DIR, executor.id, 'chat.json')),
      'executor should live under the orchestrator subagents folder',
    );

    const tools = createEscalateTools({
      dataDir: dir,
      sessionKey: executor.key,
      workspaceRoot: dir,
      runTurn: async (opts) => {
        assert.equal(opts.parentId, executor.id);
        assert.equal(opts.role, 'escalation');
        return { ok: true, type: 'done', text: 'unblocked by cursor', turnId: 'esc-nest' };
      },
    });
    const result = await tools.escalate({
      provider: 'kusa',
      action: 'finish the blocked write',
      reason: 'executor cannot write from orchestrated mode',
    });
    assert.equal(result.ok, true);
    assert.equal(result.subagent?.parentId, executor.id);
    assert.equal(result.subagent?.role, 'escalation');

    const nestedPath = join(
      dir,
      'agents',
      'orch-nest',
      SUBAGENTS_DIR,
      executor.id,
      SUBAGENTS_DIR,
      result.subagent.id,
      'chat.json',
    );
    assert.ok(existsSync(nestedPath), `escalation should nest under executor: ${nestedPath}`);
    assert.equal(
      existsSync(join(dir, 'agents', result.subagent.id, 'chat.json')),
      false,
      'must not create a detached top-level twin',
    );

    const found = findNestedSubagentFiles(dir, result.subagent.id);
    assert.equal(found?.parentId, executor.id);
    assert.ok(found?.dir?.includes(`${SUBAGENTS_DIR}/${executor.id}/${SUBAGENTS_DIR}/`));

    const executorCfg = readSessionConfig(dir, executor.id, executor.harness, 'orch-nest');
    assert.ok((executorCfg?.subagents || []).some((row) => row?.id === result.subagent.id));

    const listed = listChatSessions(dir).find((s) => s.id === result.subagent.id);
    assert.equal(listed?.parentId || listed?.options?.parentId, executor.id);
    assert.equal(listed?.role || listed?.options?.role, 'escalation');
  });

  it('surfaces escalated turn failures without inventing a child on bad args', async () => {
    const dir = tempDir();
    createChatSession(dir, {
      id: 'orch-3',
      workspaceRoot: dir,
      kind: SESSION_KIND_ORCHESTRATED,
      workflowId: 'plan-execute',
    });
    const before = listChatSessions(dir).length;
    const tools = createEscalateTools({
      dataDir: dir,
      sessionKey: 'kusa:orch-3',
      workspaceRoot: dir,
      runTurn: async () => {
        throw new Error('provider blew up');
      },
    });
    const result = await tools.escalate({
      provider: 'kusa',
      action: 'try anyway',
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /provider blew up/);
    assert.equal(result.subagent?.role, 'escalation');
    // Child session is still created so the failed attempt is visible in the nest.
    assert.equal(listChatSessions(dir).length, before + 1);
  });
});
