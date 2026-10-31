/**
 * Capability registry for agent skill destinations.
 * Detection uses workspace markers (same idea as kusa init), not "directory exists ⇒ agent installed".
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const CURSOR_MARKERS = ['.cursor', '.cursorrules', '.cursorignore'];
const COPILOT_MARKERS = [
  '.github/copilot-instructions.md',
  '.github/copilot',
  '.github/hooks',
  '.github/agents',
  '.github/instructions',
  '.github/prompts',
  '.github/extensions',
];
const CLAUDE_MARKERS = ['.claude', '.claude/settings.json', '.claude/settings.local.json'];
const CODEX_MARKERS = ['.codex', 'AGENTS.md', '.agents'];

/**
 * Destination catalog. `portable: true` marks the shared Agent Skills location.
 * Prefer publishing once to `.agents/skills` when multiple agents discover it.
 */
export const AGENT_CAPABILITIES = Object.freeze([
  {
    id: 'cursor',
    label: 'Cursor',
    markers: CURSOR_MARKERS,
    destinations: [
      {
        id: 'agents',
        relRoot: '.agents/skills',
        label: '.agents/skills (portable)',
        preferred: true,
        portable: true,
      },
      {
        id: 'cursor',
        relRoot: '.cursor/skills',
        label: '.cursor/skills',
        preferred: false,
        portable: false,
        /** Cursor also discovers `.agents/skills`; keep this optional to avoid duplicate loads. */
        note: 'Optional Cursor-only copy. Prefer .agents/skills when that is enough.',
      },
    ],
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    markers: COPILOT_MARKERS,
    destinations: [
      {
        id: 'agents',
        relRoot: '.agents/skills',
        label: '.agents/skills (portable)',
        preferred: true,
        portable: true,
      },
      {
        id: 'github',
        relRoot: '.github/skills',
        label: '.github/skills',
        preferred: false,
        portable: false,
        note: 'Copilot-specific workspace location. Prefer .agents/skills when shared.',
      },
    ],
  },
  {
    id: 'claude',
    label: 'Claude Code',
    markers: CLAUDE_MARKERS,
    destinations: [
      {
        id: 'claude',
        relRoot: '.claude/skills',
        label: '.claude/skills',
        preferred: true,
        portable: false,
      },
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    markers: CODEX_MARKERS,
    destinations: [
      {
        id: 'agents',
        relRoot: '.agents/skills',
        label: '.agents/skills (portable)',
        preferred: true,
        portable: true,
      },
    ],
  },
]);

function presentMarkers(workspaceRoot, markers) {
  return markers.filter((rel) => existsSync(join(workspaceRoot, rel)));
}

export function detectAgentCapabilities(workspaceRoot) {
  return AGENT_CAPABILITIES.map((agent) => {
    const found = presentMarkers(workspaceRoot, agent.markers);
    return {
      id: agent.id,
      label: agent.label,
      detected: found.length > 0,
      markersFound: found,
      /** Directory presence alone does not mean the agent is installed. */
      destinations: agent.destinations.map((d) => ({
        ...d,
        key: destinationKey(agent.id, d.id),
        absoluteRoot: join(workspaceRoot, d.relRoot),
        exists: existsSync(join(workspaceRoot, d.relRoot)),
      })),
    };
  });
}

export function destinationKey(agentId, destId) {
  return `${agentId}:${destId}`;
}

export function resolveDestination(workspaceRoot, key) {
  for (const agent of AGENT_CAPABILITIES) {
    for (const dest of agent.destinations) {
      if (destinationKey(agent.id, dest.id) === key) {
        return {
          key,
          agentId: agent.id,
          agentLabel: agent.label,
          ...dest,
          absoluteRoot: join(workspaceRoot, dest.relRoot),
        };
      }
    }
  }
  return null;
}

/**
 * Collapse selected destination keys that share the same filesystem root so
 * publishing writes once (idempotent, no duplicate copies).
 */
export function groupDestinationsByPath(workspaceRoot, keys) {
  const groups = new Map();
  for (const key of keys || []) {
    const dest = resolveDestination(workspaceRoot, key);
    if (!dest) continue;
    const pathKey = dest.relRoot.replace(/\\/g, '/');
    if (!groups.has(pathKey)) {
      groups.set(pathKey, {
        relRoot: dest.relRoot,
        absoluteRoot: dest.absoluteRoot,
        portable: Boolean(dest.portable),
        destinations: [],
      });
    }
    groups.get(pathKey).destinations.push(dest);
  }
  return [...groups.values()];
}

export function preferredDestinationKeys(workspaceRoot, { onlyDetected = true } = {}) {
  const caps = detectAgentCapabilities(workspaceRoot);
  const keys = [];
  for (const agent of caps) {
    if (onlyDetected && !agent.detected) continue;
    const preferred = agent.destinations.find((d) => d.preferred) || agent.destinations[0];
    if (preferred) keys.push(preferred.key);
  }
  return [...new Set(keys)];
}
