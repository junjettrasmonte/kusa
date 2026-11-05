/**
 * Visual identity for chat participants (especially orchestrated Subagents).
 *
 * Each known workflow role gets a stable Lucide icon + semi-transparent tint
 * so assistant turns read as distinct bubbles in a multi-agent transcript.
 * Unknown / custom roles hash into the same palette so they stay consistent
 * across a session without colliding on the seeded defaults.
 */

/** @typedef {{ icon: string, bubble: string, avatar: string, ink: string }} RoleVisual */

/** Seeded plan-execute roles — keep in sync with SEED_AGENT_PROFILES. */
const ROLE_VISUALS = Object.freeze({
  orchestrator: {
    icon: 'network',
    bubble: 'bg-violet-500/6 border border-violet-500/25',
    avatar: 'bg-violet-500/20 text-violet-300 ring-violet-500/35',
    ink: 'text-violet-300',
  },
  planner: {
    icon: 'clipboard-list',
    bubble: 'bg-sky-500/6 border border-sky-500/25',
    avatar: 'bg-sky-500/20 text-sky-300 ring-sky-500/35',
    ink: 'text-sky-300',
  },
  executor: {
    icon: 'hammer',
    bubble: 'bg-amber-500/6 border border-amber-500/25',
    avatar: 'bg-amber-500/20 text-amber-300 ring-amber-500/35',
    ink: 'text-amber-300',
  },
  tester: {
    icon: 'flask-conical',
    bubble: 'bg-cyan-500/6 border border-cyan-500/25',
    avatar: 'bg-cyan-500/20 text-cyan-300 ring-cyan-500/35',
    ink: 'text-cyan-300',
  },
  prototyper: {
    icon: 'blocks',
    bubble: 'bg-fuchsia-500/6 border border-fuchsia-500/25',
    avatar: 'bg-fuchsia-500/20 text-fuchsia-300 ring-fuchsia-500/35',
    ink: 'text-fuchsia-300',
  },
  reviewer: {
    icon: 'eye',
    bubble: 'bg-orange-500/6 border border-orange-500/25',
    avatar: 'bg-orange-500/20 text-orange-300 ring-orange-500/35',
    ink: 'text-orange-300',
  },
});

/** Fallback tints for custom / unnamed roles (cycled by hash). */
const FALLBACK_VISUALS = Object.freeze([
  {
    icon: 'bot-message-square',
    bubble: 'bg-indigo-500/6 border border-indigo-500/25',
    avatar: 'bg-indigo-500/20 text-indigo-300 ring-indigo-500/35',
    ink: 'text-indigo-300',
  },
  {
    icon: 'bot-message-square',
    bubble: 'bg-teal-500/6 border border-teal-500/25',
    avatar: 'bg-teal-500/20 text-teal-300 ring-teal-500/35',
    ink: 'text-teal-300',
  },
  {
    icon: 'bot-message-square',
    bubble: 'bg-rose-500/6 border border-rose-500/25',
    avatar: 'bg-rose-500/20 text-rose-300 ring-rose-500/35',
    ink: 'text-rose-300',
  },
  {
    icon: 'bot-message-square',
    bubble: 'bg-lime-500/6 border border-lime-500/25',
    avatar: 'bg-lime-500/20 text-lime-300 ring-lime-500/35',
    ink: 'text-lime-300',
  },
  {
    icon: 'bot-message-square',
    bubble: 'bg-pink-500/6 border border-pink-500/25',
    avatar: 'bg-pink-500/20 text-pink-300 ring-pink-500/35',
    ink: 'text-pink-300',
  },
  {
    icon: 'bot-message-square',
    bubble: 'bg-blue-500/6 border border-blue-500/25',
    avatar: 'bg-blue-500/20 text-blue-300 ring-blue-500/35',
    ink: 'text-blue-300',
  },
]);

const DEFAULT_VISUAL = Object.freeze({
  icon: 'bot-message-square',
  bubble: 'bg-gray-500/6 border border-gray-500/25',
  avatar: 'bg-gray-500/20 text-gray-300 ring-gray-500/35',
  ink: 'text-gray-300',
});

function normalizeRole(role) {
  return String(role || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function hashRole(role) {
  let h = 0;
  for (let i = 0; i < role.length; i += 1) {
    h = ((h << 5) - h) + role.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

/**
 * @param {string|null|undefined} role
 * @returns {RoleVisual}
 */
export function roleVisual(role) {
  const key = normalizeRole(role);
  if (!key) return DEFAULT_VISUAL;
  if (ROLE_VISUALS[key]) return ROLE_VISUALS[key];
  // Aliases used elsewhere in workflows.
  if (key === 'planning') return ROLE_VISUALS.planner;
  if (key === 'execution') return ROLE_VISUALS.executor;
  if (key === 'review') return ROLE_VISUALS.reviewer;
  return FALLBACK_VISUALS[hashRole(key) % FALLBACK_VISUALS.length];
}

/** Title-case role label for avatars / a11y. */
export function roleDisplayName(role) {
  const raw = String(role || '').trim();
  if (!raw) return 'Agent';
  return raw.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
