/**
 * Cursor Adapter — built-in Kusă extension.
 *
 * Owns Cursor Agent CLI streaming turns, model catalog (`--list-models`),
 * workspace-trust probe/grant, IDE composer titles, and `/adapters/cursor/*`.
 *
 * `runTurn` is loaded lazily so registering this adapter does not create an
 * import cycle through chat-store → load-builtin-adapters → here.
 */
import { applyCursorComposerTitles } from './composer-titles.mjs';
import {
  probeCursorWorkspaceTrust,
  trustCursorWorkspace,
} from './cli-trust.mjs';
import { listCursorModels } from './models.mjs';

export const ADAPTER_ID = 'cursor';
export const ADAPTER_NAME = 'Cursor Adapter';

/**
 * @param {typeof import('#features/chat/data/providers.mjs').registerChatProvider} register
 */
export function register(register) {
  register({
    id: 'cursor',
    label: 'Cursor',
    harness: 'cursor',
    caoProvider: 'cursor_cli',
    turnBackend: 'cao',
    standard: true,
    /** Cursor UI hook sessions are observe-only in Kusă. */
    externalOwned: true,
    /** Composer shows Cursor's own model list (not BYOK endpoints). */
    ownsModels: true,
    aliases: ['cursor_cli'],
    async runTurn(opts) {
      const { runCursorStreamTurn } = await import('./stream-turn.mjs');
      return runCursorStreamTurn(opts);
    },
    enrichSessions: applyCursorComposerTitles,
    workspaceTrust: {
      path: '/adapters/cursor/trust',
      label: 'Trust workspace',
      title: 'Cursor workspace trust required',
      summary:
        'CAO cannot start Cursor Agent in this repo until the workspace is trusted once. Click the button to run agent -p --trust (same as accepting the trust dialog).',
      probe: probeCursorWorkspaceTrust,
      grant: trustCursorWorkspace,
    },
    models: {
      path: '/adapters/cursor/models',
      list: listCursorModels,
    },
    mapCaoInitError(err) {
      const raw = String(err?.message || err || '');
      if (!/initialization timed out|Cursor CLI/i.test(raw)) return null;
      const hint = new Error(
        [
          'Cursor CLI did not become ready in CAO (workspace trust is usually blocking).',
          'Use Trust workspace on this session screen (runs `agent -p --trust`), then send again.',
        ].join(' '),
      );
      hint.code = 'ECAO_TRUST';
      hint.cause = err;
      return hint;
    },
    async handleHttp({ action, method, workspaceRoot }) {
      if (action === 'models') {
        if (method !== 'GET' && method !== 'HEAD') {
          return { status: 405, body: { error: 'method not allowed' } };
        }
        const listed = listCursorModels();
        return {
          status: listed.ok ? 200 : (listed.installed ? 502 : 503),
          body: {
            ok: listed.ok,
            installed: listed.installed,
            default: listed.default,
            error: listed.error,
            groups: [{
              name: 'Cursor',
              endpointId: '',
              models: listed.models.map((m) => ({
                id: m.id,
                label: m.label,
                contextTokens: m.contextTokens,
                vision: null,
              })),
            }],
            models: listed.models.map((m) => ({
              id: m.id,
              label: m.label,
              contextTokens: m.contextTokens,
              vision: null,
            })),
          },
        };
      }
      if (action !== 'trust') return null;
      if (method === 'GET' || method === 'HEAD') {
        return {
          status: 200,
          body: await probeCursorWorkspaceTrust({ cwd: workspaceRoot }),
        };
      }
      if (method === 'POST') {
        const result = await trustCursorWorkspace({ cwd: workspaceRoot });
        return { status: result.ok ? 200 : 503, body: result };
      }
      return { status: 405, body: { error: 'method not allowed' } };
    },
  });
}

export {
  applyCursorComposerTitles,
  listCursorModels,
  probeCursorWorkspaceTrust,
  trustCursorWorkspace,
};
