/**
 * Cursor Agent headless turn — `agent -p --output-format stream-json
 * --stream-partial-output` mapped into SessionChat harness events
 * (thinking / tool_start / tool_result / content / done).
 */
import { accessSync, constants as fsConstants, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readChatSession, writeSessionConfig } from '#features/chat/data/chat-store.mjs';
import { runNdjsonCli } from '#features/chat/data/cli-ndjson-stream.mjs';
import { looksLikeCliTlsCertError } from '#features/chat/data/cli-agent-env.mjs';
import { laneFiles } from '#features/monitor/lib.mjs';
import { looksLikeCursorTrustRequired } from './cli-trust.mjs';
import { resolveCursorCliModel } from './models.mjs';
import {
  applyCursorStreamEvent,
  emptyCursorStreamState,
} from './stream-map.mjs';

/**
 * Cursor IDE hooks re-list the CLI conversation_id as an external Agents row.
 * Stamp that lane as a shadow of the Kusă-owned session as soon as we learn it.
 */
function markCursorCliShadowLane(dataDir, cliSessionId, ownerSessionId) {
  const id = String(cliSessionId || '').trim();
  const owner = String(ownerSessionId || '').trim();
  if (!dataDir || !id || id === owner) return;
  try {
    const files = laneFiles(dataDir, { harness: 'cursor', id });
    if (!existsSync(files.json)) return;
    const raw = JSON.parse(readFileSync(files.json, 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    if (raw.cliShadow === true && raw.cliShadowOf === owner) return;
    raw.cliShadow = true;
    if (owner) raw.cliShadowOf = owner;
    writeFileSync(files.json, `${JSON.stringify(raw, null, 2)}\n`);
  } catch { /* best-effort — listing still filters by resume id / prompt */ }
}

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
  const requestedModel = String(modelOverride || opts.model || '').trim();
  // Drop foreign / stale ids (e.g. Kusă endpoint model after workflow edit).
  const resolved = resolveCursorCliModel(requestedModel);
  const model = resolved.model;
  const parentId = String(opts.parentId || session?.parentId || '').trim() || null;
  if (resolved.fallback && dataDir && sessionId) {
    try {
      // Clear the bad stamp so the next resume does not keep asking Cursor for
      // a model it cannot run; empty → provider auto on the next turn too.
      writeSessionConfig(dataDir, sessionId, {
        provider: 'cursor',
        kind: session?.kind || opts.kind || 'standard',
        model: '',
      }, harness, parentId);
    } catch { /* best-effort */ }
  }

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

  let persistedCliId = String(opts.cursorCliSessionId || opts.cliSessionId || '').trim();
  const persistCliLink = (resolvedModel = '') => {
    if (!dataDir || !sessionId) return;
    const cliId = String(state.cliSessionId || '').trim();
    const modelOut = String(resolvedModel || '').trim();
    if (!cliId && !modelOut) return;
    if (cliId && cliId === persistedCliId && !modelOut) return;
    try {
      writeSessionConfig(dataDir, sessionId, {
        provider: 'cursor',
        kind: session?.kind || opts.kind || 'standard',
        ...(modelOut ? { model: modelOut } : {}),
        ...(cliId
          ? {
            cursorCliSessionId: cliId,
            cliSessionId: cliId,
          }
          : {}),
      }, harness, parentId);
      if (cliId) {
        persistedCliId = cliId;
        markCursorCliShadowLane(dataDir, cliId, sessionId);
      }
    } catch { /* best-effort */ }
  };

  const { code, stderr } = await runNdjsonCli({
    command: binary,
    args,
    cwd: workspaceRoot || process.cwd(),
    signal,
    onJson: (ev) => {
      applyCursorStreamEvent(state, ev, emit);
      // Persist on system/init so Agents can suppress the hook twin mid-turn.
      if (state.cliSessionId && state.cliSessionId !== persistedCliId) {
        persistCliLink();
      }
    },
  });

  const resolvedModel = String(state.model || model || '').trim();
  persistCliLink(resolvedModel);

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
  return {
    text,
    cliSessionId: state.cliSessionId,
    backend: 'cursor-cli',
    ...(resolvedModel ? { model: resolvedModel } : {}),
  };
}
