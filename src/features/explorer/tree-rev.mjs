/**
 * Cheap workspace-tree generation for the sidebar Explorer.
 *
 * Bumped only on *structural* changes (create / delete), not on overwrites of
 * existing files — those leave the tree shape alone. The console polls
 * GET /files/rev and soft-refetches when this moves.
 */

let rev = 1;
let at = Date.now();

/** @returns {{ rev: number, at: number }} */
export function getWorkspaceTreeRev() {
  return { rev, at };
}

/**
 * @param {string} [reason]
 * @returns {{ rev: number, at: number }}
 */
export function bumpWorkspaceTreeRev(reason = 'change') {
  rev += 1;
  at = Date.now();
  void reason;
  return { rev, at };
}

/** Test helper — reset between cases. */
export function resetWorkspaceTreeRev(value = 1) {
  rev = Math.max(1, Number(value) || 1);
  at = Date.now();
  return { rev, at };
}
