/**
 * Session cache for the sidebar Explorer tree.
 *
 * Survives view remounts (Agents ↔ Explorer). Manual refresh and structural
 * /files/rev changes mark the snapshot stale and trigger a soft refetch while
 * the panel is mounted.
 */

/** @typedef {{
 *   payload: object,
 *   loaded: Record<string, unknown>,
 *   rev: number | null,
 *   fetchedAt: number,
 *   stale?: boolean,
 * }} ExplorerCacheSnapshot */

/** @type {ExplorerCacheSnapshot | null} */
let snapshot = null;

/** @type {Set<(event: { type: string, reason?: string }) => void>} */
const listeners = new Set();

function notify(event) {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      /* subscriber errors must not break the bus */
    }
  }
}

/** @returns {ExplorerCacheSnapshot | null} */
export function getExplorerCache() {
  return snapshot;
}

/**
 * Replace the cached tree (successful fetch).
 * @param {{ payload: object, loaded?: Record<string, unknown>, rev?: number | null }} next
 */
export function setExplorerCache(next) {
  if (!next?.payload) return;
  snapshot = {
    payload: next.payload,
    loaded: next.loaded && typeof next.loaded === 'object' ? { ...next.loaded } : {},
    rev: Number.isFinite(next.rev) ? Number(next.rev) : snapshot?.rev ?? null,
    fetchedAt: Date.now(),
    stale: false,
  };
  notify({ type: 'set' });
}

/**
 * Update only the lazy-folder map without touching the root payload.
 * @param {Record<string, unknown>} loaded
 */
export function setExplorerLoadedCache(loaded) {
  if (!snapshot) return;
  snapshot = {
    ...snapshot,
    loaded: loaded && typeof loaded === 'object' ? { ...loaded } : {},
  };
  notify({ type: 'loaded' });
}

/**
 * Mark cache stale (or clear) and wake subscribers so a mounted Explorer
 * soft-refetches. Pass `{ clear: true }` from the manual refresh button.
 * @param {string} [reason]
 * @param {{ clear?: boolean }} [opts]
 */
export function invalidateExplorerCache(reason = 'invalidate', opts = {}) {
  if (opts.clear) {
    snapshot = null;
  } else if (snapshot) {
    snapshot = { ...snapshot, stale: true };
  }
  notify({ type: 'invalidate', reason });
}

/**
 * @param {(event: { type: string, reason?: string }) => void} fn
 * @returns {() => void}
 */
export function subscribeExplorerCache(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Test helper. */
export function resetExplorerCache() {
  snapshot = null;
  listeners.clear();
}
