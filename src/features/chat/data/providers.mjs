/**
 * Chat provider registry — Kusă core only ships the first-party BYOK provider.
 * External CLIs (Cursor, GitHub Copilot, …) register via built-in adapter
 * extensions under `extensions/*-adapter/`.
 *
 * Standard sessions for registered adapters stream via each CLI's headless
 * JSON output; orchestrated multi-agent work still uses CAO when
 * `caoProvider` is set.
 */

export const SESSION_KIND_STANDARD = 'standard';
export const SESSION_KIND_ORCHESTRATED = 'orchestrated';

/**
 * @typedef {object} ChatProviderMeta
 * @property {string} id
 * @property {string} label
 * @property {string} harness
 * @property {string | null} [caoProvider]
 * @property {'byok' | 'cao'} turnBackend
 * @property {boolean} [standard]  — listed under Agents › New › Standard
 * @property {boolean} [externalOwned] — IDE-hooked chats are observe-only
 * @property {string[]} [aliases]
 * @property {(opts: object) => Promise<object>} [runTurn]
 * @property {(sessions: object[]) => void} [enrichSessions]
 * @property {(err: Error, ctx: { caoProvider?: string | null }) => Error | null | undefined} [mapCaoInitError]
 * @property {{
 *   path: string,
 *   label?: string,
 *   title?: string,
 *   summary?: string,
 *   probe?: (opts: { cwd?: string }) => Promise<object>,
 *   grant?: (opts: { cwd?: string }) => Promise<object>,
 * }} [workspaceTrust]
 * @property {(req: {
 *   action: string,
 *   method: string,
 *   workspaceRoot: string,
 * }) => Promise<{ status: number, body: object } | null> | { status: number, body: object } | null} [handleHttp]
 */

/** @type {Map<string, ChatProviderMeta>} */
const PROVIDERS = new Map();
/** @type {Map<string, string>} alias / harness / cao id → provider id */
const ALIASES = new Map();

function indexProvider(meta) {
  PROVIDERS.set(meta.id, meta);
  ALIASES.set(meta.id, meta.id);
  ALIASES.set(meta.harness, meta.id);
  if (meta.caoProvider) ALIASES.set(String(meta.caoProvider).toLowerCase(), meta.id);
  for (const alias of meta.aliases || []) {
    ALIASES.set(String(alias).toLowerCase(), meta.id);
  }
}

/** First-party Kusă agent — always present. */
const KUSA_PROVIDER = Object.freeze({
  id: 'kusa',
  label: 'Kusă',
  harness: 'kusa',
  // Optional CAO mirror id (Dev Tools › Agent Profiles sync / cao launch).
  caoProvider: 'kusa_cli',
  turnBackend: 'byok',
  standard: true,
  externalOwned: false,
  aliases: ['kusa_cli'],
});

indexProvider(KUSA_PROVIDER);

/**
 * Register (or replace) a chat provider contributed by an adapter extension.
 * @param {ChatProviderMeta} meta
 */
export function registerChatProvider(meta) {
  if (!meta || typeof meta !== 'object') {
    throw new Error('registerChatProvider: meta object required');
  }
  const id = String(meta.id || '').trim().toLowerCase();
  const harness = String(meta.harness || '').trim();
  if (!id || !harness) {
    throw new Error('registerChatProvider: id and harness are required');
  }
  if (id === 'kusa') {
    throw new Error('registerChatProvider: cannot replace the built-in kusa provider');
  }
  const entry = {
    ...meta,
    id,
    harness,
    label: String(meta.label || id),
    caoProvider: meta.caoProvider ? String(meta.caoProvider) : null,
    turnBackend: meta.turnBackend === 'byok' ? 'byok' : 'cao',
    standard: meta.standard !== false,
    externalOwned: Boolean(meta.externalOwned),
    aliases: Array.isArray(meta.aliases)
      ? meta.aliases.map((a) => String(a).toLowerCase())
      : [],
  };
  indexProvider(entry);
  return entry;
}

/** Snapshot of registered providers (kusa + adapters). */
export function listChatProviders() {
  return [...PROVIDERS.values()];
}

export function getChatProvidersRecord() {
  return Object.fromEntries(PROVIDERS);
}

/** @deprecated Prefer listChatProviders / resolveChatProvider — kept for callers. */
export const CHAT_PROVIDERS = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === 'kusa') return KUSA_PROVIDER;
      if (typeof prop === 'string') return PROVIDERS.get(prop) || undefined;
      return undefined;
    },
    has(_t, prop) {
      return typeof prop === 'string' && PROVIDERS.has(prop);
    },
    ownKeys() {
      return [...PROVIDERS.keys()];
    },
    getOwnPropertyDescriptor(_t, prop) {
      if (typeof prop === 'string' && PROVIDERS.has(prop)) {
        return { configurable: true, enumerable: true, value: PROVIDERS.get(prop) };
      }
      return undefined;
    },
  },
);

/** Provider ids shown under Standard Agent in the Agents + menu. */
export function standardProviderIds() {
  return listChatProviders().filter((p) => p.standard).map((p) => p.id);
}

/** @deprecated use standardProviderIds() — frozen snapshot after adapters load. */
export let STANDARD_PROVIDER_IDS = Object.freeze(['kusa']);

export function refreshStandardProviderIds() {
  STANDARD_PROVIDER_IDS = Object.freeze(standardProviderIds());
  return STANDARD_PROVIDER_IDS;
}

/** Harness folders that may hold chat session sidecars. */
export function chatHarnesses() {
  return [...new Set(listChatProviders().map((p) => p.harness))];
}

/** @deprecated use chatHarnesses() */
export let CHAT_HARNESSES = Object.freeze(['kusa']);

export function refreshChatHarnesses() {
  CHAT_HARNESSES = Object.freeze(chatHarnesses());
  return CHAT_HARNESSES;
}

export function resolveChatProvider(id) {
  const key = String(id || '').trim().toLowerCase();
  if (!key) return null;
  if (PROVIDERS.has(key)) return PROVIDERS.get(key);
  const aliased = ALIASES.get(key);
  if (aliased && PROVIDERS.has(aliased)) return PROVIDERS.get(aliased);
  return null;
}

export function harnessForProvider(providerId) {
  return resolveChatProvider(providerId)?.harness || 'kusa';
}

export function providerForHarness(harness) {
  return resolveChatProvider(harness)?.id || 'kusa';
}

export function isCaoChatProvider(providerId) {
  return resolveChatProvider(providerId)?.turnBackend === 'cao';
}

/**
 * Harnesses whose IDE-hooked chats are owned outside Kusă.
 * Kusă can observe them, but must not mix prompting into the same session.
 */
export function isExternalOwnedHarness(harness) {
  const meta = resolveChatProvider(harness);
  if (meta) return Boolean(meta.externalOwned);
  return false;
}

/**
 * True when this chat is owned by an external IDE and Kusă must keep the
 * composer read-only. Kusă-created CLI sessions set `external: false`
 * explicitly when created.
 */
export function isExternalChatSession(session) {
  if (!session || typeof session !== 'object') return false;
  // Kusă-spawned Subagents (including Cursor planners) are always promptable here.
  if (session.parentId || session.options?.parentId) return false;
  if (session.external === true) return true;
  if (session.external === false) return false;
  // Monitor-only IDE rows (no chat ownership record yet).
  const harness = session.harness
    || (typeof session.key === 'string' && session.key.includes(':')
      ? session.key.slice(0, session.key.indexOf(':'))
      : '');
  if (!isExternalOwnedHarness(harness)) return false;
  if (session.provider || Array.isArray(session.messages)) return false;
  return true;
}

/** Run every registered adapter's session enricher (titles, etc.). */
export function enrichChatSessions(sessions) {
  if (!Array.isArray(sessions) || !sessions.length) return sessions;
  for (const meta of PROVIDERS.values()) {
    try {
      meta.enrichSessions?.(sessions);
    } catch {
      /* best-effort */
    }
  }
  return sessions;
}

/**
 * Dispatch `/adapters/<providerId>/<action>` to the owning adapter.
 * @returns {Promise<{ status: number, body: object } | null>}
 */
export async function dispatchAdapterHttp({ providerId, action, method, workspaceRoot }) {
  const meta = resolveChatProvider(providerId);
  if (!meta?.handleHttp) return null;
  return meta.handleHttp({
    action: String(action || ''),
    method: String(method || 'GET').toUpperCase(),
    workspaceRoot,
  });
}

export function normalizeSessionKind(raw) {
  const kind = String(raw || '').trim().toLowerCase();
  if (kind === SESSION_KIND_ORCHESTRATED) return SESSION_KIND_ORCHESTRATED;
  return SESSION_KIND_STANDARD;
}
