/**
 * Detect lane.json files that are mistaken copies of `.kusa/agent-profiles/`
 * documents (a migration once treated that folder as a harness). Kept in a
 * tiny module so chat-store can import it without the monitor/lib cycle.
 */

/**
 * @param {object | null | undefined} raw
 * @returns {boolean}
 */
export function isMistakenAgentProfileLane(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return false;
  const looksLikeProfile = typeof raw.promptTemplate === 'string'
    || typeof raw.caoProvider === 'string'
    || (typeof raw.mode === 'string' && typeof raw.provider === 'string'
      && Object.hasOwn(raw, 'allowModeOverride'));
  if (!looksLikeProfile) return false;
  // Real monitor lanes always stamp a harness key / prompts / wall clock.
  if (typeof raw.key === 'string' && raw.key.includes(':')) return false;
  if (typeof raw.harness === 'string' && raw.harness.trim()) return false;
  if (Array.isArray(raw.prompts) && raw.prompts.length) return false;
  if (Number.isFinite(raw.startedAtWall) || Number.isFinite(raw.endedAtWall)) return false;
  return true;
}
