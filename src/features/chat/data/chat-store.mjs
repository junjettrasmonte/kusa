/**
 * Provider chat transcripts under `.kusa/agents/<id>/chat.json`.
 *
 * Every Agent owns a folder under the shared `agents/` tree that holds its
 * monitor lane, events, chat transcript, settings sidecar, and an
 * `attachments/` subfolder for files that rode on messages. Harness/provider is
 * a field on the record (and in lane keys), not a disk folder. Monitor lanes
 * stay in `lane.json` beside the chat sidecar so message history survives
 * across browsers and reloads.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  hydrateAttachments,
  normalizeAttachments,
  persistAttachments,
} from './attachments.mjs';
import { createKusaHookEmitter } from '#features/agent/hooks.mjs';
import { AGENT_MODE_ASK, AGENT_MODE_AGENT, AGENT_MODE_PLAN } from '#features/agent/modes.mjs';
import { normalizeApprovalMode } from '#features/agent/approval.mjs';
import {
  ORCHESTRATOR_ROLE,
  resolveWorkflowModelId,
  workflowRole,
} from '#features/workflows/store.mjs';
import {
  CHAT_FILE,
  ensureSessionDirs,
  findNestedSubagentFiles,
  laneFiles,
  laneKey,
  collectCliShadowHints,
  laneIsCliShadow,
  laneListedInSidebar,
  agentsRoot,
  migrateFlatSessionFiles,
  migrateHarnessSessionsToShared,
  reclaimDetachedSubagents,
  sessionRankAt,
  SUBAGENTS_DIR,
  subagentFiles,
} from '#features/monitor/lib.mjs';
import { isMistakenAgentProfileLane } from '#features/monitor/agent-profile-lane.mjs';
import {
  CHAT_HARNESSES,
  CHAT_PROVIDERS,
  enrichChatSessions,
  harnessForProvider,
  isExternalOwnedHarness,
  normalizeSessionKind,
  providerForHarness,
  resolveChatProvider,
  SESSION_KIND_ORCHESTRATED,
  SESSION_KIND_STANDARD,
} from './providers.mjs';
import './load-builtin-adapters.mjs';

export const KUSA_HARNESS = 'kusa';
export { CHAT_FILE };
/** @deprecated use CHAT_FILE — kept for callers matching legacy `*.chat.json`. */
export const CHAT_SUFFIX = '.chat.json';
export {
  CHAT_HARNESSES,
  CHAT_PROVIDERS,
  harnessForProvider,
  isExternalChatSession,
  normalizeSessionKind,
  providerForHarness,
  resolveChatProvider,
  SESSION_KIND_ORCHESTRATED,
  SESSION_KIND_STANDARD,
} from './providers.mjs';
// Local import is used above; re-export the same helper for callers.
export { isExternalOwnedHarness };

function atomicWriteFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, path);
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function newId() {
  try {
    return randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Paths for one chat session under a harness folder (migrates flat files first). */
export function chatSessionFiles(dir, harness, sessionId) {
  const name = typeof harness === 'string' && harness.trim() ? harness.trim() : KUSA_HARNESS;
  return migrateFlatSessionFiles(dir, { harness: name, id: sessionId });
}

/**
 * Walk agents/&lt;id&gt;/subagents/… (any depth) for a nested Subagent folder matching sessionId.
 * @returns {object | null}
 */
export function findNestedSessionFiles(dir, sessionId) {
  const nested = findNestedSubagentFiles(dir, sessionId);
  return nested ? ensureSessionDirs(nested) : null;
}

/**
 * Top-level session folder, or nested Subagent folder when `parentId` is set /
 * when the id only exists under some parent's `subagents/`.
 * Nested always wins over a detached top-level twin of the same id.
 */
export function resolveSessionFiles(dir, harness, sessionId, { parentId = null } = {}) {
  const name = typeof harness === 'string' && harness.trim() ? harness.trim() : KUSA_HARNESS;
  const id = String(sessionId || '').trim();
  if (parentId) {
    return ensureSessionDirs(subagentFiles(dir, parentId, { harness: name, id }));
  }
  const nested = findNestedSessionFiles(dir, id);
  if (nested) return nested;
  return chatSessionFiles(dir, name, id);
}

/** @deprecated use chatSessionFiles — kept for callers that still assume Kusă. */
function kusaSessionFiles(dir, sessionId) {
  return chatSessionFiles(dir, KUSA_HARNESS, sessionId);
}

/**
 * Resolve a session id (or `harness:id` key) to `{ harness, id }`.
 * Disk layout is shared (`agents/<id>/`); harness comes from the key prefix
 * when present, otherwise from the lane/chat/config record on disk.
 */
export function resolveSessionRef(dir, sessionIdOrKey) {
  const raw = String(sessionIdOrKey || '').trim();
  if (!raw) return null;
  let harnessHint = null;
  let id = raw;
  for (const harness of CHAT_HARNESSES) {
    const prefix = `${harness}:`;
    if (raw.startsWith(prefix)) {
      harnessHint = harness;
      id = raw.slice(prefix.length);
      break;
    }
  }
  if (!id) return null;
  // Touch migration so a bare id still finds a just-upgraded folder.
  try { migrateHarnessSessionsToShared(dir); } catch { /* ignore */ }
  const files = resolveSessionFiles(dir, harnessHint || KUSA_HARNESS, id);
  const chat = existsSync(files.chat) ? readJsonSafe(files.chat) : null;
  const config = existsSync(files.config) ? readJsonSafe(files.config) : null;
  const lane = existsSync(files.json) ? readJsonSafe(files.json) : null;
  const fromRecord = lane?.harness
    || chat?.harness
    || resolveChatProvider(config?.provider || chat?.provider)?.harness
    || null;
  const harness = harnessHint
    || (CHAT_HARNESSES.includes(fromRecord) ? fromRecord : null)
    || KUSA_HARNESS;
  const parentId = typeof config?.parentId === 'string' && config.parentId.trim()
    ? config.parentId.trim()
    : (typeof files.parentId === 'string' && files.parentId ? files.parentId : null);
  return { harness, id, parentId };
}

/** Absolute path for a session's chat sidecar. */
export function chatFilePath(dir, sessionId, harness = null, parentId = null) {
  const ref = harness
    ? { harness, id: String(sessionId || '').trim(), parentId }
    : resolveSessionRef(dir, sessionId);
  if (!ref?.id) return chatSessionFiles(dir, KUSA_HARNESS, '').chat;
  return resolveSessionFiles(dir, ref.harness, ref.id, {
    parentId: parentId || ref.parentId,
  }).chat;
}

/**
 * Per-Agent settings sidecar: `.kusa/agents/<id>/agent.json`.
 *
 * A chat owns its composer picks (Mode / Rule / Model), and a chat transcript
 * is the wrong place to keep them: the turn path rewrites the transcript on
 * every step (`persistTurnPrompt`, `persistTurnCompletion`, `saveChatSessions`),
 * so a pick stored inside it only survives as long as the last writer happens
 * to carry it — one writer that rebuilds the record drops the pick and the next
 * refresh reopens the chat on a Settings default. Settings are not turn data,
 * so they get their own file inside the Agent folder: written only when a
 * pick is made, never touched by a turn write, and hand-editable like any
 * other file here. Flat `<id>.session.json` leftovers and legacy `session.json`
 * are migrated to `agent.json` on read/write.
 */
export const AGENT_CONFIG_FILE = 'agent.json';
/** @deprecated use {@link AGENT_CONFIG_FILE} */
export const SESSION_CONFIG_FILE = AGENT_CONFIG_FILE;
/** @deprecated legacy suffix — migrated into {@link AGENT_CONFIG_FILE}. */
export const SESSION_CONFIG_SUFFIX = '.session.json';

/** Absolute path for a session's settings sidecar. */
export function sessionConfigPath(dir, sessionId, harness = null, parentId = null) {
  const ref = harness
    ? { harness, id: String(sessionId || '').trim(), parentId }
    : resolveSessionRef(dir, sessionId);
  if (!ref?.id) return chatSessionFiles(dir, KUSA_HARNESS, '').config;
  return resolveSessionFiles(dir, ref.harness, ref.id, {
    parentId: parentId || ref.parentId,
  }).config;
}

/**
 * Normalize a message. When `dir` + `sessionId` are given, attachment bytes are
 * written into that session's `attachments/` folder and the returned record
 * keeps only the slim pointer (`file`) — chat.json must not grow with every
 * picture. Without a session folder the inline payload is kept (queue / tests).
 */
function normalizeMessage(m, { dir = null, sessionId = '', harness = KUSA_HARNESS, persist = false, hydrate = false } = {}) {
  if (!m || typeof m !== 'object' || typeof m.text !== 'string') return null;
  let attachments = normalizeAttachments(m.attachments);
  if (attachments.length && dir && sessionId && persist) {
    attachments = persistAttachments(dir, sessionId, attachments, harness);
  } else if (attachments.length && dir && sessionId && hydrate) {
    attachments = hydrateAttachments(dir, sessionId, attachments, harness);
  }
  return {
    id: String(m.id || newId()),
    role: m.role === 'assistant' ? 'assistant' : 'user',
    text: String(m.text),
    thinking: typeof m.thinking === 'string' ? m.thinking : '',
    tools: Array.isArray(m.tools) ? m.tools : [],
    parts: Array.isArray(m.parts) ? m.parts : undefined,
    at: Number.isFinite(m.at) ? m.at : Date.now(),
    ...(m.backend != null ? { backend: m.backend } : {}),
    ...(typeof m.model === 'string' && m.model.trim() ? { model: m.model.trim().slice(0, 200) } : {}),
    ...(typeof m.turnId === 'string' && m.turnId ? { turnId: m.turnId } : {}),
    ...(m.stopped === true ? { stopped: true } : {}),
    ...(m.steered === true ? { steered: true } : {}),
    // Soft-steer (Send now) freezes a half-finished assistant bubble before the
    // steered user row; keep the flag so a later persist of the same turnId
    // does not overwrite that stub with the final reply.
    ...(m.interrupted === true ? { interrupted: true } : {}),
    ...(m.error === true ? { error: true } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
}

/**
 * Concise one-line session title derived from a prompt's first meaningful line.
 * Deterministic and local (no model call) so titles work offline and stay
 * stable across reloads — the first user prompt is what names a chat.
 */
export const TITLE_MAX_CHARS = 72;

function titleFromText(raw) {
  if (!raw) return null;
  const stripped = String(raw)
    // Drop fenced code blocks, then inline code and link targets.
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)\n]*\)/g, '$1');
  const line = stripped
    .split(/\r?\n/)
    .map((s) => s.replace(/^[ \t]*(?:#{1,6}|[-*+•>])[ \t]+/, '').trim())
    .find((s) => s.length > 0);
  if (!line) return null;
  const flat = line
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return null;
  // Prefer a leading sentence: "Fix the parser. Then add tests" -> "Fix the parser".
  const sentence = flat.match(/^(.{8,}?[.!?])(?:\s|$)/);
  const base = sentence ? sentence[1].trim() : flat;
  if (base.length <= TITLE_MAX_CHARS) return base;
  const cut = base.slice(0, TITLE_MAX_CHARS);
  const boundary = cut.lastIndexOf(' ');
  const clipped = boundary > TITLE_MAX_CHARS * 0.5 ? cut.slice(0, boundary) : cut;
  const trimmed = clipped.replace(/[\s,;:.!?\-–—]+$/, '').trim();
  return trimmed ? `${trimmed}…` : null;
}

/** Title for a transcript: first user message wins; explicit title wins over it. */
export function deriveSessionTitle(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const first = list.find((m) => m && m.role === 'user' && typeof m.text === 'string' && m.text.trim());
  return first ? titleFromText(first.text) : null;
}

function clampTitle(raw) {
  if (typeof raw !== 'string') return null;
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (!oneLine) return null;
  return oneLine.length <= TITLE_MAX_CHARS ? oneLine : `${oneLine.slice(0, TITLE_MAX_CHARS - 1).trim()}…`;
}

/**
 * A name the model authored for a session (`kusa_name_session`). Clamped exactly
 * like a derived title because the sidebar renders either one through the same
 * box — two different widths would make a renamed row look different.
 */
function normalizeSessionName(raw) {
  const clamped = clampTitle(raw);
  if (!clamped) return null;
  // A name must not end in punctuation, the same trim `titleFromText` does
  // before it appends '…': the model is asked for a plain line, and a stray
  // "—" or "," would otherwise sit in the same box a derived title fills.
  const trimmed = clamped.replace(/[\s,;:.!?\-–—]+$/, '').trim();
  return trimmed || null;
}

/**
 * Per-session composer picks (Mode / Rule / Model), as stored on the session.
 *
 * A chat owns its pickers: the choice survives a refresh for THAT session only,
 * and a session that never picked has no `options` at all — Settings → Kusă
 * agent is what fills it in then. Unknown ids are dropped rather than coerced,
 * so a hand-edited sidecar cannot smuggle a rule the agent does not implement.
 * Allow / Deny are stored as-is: they are sticky, so a refresh reopens the chat
 * on the rule the user chose and nothing re-derives a fallback from a window.
 * The record lives in the settings sidecar (`agent.json`), not in the
 * transcript — see `sessionConfigPath`.
 */
function normalizeSessionOptions(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  const mode = typeof raw.mode === 'string' ? raw.mode.trim().toLowerCase() : '';
  if (mode === AGENT_MODE_ASK || mode === AGENT_MODE_PLAN || mode === AGENT_MODE_AGENT) {
    out.mode = mode;
  }
  const rules = typeof raw.rules === 'string' ? raw.rules.trim().toLowerCase() : '';
  if (rules && normalizeApprovalMode(rules) === rules) {
    out.rules = rules;
  }
  const model = typeof raw.model === 'string' ? resolveWorkflowModelId(raw.model) : '';
  if (model) out.model = model;
  // Which agentEndpoints[] id the Model pick sat under (empty = Default). Kept
  // so a probed-only model still routes to that endpoint after a refresh.
  // Empty string is intentional: writeSessionConfig merges with the prior
  // record, so omitting the key would leave a stale extra-endpoint id in place
  // after the user switched back to Default.
  if (Object.hasOwn(raw, 'endpointId')) {
    out.endpointId = typeof raw.endpointId === 'string' ? raw.endpointId.trim().slice(0, 80) : '';
  }
  // Workflow orchestrator flags: when false, the composer picker is locked to
  // the role default; when true, the human may override via the message box.
  for (const key of ['allowModeOverride', 'allowRuleOverride', 'allowModelOverride']) {
    if (Object.hasOwn(raw, key)) {
      out[key] = raw[key] === true || raw[key] === 1 || String(raw[key]).trim().toLowerCase() === 'true';
    }
  }
  const provider = resolveChatProvider(raw.provider);
  if (provider) out.provider = provider.id;
  if (Object.hasOwn(raw, 'kind') || raw.kind) {
    out.kind = normalizeSessionKind(raw.kind);
  }
  // A name the model authored for this chat (kusa_name_session). It lives here,
  // not in the transcript: the turn path rebuilds chat.json on every step, so a
  // name written into it only survives while the last writer happens to carry it
  // — the sidecar is never touched by those writes (same rule as the picks).
  const authoredName = normalizeSessionName(raw.name);
  if (authoredName) out.name = authoredName;
  if (typeof raw.caoSessionName === 'string' && raw.caoSessionName.trim()) {
    out.caoSessionName = raw.caoSessionName.trim().slice(0, 120);
  }
  if (typeof raw.caoTerminalId === 'string' && raw.caoTerminalId.trim()) {
    out.caoTerminalId = raw.caoTerminalId.trim().slice(0, 120);
  }
  if (typeof raw.workflowId === 'string' && raw.workflowId.trim()) {
    out.workflowId = raw.workflowId.trim().slice(0, 200);
  }
  if (typeof raw.parentId === 'string' && raw.parentId.trim()) {
    out.parentId = raw.parentId.trim().slice(0, 120);
  }
  if (typeof raw.role === 'string' && raw.role.trim()) {
    out.role = raw.role.trim().toLowerCase().slice(0, 60);
  }
  if (typeof raw.planId === 'string' && raw.planId.trim()) {
    out.planId = raw.planId.trim().slice(0, 120);
  }
  if (Array.isArray(raw.subagents)) {
    out.subagents = raw.subagents
      .map((row) => {
        if (!row || typeof row !== 'object') return null;
        const childId = String(row.id || '').trim().slice(0, 120);
        if (!childId) return null;
        return {
          id: childId,
          role: String(row.role || '').trim().toLowerCase().slice(0, 60),
          provider: String(row.provider || '').trim().slice(0, 80),
          key: String(row.key || '').trim().slice(0, 200),
          planId: String(row.planId || '').trim().slice(0, 120),
          createdAt: Number.isFinite(row.createdAt) ? row.createdAt : Date.now(),
        };
      })
      .filter(Boolean)
      .slice(0, 40);
  }
  // Opaque CLI resume ids written by provider adapters (Cursor / Copilot).
  for (const key of ['cliSessionId', 'cursorCliSessionId', 'copilotCliSessionId']) {
    if (typeof raw[key] === 'string' && raw[key].trim()) {
      out[key] = raw[key].trim().slice(0, 200);
    }
  }
  // Pre-start Mode take-back writes kind=standard while writeSessionConfig still
  // merges the prior sidecar — without this strip, a leftover workflowId keeps
  // the composer stuck on Orchestrator after the user picked Ask/Plan/Agent.
  // Subagents are also kind=standard but keep parentId + role — leave those alone.
  if (out.kind === SESSION_KIND_STANDARD && !out.parentId) {
    delete out.workflowId;
    delete out.role;
    delete out.allowModeOverride;
    delete out.allowRuleOverride;
    delete out.allowModelOverride;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Normalize a chat session record for the dashboard UI.
 * @param {object} raw
 * @param {{ dir?: string, persist?: boolean, hydrate?: boolean }} [opts]
 *   When `dir` is set, `persist` writes attachment bytes into that session's
 *   attachments/ folder (for saves) and `hydrate` reloads them (for reads).
 */
/**
 * Bind harness/key to the Agent-picker provider when one is set.
 * Folder stays `agents/<id>/` (shared); only the lane key + harness fields move
 * so a kusa-keyed session switched to Cursor/Copilot survives refresh as that
 * provider and does not hydrate as an IDE-owned external row.
 */
export function alignChatSessionToProvider(session) {
  if (!session?.id) return session;
  const providerId = String(
    session.options?.provider
    || session.provider
    || '',
  ).trim().toLowerCase();
  if (!providerId) return session;
  const meta = resolveChatProvider(providerId);
  if (!meta?.harness) return session;
  const harness = meta.harness;
  const provider = meta.id;
  const key = laneKey(harness, session.id);
  if (
    session.harness === harness
    && session.provider === provider
    && session.key === key
  ) {
    return session;
  }
  const modelsMeta = meta.models;
  const trust = meta.workspaceTrust;
  return {
    ...session,
    harness,
    provider,
    key,
    // Kusă-initiated provider switches stay owned here (not Cursor UI).
    // IDE-hooked rows keep external:true when already stamped.
    external: session.external === true,
    cliBacked: meta.turnBackend === 'cao',
    ownsModels: Boolean(meta.ownsModels && modelsMeta?.path),
    modelsPath: meta.ownsModels && modelsMeta?.path ? String(modelsMeta.path) : null,
    workspaceTrust: trust
      ? {
        path: String(trust.path || ''),
        label: String(trust.label || 'Trust workspace'),
        title: String(trust.title || ''),
        summary: String(trust.summary || ''),
      }
      : null,
  };
}

export function normalizeChatSession(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
  if (!id) return null;
  // Only the settings sidecar / explicit `options` object carries picks — never
  // scrape top-level provider/kind onto options or every write invents a sidecar.
  const options = normalizeSessionOptions(raw.options) || null;
  // Explicit Agent-picker provider wins over a stale kusa: lane key so a
  // session switched to Cursor/Copilot remounts identity without a new folder.
  const explicitProvider = options?.provider
    || (typeof raw.provider === 'string' && raw.provider.trim() ? raw.provider.trim() : '');
  const keyPrefix = typeof raw.key === 'string' && raw.key.includes(':')
    ? raw.key.slice(0, raw.key.indexOf(':'))
    : '';
  const providerMeta = resolveChatProvider(
    explicitProvider || raw.harness || keyPrefix || opts.harness,
  );
  let harness = providerMeta?.harness || KUSA_HARNESS;
  if (!explicitProvider) {
    if (typeof raw.harness === 'string' && CHAT_HARNESSES.includes(raw.harness)) {
      harness = raw.harness;
    } else if (opts.harness && CHAT_HARNESSES.includes(opts.harness)) {
      harness = opts.harness;
    } else if (keyPrefix && CHAT_HARNESSES.includes(keyPrefix)) {
      harness = keyPrefix;
    }
  }
  const key = laneKey(harness, id);
  const provider = providerMeta?.id || providerForHarness(harness);
  const kind = normalizeSessionKind(options?.kind || raw.kind || SESSION_KIND_STANDARD);
  const messageOpts = {
    dir: opts.dir || null,
    sessionId: id,
    harness,
    persist: Boolean(opts.persist),
    hydrate: Boolean(opts.hydrate),
  };
  const messages = Array.isArray(raw.messages)
    ? raw.messages.map((m) => normalizeMessage(m, messageOpts)).filter(Boolean)
    : [];
  // Composer sidecar picks only — provider/kind live on the session record so a
  // brand-new chat does not invent an agent.json full of defaults.
  // `external` marks IDE-owned chats (adapter hooks). Kusă-created CLI sessions
  // write false; lane-only externalOwned harness chats hydrate as true.
  const external = raw.external === true;
  const resolvedMeta = providerMeta || resolveChatProvider(provider);
  const trust = resolvedMeta?.workspaceTrust;
  const modelsMeta = resolvedMeta?.models;
  // What names this row in the sidebar. An authored name (the model renamed the
  // session) wins over the transcript: it is not turn data, it lives in the
  // settings sidecar, and a record already carrying `options` was just read
  // through that sidecar — reading it again only happens for a bare record.
  const authoredName = normalizeSessionName(options?.name)
    || (opts.dir ? normalizeSessionName(readSessionConfig(opts.dir, id, harness)?.name) : null);
  return {
    key,
    id,
    harness,
    provider,
    kind,
    external,
    /** True for adapter/CAO providers — BYOK endpoint credentials do not apply. */
    cliBacked: resolvedMeta?.turnBackend === 'cao',
    /** Adapter owns its model catalog (e.g. Cursor `--list-models`). */
    ownsModels: Boolean(resolvedMeta?.ownsModels && modelsMeta?.path),
    modelsPath: modelsMeta?.path ? String(modelsMeta.path) : null,
    /** Workspace gate contributed by the provider adapter (e.g. Cursor trust). */
    workspaceTrust: trust
      ? {
        path: String(trust.path || ''),
        label: String(trust.label || 'Trust workspace'),
        title: String(trust.title || ''),
        summary: String(trust.summary || ''),
      }
      : null,
    title: authoredName || clampTitle(raw.title) || deriveSessionTitle(messages),
    // Live activity (busy/thinking/idle/ended) is separate from user archive.
    // `status === 'archived'` is accepted as a legacy/alias write shape.
    status: raw.status === 'ended' ? 'ended' : 'idle',
    archived: raw.archived === true || raw.status === 'archived',
    archivedAt: Number.isFinite(raw.archivedAt) ? raw.archivedAt : null,
    endedAt: Number.isFinite(raw.endedAt) ? raw.endedAt : null,
    attempts: Number.isFinite(raw.attempts) ? raw.attempts : 0,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    opencodeSessionId: typeof raw.opencodeSessionId === 'string' ? raw.opencodeSessionId : null,
    // The session's own composer picks — null means "never picked, use Settings".
    options: options || null,
    /** Nested Subagent linkage (also on options). */
    parentId: options?.parentId || null,
    role: options?.role || null,
    planId: options?.planId || null,
    subagents: Array.isArray(options?.subagents) ? options.subagents : [],
    messages,
    live: null,
  };
}

/**
 * Read a session's settings sidecar. Null when it never picked anything, which
 * is different from "picked the default": no file means Settings fills the pick
 * in, so a session that was never opened keeps inheriting Settings.
 */
export function readSessionConfig(dir, sessionId, harness = null, parentId = null) {
  const path = sessionConfigPath(dir, sessionId, harness, parentId);
  // Migrate legacy session.json → agent.json before reading the canonical path.
  try {
    const folder = dirname(path);
    ensureSessionDirs({
      dir: folder,
      attachments: join(folder, 'attachments'),
      subagents: join(folder, SUBAGENTS_DIR),
      config: path,
    });
  } catch { /* ignore */ }
  return normalizeSessionOptions(readJsonSafe(path));
}

/**
 * Merge picks into the settings sidecar and return what is now stored.
 *
 * Only supplied fields change, so a partial pick can never drop the others, and
 * an empty merge writes no file at all — nothing here invents a pick, which is
 * what keeps a turn write from clearing a Rule the user chose.
 */
export function writeSessionConfig(dir, sessionId, over = {}, harness = null, parentId = null) {
  const ref = harness
    ? { harness, id: String(sessionId || '').trim(), parentId }
    : resolveSessionRef(dir, sessionId);
  const id = ref?.id || String(sessionId || '').trim();
  const h = ref?.harness || KUSA_HARNESS;
  const nestedParent = parentId || ref?.parentId || over?.parentId || null;
  const merged = normalizeSessionOptions({
    ...(readSessionConfig(dir, id, h, nestedParent) || {}),
    ...(over || {}),
  });
  const path = sessionConfigPath(dir, id, h, nestedParent);
  if (!merged) {
    // Nothing is left to store: a cleared pick (an authored name, a model…) must
    // not linger on disk, or the next read would resurrect it. No file is the
    // "never picked" shape, so dropping the sidecar is the honest end state.
    try {
      unlinkSync(path);
    } catch {
      /* absent already — nothing to clear */
    }
    return null;
  }
  const files = resolveSessionFiles(dir, h, id, { parentId: nestedParent });
  ensureSessionDirs(files);
  atomicWriteFile(path, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

/**
 * Name (or rename) a session with an authored title.
 *
 * The name lands in the settings sidecar, never in the transcript — see the
 * note in `normalizeChatSession`: turn writers rebuild chat.json every step and
 * know nothing about names, so an authored name written there would be reset by
 * the next turn write. Pass an empty name to drop the authored name and let the
 * first user prompt title the row again.
 * @returns {{ ok: boolean, name: string|null, previous: string|null, cleared: boolean }}
 */
export function nameChatSession(dir, sessionIdOrKey, name, harness = null) {
  const ref = harness
    ? { harness, id: String(sessionIdOrKey || '').trim() }
    : resolveSessionRef(dir, sessionIdOrKey);
  const id = ref?.id || '';
  if (!id) return { ok: false, error: 'session not found' };
  const h = ref.harness || KUSA_HARNESS;
  const files = chatSessionFiles(dir, h, id);
  // A name only belongs to a session that exists — naming a phantom would write
  // a sidecar nothing owns and leave an orphan folder on disk.
  const known = [files.chat, files.json, files.config].some((p) => existsSync(p));
  if (!known) return { ok: false, error: `no session ${id} to name` };
  const previous = normalizeSessionName(readSessionConfig(dir, id, h)?.name);
  const cleared = !(typeof name === 'string' && String(name).trim());
  const next = cleared ? null : normalizeSessionName(name);
  const options = writeSessionConfig(dir, id, { ...(cleared ? { name: '' } : { name: next }) }, h);
  return {
    ok: Boolean(options?.name) || cleared,
    name: normalizeSessionName(options?.name),
    previous,
    cleared,
    sessionId: id,
    harness: h,
  };
}

/**
 * Persistable shape — drop ephemeral live/busy state.
 * Pass `{ dir }` so attachment bytes are written into attachments/ and the
 * returned messages keep only slim `file` pointers for chat.json.
 */
export function slimChatSession(session, opts = {}) {
  const normalized = normalizeChatSession(session, {
    dir: opts.dir || null,
    persist: Boolean(opts.dir),
  });
  if (!normalized) return null;
  const { live: _live, ...rest } = normalized;
  const status = rest.status === 'ended' ? 'ended' : 'idle';
  const archived = rest.archived === true;
  return {
    ...rest,
    // An end is the only chat event that re-ranks the row (see sessionRankAt),
    // so stamp it once — later saves must not move the session again.
    status,
    endedAt: status === 'ended' ? (rest.endedAt ?? Date.now()) : null,
    archived,
    archivedAt: archived ? (rest.archivedAt ?? Date.now()) : null,
  };
}

/** Rebuild a minimal chat transcript from a monitor lane's prompts. */
export function chatSessionFromLane(lane) {
  if (!lane || !lane.id) return null;
  const harness = CHAT_HARNESSES.includes(lane.harness) ? lane.harness : null;
  if (!harness) return null;
  const messages = [];
  const prompts = Array.isArray(lane.prompts) ? lane.prompts : [];
  // Oldest first so the chat reads top-to-bottom.
  const ordered = [...prompts].sort((a, b) => (a.atWall ?? 0) - (b.atWall ?? 0));
  for (const prompt of ordered) {
    if (!prompt || typeof prompt.text !== 'string') continue;
    messages.push({
      id: `prompt-${prompt.index ?? messages.length}-user`,
      role: 'user',
      text: String(prompt.text),
      thinking: '',
      tools: [],
      at: Number.isFinite(prompt.atWall) ? prompt.atWall : Date.now(),
    });
    if (typeof prompt.response === 'string' && prompt.response) {
      messages.push({
        id: `prompt-${prompt.index ?? messages.length}-assistant`,
        role: 'assistant',
        text: String(prompt.response),
        thinking: '',
        tools: [],
        at: Number.isFinite(prompt.endedAtWall) ? prompt.endedAtWall : (prompt.atWall ?? Date.now()),
      });
    }
  }
  return normalizeChatSession({
    key: lane.key || laneKey(harness, lane.id),
    id: lane.id,
    harness,
    provider: providerForHarness(harness),
    // Kusă-owned CLI lanes stay promptable; other Cursor lanes are IDE-owned.
    external: lane.kusaOwned === true ? false : isExternalOwnedHarness(harness),
    status: lane.active === false || lane.endedAtWall != null ? 'ended' : 'idle',
    endedAt: Number.isFinite(lane.endedAtWall) ? lane.endedAtWall : null,
    attempts: Number.isFinite(lane.promptToolAttempts) ? lane.promptToolAttempts : 0,
    createdAt: Number.isFinite(lane.startedAtWall) ? lane.startedAtWall : Date.now(),
    // Cursor UI titles land on the lane when the IDE generates/renames them.
    title: typeof lane.title === 'string' ? lane.title : null,
    messages,
  });
}

function listLaneFiles(dir) {
  try { migrateHarnessSessionsToShared(dir); } catch { /* ignore */ }
  try { reclaimDetachedSubagents(dir); } catch { /* ignore */ }
  const folder = agentsRoot(dir);
  if (!existsSync(folder)) return [];
  let entries = [];
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (findNestedSubagentFiles(dir, entry.name)) continue;
    const files = migrateFlatSessionFiles(dir, { harness: KUSA_HARNESS, id: entry.name });
    if (existsSync(files.json)) {
      const raw = readJsonSafe(files.json);
      // Skip / ignore agent-profile docs that landed under agents/ by mistake.
      if (raw?.id && !isMistakenAgentProfileLane(raw)) {
        const harness = CHAT_HARNESSES.includes(raw.harness) ? raw.harness : KUSA_HARNESS;
        out.push({ ...raw, harness });
      }
    }
    const walkLanes = (parentFolder, parentId) => {
      const subRoot = join(parentFolder, SUBAGENTS_DIR);
      if (!existsSync(subRoot)) return;
      let kids = [];
      try {
        kids = readdirSync(subRoot, { withFileTypes: true });
      } catch {
        return;
      }
      for (const kid of kids) {
        if (!kid.isDirectory()) continue;
        const nested = ensureSessionDirs(subagentFiles(dir, parentId, { id: kid.name }));
        if (existsSync(nested.json)) {
          const raw = readJsonSafe(nested.json);
          if (raw?.id) {
            const harness = CHAT_HARNESSES.includes(raw.harness) ? raw.harness : KUSA_HARNESS;
            out.push({ ...raw, harness, parentId });
          }
        }
        walkLanes(nested.dir, kid.name);
      }
    };
    walkLanes(join(folder, entry.name), entry.name);
  }
  return out;
}

function listNestedChatFiles(dir, parentStem, parentFolder = null) {
  const folder = parentFolder || join(agentsRoot(dir), parentStem);
  const subRoot = join(folder, SUBAGENTS_DIR);
  if (!existsSync(subRoot)) return [];
  let entries = [];
  try {
    entries = readdirSync(subRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const files = ensureSessionDirs(subagentFiles(dir, parentStem, { id: entry.name }));
    if (existsSync(files.chat)) {
      const raw = readJsonSafe(files.chat);
      const config = existsSync(files.config) ? readJsonSafe(files.config) : null;
      const harnessHint = CHAT_HARNESSES.includes(raw?.harness)
        ? raw.harness
        : (CHAT_HARNESSES.includes(config?.provider) ? resolveChatProvider(config.provider)?.harness : null);
      const session = normalizeChatSession({
        ...raw,
        options: { ...(raw?.options || {}), ...(config || {}), parentId: config?.parentId || parentStem },
      }, {
        dir,
        hydrate: true,
        harness: harnessHint || undefined,
      });
      if (session) out.push(session);
    }
    // Escalations (and deeper nests) under this Subagent.
    for (const grand of listNestedChatFiles(dir, entry.name, files.dir)) {
      out.push(grand);
    }
  }
  return out;
}

function listChatFiles(dir) {
  try { migrateHarnessSessionsToShared(dir); } catch { /* ignore */ }
  try { reclaimDetachedSubagents(dir); } catch { /* ignore */ }
  const folder = agentsRoot(dir);
  if (!existsSync(folder)) return [];
  let entries = [];
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // A top-level twin of a nested Subagent must never list as its own Agent.
    if (findNestedSubagentFiles(dir, entry.name)) continue;
    const files = migrateFlatSessionFiles(dir, { harness: KUSA_HARNESS, id: entry.name });
    if (existsSync(files.chat)) {
      const raw = readJsonSafe(files.chat);
      const harnessHint = CHAT_HARNESSES.includes(raw?.harness) ? raw.harness : null;
      const session = normalizeChatSession(raw, {
        dir,
        hydrate: true,
        harness: harnessHint || undefined,
      });
      if (session) out.push(session);
    }
    // Nested Subagents under this parent Agent folder.
    for (const child of listNestedChatFiles(dir, entry.name)) {
      out.push(child);
    }
  }
  return out;
}

/**
 * When the same session id exists under more than one provider folder (a kusa
 * hook shadow next to a cursor/copilot chat, etc.), pick the row the Agents
 * list should keep. Richer transcripts win; a declared provider that matches
 * the folder beats a shadow; non-kusa folders beat bare kusa copies.
 */
function chatSessionListScore(session) {
  if (!session) return -1;
  let score = 0;
  const msgs = Array.isArray(session.messages) ? session.messages.length : 0;
  score += msgs * 10;
  const providerMeta = resolveChatProvider(session.provider || session.options?.provider);
  if (providerMeta?.harness && providerMeta.harness === session.harness) score += 20;
  if (session.harness && session.harness === providerMeta?.harness) score += 5;
  if (session.harness && session.harness !== KUSA_HARNESS) score += 3;
  if (session.title) score += 1;
  return score;
}

function preferListedChatSession(current, next) {
  if (!current) return next;
  if (!next) return current;
  const curScore = chatSessionListScore(current);
  const nextScore = chatSessionListScore(next);
  if (nextScore !== curScore) return nextScore > curScore ? next : current;
  return sessionRankAt(next) > sessionRankAt(current) ? next : current;
}

/**
 * A `chat.json` sidecar can exist with zero messages — it was written by a
 * turn writer before the lane was ever backfilled from disk. It is not
 * authoritative for the transcript in that case, so the richer message list
 * wins while the sidecar keeps its identity, picks, and attachments.
 */
function mergeRicherChatSession(existing, hydrated) {
  if (!existing) return hydrated;
  if (!hydrated) return existing;
  const existingMsgs = Array.isArray(existing.messages) ? existing.messages : [];
  const hydratedMsgs = Array.isArray(hydrated.messages) ? hydrated.messages : [];
  if (hydratedMsgs.length <= existingMsgs.length) return existing;
  return {
    ...existing,
    // Keep Kusă ownership / provider pick when a lane backfill only adds text.
    external: existing.external === false ? false : (existing.external ?? hydrated.external),
    provider: existing.provider || hydrated.provider,
    messages: hydratedMsgs,
    attempts: Math.max(Number(existing.attempts) || 0, Number(hydrated.attempts) || 0),
    endedAt: existing.endedAt ?? hydrated.endedAt,
    createdAt: existing.createdAt ?? hydrated.createdAt,
    title: existing.title || hydrated.title || null,
  };
}

/**
 * All provider chats: prefer `chat.json` sidecars; fall back to hydrating from
 * monitor lane prompts when a sidecar is missing (pre-persistence sessions).
 * One row per session id — cross-harness copies of the same id collapse here
 * so the consolidated Agents list never double-loads kusa+cursor twins.
 */
export function listChatSessions(dir) {
  const byId = new Map();
  for (const session of listChatFiles(dir)) {
    if (!session?.id) continue;
    byId.set(session.id, preferListedChatSession(byId.get(session.id), session));
  }
  // Overlay composer sidecars early so cursorCliSessionId is visible when we
  // suppress Cursor-hook ghosts of Kusă-owned CLI turns below. Then rebind
  // harness/key to the Agent-picker provider so a switched Cursor/Copilot
  // session still lists after refresh (not as a missing kusa: row).
  for (const [id, session] of [...byId.entries()]) {
    const config = readSessionConfig(
      dir,
      session.id,
      session.harness,
      session.parentId || session.options?.parentId,
    );
    if (config) session.options = { ...(session.options || {}), ...config };
    byId.set(id, alignChatSessionToProvider(session));
  }
  const shadowHints = collectCliShadowHints(byId.values());
  for (const lane of listLaneFiles(dir)) {
    if (!lane?.id) continue;
    const existing = byId.get(lane.id);
    // A sidecar that already carries messages wins outright. An empty one is a
    // stale artifact, not proof of an empty session — a backfilled Cursor IDE
    // lane would otherwise render as a blank Agents transcript.
    if (existing?.messages?.length) continue;
    // Same gate as monitor buildView: prompt-less Cursor CLI/IDE blips must
    // not appear as empty Agents rows (tools alone ≠ a chat).
    if (!laneListedInSidebar(lane)) continue;
    // Cursor Agent CLI turns also fire IDE hooks under a different
    // conversation_id — that twin must not hydrate as a second external row.
    if (laneIsCliShadow(lane, shadowHints)) continue;
    const hydrated = chatSessionFromLane(lane);
    if (!hydrated) continue;
    if (existing) byId.set(lane.id, mergeRicherChatSession(existing, hydrated));
    else byId.set(hydrated.id, hydrated);
  }
  const sessions = [...byId.values()];
  // Overlay each session's own settings. This is what makes a Rule survive a
  // page refresh: the dashboard re-reads the sidecar, and no transcript writer
  // on the turn path can have cleared it.
  for (let i = 0; i < sessions.length; i += 1) {
    let session = sessions[i];
    const config = readSessionConfig(dir, session.id, session.harness, session.parentId || session.options?.parentId);
    if (config) {
      session.options = config;
      session.parentId = config.parentId || session.parentId || null;
      session.role = config.role || session.role || null;
      session.planId = config.planId || session.planId || null;
      session.subagents = Array.isArray(config.subagents) ? config.subagents : (session.subagents || []);
    }
    session = alignChatSessionToProvider(session);
    sessions[i] = session;
    // Live workflow override flags for orchestrator parents (JSON edits apply
    // without recreating the session). Subagents keep composer locked.
    const wfId = session.options?.workflowId || '';
    const isOrch = (session.role || session.options?.role) === ORCHESTRATOR_ROLE
      || session.kind === 'orchestrated'
      || Boolean(wfId && !session.parentId && !session.options?.parentId);
    if (wfId && isOrch) {
      try {
        const orch = workflowRole(dir, wfId, ORCHESTRATOR_ROLE);
        if (orch) {
          session.options = {
            ...(session.options || {}),
            allowModeOverride: orch.allowModeOverride === true,
            allowRuleOverride: orch.allowRuleOverride === true,
            allowModelOverride: orch.allowModelOverride === true,
          };
        }
      } catch { /* best-effort */ }
    }
  }
  // Rebuild parent.subagents[] from live children so the sidebar nest stays accurate.
  const childrenByParent = new Map();
  for (const session of sessions) {
    const parentId = session.parentId || session.options?.parentId;
    if (!parentId) continue;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push({
      id: session.id,
      key: session.key,
      role: session.role || session.options?.role || '',
      provider: session.provider || '',
      planId: session.planId || session.options?.planId || '',
      createdAt: session.createdAt,
    });
  }
  for (const session of sessions) {
    const kids = childrenByParent.get(session.id);
    if (kids?.length) {
      session.subagents = kids;
      if (session.options) session.options = { ...session.options, subagents: kids };
    }
  }
  // Adapter enrichers (e.g. Cursor IDE composer titles) overlay provider-specific
  // metadata so the Agents list picks them up on the next /kusa/sessions poll.
  enrichChatSessions(sessions);
  return sessions.sort((a, b) => sessionRankAt(b) - sessionRankAt(a));
}

export function readChatSession(dir, sessionId, harness = null) {
  const ref = harness
    ? { harness, id: String(sessionId || '').trim() }
    : resolveSessionRef(dir, sessionId);
  const id = ref?.id || '';
  if (!id) return null;
  const h = ref.harness || KUSA_HARNESS;
  // The sidecar is the source of truth for picks; a transcript that still
  // carries them (written before the sidecar existed) is used only when no
  // sidecar is there, so an old file cannot shadow a newer pick.
  const config = readSessionConfig(dir, id, h);
  const fromFile = normalizeChatSession(readJsonSafe(chatFilePath(dir, id, h)), {
    dir,
    hydrate: true,
    harness: h,
  });
  const fileMessages = fromFile && Array.isArray(fromFile.messages) ? fromFile.messages : [];
  let resolved = fromFile;
  if (!fileMessages.length) {
    // Empty sidecar: fall through to the lane, which the monitor backfills from
    // Cursor's own agent-transcripts. Hydrating here is what keeps an open
    // session detail readable after a disk backfill.
    const lanePath = laneFiles(dir, { harness: h, id }).json;
    const hydrated = chatSessionFromLane(readJsonSafe(lanePath));
    resolved = mergeRicherChatSession(fromFile, hydrated);
  }
  if (!resolved) return null;
  const withOpts = config
    ? { ...resolved, options: { ...(resolved.options || {}), ...config } }
    : resolved;
  return alignChatSessionToProvider(withOpts);
}

/**
 * Persist a transcript. Picks are NOT written into it: any the incoming record
 * carries are merged into the settings sidecar instead, so the turn writers
 * (which rebuild this file every step and know nothing about picks) cannot
 * reset a Rule — and a pre-sidecar transcript that still has `options` inside
 * it is migrated out on the first write that touches it.
 *
 * Attachment bytes are written into `<id>/attachments/` and the transcript
 * stores slim pointers only, so chat.json stays readable and the files survive
 * for as long as the session folder does.
 */
export function writeChatSession(dir, session) {
  // Remount harness/key to the Agent-picker provider before slim so disk and
  // the Agents list agree after a Cursor/Copilot switch + refresh.
  const slim = slimChatSession(alignChatSessionToProvider(session), { dir });
  if (!slim) {
    const err = new Error('invalid chat session');
    err.code = 'EINVAL';
    throw err;
  }
  const harness = slim.harness || KUSA_HARNESS;
  const incoming = normalizeSessionOptions(session.options) || {};
  const parentId = incoming.parentId
    || resolveSessionRef(dir, slim.id)?.parentId
    || null;
  const stored = readSessionConfig(dir, slim.id, harness, parentId);
  const merged = writeSessionConfig(dir, slim.id, {
    ...(stored || {}),
    ...incoming,
  }, harness, parentId);
  const { options: _picks, ...transcript } = slim;
  const files = resolveSessionFiles(dir, harness, slim.id, {
    parentId: merged?.parentId || parentId,
  });
  ensureSessionDirs(files);
  atomicWriteFile(files.chat, `${JSON.stringify(transcript, null, 2)}\n`);
  // Hand back a hydrated view so the dashboard / agent still see dataUrls —
  // the on-disk transcript stays slim.
  const hydrated = normalizeChatSession(transcript, { dir, hydrate: true, harness }) || slim;
  return {
    ...hydrated,
    options: merged,
    parentId: merged?.parentId || parentId || null,
  };
}

/** Create an empty chat + monitor lane (sessionStart hook). */
export function createChatSession(dir, {
  id,
  workspaceRoot = process.cwd(),
  createdAt,
  provider = 'kusa',
  kind = SESSION_KIND_STANDARD,
  workflowId = null,
} = {}) {
  const meta = resolveChatProvider(provider) || CHAT_PROVIDERS.kusa;
  const harness = meta.harness;
  const sessionId = (typeof id === 'string' && id.trim()) ? id.trim() : newId();
  const existing = readChatSession(dir, sessionId, harness);
  if (existing && (existing.messages?.length || existsSync(chatFilePath(dir, sessionId, harness)))) {
    return existing;
  }
  const sessionKind = normalizeSessionKind(kind);
  const wfId = typeof workflowId === 'string' ? workflowId.trim() : '';
  const orchestrated = sessionKind === SESSION_KIND_ORCHESTRATED || Boolean(wfId);
  // Seed composer triad + override flags from the workflow's orchestrator role.
  const orchRole = (orchestrated && wfId) ? workflowRole(dir, wfId, ORCHESTRATOR_ROLE) : null;
  const orchMode = typeof orchRole?.mode === 'string' ? orchRole.mode.trim().toLowerCase() : '';
  const orchRules = typeof orchRole?.rules === 'string' ? orchRole.rules.trim().toLowerCase() : '';
  // Blank / auto model is omitted — turn path uses Settings endpoint default.
  const orchModel = resolveWorkflowModelId(orchRole?.model);
  const createOptions = {
    ...(meta.id !== 'kusa' ? { provider: meta.id } : {}),
    ...(sessionKind !== SESSION_KIND_STANDARD ? { kind: sessionKind } : {}),
    ...(wfId
      ? { workflowId: wfId, kind: sessionKind, provider: meta.id }
      : {}),
    // Orchestrated parents own the Orchestrator actor role in the workflow.
    ...(orchestrated ? { role: ORCHESTRATOR_ROLE } : {}),
    ...(orchMode ? { mode: orchMode } : {}),
    ...(orchRules && normalizeApprovalMode(orchRules) === orchRules ? { rules: orchRules } : {}),
    ...(orchModel ? { model: orchModel } : {}),
    ...(orchestrated ? {
      allowModeOverride: orchRole?.allowModeOverride === true,
      allowRuleOverride: orchRole?.allowRuleOverride === true,
      allowModelOverride: orchRole?.allowModelOverride === true,
    } : {}),
  };
  const session = writeChatSession(dir, {
    key: laneKey(harness, sessionId),
    id: sessionId,
    harness,
    provider: meta.id,
    kind: sessionKind,
    // Created in Kusă (including Cursor via CLI) — not an external IDE chat.
    external: false,
    status: 'idle',
    attempts: 0,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    messages: [],
    ...(Object.keys(createOptions).length ? { options: createOptions } : {}),
  });
  const hooks = createKusaHookEmitter({
    dataDir: dir,
    sessionId,
    workspaceRoot,
    harness,
  });
  if (hooks.enabled) hooks.sessionStart();
  return session;
}

/**
 * Create a Subagent nested under a parent Agent at
 * `.kusa/agents/<parent>/subagents/<child>/`.
 */
export function createSubagent(dir, {
  parentId,
  id,
  workspaceRoot = process.cwd(),
  provider = 'kusa',
  role = '',
  workflowId = null,
  planId = null,
  mode = null,
  rules = null,
  model = null,
  createdAt,
} = {}) {
  const parent = String(parentId || '').trim();
  if (!parent) {
    const err = new Error('parentId is required');
    err.code = 'EINVAL';
    throw err;
  }
  const meta = resolveChatProvider(provider) || CHAT_PROVIDERS.kusa;
  const harness = meta.harness;
  const sessionId = (typeof id === 'string' && id.trim()) ? id.trim() : newId();
  const now = Number.isFinite(createdAt) ? createdAt : Date.now();
  const rulesNorm = typeof rules === 'string' ? rules.trim().toLowerCase() : '';
  // Blank / auto → omit; turn uses Settings → Kusă agent default endpoints.
  const modelNorm = resolveWorkflowModelId(model);
  const createOptions = {
    provider: meta.id,
    parentId: parent,
    ...(role ? { role: String(role).trim().toLowerCase() } : {}),
    ...(typeof workflowId === 'string' && workflowId.trim() ? { workflowId: workflowId.trim() } : {}),
    ...(typeof planId === 'string' && planId.trim() ? { planId: planId.trim() } : {}),
    ...(mode ? { mode: String(mode).trim().toLowerCase() } : {}),
    // Workflow role Rule — Subagent gates resolve under this (composer Rules).
    ...(rulesNorm && normalizeApprovalMode(rulesNorm) === rulesNorm ? { rules: rulesNorm } : {}),
    ...(modelNorm ? { model: modelNorm } : {}),
  };
  const session = writeChatSession(dir, {
    key: laneKey(harness, sessionId),
    id: sessionId,
    harness,
    provider: meta.id,
    kind: SESSION_KIND_STANDARD,
    external: false,
    status: 'idle',
    attempts: 0,
    createdAt: now,
    messages: [],
    options: createOptions,
  });

  // Index the child on the parent Agent's sidecar.
  const parentConfig = readSessionConfig(dir, parent) || {};
  const existingKids = Array.isArray(parentConfig.subagents) ? parentConfig.subagents : [];
  if (!existingKids.some((row) => row?.id === sessionId)) {
    writeSessionConfig(dir, parent, {
      ...parentConfig,
      subagents: [
        ...existingKids,
        {
          id: sessionId,
          key: session.key,
          role: createOptions.role || '',
          provider: meta.id,
          planId: createOptions.planId || '',
          createdAt: now,
        },
      ],
    });
  }

  const hooks = createKusaHookEmitter({
    dataDir: dir,
    sessionId,
    workspaceRoot,
    harness,
  });
  // Nested chat/config already on disk — persist must resolve under subagents/.
  if (hooks.enabled) hooks.sessionStart();
  try { reclaimDetachedSubagents(dir); } catch { /* ignore */ }
  return session;
}

/** Upsert one or many chat sessions. Returns the written list. */
export function saveChatSessions(dir, sessions) {
  const list = Array.isArray(sessions) ? sessions : [sessions];
  const written = [];
  for (const item of list) {
    const slim = writeChatSession(dir, item);
    written.push(slim);
  }
  return written;
}

/**
 * Import browser-local sessions (legacy localStorage). Skips ids that already
 * have a richer on-disk transcript.
 */
export function migrateChatSessions(dir, sessions, { workspaceRoot = process.cwd() } = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const imported = [];
  const skipped = [];
  for (const raw of list) {
    const incoming = slimChatSession(raw);
    if (!incoming) continue;
    const existing = readChatSession(dir, incoming.id);
    const existingLen = existing?.messages?.length || 0;
    const incomingLen = incoming.messages?.length || 0;
    if (existing && existingLen >= incomingLen && existsSync(chatFilePath(dir, incoming.id))) {
      skipped.push(incoming.id);
      continue;
    }
    writeChatSession(dir, {
      ...incoming,
      // Keep the longer transcript when merging.
      messages: incomingLen >= existingLen ? incoming.messages : existing.messages,
    });
    // Ensure a monitor lane exists for sidebar/delete parity.
    const migrateHarness = incoming.harness || KUSA_HARNESS;
    if (!existsSync(laneFiles(dir, { harness: migrateHarness, id: incoming.id }).json)) {
      const hooks = createKusaHookEmitter({
        dataDir: dir,
        sessionId: incoming.id,
        workspaceRoot,
        harness: migrateHarness,
      });
      if (hooks.enabled) hooks.sessionStart();
    }
    imported.push(incoming.id);
  }
  return { imported, skipped, sessions: listChatSessions(dir) };
}

/**
 * Remove chat transcript, settings, and attachments for the given ids.
 * The monitor lane (and its events) stay so a lane-only row can still hydrate;
 * an explicit session delete goes through `deleteSessions`, which drops the
 * whole folder.
 */
export function deleteChatFiles(dir, sessionIds) {
  const deleted = [];
  for (const raw of sessionIds || []) {
    const id = String(raw || '').trim();
    if (!id) continue;
    const ref = resolveSessionRef(dir, id);
    if (!ref?.id) continue;
    const files = chatSessionFiles(dir, ref.harness, ref.id);
    let removed = false;
    for (const path of [files.chat, files.config]) {
      try {
        unlinkSync(path);
        removed = true;
      } catch {
        /* missing is fine */
      }
    }
    // Attachments belong to the chat — drop the folder so files cannot outlive
    // a transcript the user already threw away.
    try {
      rmSync(files.attachments, { recursive: true, force: true });
    } catch {
      /* no attachments folder */
    }
    if (removed) deleted.push(ref.id);
  }
  return deleted;
}
