/**
 * Load built-in provider adapter extensions (Cursor, GitHub Copilot, …).
 * Side-effect import — idempotent via the adapters' own guards + registry replace.
 */
import { register as registerCursorAdapter } from '#extensions/cursor-adapter/index.mjs';
import { register as registerCopilotAdapter } from '#extensions/github-copilot-adapter/index.mjs';
import {
  registerChatProvider,
  refreshChatHarnesses,
  refreshStandardProviderIds,
} from './providers.mjs';

let loaded = false;

export function loadBuiltinProviderAdapters() {
  if (loaded) return;
  loaded = true;
  registerCursorAdapter(registerChatProvider);
  registerCopilotAdapter(registerChatProvider);
  refreshChatHarnesses();
  refreshStandardProviderIds();
}

// Auto-load when this module is imported (chat-store / serve / tests).
loadBuiltinProviderAdapters();
