/**
 * GitHub Copilot Adapter — built-in Kusă extension.
 *
 * Owns Copilot CLI streaming turns (`copilot -p --output-format json --stream on`)
 * mapped into SessionChat harness events. Same registration shape as the
 * Cursor Adapter so core stays provider-agnostic.
 *
 * `runTurn` is loaded lazily to avoid an import cycle through chat-store.
 */
export const ADAPTER_ID = 'copilot';
export const ADAPTER_NAME = 'GitHub Copilot Adapter';

/**
 * @param {typeof import('#features/chat/data/providers.mjs').registerChatProvider} register
 */
export function register(register) {
  register({
    id: 'copilot',
    label: 'Copilot',
    harness: 'github-copilot',
    caoProvider: 'copilot_cli',
    turnBackend: 'cao',
    standard: true,
    /** Copilot IDE chats are not mirrored as observe-only lanes today. */
    externalOwned: false,
    aliases: ['github-copilot', 'github_copilot', 'copilot_cli'],
    async runTurn(opts) {
      const { runCopilotStreamTurn } = await import('./stream-turn.mjs');
      return runCopilotStreamTurn(opts);
    },
    async handleHttp() {
      return null;
    },
  });
}
