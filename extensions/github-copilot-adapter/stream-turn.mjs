/**
 * GitHub Copilot CLI headless turn — `copilot -p --output-format json --stream on`
 * JSONL mapped into SessionChat harness events
 * (thinking / tool_start / tool_result / content / done).
 */
import { accessSync, constants as fsConstants } from 'node:fs';
import { readChatSession, writeSessionConfig } from '#features/chat/data/chat-store.mjs';
import { runNdjsonCli } from '#features/chat/data/cli-ndjson-stream.mjs';
import {
  applyCopilotStreamEvent,
  emptyCopilotStreamState,
} from './stream-map.mjs';

function resolveCopilotBinary() {
  const pathDirs = String(process.env.PATH || '').split(':').filter(Boolean);
  for (const dir of pathDirs) {
    const full = `${dir.replace(/\/+$/, '')}/copilot`;
    try {
      accessSync(full, fsConstants.X_OK);
      return 'copilot';
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {string} opts.sessionId
 * @param {string} [opts.harness]
 * @param {string} opts.workspaceRoot
 * @param {string} opts.prompt
 * @param {AbortSignal} [opts.signal]
 * @param {(ev: object) => void} [opts.onEvent]
 */
export async function runCopilotStreamTurn({
  dataDir,
  sessionId,
  harness = 'github-copilot',
  workspaceRoot,
  prompt,
  signal,
  onEvent,
} = {}) {
  const binary = resolveCopilotBinary();
  if (!binary) {
    const err = new Error('GitHub Copilot CLI not found on PATH (`npm i -g @github/copilot`)');
    err.code = 'ENOENT';
    throw err;
  }

  const session = readChatSession(dataDir, sessionId, harness);
  const opts = session?.options || {};
  const state = emptyCopilotStreamState(
    String(opts.copilotCliSessionId || opts.cliSessionId || '').trim(),
  );

  const args = [
    '-p', String(prompt || ''),
    '--allow-all-tools',
    '--allow-all-paths',
    '--output-format', 'json',
    '--stream', 'on',
  ];
  if (workspaceRoot) args.push('-C', workspaceRoot);
  if (state.cliSessionId) args.push('--resume', state.cliSessionId);

  const emit = (ev) => { onEvent?.(ev); };

  const { code, stderr } = await runNdjsonCli({
    command: binary,
    args,
    cwd: workspaceRoot || process.cwd(),
    signal,
    onJson: (ev) => applyCopilotStreamEvent(state, ev, emit),
  });

  const resolvedModel = String(state.model || opts.model || '').trim();
  const parentId = String(opts.parentId || session?.parentId || '').trim() || null;
  if (state.cliSessionId || resolvedModel) {
    try {
      writeSessionConfig(dataDir, sessionId, {
        provider: 'copilot',
        kind: session?.kind || opts.kind || 'standard',
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(state.cliSessionId
          ? {
            copilotCliSessionId: state.cliSessionId,
            cliSessionId: state.cliSessionId,
          }
          : {}),
      }, harness, parentId);
    } catch { /* best-effort */ }
  }

  if (signal?.aborted) {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  }

  if (state.turnError && !state.content.trim()) throw state.turnError;

  if (code && code !== 0 && !state.content.trim()) {
    const err = new Error(stderr || `Copilot CLI exited with code ${code}`);
    err.code = 'ECOPILOT';
    throw err;
  }

  const text = state.content.trim() || '(empty response)';
  emit({ type: 'content', text, delta: '' });
  emit({ type: 'done', text });
  return {
    text,
    cliSessionId: state.cliSessionId,
    backend: 'copilot-cli',
    ...(resolvedModel ? { model: resolvedModel } : {}),
  };
}
