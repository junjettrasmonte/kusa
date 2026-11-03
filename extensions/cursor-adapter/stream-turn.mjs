/**
 * Cursor Agent headless turn — `agent -p --output-format stream-json
 * --stream-partial-output` mapped into SessionChat harness events
 * (thinking / tool_start / tool_result / content / done).
 */
import { accessSync, constants as fsConstants } from 'node:fs';
import { readChatSession, writeSessionConfig } from '#features/chat/data/chat-store.mjs';
import { runNdjsonCli } from '#features/chat/data/cli-ndjson-stream.mjs';
import { looksLikeCliTlsCertError } from '#features/chat/data/cli-agent-env.mjs';
import { looksLikeCursorTrustRequired } from './cli-trust.mjs';
import {
  applyCursorStreamEvent,
  emptyCursorStreamState,
} from './stream-map.mjs';

function resolveCursorBinary() {
  const names = ['cursor-agent', 'agent'];
  const pathDirs = String(process.env.PATH || '').split(':').filter(Boolean);
  for (const name of names) {
    for (const dir of pathDirs) {
      const full = `${dir.replace(/\/+$/, '')}/${name}`;
      try {
        accessSync(full, fsConstants.X_OK);
        return name;
      } catch {
        /* next */
      }
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
export async function runCursorStreamTurn({
  dataDir,
  sessionId,
  harness = 'cursor',
  workspaceRoot,
  prompt,
  model: modelOverride = '',
  signal,
  onEvent,
} = {}) {
  const binary = resolveCursorBinary();
  if (!binary) {
    const err = new Error('Cursor Agent CLI not found (install from https://cursor.com/cli)');
    err.code = 'ENOENT';
    throw err;
  }

  const session = readChatSession(dataDir, sessionId, harness);
  const opts = session?.options || {};
  const state = emptyCursorStreamState(
    String(opts.cursorCliSessionId || opts.cliSessionId || '').trim(),
  );
  const model = String(modelOverride || opts.model || '').trim();

  const args = [
    '-p',
    '--force',
    '--trust',
    '--output-format', 'stream-json',
    '--stream-partial-output',
  ];
  if (model && model.toLowerCase() !== 'auto') {
    args.push('--model', model);
  }
  if (state.cliSessionId) args.push('--resume', state.cliSessionId);
  args.push(String(prompt || ''));

  const emit = (ev) => { onEvent?.(ev); };

  const { code, stderr } = await runNdjsonCli({
    command: binary,
    args,
    cwd: workspaceRoot || process.cwd(),
    signal,
    onJson: (ev) => applyCursorStreamEvent(state, ev, emit),
  });

  if (state.cliSessionId || model) {
    try {
      writeSessionConfig(dataDir, sessionId, {
        provider: 'cursor',
        kind: session?.kind || opts.kind || 'standard',
        ...(model ? { model } : {}),
        ...(state.cliSessionId
          ? {
            cursorCliSessionId: state.cliSessionId,
            cliSessionId: state.cliSessionId,
          }
          : {}),
      }, harness);
    } catch { /* best-effort */ }
  }

  if (signal?.aborted) {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  }

  if (looksLikeCursorTrustRequired(stderr) || looksLikeCursorTrustRequired(state.content)) {
    const err = new Error(
      'Cursor CLI requires workspace trust. Use Trust workspace on this session screen, then send again.',
    );
    err.code = 'ECAO_TRUST';
    throw err;
  }

  const tlsBlob = `${stderr}\n${state.content}\n${state.sawResultText}\n${state.turnError?.message || ''}`;
  if (looksLikeCliTlsCertError(tlsBlob)) {
    const err = new Error(
      'Cursor Agent TLS failed (unable to get local issuer certificate). Usually HTTP_PROXY MITM — kusa strips proxy for Cursor spawns; if this persists, unset HTTP_PROXY for this shell or install your corporate CA into the system trust store.',
    );
    err.code = 'ECURSOR_TLS';
    throw err;
  }

  if (state.turnError && !state.content.trim() && !state.sawResultText.trim()) {
    throw state.turnError;
  }

  if (code && code !== 0 && !state.content.trim() && !state.sawResultText.trim()) {
    const err = new Error(stderr || `Cursor Agent exited with code ${code}`);
    err.code = 'ECURSOR';
    throw err;
  }

  const text = state.content.trim() || state.sawResultText.trim() || '(empty response)';
  emit({ type: 'content', text, delta: '' });
  emit({ type: 'done', text });
  return { text, cliSessionId: state.cliSessionId, backend: 'cursor-cli' };
}
