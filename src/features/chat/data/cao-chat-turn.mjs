/**
 * External / CAO-backed chat turns.
 *
 * Providers registered by adapter extensions (Cursor, Copilot, …) may supply
 * `runTurn` for headless CLI JSON streams. Orchestrated / other CAO providers
 * still use an interactive terminal paste + output poll.
 */
import {
  createCaoSession,
  getCaoTerminal,
  getCaoTerminalOutput,
  sendCaoTerminalInput,
} from '#features/cao/index.mjs';
import { resolveChatProvider } from './providers.mjs';
import { readChatSession, writeSessionConfig } from './chat-store.mjs';
import './load-builtin-adapters.mjs';

const IDLE_STATUSES = new Set([
  'idle',
  'IDLE',
  'completed',
  'COMPLETED',
  'complete',
  'COMPLETE',
  'ready',
  'READY',
]);

const ERROR_STATUSES = new Set([
  'error',
  'ERROR',
  'failed',
  'FAILED',
]);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function terminalStatus(term) {
  return String(term?.status || term?.state || term?.terminal_status || '').trim();
}

function terminalOutputText(output) {
  if (!output) return '';
  if (typeof output === 'string') return output;
  if (typeof output.output === 'string') return output.output;
  if (typeof output.text === 'string') return output.text;
  if (typeof output.content === 'string') return output.content;
  if (Array.isArray(output.lines)) return output.lines.join('\n');
  return '';
}

function stripAnsi(text) {
  return String(text || '').replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Ensure the chat session has a live CAO terminal. Persists ids on session.json.
 * @returns {{ terminalId: string, sessionName: string }}
 */
export async function ensureCaoChatTerminal({
  dataDir,
  sessionId,
  harness,
  provider,
  workspaceRoot,
  signal,
} = {}) {
  const meta = resolveChatProvider(provider);
  if (!meta?.caoProvider) {
    const err = new Error(`provider ${provider} is not CAO-backed`);
    err.code = 'EINVAL';
    throw err;
  }
  const session = readChatSession(dataDir, sessionId, harness);
  const opts = session?.options || {};
  if (opts.caoTerminalId) {
    try {
      await getCaoTerminal(opts.caoTerminalId);
      return {
        terminalId: opts.caoTerminalId,
        sessionName: opts.caoSessionName || '',
      };
    } catch {
      /* recreate below */
    }
  }

  const sessionName = `kusa-${String(sessionId || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40)}`;
  let created;
  try {
    created = await createCaoSession({
      agentProfile: 'developer',
      provider: meta.caoProvider,
      sessionName,
      workingDirectory: workspaceRoot,
    });
  } catch (err) {
    const mapped = meta.mapCaoInitError?.(err, { caoProvider: meta.caoProvider });
    if (mapped) throw mapped;
    throw err;
  }
  if (signal?.aborted) {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    throw err;
  }
  const terminalId = String(
    created?.id
    || created?.terminal_id
    || created?.terminalId
    || '',
  ).trim();
  const caoSessionName = String(
    created?.session_name
    || created?.sessionName
    || sessionName,
  ).trim();
  if (!terminalId) {
    const err = new Error('CAO create session returned no terminal id — is cao-server running?');
    err.code = 'ECAO';
    throw err;
  }
  writeSessionConfig(dataDir, sessionId, {
    provider: meta.id,
    kind: session?.kind || opts.kind || 'standard',
    caoTerminalId: terminalId,
    caoSessionName,
  }, harness);
  return { terminalId, sessionName: caoSessionName };
}

/**
 * Run one CAO / adapter chat turn. Invokes onEvent with { type, text?, ... }.
 * Adapters with `runTurn` emit thinking + tool_* from their CLI JSON streams.
 */
export async function runCaoChatTurn({
  dataDir,
  sessionId,
  harness,
  provider,
  workspaceRoot,
  prompt,
  model = '',
  signal,
  onEvent,
  pollMs = 900,
  maxWaitMs = 15 * 60_000,
} = {}) {
  const meta = resolveChatProvider(provider);
  if (typeof meta?.runTurn === 'function') {
    return meta.runTurn({
      dataDir,
      sessionId,
      harness: harness || meta.harness,
      workspaceRoot,
      prompt,
      model,
      signal,
      onEvent,
    });
  }

  const { terminalId } = await ensureCaoChatTerminal({
    dataDir,
    sessionId,
    harness,
    provider,
    workspaceRoot,
    signal,
  });

  // Snapshot output before paste so we can report a delta as assistant text.
  let before = '';
  try {
    before = stripAnsi(terminalOutputText(await getCaoTerminalOutput(terminalId)));
  } catch {
    before = '';
  }

  const sent = await sendCaoTerminalInput(terminalId, prompt, {});
  const boundary = sent?.dispatch_boundary;

  const started = Date.now();
  let lastText = '';
  let sawBusy = false;

  while (true) {
    if (signal?.aborted) {
      const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
      throw err;
    }
    if (Date.now() - started > maxWaitMs) {
      const err = new Error('CAO turn timed out waiting for the terminal to go idle');
      err.code = 'ETIMEDOUT';
      throw err;
    }

    let term;
    try {
      term = await getCaoTerminal(terminalId);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      await sleep(pollMs, signal);
      continue;
    }

    const status = terminalStatus(term);
    const generation = term?.status_generation ?? term?.statusGeneration ?? null;
    if (status && !IDLE_STATUSES.has(status) && !ERROR_STATUSES.has(status)) {
      sawBusy = true;
    }

    let outputText = '';
    try {
      outputText = stripAnsi(terminalOutputText(await getCaoTerminalOutput(terminalId)));
    } catch {
      outputText = lastText;
    }

    // Prefer the suffix after the pre-paste snapshot; fall back to full buffer.
    let delta = outputText;
    if (before && outputText.startsWith(before)) {
      delta = outputText.slice(before.length);
    }
    delta = delta.trim();
    if (delta && delta !== lastText) {
      lastText = delta;
      onEvent?.({ type: 'content', text: lastText, delta: '' });
    }

    const pastBoundary = boundary == null
      || generation == null
      || Number(generation) > Number(boundary);

    if (ERROR_STATUSES.has(status) && pastBoundary) {
      const err = new Error(`CAO terminal error (${status})`);
      err.code = 'ECAO';
      throw err;
    }

    if (sawBusy && IDLE_STATUSES.has(status) && pastBoundary) {
      break;
    }
    // Provider finished so quickly we never observed PROCESSING — still settle
    // once idle after a short grace if we already have new output.
    if (!sawBusy && IDLE_STATUSES.has(status) && pastBoundary && lastText && Date.now() - started > 2_500) {
      break;
    }

    await sleep(pollMs, signal);
  }

  const text = lastText || '(no output captured from CAO terminal)';
  onEvent?.({ type: 'content', text, delta: '' });
  onEvent?.({ type: 'done', text });
  return { text, terminalId };
}
