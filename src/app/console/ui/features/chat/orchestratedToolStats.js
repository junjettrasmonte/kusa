import { CHAT_PROVIDER_GROUPS } from '#ui/shared/lib/format.js';

const PROVIDER_LABELS = Object.fromEntries(
  CHAT_PROVIDER_GROUPS.map((g) => [g.id, g.label]),
);

const RULE_LABELS = {
  'ask-deny': 'Ask · deny on timeout',
  'ask-allow': 'Ask · allow on timeout',
  allow: 'Allow',
  deny: 'Deny',
};

export function isOrchestratedChat(session) {
  if (!session) return false;
  if (session.parentId || session.options?.parentId) return false;
  const kind = String(session.kind || session.options?.kind || '').toLowerCase();
  return kind === 'orchestrated'
    || Boolean(session.options?.workflowId || session.workflowId);
}

function sessionRole(session) {
  return String(session?.role || session?.options?.role || 'orchestrator').trim() || 'orchestrator';
}

function sessionProvider(session, roleCfg = null) {
  return String(
    session?.provider
    || session?.options?.provider
    || roleCfg?.provider
    || session?.harness
    || 'kusa',
  ).trim().toLowerCase() || 'kusa';
}

export function ruleLabel(rules) {
  const id = String(rules || 'ask-deny').trim().toLowerCase() || 'ask-deny';
  return RULE_LABELS[id] || id;
}

export function providerLabel(provider) {
  const id = String(provider || '').trim().toLowerCase();
  return PROVIDER_LABELS[id] || id || 'Unknown';
}

export function roleTitle(role) {
  const raw = String(role || '').trim();
  if (!raw) return 'Role';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** Weighted average when merging tool rows from multiple Subagent lanes. */
function mergeAvg(aAvg, aWeight, bAvg, bWeight) {
  const aw = Number(aWeight) || 0;
  const bw = Number(bWeight) || 0;
  const aOk = Number.isFinite(aAvg);
  const bOk = Number.isFinite(bAvg);
  if (aOk && bOk && aw + bw > 0) return ((aAvg * aw) + (bAvg * bw)) / (aw + bw);
  if (aOk) return aAvg;
  if (bOk) return bAvg;
  return null;
}

function mergeToolRow(into, row) {
  if (!into) {
    return {
      name: row.name,
      depth: row.depth || 0,
      total: row.total || 0,
      running: row.running || 0,
      success: row.success || 0,
      failed: row.failed || 0,
      denied: row.denied || 0,
      incomplete: row.incomplete || 0,
      avg: row.avg ?? null,
      max: row.max ?? null,
      last: row.last ?? null,
      commands: Array.isArray(row.commands) ? row.commands.slice() : undefined,
    };
  }
  const next = {
    ...into,
    total: (into.total || 0) + (row.total || 0),
    running: (into.running || 0) + (row.running || 0),
    success: (into.success || 0) + (row.success || 0),
    failed: (into.failed || 0) + (row.failed || 0),
    denied: (into.denied || 0) + (row.denied || 0),
    incomplete: (into.incomplete || 0) + (row.incomplete || 0),
    avg: mergeAvg(into.avg, into.total, row.avg, row.total),
    max: Math.max(into.max || 0, row.max || 0) || null,
    last: Math.max(into.last || 0, row.last || 0) || null,
  };
  if (Array.isArray(row.commands) && row.commands.length) {
    const seen = new Set(into.commands || []);
    const commands = [...(into.commands || [])];
    for (const cmd of row.commands) {
      if (seen.has(cmd)) continue;
      seen.add(cmd);
      commands.push(cmd);
    }
    next.commands = commands;
  }
  return next;
}

/**
 * Build provider → role → tool groups for an orchestrated Agent + its Subagents.
 * @returns {{ providers: Array, usedNames: Set<string>, open: Array }}
 */
export function buildOrchestratedToolStats({
  chatSession,
  peerSessions = [],
  lanes = {},
  workflow = null,
} = {}) {
  const sessions = [chatSession, ...(Array.isArray(peerSessions) ? peerSessions : [])].filter(Boolean);
  const roleConfigs = workflow?.roleConfigs || {};
  /** @type {Map<string, Map<string, { rules: string, tools: Map<string, object>, children: Map<string, Map<string, object>> }>>} */
  const byProvider = new Map();
  const usedNames = new Set();
  const open = [];

  for (const session of sessions) {
    const role = sessionRole(session);
    const roleCfg = roleConfigs[role] || null;
    const provider = sessionProvider(session, roleCfg);
    const rules = String(
      session?.options?.rules
      || roleCfg?.rules
      || 'ask-deny',
    ).trim().toLowerCase() || 'ask-deny';
    let lane = lanes?.[session.key] || null;
    // Fallback when the monitor lane key and chat key disagree (legacy / harness rename).
    if (!lane && session?.id && lanes && typeof lanes === 'object') {
      lane = Object.values(lanes).find((entry) => entry?.session?.id === session.id || entry?.id === session.id) || null;
    }

    if (!byProvider.has(provider)) byProvider.set(provider, new Map());
    const roles = byProvider.get(provider);
    if (!roles.has(role)) {
      roles.set(role, {
        rules,
        tools: new Map(),
        children: new Map(),
      });
    }
    // Prefer live session rules over stale workflow defaults when present.
    if (session?.options?.rules) roles.get(role).rules = rules;
    else if (!roles.get(role).rules) roles.get(role).rules = rules;

    const bucket = roles.get(role);
    // Walk with parent/child pairing so command children stay under the tool.
    let currentTool = null;
    for (const row of lane?.rows || []) {
      if (!row?.name) continue;
      if (!row.depth) {
        currentTool = row.name;
        usedNames.add(String(row.name));
        bucket.tools.set(row.name, mergeToolRow(bucket.tools.get(row.name), row));
        if (!bucket.children.has(row.name)) bucket.children.set(row.name, new Map());
        continue;
      }
      if (!currentTool) continue;
      if (!bucket.children.has(currentTool)) bucket.children.set(currentTool, new Map());
      const kids = bucket.children.get(currentTool);
      kids.set(row.name, mergeToolRow(kids.get(row.name), row));
    }

    for (const inv of lane?.open || []) {
      open.push({
        ...inv,
        provider,
        role,
        sessionKey: session.key,
      });
    }
  }

  const providers = [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, roles]) => ({
      provider,
      label: providerLabel(provider),
      roles: [...roles.entries()]
        .sort(([a], [b]) => {
          if (a === 'orchestrator') return -1;
          if (b === 'orchestrator') return 1;
          return a.localeCompare(b);
        })
        .map(([role, bucket]) => {
          const toolGroups = [...bucket.tools.entries()]
            .map(([name, row]) => {
              const children = [...(bucket.children.get(name)?.values() || [])]
                .sort((a, b) => (b.total || 0) - (a.total || 0) || a.name.localeCompare(b.name));
              return { row, children };
            })
            .sort((a, b) => (b.row.total || 0) - (a.row.total || 0) || a.row.name.localeCompare(b.row.name));
          return {
            role,
            label: roleTitle(role),
            rules: bucket.rules,
            rulesLabel: ruleLabel(bucket.rules),
            toolGroups,
          };
        }),
    }));

  return { providers, usedNames, open };
}
