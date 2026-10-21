/**
 * Agentic Development Console — harness-agnostic counters and dashboard for
 * agent sessions. Any hook-capable harness can write the same state folder
 * and UI (today: GitHub Copilot, VS Code Local, Cursor; more can be added).
 *
 * Copilot hook names follow the Copilot SDK / Copilot CLI reference
 * (camelCase events). The VS Code Local harness delivers snake_case payloads
 * for that same config. Cursor project hooks (`.cursor/hooks.json`) send
 * their own event names and a snake_case payload that includes
 * `cursor_version` and `conversation_id`. Each harness keeps its own
 * sessions; a new conversation resets only that harness's tool rows.
 *
 * Copilot preToolUse / postToolUse payloads do not include a tool-call id.
 * Local and Cursor payloads include tool_use_id. Without an id, correlation
 * is best-effort.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decryptSecret,
  encryptSecret,
  isSecretEnvelope,
  publicSettings,
} from './secrets.mjs';
import { loadTasks, saveTasks } from './task-store.mjs';

export { publicSettings } from './secrets.mjs';

const STALE_LOCK_MS = 5000;
const LOCK_WAIT_MS = 6000;
const KNOWN_EVENTS = new Set([
  'sessionStart',
  'sessionEnd',
  'userPromptSubmitted',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'agentStop',
  'afterAgentResponse',
  'subagentStart',
  'subagentStop',
  'errorOccurred',
  'permissionRequest',
  'notification',
  'preCompact',
  'userPromptTransformed',
]);

// Cursor names that mean the same thing as a Copilot event. Specialized Cursor
// hooks (beforeShellExecution, beforeReadFile, afterMCPExecution, …) are not
// listed: preToolUse already fires for those tools, and counting both would
// double the totals.
const CURSOR_EVENT_ALIAS = {
  beforeSubmitPrompt: 'userPromptSubmitted',
  stop: 'agentStop',
};

const CURSOR_ONLY_EVENTS = new Set([
  'beforeSubmitPrompt',
  'beforeShellExecution',
  'afterShellExecution',
  'beforeMCPExecution',
  'afterMCPExecution',
  'beforeReadFile',
  'afterFileEdit',
  'afterAgentResponse',
  'afterAgentThought',
  'workspaceOpen',
  'beforeTabFileRead',
  'afterTabFileEdit',
]);

export function canonicalEventName(eventName) {
  return CURSOR_EVENT_ALIAS[eventName] || eventName;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));

function envFirst(...names) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw != null && String(raw).trim()) return String(raw).trim();
  }
  return undefined;
}

/**
 * Consumer project root (the workspace being monitored), not this package.
 * Prefer KUSA_WORKSPACE / KUSA_REPO_ROOT; otherwise process.cwd().
 */
export function defaultWorkspaceRoot(cwd = process.cwd()) {
  const fromEnv = envFirst('KUSA_WORKSPACE', 'KUSA_REPO_ROOT');
  if (fromEnv) return resolve(fromEnv);
  return resolve(cwd);
}

export function defaultMonitorDir(cwd = defaultWorkspaceRoot()) {
  const fromEnv = envFirst('KUSA_DIR', 'COPILOT_MONITOR_DIR');
  if (fromEnv) {
    return fromEnv.startsWith('/') ? fromEnv : join(cwd, fromEnv);
  }
  return join(cwd, '.kusa');
}

export function readMonoClock() {
  try {
    const uptime = readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0];
    const sec = Number(uptime);
    if (!Number.isFinite(sec)) return { mono: null, bootId: '' };
    let bootId = '';
    try {
      bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      bootId = '';
    }
    return { mono: Math.round(sec * 1000), bootId };
  } catch {
    return { mono: null, bootId: '' };
  }
}

export function loadThresholds(dir, override) {
  const defaults = JSON.parse(readFileSync(join(moduleDir, 'thresholds.json'), 'utf8'));
  let fileOverride = {};
  let overrideError = null;
  if (!override && dir) {
    const path = join(dir, 'thresholds.json');
    if (existsSync(path)) {
      try {
        fileOverride = JSON.parse(readFileSync(path, 'utf8'));
        if (!fileOverride || typeof fileOverride !== 'object' || Array.isArray(fileOverride)) {
          fileOverride = {};
          overrideError = 'thresholds override was not a JSON object';
        }
      } catch {
        overrideError = 'thresholds override could not be parsed';
      }
    }
  }
  const merged = { ...defaults, ...(override ?? fileOverride) };
  const envMap = [
    [['KUSA_TOOL_WARN_MS', 'COPILOT_MONITOR_TOOL_WARN_MS'], 'toolDurationWarnMs'],
    [['KUSA_REPEAT_WINDOW_MS', 'COPILOT_MONITOR_REPEAT_WINDOW_MS'], 'repeatWindowMs'],
    [['KUSA_REPEAT_COUNT', 'COPILOT_MONITOR_REPEAT_COUNT'], 'repeatCount'],
    [['KUSA_PROMPT_TOOL_WARN', 'COPILOT_MONITOR_PROMPT_TOOL_WARN'], 'promptToolCountWarn'],
    [['KUSA_PROMPT_WARN_MS', 'COPILOT_MONITOR_PROMPT_WARN_MS'], 'promptElapsedWarnMs'],
    [['KUSA_SESSION_WARN_MS', 'COPILOT_MONITOR_SESSION_WARN_MS'], 'sessionElapsedWarnMs'],
    [['KUSA_MAX_EVENTS', 'COPILOT_MONITOR_MAX_EVENTS'], 'maxEvents'],
  ];
  if (!override) {
    for (const [envNames, key] of envMap) {
      const raw = envFirst(...envNames);
      if (raw == null) continue;
      const value = Number(raw);
      if (Number.isFinite(value)) merged[key] = value;
    }
  }
  for (const key of Object.keys(defaults)) {
    const value = Number(merged[key]);
    merged[key] = Number.isFinite(value) && value > 0 ? value : defaults[key];
  }
  merged.maxEvents = Math.min(5000, Math.max(20, Math.floor(merged.maxEvents)));
  return { config: merged, overrideError };
}

function emptyTool() {
  return {
    total: 0,
    running: 0,
    success: 0,
    failed: 0,
    denied: 0,
    incomplete: 0,
    unmatched: 0,
    uncertain: 0,
    durationMsSum: 0,
    durationCount: 0,
    maxDurationMs: 0,
    lastInvocationWall: null,
    children: {},
  };
}

const MAX_CHILDREN = 60;

/**
 * Sub-counter under a tool: the program name for terminal tools, the
 * workspace-relative path for file tools. Capped so a long session cannot grow
 * state without bound; extra keys fold into "(other)".
 */
function ensureChild(tool, subName) {
  if (!subName) return null;
  if (!tool.children || typeof tool.children !== 'object') tool.children = {};
  let key = subName;
  if (!tool.children[key] && Object.keys(tool.children).length >= MAX_CHILDREN) key = '(other)';
  if (!tool.children[key]) {
    const child = emptyTool();
    delete child.children;
    tool.children[key] = child;
  }
  return tool.children[key];
}

function recordOutcome(counter, outcome) {
  if (!counter) return;
  if (outcome === 'success') counter.success += 1;
  else if (outcome === 'denied') counter.denied += 1;
  else counter.failed += 1;
}

function recordDuration(counter, durationMs) {
  if (!counter || durationMs == null) return;
  counter.durationMsSum += durationMs;
  counter.durationCount += 1;
  if (durationMs > counter.maxDurationMs) counter.maxDurationMs = durationMs;
}

const MAX_LANES_PER_HARNESS = 8;
/** Cap stored prompt / agent-response bodies so a wall of text cannot blow up the session file. */
const MAX_PROMPT_TEXT = 8_000;
const MAX_RESPONSE_TEXT = MAX_PROMPT_TEXT;
const MAX_PROMPTS = 200;
/** Cap stored plan markdown (Plan mode `.plan.md` / CreatePlan body). */
const MAX_PLAN_TEXT = 60_000;
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled']);
/** Default port for `trail viz` (iframe target on the Trail tab). */
const TRAIL_VIZ_URL = 'http://127.0.0.1:4400/';
/** @deprecated Prefer defaultWorkspaceRoot() — kept as a live binding for callers. */
const repoRoot = defaultWorkspaceRoot();
/** Cap working-copy path rows in the Git tab / dashboard snapshot. */
const MAX_GIT_PATHS = 500;
const GIT_STATUS_CACHE_MS = 2000;
const GIT_TIMEOUT_MS = 1500;
let gitStatusCache = { at: 0, cwd: '', value: null };

/** Empty / error-shaped working-copy snapshot for the Git tab. */
export function emptyGitStatus(error = null) {
  return {
    ok: false,
    checkedAt: Date.now(),
    installed: false,
    initialized: false,
    root: null,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    head: null,
    subject: null,
    clean: true,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    truncated: false,
    error: error || null,
    steps: [],
  };
}

/** Empty / error-shaped Trail readiness for the Trail tab. */
export function emptyTrailStatus(error = null) {
  return {
    ok: false,
    checkedAt: Date.now(),
    installed: false,
    /** Which context CLI was found on PATH: `trail` | `graft` | null. */
    cli: null,
    /** True when the old Graft CLI is present and Trail is not (or is unusable). */
    needsUpgrade: false,
    initialized: false,
    version: null,
    root: null,
    graphDir: null,
    vizUrl: TRAIL_VIZ_URL,
    error: error || null,
    steps: [],
  };
}

const TRAIL_INSTALL_STEPS = [
  'Install the Trail CLI: npm install -g @trailhq/trail-code',
  'Confirm it works: trail version',
  'From the workspace root, build the context graph: trail build',
  'Optional — wire agent instruction files: trail init -y',
  'Reload this dashboard',
];

const TRAIL_UPGRADE_STEPS = [
  'Graft has been renamed to Trail. Uninstall the old CLI: npm uninstall -g @nanonets/graft',
  'Install Trail: npm install -g @trailhq/trail-code',
  'Confirm it works: trail version',
  'From the workspace root, rebuild the context graph: trail build',
  'Optional — re-wire agent instruction files: trail init -y',
  'Reload this dashboard',
];

const TRAIL_INIT_STEPS = [
  'Open a terminal at the workspace root',
  'Build the context graph: trail build',
  'Optional — wire Cursor / Copilot rules: trail init -y',
  'Reload this dashboard (or reopen the Trail tab)',
];

const GIT_INSTALL_STEPS = [
  'Install Git for your OS: https://git-scm.com/downloads',
  'Confirm it is on PATH: git --version',
  'Restart the terminal / IDE, then reload this dashboard',
];

const GIT_INIT_STEPS = [
  'Open a terminal at the workspace root',
  'Initialize the repository: git init',
  'Optional — create the first commit: git add . && git commit -m "Initial commit"',
  'Reload this dashboard (or reopen the Git tab)',
];

function runGit(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
}

function pushCapped(list, entry, state) {
  if (list.length >= MAX_GIT_PATHS) {
    state.truncated = true;
    return;
  }
  list.push(entry);
}

/**
 * Parse `git status --porcelain=v1 -b` into staged / unstaged / untracked /
 * conflicted rows. Branch line: `## main...origin/main [ahead 1, behind 2]`.
 */
export function parseGitStatusPorcelain(text) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const conflicted = [];
  const state = { truncated: false };
  let branch = null;
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  let detached = false;

  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    if (!raw) continue;
    if (raw.startsWith('## ')) {
      const head = raw.slice(3).trim();
      const aheadM = head.match(/\[ahead (\d+)/);
      const behindM = head.match(/behind (\d+)/);
      if (aheadM) ahead = Number(aheadM[1]) || 0;
      if (behindM) behind = Number(behindM[1]) || 0;
      const core = head.replace(/\s*\[.*$/, '').trim();
      if (core.startsWith('HEAD (no branch)') || core === 'HEAD') {
        detached = true;
        branch = 'HEAD';
        upstream = null;
      } else {
        const dots = core.indexOf('...');
        if (dots >= 0) {
          branch = core.slice(0, dots) || null;
          upstream = core.slice(dots + 3) || null;
        } else {
          branch = core || null;
          upstream = null;
        }
      }
      continue;
    }
    if (raw.length < 3) continue;
    const x = raw[0];
    const y = raw[1];
    let path = raw.slice(3);
    const arrow = path.indexOf(' -> ');
    if (arrow >= 0) path = path.slice(arrow + 4);
    path = path.replace(/^"|"$/g, '');
    const code = `${x}${y}`;
    const entry = { path, code };
    if (x === '?' || y === '?') {
      pushCapped(untracked, entry, state);
      continue;
    }
    if (x === 'U' || y === 'U' || code === 'DD' || code === 'AA') {
      pushCapped(conflicted, entry, state);
      continue;
    }
    if (x !== ' ' && x !== '?') pushCapped(staged, { path, code: x }, state);
    if (y !== ' ' && y !== '?') pushCapped(unstaged, { path, code: y }, state);
  }

  return {
    branch,
    upstream,
    ahead,
    behind,
    detached,
    staged,
    unstaged,
    untracked,
    conflicted,
    truncated: state.truncated,
  };
}

/**
 * Workspace git status for the Git tab. Cached briefly so hook bursts do not
 * re-run git on every persist. Pass `{ force: true }` for the live `/git` route.
 */
export function collectGitStatus(cwd = repoRoot, { force = false } = {}) {
  const now = Date.now();
  const root = resolve(cwd || repoRoot);
  if (
    !force
    && gitStatusCache.value
    && gitStatusCache.cwd === root
    && now - gitStatusCache.at < GIT_STATUS_CACHE_MS
  ) {
    return gitStatusCache.value;
  }

  const result = emptyGitStatus();
  result.checkedAt = now;
  result.root = root;

  const inside = runGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.error && inside.error.code === 'ENOENT') {
    result.error = 'git not available on PATH';
    result.steps = [...GIT_INSTALL_STEPS];
    gitStatusCache = { at: now, cwd: root, value: result };
    return result;
  }
  result.installed = true;
  if (inside.status !== 0) {
    result.error = (inside.stderr || inside.stdout || 'not a git repository').trim().slice(0, 200)
      || 'not a git repository';
    result.steps = [...GIT_INIT_STEPS];
    gitStatusCache = { at: now, cwd: root, value: result };
    return result;
  }
  result.initialized = true;

  const top = runGit(root, ['rev-parse', '--show-toplevel']);
  if (top.status === 0) result.root = (top.stdout || '').trim() || root;
  else result.root = root;

  const head = runGit(root, ['rev-parse', '--short', 'HEAD']);
  if (head.status === 0) result.head = (head.stdout || '').trim() || null;

  const subject = runGit(root, ['log', '-1', '--format=%s']);
  if (subject.status === 0) {
    const line = (subject.stdout || '').trim();
    result.subject = line ? line.slice(0, 200) : null;
  }

  // -uall expands untracked directories into every file (default porcelain only
  // reports `?? .ai/`, which hides the working-copy file list on the Git tab).
  const status = runGit(root, ['status', '--porcelain=v1', '-b', '-uall']);
  if (status.status !== 0) {
    result.error = (status.stderr || status.stdout || 'git status failed').trim().slice(0, 200)
      || 'git status failed';
    gitStatusCache = { at: now, cwd: root, value: result };
    return result;
  }

  const parsed = parseGitStatusPorcelain(status.stdout || '');
  result.ok = true;
  result.error = null;
  result.branch = parsed.branch;
  result.upstream = parsed.upstream;
  result.ahead = parsed.ahead;
  result.behind = parsed.behind;
  result.detached = parsed.detached;
  result.staged = parsed.staged;
  result.unstaged = parsed.unstaged;
  result.untracked = parsed.untracked;
  result.conflicted = parsed.conflicted;
  result.truncated = parsed.truncated;
  result.clean = !(
    parsed.staged.length
    || parsed.unstaged.length
    || parsed.untracked.length
    || parsed.conflicted.length
  );

  result.steps = [];
  gitStatusCache = { at: now, cwd: root, value: result };
  return result;
}

const TRAIL_STATUS_CACHE_MS = 2000;
let trailStatusCache = { at: 0, cwd: '', value: null };

function runContextCli(cwd, bin, args, env = process.env) {
  return spawnSync(bin, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 512 * 1024,
    windowsHide: true,
  });
}

/**
 * Probe whether `bin` (`trail` or `graft`) is the context-graph CLI
 * (`ask` / `build` / `init`). Rejects unrelated packages that happen to share
 * the name (e.g. the microservices npm package `graft`).
 */
function probeContextCli(cwd, bin, env = process.env) {
  const version = runContextCli(cwd, bin, ['-v'], env);
  if (version.error && version.error.code === 'ENOENT') {
    return { found: false, valid: false, version: null, missing: true };
  }
  const askHelp = runContextCli(cwd, bin, ['ask', '--help'], env);
  const askText = `${askHelp.stdout || ''}\n${askHelp.stderr || ''}`;
  const valid = askHelp.status === 0 || /\bask\b/i.test(askText);
  if (!valid) {
    return { found: true, valid: false, version: null, missing: false };
  }
  const verText = (version.stdout || version.stderr || '').trim();
  const parsed = verText.replace(/^(?:trail|graft)\s+/i, '').split(/\s+/)[0] || verText || null;
  return { found: true, valid: true, version: parsed, missing: false };
}

function trailGraphInitialized(graphDir) {
  return existsSync(join(graphDir, 'INDEX.md'))
    || existsSync(join(graphDir, '.graph', 'wiring.json'));
}

function legacyGraftGraphPresent(root) {
  const graphDir = join(root, 'graft');
  return existsSync(join(graphDir, 'INDEX.md'))
    || existsSync(join(graphDir, '.graph', 'wiring.json'));
}

/**
 * Whether Trail CLI is installed and `.trail/cache/` is built in this workspace.
 * Also probes the legacy `graft` CLI: if only Graft is present, readiness fails
 * with upgrade steps. Cached briefly like git status; pass `{ force: true }`
 * for live `/trail` / `/ready`. Optional `env` overrides PATH (tests).
 */
export function collectTrailStatus(cwd = repoRoot, { force = false, env = process.env } = {}) {
  const now = Date.now();
  const root = resolve(cwd || repoRoot);
  if (
    !force
    && trailStatusCache.value
    && trailStatusCache.cwd === root
    && now - trailStatusCache.at < TRAIL_STATUS_CACHE_MS
  ) {
    return trailStatusCache.value;
  }

  const result = emptyTrailStatus();
  result.checkedAt = now;
  result.root = root;
  result.graphDir = join(root, '.trail', 'cache');

  const trail = probeContextCli(root, 'trail', env);
  const graft = probeContextCli(root, 'graft', env);

  if (trail.valid) {
    result.cli = 'trail';
    result.installed = true;
    result.version = trail.version;

    result.initialized = trailGraphInitialized(result.graphDir);
    if (!result.initialized) {
      result.error = '.trail/cache graph not initialized in this workspace';
      result.steps = [...TRAIL_INIT_STEPS];
      trailStatusCache = { at: now, cwd: root, value: result };
      return result;
    }

    result.ok = true;
    result.error = null;
    result.steps = [];
    trailStatusCache = { at: now, cwd: root, value: result };
    return result;
  }

  if (graft.valid) {
    // Old Graft CLI is the context-graph tool — instruct upgrade to Trail.
    result.cli = 'graft';
    result.needsUpgrade = true;
    result.installed = false;
    result.version = graft.version;
    result.initialized = trailGraphInitialized(result.graphDir) || legacyGraftGraphPresent(root);
    result.error = 'Graft CLI detected — upgrade to Trail (@trailhq/trail-code)';
    result.steps = [...TRAIL_UPGRADE_STEPS];
    trailStatusCache = { at: now, cwd: root, value: result };
    return result;
  }

  // Neither context CLI found (or only unrelated binaries that share the name).
  const wrongTrail = trail.found && !trail.valid;
  const wrongGraft = graft.found && !graft.valid;
  if (wrongTrail || wrongGraft) {
    result.error = wrongTrail
      ? 'A different `trail` binary is on PATH (need @trailhq/trail-code)'
      : 'A different `graft` package is on PATH (need Trail: @trailhq/trail-code)';
    result.steps = [
      ...(wrongGraft ? ['Remove the unrelated package: npm uninstall -g graft'] : []),
      ...TRAIL_INSTALL_STEPS,
    ];
  } else {
    result.error = 'Trail CLI not found on PATH (Graft was not found either)';
    result.steps = [...TRAIL_INSTALL_STEPS];
  }
  trailStatusCache = { at: now, cwd: root, value: result };
  return result;
}

/**
 * Filesystem-only Trail readiness for hook persist (no CLI spawn — spawning
 * `trail` under the monitor lock made overlapping hooks time out). Full CLI
 * detection stays on `collectTrailStatus` / `GET /ready`.
 */
export function snapshotTrailStatus(cwd = repoRoot) {
  const result = emptyTrailStatus();
  result.checkedAt = Date.now();
  result.root = resolve(cwd || repoRoot);
  result.graphDir = join(result.root, '.trail', 'cache');
  result.initialized = trailGraphInitialized(result.graphDir);
  if (result.initialized) {
    result.ok = true;
    result.installed = true;
    result.cli = 'trail';
    result.error = null;
    result.steps = [];
    return result;
  }
  if (legacyGraftGraphPresent(result.root)) {
    // Old graft/ graph on disk — likely still on the pre-rename CLI.
    result.needsUpgrade = true;
    result.cli = 'graft';
    result.error = 'Legacy graft/ graph found — upgrade to Trail and run trail build';
    result.steps = [...TRAIL_UPGRADE_STEPS];
    return result;
  }
  result.error = '.trail/cache graph not initialized in this workspace';
  // Snapshot cannot see PATH; include install + build guidance.
  result.steps = [...TRAIL_INSTALL_STEPS];
  return result;
}

/** Combined readiness snapshot used on dashboard load (`GET /ready`). */
export function collectWorkspaceReady(cwd = repoRoot, { force = false } = {}) {
  return {
    checkedAt: Date.now(),
    git: collectGitStatus(cwd, { force }),
    trail: collectTrailStatus(cwd, { force }),
  };
}

export function laneKey(harness, sessionId) {
  return `${harness || 'github-copilot'}:${sessionId || 'unknown'}`;
}

/**
 * One harness + session pair ("lane"). Each lane owns its tools, recent
 * events, warnings, and counters, so the dashboard can show a tree of
 * harness > session and the figures for exactly one of them.
 */
function emptyLane(harness, sessionId) {
  return {
    key: laneKey(harness, sessionId),
    harness: harness || 'github-copilot',
    id: sessionId || null,
    source: null,
    active: false,
    startObserved: false,
    startEstimated: false,
    startedAtWall: null,
    endedAtWall: null,
    endReason: null,
    promptIndex: 0,
    promptStartedAtWall: null,
    promptToolAttempts: 0,
    prompts: [],
    plan: null,
    todos: [],
    todosUpdatedAtWall: null,
    todosTranscriptMtime: null,
    trail: emptyTrail(),
    trailTranscriptMtime: null,
    transcriptPath: null,
    tokens: emptyTokens(),
    tokenTurns: [],
    tokenSeen: [],
    turnOpen: false,
    notificationWaiting: null,
    notificationsSeen: 0,
    lastEventAtWall: null,
    lastEventName: null,
    elapsedWarned: false,
    promptElapsedWarned: false,
    promptCountWarned: false,
    bootId: '',
    tools: {},
    recent: [],
    warnings: [],
    subagents: { started: 0, stopped: 0 },
    agentErrors: 0,
    attemptTimes: [],
    repeatWarnedAt: {},
    summary: emptySummary(),
    // SDK session-listener fields (Copilot CLI joinSession path)
    currentIntent: '',
    currentTurnId: null,
    turnStartedAtWall: null,
    turnEndedAtWall: null,
    turnCount: 0,
    apiCallDurationMsSum: 0,
    apiCallDurationCount: 0,
    apiCallDurationMaxMs: 0,
    outsideToolMsEstimate: null,
    reasoning: {
      seen: false,
      active: false,
      blocks: 0,
      lastAtWall: null,
      lastId: null,
      // Raw text is never stored unless settings.persistReasoningText is on.
      textPersisted: false,
    },
    sdkUsageTurns: 0,
  };
}

/** Connection status for the optional Copilot SDK session listener. */
export function emptySdkListener() {
  return {
    status: 'idle', // idle | connecting | connected | disconnected | unsupported | error
    target: null,
    label: null,
    sessionId: null,
    reason: null,
    detail: null,
    startedAtWall: null,
    updatedAtWall: null,
    lastEventAtWall: null,
    lastEventType: null,
  };
}

export function defaultMonitorSettings() {
  return {
    sdkListenerEnabled: true,
    collectReasoningEvents: true,
    persistReasoningText: false,
    /** Poll / show Trail install+init status on the Trail tab. */
    detectTrail: true,
    /** Red tab badge + setup guide when Trail is missing or uninitialized. */
    enforceTrail: true,
    /** Poll / show Git install+init status on the Git tab. */
    detectGit: true,
    /** Red tab badge + setup guide when Git is missing or the folder is not a repo. */
    enforceGit: true,
    /** Kusă chat harness: OpenAI-compatible base URL (…/v1). */
    agentBaseUrl: '',
    /** Model id sent to the endpoint. */
    agentModel: 'gpt-4o-mini',
    /** Native tool-loop max model↔tool rounds before stopping. */
    agentMaxSteps: 100,
    /** `none` = no auth header; `apikey` = OpenAI-style Authorization: Bearer <api key>. */
    agentAuthMode: 'none',
    /** API key when agentAuthMode is `apikey`. */
    agentApiKey: '',
    /** `native` = Kusă OpenAI tool loop; `opencode` = @opencode-ai/sdk (needs `opencode` CLI). */
    agentBackend: 'native',
    /** 'ask-deny' = kusa_terminal/kusa_browse need a user yes first and a timeout denies them; 'ask-allow' asks but a timeout allows; 'allow' skips the prompt; 'deny' blocks them. */
    agentApprovalMode: 'ask-deny',
    /** Minutes an ask-deny / ask-allow prompt waits before the rule's timeout default. */
    agentApprovalTimeoutMinutes: 2,
    /** Minutes the composer Allow / Deny rules stay before reverting to ask-deny. */
    agentAllowDenyRevertMinutes: 15,
  };
}

function normalizeAgentMaxSteps(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 100;
  return Math.min(1000, Math.max(1, Math.floor(n)));
}

/** Ask-wait minutes (1–60). Kept in sync with approval.mjs max timeout. */
function normalizeApprovalTimeoutMinutes(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 2;
  return Math.min(60, Math.max(1, Math.floor(n)));
}

/** Temporary Allow/Deny window minutes (1–240). */
function normalizeAllowDenyRevertMinutes(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 15;
  return Math.min(240, Math.max(1, Math.floor(n)));
}

/**
 * Side-effect tool approval policy; unknown or legacy values (including bare
 * 'ask') fall back to the safe 'ask-deny'. Kept in sync with
 * src/agent/approval.mjs — this file must stay dependency-free.
 */
function normalizeApprovalMode(raw) {
  const mode = String(raw ?? '').trim().toLowerCase();
  if (mode === 'allow' || mode === 'deny') return mode;
  return mode === 'ask-allow' ? 'ask-allow' : 'ask-deny';
}

/** Milliseconds the approval gate waits for a human answer (from settings). */
export function approvalTimeoutMsFromSettings(settings = {}) {
  return normalizeApprovalTimeoutMinutes(settings?.agentApprovalTimeoutMinutes) * 60_000;
}

function normalizeMonitorSettings(raw = {}) {
  // Accept legacy detectGraft / enforceGraft from settings written before the rename.
  const detectTrail = (raw.detectTrail ?? raw.detectGraft) !== false;
  const detectGit = raw.detectGit !== false;
  // Accept legacy `bearer` / agentAuthToken from the first agent settings shape.
  const agentAuthMode = (raw.agentAuthMode === 'apikey' || raw.agentAuthMode === 'bearer')
    ? 'apikey'
    : 'none';
  const agentBackend = raw.agentBackend === 'opencode' ? 'opencode' : 'native';
  // Prefer agentApiKey; fall back to legacy agentAuthToken when the new field is empty/absent.
  let apiKeyRaw = '';
  if (typeof raw.agentApiKey === 'string' && raw.agentApiKey) apiKeyRaw = raw.agentApiKey;
  else if (typeof raw.agentAuthToken === 'string' && raw.agentAuthToken) apiKeyRaw = raw.agentAuthToken;
  else if (typeof raw.agentApiKey === 'string') apiKeyRaw = raw.agentApiKey;
  return {
    sdkListenerEnabled: raw.sdkListenerEnabled !== false,
    collectReasoningEvents: raw.collectReasoningEvents !== false,
    persistReasoningText: raw.persistReasoningText === true,
    detectTrail,
    // Enforcement requires detection; turning detect off clears enforce.
    enforceTrail: detectTrail && (raw.enforceTrail ?? raw.enforceGraft) !== false,
    detectGit,
    enforceGit: detectGit && raw.enforceGit !== false,
    agentBaseUrl: typeof raw.agentBaseUrl === 'string' ? raw.agentBaseUrl.trim() : '',
    agentModel: typeof raw.agentModel === 'string' && raw.agentModel.trim()
      ? raw.agentModel.trim().slice(0, 200)
      : 'gpt-4o-mini',
    agentMaxSteps: normalizeAgentMaxSteps(raw.agentMaxSteps),
    agentAuthMode,
    agentApiKey: typeof apiKeyRaw === 'string' ? apiKeyRaw.slice(0, 4000) : '',
    agentBackend,
    agentApprovalMode: normalizeApprovalMode(raw.agentApprovalMode),
    agentApprovalTimeoutMinutes: normalizeApprovalTimeoutMinutes(raw.agentApprovalTimeoutMinutes),
    agentAllowDenyRevertMinutes: normalizeAllowDenyRevertMinutes(raw.agentAllowDenyRevertMinutes),
  };
}

/**
 * Read settings.json into memory (agentApiKey decrypted when encrypted on disk).
 * Migrates legacy plaintext agentApiKey to agentApiKeyEnc on first load.
 */
export function loadMonitorSettings(dir) {
  const defaults = defaultMonitorSettings();
  const path = join(dir, 'settings.json');
  if (!existsSync(path)) return { ...defaults };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object') return { ...defaults };
    const { memory, migrate } = settingsFromDisk(raw);
    const normalized = normalizeMonitorSettings(memory);
    if (migrate) writeSettingsFile(dir, normalized);
    return normalized;
  } catch {
    return { ...defaults };
  }
}

export function saveMonitorSettings(dir, patch = {}) {
  const normalized = normalizeMonitorSettings({ ...loadMonitorSettings(dir), ...patch });
  writeSettingsFile(dir, normalized);
  return normalized;
}

/** Decode on-disk settings; decrypt agentApiKeyEnc → agentApiKey for in-memory use. */
function settingsFromDisk(raw) {
  const out = { ...raw };
  let migrate = false;
  const hasEnc = isSecretEnvelope(raw.agentApiKeyEnc);
  const plain = typeof raw.agentApiKey === 'string' ? raw.agentApiKey : '';
  const legacy = typeof raw.agentAuthToken === 'string' ? raw.agentAuthToken : '';

  if (hasEnc) {
    try {
      out.agentApiKey = decryptSecret(raw.agentApiKeyEnc);
    } catch {
      // Wrong master key / corrupt envelope — treat as unset rather than crash serve.
      out.agentApiKey = '';
    }
    delete out.agentApiKeyEnc;
  } else if (plain || legacy) {
    out.agentApiKey = plain || legacy;
    migrate = Boolean(out.agentApiKey);
  }

  return { memory: out, migrate };
}

/** Persist settings with agentApiKey encrypted; never write plaintext secrets. */
function writeSettingsFile(dir, memorySettings) {
  mkdirSync(dir, { recursive: true });
  const disk = settingsToDisk(memorySettings);
  const path = join(dir, 'settings.json');
  const tmp = join(dir, `settings.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(disk, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* best effort on platforms without chmod */ }
}

function settingsToDisk(memorySettings) {
  const s = normalizeMonitorSettings(memorySettings);
  const {
    agentApiKey,
    ...rest
  } = s;
  /** @type {Record<string, unknown>} */
  const disk = { ...rest };
  delete disk.agentAuthToken;
  delete disk.agentApiKeyEnc;
  delete disk.agentApiKeySet;
  if (typeof agentApiKey === 'string' && agentApiKey) {
    disk.agentApiKeyEnc = encryptSecret(agentApiKey);
  }
  return disk;
}

/** Session-level token totals (Cursor stop / afterAgentResponse). */
function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
}

/** Trail usage mix for one session (mirrors `.trail/cache/.cache/session/<id>.json`). */
function emptyTrail() {
  return {
    trailReads: 0,
    sourceReads: 0,
    savedTokens: 0,
    host: '',
    vizUrl: TRAIL_VIZ_URL,
  };
}

/** Sum `[trail] tokens saved ≈ N` footers in tool output (also accepts legacy `[graft]`). */
export function sumTrailFooters(text) {
  if (typeof text !== 'string' || !text.includes('tokens saved')) return 0;
  let total = 0;
  for (const match of text.matchAll(/\[(?:trail|graft)\] tokens saved ≈ ([\d,]+)/g)) {
    total += Number(match[1].replace(/,/g, '')) || 0;
  }
  return total;
}

/** Parse the agent’s turn tally line: `🌱 trail saved ~N tokens` (also accepts legacy graft). */
export function parseTrailTurnSavings(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/🌱\s*(?:trail|graft) saved\s*~?([\d,]+)\s*tokens/i)
    || text.match(/(?:trail|graft) saved\s*~?([\d,]+)\s*tokens/i);
  if (!match) return null;
  const n = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function toolOutputBlob(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const candidates = [
    raw.tool_output,
    raw.toolOutput,
    raw.tool_response,
    raw.result_json,
    raw.toolResult && (raw.toolResult.textResultForLlm || raw.toolResult.content),
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value) return value;
    if (value && typeof value === 'object') {
      try { return JSON.stringify(value); } catch { /* ignore */ }
    }
  }
  return '';
}

function contentBlob(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    try { return JSON.stringify(content ?? ''); } catch { return ''; }
  }
  return content.map((part) => {
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (part.type === 'tool_result' && typeof part.content === 'string') return part.content;
    if (part.input) {
      try { return JSON.stringify(part.input); } catch { return ''; }
    }
    return '';
  }).join('\n');
}

/**
 * Cursor Plan Mode auto-submits this boilerplate when the user accepts a plan.
 * The transcript still wraps it in `<user_query>`, so detect by content.
 */
export function isPlanExecutionPrompt(text) {
  if (typeof text !== 'string' || !text) return false;
  return /Implement the plan as specified/i.test(text)
    && /Do NOT edit the plan file itself/i.test(text);
}

/**
 * Cursor wraps human chat submissions in `<user_query>`. Plan-execution
 * boilerplate (still wrapped that way) is `plan`. Other injected context is
 * `system`.
 */
export function classifyPromptRole(blob, explicit) {
  const named = String(explicit || '').toLowerCase();
  if (named === 'plan') return 'plan';
  if (named === 'system' || named === 'developer') return 'system';
  if (typeof blob === 'string' && isPlanExecutionPrompt(blob)) return 'plan';
  if (named === 'user') return 'user';
  if (typeof blob !== 'string' || !blob) return 'user';
  if (/<user_query>[\s\S]*?<\/user_query>/.test(blob) || /<user_query>/.test(blob)) return 'user';
  if (/<system_reminder>|<system\b|^\s*\[System\]/i.test(blob)) return 'system';
  return 'user';
}

/** Re-classify stored prompts from their text (fixes plan-execution rows). */
function syncPromptRoles(lane) {
  if (!lane?.prompts?.length) return;
  for (const prompt of lane.prompts) {
    prompt.role = classifyPromptRole(prompt.text || '');
  }
}

function planSnapshot(lane) {
  if (!lane?.plan) return null;
  return {
    name: lane.plan.name || '',
    overview: lane.plan.overview || '',
    body: lane.plan.body || '',
    path: lane.plan.path || '',
    source: lane.plan.source || '',
    atWall: lane.plan.atWall,
  };
}

function todoSnapshot(lane) {
  if (!Array.isArray(lane?.todos) || !lane.todos.length) return null;
  return lane.todos.map((todo) => ({
    id: todo.id || '',
    content: todo.content || '',
    status: todo.status || 'pending',
  }));
}

/**
 * Ensure plan-execution turns (and turns that overlapped plan creation) carry
 * a plan snapshot. Session-level `lane.plan` alone is not enough for history.
 */
function syncPlansOntoPrompts(lane) {
  if (!lane?.prompts?.length) return;
  const snapshot = planSnapshot(lane);
  if (!snapshot) return;
  const todos = todoSnapshot(lane);
  const planAt = lane.plan.atWall;
  for (const prompt of lane.prompts) {
    const isExec = prompt.role === 'plan' || isPlanExecutionPrompt(prompt.text || '');
    let inWindow = false;
    if (planAt != null && prompt.atWall != null) {
      const start = prompt.atWall;
      const end = prompt.endedAtWall != null ? prompt.endedAtWall : Date.now();
      inWindow = planAt >= start && planAt <= end + 5_000;
    }
    if (!isExec && !inWindow) continue;
    if (!prompt.plan) prompt.plan = { ...snapshot };
    if (todos && !prompt.todos?.length) prompt.todos = todos.map((t) => ({ ...t }));
  }
}

/**
 * Walk an agent transcript and collect trail savings per user turn (oldest first).
 * Prefers the reply’s `🌱 trail saved ~N` tally; falls back to summing footers.
 * Each turn also carries a prompt `role` (`user` | `system`) from the user row.
 */
export function trailSavingsFromTranscript(text) {
  if (typeof text !== 'string' || !text) return [];
  const turns = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    turns.push({
      reportedTokens: current.reportedTokens,
      footerTokens: current.footerTokens,
      savedTokens: current.reportedTokens != null ? current.reportedTokens : (current.footerTokens || null),
      role: current.role || 'user',
    });
    current = null;
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const role = row.role;
    if (role === 'user') {
      flush();
      const blob = contentBlob(row?.message?.content);
      current = {
        reportedTokens: null,
        footerTokens: 0,
        role: classifyPromptRole(blob, row.prompt_role || row.promptRole),
      };
      continue;
    }
    if (!current) continue;
    const blob = contentBlob(row?.message?.content);
    if (!blob) continue;
    current.footerTokens += sumTrailFooters(blob);
    const reported = parseTrailTurnSavings(blob);
    if (reported != null) current.reportedTokens = reported;
  }
  flush();
  return turns;
}

function loadTrailSessionCache(lane) {
  if (!lane?.id) return;
  const path = join(repoRoot, '.trail', 'cache', '.cache', 'session', `${lane.id}.json`);
  if (!existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    if (!lane.trail || typeof lane.trail !== 'object') lane.trail = emptyTrail();
    // Trail session JSON still uses graftReads; accept trailReads if/when renamed.
    const reads = Number.isFinite(raw.trailReads) ? raw.trailReads
      : Number.isFinite(raw.graftReads) ? raw.graftReads : null;
    if (reads != null) lane.trail.trailReads = reads;
    if (Number.isFinite(raw.sourceReads)) lane.trail.sourceReads = raw.sourceReads;
    if (Number.isFinite(raw.savedTokens)) lane.trail.savedTokens = raw.savedTokens;
    if (typeof raw.host === 'string') lane.trail.host = raw.host;
    lane.trail.vizUrl = TRAIL_VIZ_URL;
  } catch { /* ignore */ }
}

function syncTrailSavings(lane) {
  if (!lane) return;
  loadTrailSessionCache(lane);
  const transcript = findAgentTranscript(lane);
  if (!transcript) {
    deriveTrailSavedFromPrompts(lane);
    return;
  }
  try {
    const st = statSync(transcript);
    if (lane.trailTranscriptMtime === st.mtimeMs) return;
    const turns = trailSavingsFromTranscript(readFileSync(transcript, 'utf8'));
    // Empty / unrecognized transcript formats (common for some Copilot paths)
    // must not wipe savings already attributed from postToolUse footers.
    if (!turns.length) {
      deriveTrailSavedFromPrompts(lane);
      lane.trailTranscriptMtime = st.mtimeMs;
      return;
    }
    const prompts = [...(lane.prompts || [])].sort((a, b) => (a.index || 0) - (b.index || 0));
    for (const prompt of prompts) prompt.trailSavedTokens = null;
    // Prefer full alignment when we have every prompt from #1; otherwise pair
    // closed prompts with tallied turns from the newest end. The open turn uses
    // footer totals from the latest transcript turn (live mid-reply figure).
    if (prompts[0]?.index === 1 && turns.length >= prompts.length) {
      for (let i = 0; i < prompts.length; i++) {
        const turn = turns[i];
        if (!turn) continue;
        if (turn.role) prompts[i].role = turn.role;
        if (prompts[i].open) prompts[i].trailSavedTokens = turn.footerTokens || null;
        else if (turn.savedTokens != null) prompts[i].trailSavedTokens = turn.savedTokens;
      }
    } else {
      const closedPrompts = prompts.filter((p) => !p.open);
      const closedTurns = turns.filter((t) => t.savedTokens != null);
      const n = Math.min(closedPrompts.length, closedTurns.length);
      for (let i = 0; i < n; i++) {
        const turn = closedTurns[closedTurns.length - 1 - i];
        const prompt = closedPrompts[closedPrompts.length - 1 - i];
        prompt.trailSavedTokens = turn.savedTokens;
        if (turn.role) prompt.role = turn.role;
      }
      const open = prompts.find((p) => p.open);
      const latest = turns[turns.length - 1];
      if (open && latest) {
        open.trailSavedTokens = latest.footerTokens || null;
        if (latest.role) open.role = latest.role;
      }
    }
    deriveTrailSavedFromPrompts(lane);
    lane.trailTranscriptMtime = st.mtimeMs;
  } catch { /* ignore */ }
}

function asTokenCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.floor(value), 1_000_000_000_000);
}

/** Null when the payload carried no token fields (Copilot / Local / older Cursor). */
function parseTokenUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const input = asTokenCount(raw.input_tokens ?? raw.inputTokens);
  const output = asTokenCount(raw.output_tokens ?? raw.outputTokens);
  const cacheRead = asTokenCount(raw.cache_read_tokens ?? raw.cacheReadTokens);
  const cacheWrite = asTokenCount(raw.cache_write_tokens ?? raw.cacheWriteTokens);
  if (input == null && output == null && cacheRead == null && cacheWrite == null) return null;
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
  };
}

function normalizeTodoItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = asString(raw.id, 80);
  const contentProvided = raw.content != null || raw.text != null || raw.title != null;
  const content = contentProvided ? asString(raw.content ?? raw.text ?? raw.title, 500) : '';
  const status = asString(raw.status, 40);
  if (!id && !content) return null;
  return {
    id: id || content.slice(0, 40),
    content: content || id,
    contentProvided,
    status: TODO_STATUSES.has(status) ? status : 'pending',
  };
}

/** Replace or merge todo rows on a lane. */
export function applyTodos(lane, todos, merge, wall) {
  if (!Array.isArray(todos)) return;
  const incoming = todos.map(normalizeTodoItem).filter(Boolean);
  if (!incoming.length && merge) return;
  if (!merge) {
    lane.todos = incoming.map(({ id, content, status }) => ({ id, content, status }));
  } else {
    const byId = new Map((lane.todos || []).map((todo) => [todo.id, { ...todo }]));
    for (const todo of incoming) {
      const prev = byId.get(todo.id);
      byId.set(todo.id, prev ? {
        id: todo.id,
        content: todo.contentProvided ? todo.content : prev.content,
        status: TODO_STATUSES.has(todo.status) ? todo.status : prev.status,
      } : { id: todo.id, content: todo.content, status: todo.status });
    }
    lane.todos = [...byId.values()];
  }
  lane.todosUpdatedAtWall = wall ?? Date.now();
}

/** Slim `{id,content,status}` rows for the per-session task sidecar. */
function slimTodoRows(todos) {
  return (Array.isArray(todos) ? todos : [])
    .map((todo) => {
      const n = normalizeTodoItem(todo);
      return n ? { id: n.id, content: n.content, status: n.status } : null;
    })
    .filter(Boolean);
}

/**
 * Write each session's Task List into `.kusa/kusa/tasks.json` (per-session,
 * not shared — the prompt queue is the workspace-shared one).
 */
function persistTasksSidecar(dir, state) {
  if (!dir || !state) return;
  /** @type {Record<string, { todos: object[], updatedAtWall: number }>} */
  const sessions = {};
  // Every lane key, including lanes that currently have no rows: a lane owns
  // its list, so its emptiness must win over anything still on disk.
  const laneKeys = new Set();
  for (const lane of Object.values(state.sessions || {})) {
    if (!lane?.key) continue;
    laneKeys.add(lane.key);
    const todos = slimTodoRows(lane.todos);
    if (!todos.length) continue;
    sessions[lane.key] = {
      todos,
      updatedAtWall: lane.todosUpdatedAtWall ?? Date.now(),
    };
  }
  // A session with no lane in this state is not this render's to rewrite — its
  // list may have been written straight to the sidecar by the task tools before
  // any lane existed, or its lane lives in another data dir. Keeping those
  // entries is what lets a task-tool write survive the re-render it triggers,
  // and hydrateTasksFromSidecar puts them back on the lane when it appears.
  for (const [key, entry] of Object.entries(loadTasks(dir) || {})) {
    if (laneKeys.has(key)) continue;
    sessions[key] = entry;
  }
  try {
    saveTasks(dir, sessions);
  } catch {
    /* disk must not break hook persist */
  }
}

/** Overlay per-session rows from tasks.json onto matching lanes (newer wins). */
function hydrateTasksFromSidecar(dir, state) {
  if (!dir || !state) return;
  let stored = {};
  try {
    stored = loadTasks(dir);
  } catch {
    return;
  }
  for (const [key, entry] of Object.entries(stored || {})) {
    const lane = state.sessions?.[key];
    if (!lane || !entry?.todos?.length) continue;
    const storedAt = entry.updatedAtWall ?? 0;
    const laneAt = lane.todosUpdatedAtWall ?? 0;
    if (storedAt >= laneAt || !lane.todos?.length) {
      lane.todos = entry.todos.map((todo) => ({ ...todo }));
      lane.todosUpdatedAtWall = storedAt || Date.now();
    }
  }
}

/** Snapshot session plan/todos onto the open (or newest) prompt for history. */
function attachPlanToOpenPrompt(lane, options = {}) {
  const prompt = lane.prompts?.find((entry) => entry.open) || lane.prompts?.[0];
  if (!prompt) return;
  if (lane.plan) {
    prompt.plan = {
      name: lane.plan.name || '',
      overview: lane.plan.overview || '',
      body: lane.plan.body || '',
      path: lane.plan.path || '',
      source: lane.plan.source || '',
      atWall: lane.plan.atWall,
    };
  }
  if (options.todos) {
    prompt.todos = options.todos.map((todo) => ({
      id: todo.id || '',
      content: todo.content || '',
      status: todo.status || 'pending',
    }));
  }
}

export function setPlan(lane, plan, wall) {
  if (!plan || typeof plan !== 'object') return;
  const body = typeof plan.body === 'string' ? plan.body.slice(0, MAX_PLAN_TEXT) : '';
  const name = asString(plan.name, 160);
  const overview = asString(plan.overview, 500);
  if (!body && !name && !overview) return;
  lane.plan = {
    name,
    overview,
    body,
    path: asString(plan.path, 200),
    source: asString(plan.source, 40) || 'hooks',
    atWall: wall ?? Date.now(),
  };
  attachPlanToOpenPrompt(lane);
}

/**
 * Parse Cursor Plan Mode markdown (`---` YAML frontmatter + body).
 * Only the fields we need — not a general YAML parser.
 */
export function parsePlanMarkdown(text, path = '') {
  if (typeof text !== 'string' || !text.trim()) return null;
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const front = match ? match[1] : '';
  const body = (match ? match[2] : text).slice(0, MAX_PLAN_TEXT);
  const name = front.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') || '';
  const overview = front.match(/^overview:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') || '';
  const todos = [];
  // Only indented lines under `todos:` (avoids `$` matching every EOL in /m mode).
  const todosBlock = front.match(/^todos:\s*\n((?:[ \t]+.*\n?)+)/m);
  if (todosBlock) {
    let current = null;
    for (const line of todosBlock[1].split(/\r?\n/)) {
      const start = line.match(/^\s*-\s+id:\s*(.+)\s*$/);
      if (start) {
        if (current) todos.push(current);
        current = { id: start[1].trim().replace(/^["']|["']$/g, ''), content: '', status: 'pending' };
        continue;
      }
      if (!current) continue;
      const content = line.match(/^\s+content:\s*(.+)\s*$/);
      if (content) { current.content = content[1].trim().replace(/^["']|["']$/g, ''); continue; }
      const status = line.match(/^\s+status:\s*(.+)\s*$/);
      if (status) current.status = status[1].trim().replace(/^["']|["']$/g, '');
    }
    if (current) todos.push(current);
  }
  if (!body && !name && !overview && !todos.length) return null;
  return {
    plan: { name, overview, body, path, source: 'plan-file' },
    todos: todos.map(normalizeTodoItem).filter(Boolean),
  };
}

/**
 * Pull plan / todo updates out of tool arguments. Handles TodoWrite,
 * CreatePlan, CallDynamicTool wrappers, and Write of `*.plan.md`.
 */
export function extractPlanTodo(toolName, toolArgs) {
  const outer = argsObject(toolArgs);
  if (!outer && typeof toolName !== 'string') return null;
  let name = toolName || '';
  let args = outer || {};
  // Composer routes many cursor tools through CallDynamicTool.
  if (/^CallDynamicTool$/i.test(name) || (args.namespace && (args.toolName || args.tool_name))) {
    const innerName = asString(args.toolName || args.tool_name, 80);
    const innerArgs = argsObject(args.arguments || args.tool_input || args.input || args.args);
    if (innerName) {
      name = innerName;
      if (innerArgs) args = innerArgs;
    }
  }
  if (/^(TodoWrite|update_todos|UpdateTodos)$/i.test(name) || (Array.isArray(args.todos) && ('merge' in args || name.toLowerCase().includes('todo')))) {
    if (!Array.isArray(args.todos)) return null;
    return { kind: 'todos', todos: args.todos, merge: args.merge !== false && args.merge !== 'false' };
  }
  if (/^(CreatePlan|create_plan)$/i.test(name) || (typeof args.plan === 'string' && (args.todos || args.overview || args.name))) {
    const parsed = typeof args.plan === 'string'
      ? { plan: { name: args.name, overview: args.overview, body: args.plan, path: '', source: 'create-plan' }, todos: Array.isArray(args.todos) ? args.todos : [] }
      : null;
    if (!parsed) return null;
    return { kind: 'plan', ...parsed, merge: false };
  }
  const filePath = filePathOf(args);
  if (filePath && /\.plan\.md$/i.test(filePath)) {
    const contents = firstStringArg(args, ['contents', 'content', 'text', 'new_string', 'newString']);
    if (!contents) return { kind: 'plan-path', path: filePath };
    const parsed = parsePlanMarkdown(contents, filePath);
    if (!parsed) return null;
    return { kind: 'plan', ...parsed, merge: false };
  }
  return null;
}

function applyPlanTodoUpdate(lane, update, wall) {
  if (!update || !lane) return;
  if (update.kind === 'plan' && update.plan) {
    setPlan(lane, update.plan, wall);
    if (Array.isArray(update.todos) && update.todos.length) {
      applyTodos(lane, update.todos, false, wall);
      attachPlanToOpenPrompt(lane, { todos: lane.todos || [] });
    }
    return;
  }
  if (update.kind === 'plan-path' && update.path) {
    tryLoadPlanFile(lane, update.path, wall);
    return;
  }
  if (update.kind === 'todos' || update.todos) {
    applyTodos(lane, update.todos, Boolean(update.merge), wall);
  }
}

/** Replay TodoWrite / CallDynamicTool{TodoWrite} calls from an agent transcript JSONL. */
export function todosFromTranscriptText(text) {
  if (typeof text !== 'string' || !text) return [];
  let todos = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('TodoWrite') && !line.includes('todos')) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const content = row?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || part.type !== 'tool_use') continue;
      const update = extractPlanTodo(part.name, part.input);
      if (!update || (update.kind !== 'todos' && !update.todos)) continue;
      const lane = { todos };
      applyTodos(lane, update.todos, Boolean(update.merge), 0);
      todos = lane.todos;
    }
  }
  return todos;
}

/**
 * Resolve a readable agent transcript for this lane. Prefer the path the
 * harness reported (`transcriptPath` on Copilot / Local / Cursor stop hooks),
 * then fall back to Cursor's on-disk layout by session id.
 */
function findAgentTranscript(lane) {
  const reported = typeof lane?.transcriptPath === 'string' ? lane.transcriptPath.trim() : '';
  if (reported && existsSync(reported) && statSync(reported).isFile()) return reported;
  const sessionId = lane?.id;
  if (!sessionId || !/^[A-Za-z0-9._-]{8,120}$/.test(sessionId)) return '';
  const root = join(homedir(), '.cursor', 'projects');
  let projects;
  try { projects = readdirSync(root, { withFileTypes: true }); } catch { return ''; }
  for (const entry of projects) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, 'agent-transcripts', sessionId, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return '';
}

function deriveTrailSavedFromPrompts(lane) {
  if (!lane?.trail || typeof lane.trail !== 'object') lane.trail = emptyTrail();
  const cachePath = join(repoRoot, '.trail', 'cache', '.cache', 'session', `${lane.id}.json`);
  if (existsSync(cachePath)) return;
  const sum = (lane.prompts || []).reduce((total, p) => total + (p.trailSavedTokens || 0), 0);
  if (sum > 0) lane.trail.savedTokens = sum;
}

function tryLoadPlanFile(lane, path, wall) {
  if (typeof path !== 'string' || !path) return false;
  // Allow home .cursor/plans and workspace-relative plan files only.
  const resolved = path.startsWith('~') ? join(homedir(), path.slice(1)) : path;
  if (!existsSync(resolved)) return false;
  try {
    const text = readFileSync(resolved, 'utf8');
    const parsed = parsePlanMarkdown(text, resolved);
    if (!parsed) return false;
    setPlan(lane, { ...parsed.plan, path: resolved, source: 'plan-file' }, wall);
    // Do not clobber todos already captured from TodoWrite hooks.
    if (parsed.todos.length && !(lane.todos || []).length) applyTodos(lane, parsed.todos, false, wall);
    return true;
  } catch {
    return false;
  }
}

/** Newest Plan Mode file under ~/.cursor/plans modified during this session. */
function loadRecentCursorPlan(lane) {
  const dir = join(homedir(), '.cursor', 'plans');
  let names;
  try { names = readdirSync(dir); } catch { return; }
  const started = lane.startedAtWall || 0;
  let best = null;
  for (const name of names) {
    if (!name.endsWith('.plan.md')) continue;
    const path = join(dir, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (started && st.mtimeMs + 60_000 < started) continue; // allow small clock skew
    if (!best || st.mtimeMs > best.mtimeMs) best = { path, mtimeMs: st.mtimeMs };
  }
  if (best) tryLoadPlanFile(lane, best.path, best.mtimeMs);
}

/**
 * Fill plan/todo gaps from the harness transcript when tool hooks miss them
 * (e.g. Cursor Composer routing TodoWrite through CallDynamicTool). Works for
 * any harness that reports `transcriptPath` or has a readable transcript.
 * Cursor Plan Mode files under ~/.cursor/plans stay Cursor-only.
 */
function syncPlanTodos(lane) {
  if (!lane) return;
  const transcript = findAgentTranscript(lane);
  if (transcript) {
    try {
      const st = statSync(transcript);
      if (lane.todosTranscriptMtime !== st.mtimeMs) {
        const todos = todosFromTranscriptText(readFileSync(transcript, 'utf8'));
        if (todos.length) {
          applyTodos(lane, todos, false, st.mtimeMs);
          lane.todosTranscriptMtime = st.mtimeMs;
        }
      }
    } catch { /* transcript unreadable */ }
  }
  if (lane.harness === 'cursor' && !lane.plan) loadRecentCursorPlan(lane);
}

/**
 * The top-level `session`, `tools`, `recent`, … fields mirror the lane the
 * last event belonged to. They exist for readers that want "the current
 * session" without walking `sessions`; the lane objects are the source.
 */
function syncAliases(state) {
  const lane = state.session;
  state.tools = lane.tools;
  state.recent = lane.recent;
  state.warnings = lane.warnings;
  state.subagents = lane.subagents;
  state.agentErrors = lane.agentErrors;
  state.attemptTimes = lane.attemptTimes;
  state.repeatWarnedAt = lane.repeatWarnedAt;
  state.summary = lane.summary;
}

export function emptyState(config, origin = 'hooks') {
  const state = {
    schemaVersion: 3, // 3 = index.json + <harness>/<session>.json files
    origin,
    harness: 'github-copilot',
    harnessesSeen: [],
    liveSessionVerified: false,
    focus: null,
    current: {},
    sessions: {},
    session: emptyLane('github-copilot', null),
    open: [],
    nextId: 1,
    monitoringErrors: [],
    seen: [],
    // Cross-source tool-call ids so hooks and SDK listener do not double-count.
    sdkCallIds: [],
    hookCallIds: [],
    nonCopilotPayloads: 0,
    truncatedPayloads: 0,
    duplicates: 0,
    lastNonCopilotKeys: [],
    sdkListener: emptySdkListener(),
    settings: defaultMonitorSettings(),
    config,
  };
  syncAliases(state);
  return state;
}

function allLanes(state) {
  const lanes = Object.values(state.sessions || {});
  if (state.session && !lanes.includes(state.session)) lanes.push(state.session);
  return lanes;
}

function laneOfInvocation(state, inv) {
  return (inv.laneKey && state.sessions[inv.laneKey]) || state.session;
}

function emptySummary() {
  return {
    attempts: 0,
    running: 0,
    success: 0,
    failed: 0,
    denied: 0,
    incomplete: 0,
    unmatched: 0,
    uncertain: 0,
    distinct: 0,
  };
}

function summarize(tools) {
  const summary = emptySummary();
  for (const tool of Object.values(tools)) {
    summary.attempts += tool.total;
    summary.running += tool.running;
    summary.success += tool.success;
    summary.failed += tool.failed;
    summary.denied += tool.denied;
    summary.incomplete += tool.incomplete;
    summary.unmatched += tool.unmatched;
    summary.uncertain += tool.uncertain;
    if (tool.total || tool.success || tool.failed || tool.denied || tool.incomplete || tool.unmatched) {
      summary.distinct += 1;
    }
  }
  return summary;
}

function recompute(state) {
  for (const lane of allLanes(state)) {
    for (const tool of Object.values(lane.tools)) {
      tool.running = 0;
      for (const child of Object.values(tool.children ?? {})) child.running = 0;
    }
  }
  for (const inv of state.open) {
    const tool = ensureTool(laneOfInvocation(state, inv), inv.toolName);
    tool.running += 1;
    const child = ensureChild(tool, inv.subName);
    if (child) child.running += 1;
  }
  for (const lane of allLanes(state)) lane.summary = summarize(lane.tools);
  syncAliases(state);
}

function ensureTool(lane, name) {
  if (!lane.tools[name]) lane.tools[name] = emptyTool();
  return lane.tools[name];
}

export function classifyFamily(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  // First-party Kusă chat agent — tagged so camelCase payloads are not
  // counted as GitHub Copilot.
  if (typeof raw.kusa_version === 'string' || raw.harness === 'kusa') return 'kusa';
  // Cursor's common schema is also snake_case, so it has to be recognized
  // before the VS Code Local check. Docs: cursor.com/docs/hooks.
  if (
    typeof raw.cursor_version === 'string'
    || 'conversation_id' in raw
    || 'generation_id' in raw
    || Array.isArray(raw.workspace_roots)
    || CURSOR_ONLY_EVENTS.has(raw.hook_event_name)
  ) return 'cursor';
  const camel = ['sessionId', 'toolName', 'toolArgs', 'stopReason', 'agentName', 'errorContext'].some((key) => key in raw);
  if (camel) return 'copilot';
  const snake = ['hook_event_name', 'session_id', 'tool_name', 'tool_input', 'tool_use_id', 'tool_response'].some((key) => key in raw);
  if (snake) return 'local';
  if (typeof raw.timestamp === 'number' && (typeof raw.cwd === 'string' || typeof raw.source === 'string')) return 'copilot';
  if (typeof raw.timestamp === 'string' && typeof raw.cwd === 'string') return 'local';
  return 'unknown';
}

function asString(value, max = 160) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function parseWall(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 0 && value < 1e12) return Math.round(value * 1000);
    return Math.round(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function fingerprintValue(value) {
  if (value == null) return '';
  let text;
  try {
    text = typeof value === 'string' ? value : stableStringify(value);
  } catch {
    return '';
  }
  if (!text) return '';
  if (text.length > 8000) text = text.slice(0, 8000);
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function classifyFailure(message, raw = null) {
  if (raw && raw.failure_type === 'permission_denied') return 'denied';
  if (typeof message !== 'string') return 'failed';
  if (/\b(permission denied|access denied|denied by|not permitted|user denied|blocked by (?:policy|hook|user)|requires approval)\b/i.test(message)) {
    return 'denied';
  }
  return 'failed';
}

const MAX_STORED_COMMANDS = 30;
const MAX_COMMAND_TEXT = 4_000;
const TERMINAL_TOOL = /terminal|^(bash|powershell|pwsh|sh|zsh|shell|run_command|execute_command|runCommand|executeCommand)$/i;
const COMMAND_WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'exec', 'command', 'builtin', 'nice', 'doas', 'timeout', 'stdbuf']);

export function isTerminalTool(toolName) {
  return typeof toolName === 'string' && TERMINAL_TOOL.test(toolName);
}

/** Collapse a shell command to one display line and cap its stored length. */
export function commandTextOf(commandLine) {
  if (typeof commandLine !== 'string') return '';
  const text = commandLine.replace(/[\u0000\r\n]+/g, ' ').replace(/[ \t]+/g, ' ').trim();
  if (!text) return '';
  return text.length > MAX_COMMAND_TEXT ? `${text.slice(0, MAX_COMMAND_TEXT)}…` : text;
}

/** Keep unique full command lines on a terminal child, oldest first. */
function rememberCommand(child, commandLine) {
  const text = commandTextOf(commandLine);
  if (!child || !text) return;
  if (!Array.isArray(child.commands)) child.commands = [];
  if (child.commands.includes(text) || child.commands.length >= MAX_STORED_COMMANDS) return;
  child.commands.push(text);
}

/**
 * Reduce a shell command line to the name of the program it runs.
 * The full command line is stored separately on that child row.
 */
export function commandNameOf(commandLine) {
  if (typeof commandLine !== 'string') return '';
  // Only the first simple command; drop pipelines / chains / redirections.
  let segments = commandLine.replace(/[\r\n]+/g, ' ; ').split(/\s*(?:&&|\|\||;|\||>|<)\s*/).filter(Boolean);
  // Skip a leading `cd somewhere` so `cd x && npm test` reports npm.
  while (segments.length > 1 && /^\s*(cd|pushd|set\s+-\w+|export\s+\w+=)/.test(segments[0])) segments.shift();
  const first = segments[0] ?? '';
  // Quote-aware split so `BAR="x y" node` does not yield `y` as a token.
  const tokens = (first.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index].replace(/^['"]|['"]$/g, '');
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index += 1; continue; }     // FOO=bar prefix
    if (COMMAND_WRAPPERS.has(token.toLowerCase())) {                         // sudo npm ... -> npm
      index += 1;
      while (index < tokens.length && tokens[index].startsWith('-')) index += 1; // skip wrapper flags
      continue;
    }
    if (token === '&' || token.startsWith('-') || token.startsWith('(') || token.startsWith('{')) { index += 1; continue; } // PowerShell call operator, flags
    const base = token.split(/[\\/]/).pop() ?? token;                        // /usr/bin/node -> node
    const clean = base.replace(/\.(exe|cmd|bat|ps1)$/i, '').replace(/[^\w.+-]/g, '');
    return clean ? clean.slice(0, 40) : '(other)';
  }
  return tokens.length ? '(other)' : '';
}

function argsObject(args) {
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed.startsWith('{')) return null;
    try { return argsObject(JSON.parse(trimmed)); } catch { return null; }
  }
  return args && typeof args === 'object' && !Array.isArray(args) ? args : null;
}

function firstStringArg(args, keys) {
  const object = argsObject(args);
  if (!object) return '';
  for (const key of keys) {
    if (typeof object[key] === 'string') return object[key];
  }
  return '';
}

function commandLineOf(args) {
  return firstStringArg(args, ['command', 'cmd', 'commandLine', 'script']);
}

// Tools whose main argument is a single file: Copilot view/edit/create,
// VS Code read_file/create_file/replace_string_in_file, Cursor Read/Write/
// StrReplace/Delete. Search tools (Grep, Glob, file_search) take patterns, not
// a file, so they stay out.
const FILE_TOOL = /(^|_)file(s)?($|_)|^(view|read|write|edit|create|delete|str_?replace|insert_edit|apply_patch|multi_replace|notebook_edit|edit_notebook|editnotebook)$/i;
const FILE_ARG_KEYS = ['file_path', 'filePath', 'path', 'target_file', 'targetFile', 'notebook_path', 'filename', 'fileName', 'file', 'uri'];

export function isFileTool(toolName) {
  return typeof toolName === 'string' && !isTerminalTool(toolName) && !/search|glob|grep|list|find/i.test(toolName) && FILE_TOOL.test(toolName);
}

function filePathOf(args) {
  return firstStringArg(args, FILE_ARG_KEYS);
}

function normalizeSlashes(path) {
  return path.replace(/^file:\/\/\/?/, (m) => (m.length > 7 ? '/' : '')).replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Reduce a file argument to a workspace-relative path. Paths outside every
 * known root keep only their final name, so home directories and other
 * absolute locations never reach the dashboard.
 */
export function fileLabelOf(filePath, roots = []) {
  if (typeof filePath !== 'string') return '';
  let path = normalizeSlashes(filePath.trim().replace(/[\r\n\t\0]/g, ''));
  if (!path) return '';
  const windows = (value) => /^[A-Za-z]:\//.test(value);
  for (const root of roots) {
    if (typeof root !== 'string' || !root.trim()) continue;
    const base = normalizeSlashes(root.trim());
    if (!base) continue;
    const fold = windows(base) || windows(path);
    const left = fold ? path.toLowerCase() : path;
    const right = fold ? base.toLowerCase() : base;
    if (left === right) { path = '.'; break; }
    if (left.startsWith(`${right}/`)) { path = path.slice(base.length + 1); break; }
  }
  if (path.startsWith('/') || windows(path) || path.startsWith('~')) {
    path = `…/${path.split('/').pop() || ''}`;
  }
  path = path.replace(/^(\.\/)+/, '').replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, '');
  if (!path) return '';
  if (path.length > 80) path = `…${path.slice(-79)}`;
  return path;
}

function workspaceRootsOf(raw) {
  const roots = [];
  if (typeof raw.cwd === 'string') roots.push(raw.cwd);
  if (Array.isArray(raw.workspace_roots)) for (const root of raw.workspace_roots) if (typeof root === 'string') roots.push(root);
  if (Array.isArray(raw.workspaceRoots)) for (const root of raw.workspaceRoots) if (typeof root === 'string') roots.push(root);
  roots.push(process.cwd());
  return roots;
}

function subNameOf(toolName, toolArgs, raw) {
  if (isTerminalTool(toolName)) return commandNameOf(commandLineOf(toolArgs));
  if (isFileTool(toolName)) return fileLabelOf(filePathOf(toolArgs), workspaceRootsOf(raw));
  return '';
}

function callIdOf(raw) {
  const value = raw.toolUseId ?? raw.toolCallId ?? raw.tool_use_id ?? raw.tool_call_id;
  return asString(value, 120);
}

function failureMessage(raw) {
  if (typeof raw.error_message === 'string') return raw.error_message;
  if (typeof raw.error === 'string') return raw.error;
  if (raw.error && typeof raw.error === 'object' && typeof raw.error.message === 'string') return raw.error.message;
  return '';
}

export function normalizeEvent(raw, declaredName, clocks, extras = {}) {
  const family = classifyFamily(raw);
  const canonical = canonicalEventName(declaredName);
  const declared = KNOWN_EVENTS.has(canonical) ? canonical : asString(canonical, 80) || 'unknown';
  if (family === 'invalid' || family === 'unknown') {
    return { ignore: true, reason: family, keys: raw && typeof raw === 'object' ? Object.keys(raw).slice(0, 24) : [], declared };
  }
  // The VS Code Local harness maps this Copilot-format config onto its own
  // events and delivers snake_case payloads (observed in a real session).
  // Cursor sends the same shape plus cursor_version / conversation_id.
  // Kusă agent uses Copilot-shaped camelCase with kusa_version.
  const local = family === 'local';
  const cursor = family === 'cursor';
  const kusa = family === 'kusa';
  const pick = (camel, snake) => (local || cursor ? raw[snake] : raw[camel]);
  const toolName = asString(pick('toolName', 'tool_name'), 120);
  const sessionId = asString(
    cursor ? (raw.conversation_id || raw.session_id) : pick('sessionId', 'session_id'),
    120,
  );
  const wall = parseWall(raw.timestamp, clocks.wall);
  const toolArgs = pick('toolArgs', 'tool_input');
  const fingerprint = extras.truncated ? '' : fingerprintValue(toolArgs);
  const toolResult = pick('toolResult', 'tool_result');
  const subName = extras.truncated ? '' : subNameOf(toolName, toolArgs, raw);
  const commandLine = !subName || !isTerminalTool(toolName) ? '' : commandTextOf(commandLineOf(toolArgs));
  const event = {
    ignore: false,
    harness: kusa ? 'kusa' : cursor ? 'cursor' : local ? 'vscode-local' : 'github-copilot',
    name: declared,
    sessionId,
    wall,
    wallSource: raw.timestamp == null ? 'hook-receipt' : 'harness',
    toolName,
    callId: callIdOf(raw) || asString(raw.tool_call_id, 120),
    agentId: asString(raw.subagent_id || pick('agentId', 'agent_id'), 120),
    agentName: asString(raw.subagent_type || (local || cursor ? raw.agent_name || raw.agent_type : raw.agentName || raw.agentType), 120),
    source: asString(cursor ? (raw.composer_mode || (raw.is_background_agent ? 'background' : raw.source)) : raw.source, 40),
    reason: asString(raw.reason, 40),
    stopReason: asString(pick('stopReason', 'stop_reason') || (cursor ? raw.status : ''), 40),
    errorContext: asString(pick('errorContext', 'error_context'), 40),
    notificationType: asString(raw.notification_type, 60),
    resultType: asString(toolResult && (toolResult.resultType || toolResult.result_type), 40),
    failureClass: declared === 'postToolUseFailure' ? classifyFailure(failureMessage(raw), raw) : '',
    fingerprint,
    truncated: Boolean(extras.truncated),
    promptChars: typeof raw.prompt === 'string' ? Math.min(raw.prompt.length, 1_000_000) : 0,
    promptText: typeof raw.prompt === 'string' ? raw.prompt.slice(0, MAX_PROMPT_TEXT) : '',
    // beforeSubmitPrompt / userPromptSubmitted are user submissions unless the
    // payload names another role (rare). Transcript sync may refine this later.
    promptRole: classifyPromptRole(
      typeof raw.prompt === 'string' ? raw.prompt : '',
      raw.role || raw.prompt_role || raw.promptRole || raw.message_role || raw.messageRole,
    ),
    // Cursor afterAgentResponse only — stop / agentStop do not carry the reply body.
    responseChars: declared === 'afterAgentResponse' && typeof raw.text === 'string'
      ? Math.min(raw.text.length, 1_000_000) : 0,
    responseText: declared === 'afterAgentResponse' && typeof raw.text === 'string'
      ? raw.text.slice(0, MAX_RESPONSE_TEXT) : '',
    generationId: asString(raw.generation_id || raw.generationId, 120),
    model: asString(raw.model || raw.model_id || raw.modelId, 80),
    tokens: parseTokenUsage(raw),
    planTodo: extras.truncated ? null : extractPlanTodo(toolName, toolArgs),
    // Parse savings numbers only; never keep the tool output body.
    trailSavedTokens: extras.truncated ? 0 : sumTrailFooters(toolOutputBlob(raw)),
    // Copilot / Local / Cursor stop hooks report this; used for trail + todos sync.
    transcriptPath: asString(raw.transcriptPath || raw.transcript_path, 500),
    subName,
    commandLine,
  };
  event.dedupKey = createHash('sha256')
    .update([
      event.name,
      event.sessionId,
      String(event.wall),
      event.toolName,
      event.callId,
      event.fingerprint,
      event.failureClass,
      event.notificationType,
      event.source,
      event.reason,
      event.generationId,
    ].join('\u0000'))
    .digest('hex');
  return event;
}

function pushRecent(state, entry, maxEvents) {
  const lane = state.session;
  lane.recent.unshift({ ...entry, harness: entry.harness || lane.harness || '' });
  if (lane.recent.length > maxEvents) lane.recent.length = maxEvents;
}

function pushWarning(state, warning) {
  const lane = state.session;
  lane.warnings.unshift(warning);
  if (lane.warnings.length > 80) lane.warnings.length = 80;
}

/** Close the open prompt row (newest-first) when the turn ends or a new prompt starts. */
function closeOpenPrompt(lane, wall) {
  const open = lane.prompts.find((entry) => entry.open);
  if (!open) return;
  open.open = false;
  open.endedAtWall = wall;
  open.durationMs = open.atWall != null && wall != null ? Math.max(0, wall - open.atWall) : null;
  open.toolAttempts = lane.promptToolAttempts;
}

/** Match a prompt row to a Cursor generation (or the open / newest turn). */
function promptForGeneration(lane, generationId) {
  return (generationId && lane.prompts.find((entry) => entry.generationId === generationId))
    || lane.prompts.find((entry) => entry.open)
    || lane.prompts[0]
    || null;
}

/**
 * Cursor `stop` and `afterAgentResponse` report the same turn totals for a
 * generation_id. Dedup on that id so registering both hooks cannot double-count.
 * Figures are parent-agent only; subagent spend is not included.
 */
function recordTokenUsage(lane, event) {
  const usage = event.tokens;
  if (!usage) return;
  const generationId = event.generationId || '';
  if (generationId && lane.tokenSeen.includes(generationId)) return;
  if (generationId) {
    lane.tokenSeen.unshift(generationId);
    if (lane.tokenSeen.length > 500) lane.tokenSeen.length = 500;
  }
  const prompt = promptForGeneration(lane, generationId);
  if (prompt) prompt.tokens = { ...usage };
  const uncached = Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite);
  lane.tokenTurns.unshift({
    generationId,
    promptIndex: prompt ? prompt.index : lane.promptIndex || null,
    atWall: event.wall,
    model: event.model || '',
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    uncached,
  });
  if (lane.tokenTurns.length > MAX_PROMPTS) lane.tokenTurns.length = MAX_PROMPTS;
  if (!lane.tokens || typeof lane.tokens !== 'object') lane.tokens = emptyTokens();
  lane.tokens.input += usage.input;
  lane.tokens.output += usage.output;
  lane.tokens.cacheRead += usage.cacheRead;
  lane.tokens.cacheWrite += usage.cacheWrite;
  lane.tokens.turns += 1;
}

function noteError(state, message, wall) {
  state.monitoringErrors.unshift({ atWall: wall, message: asString(message, 240) || 'monitoring error' });
  if (state.monitoringErrors.length > 40) state.monitoringErrors.length = 40;
}

/** Drop the oldest finished lanes of one harness once it has too many. */
function pruneLanes(state, harness) {
  // Kusă chat sessions are user-owned transcripts — never auto-drop them for the
  // per-harness cap (that would also orphan / delete .chat.json sidecars).
  if (harness === 'kusa') return;
  const lanes = Object.values(state.sessions).filter((lane) => lane.harness === harness);
  if (lanes.length <= MAX_LANES_PER_HARNESS) return;
  lanes.sort((a, b) => (b.lastEventAtWall ?? 0) - (a.lastEventAtWall ?? 0));
  const current = state.current[harness];
  const victims = lanes.slice(MAX_LANES_PER_HARNESS).filter((lane) => lane.key !== current && lane.key !== state.focus);
  for (const lane of victims) {
    delete state.sessions[lane.key];
    state.open = state.open.filter((inv) => inv.laneKey !== lane.key);
    (state.pruned ||= []).push(lane);
  }
}

/**
 * Remove one or more sessions by lane key (`harness:sessionId`). Files are
 * unlinked on the next persist. When the focused lane is removed, focus moves
 * to the most recently active remaining session.
 */
export function deleteSessions(dir, keys, { config, origin, nowWall = Date.now() } = {}) {
  const wanted = [...new Set((Array.isArray(keys) ? keys : []).map((key) => String(key || '').trim()).filter(Boolean))];
  if (!wanted.length) return { deleted: [], missing: [] };
  return withLock(dir, () => {
    const loaded = loadThresholds(dir, config);
    const { state } = readState(dir, loaded.config, origin || 'hooks');
    const deleted = [];
    const missing = [];
    let lostFocus = false;
    for (const key of wanted) {
      const lane = state.sessions[key];
      if (!lane) {
        // Kusă chat sidecar may exist without a monitor lane — still remove it.
        const chatGone = removeOrphanChat(dir, key);
        if (chatGone) deleted.push(key);
        else missing.push(key);
        continue;
      }
      if (state.focus === key) lostFocus = true;
      delete state.sessions[key];
      state.open = state.open.filter((inv) => inv.laneKey !== key);
      // Explicit delete may also remove the Kusă chat sidecar.
      if (lane.harness === 'kusa') lane._dropChat = true;
      (state.pruned ||= []).push(lane);
      deleted.push(key);
    }
    if (lostFocus || (state.focus && !state.sessions[state.focus])) {
      const remaining = Object.values(state.sessions)
        .sort((a, b) => (b.lastEventAtWall ?? 0) - (a.lastEventAtWall ?? 0));
      state.focus = remaining[0]?.key || null;
    }
    state.generatedAtWall = nowWall;
    finishState(state);
    persist(dir, state);
    return { deleted, missing };
  });
}

/** Best-effort remove of a Kusă `.chat.json` when no lane record exists. */
function removeOrphanChat(dir, key) {
  const text = String(key || '');
  if (!text.startsWith('kusa:')) return false;
  const id = text.slice('kusa:'.length);
  if (!id) return false;
  const path = join(harnessDir(dir, 'kusa'), `${sessionFileStem(id)}.chat.json`);
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Point `state.session` at the lane this event belongs to, creating it when a
 * new session id appears. An event without a session id lands in the harness's
 * current lane. The previous lane of that harness is kept, so the dashboard can
 * list every session the hooks have seen.
 */
function bindLane(state, event, clocks) {
  const harness = event.harness || 'github-copilot';
  if (!state.sessions || typeof state.sessions !== 'object' || Array.isArray(state.sessions)) state.sessions = {};
  if (!state.current || typeof state.current !== 'object') state.current = {};
  const key = event.sessionId ? laneKey(harness, event.sessionId) : (state.current[harness] || laneKey(harness, null));
  let lane = state.sessions[key];
  if (!lane) {
    lane = emptyLane(harness, event.sessionId || null);
    lane.active = true;
    lane.startedAtWall = event.wall;
    lane.startObserved = event.name === 'sessionStart';
    lane.startEstimated = event.name !== 'sessionStart';
    lane.bootId = clocks.bootId || '';
    state.sessions[key] = lane;
  }
  state.current[harness] = key;
  state.focus = key;
  state.session = lane;
  syncAliases(state);
  pruneLanes(state, harness);
}

function matchOpen(state, event) {
  const sameAgent = (inv) => (inv.agentId || '') === (event.agentId || '')
    && (inv.laneKey || state.focus) === state.focus;
  if (event.callId) {
    const index = state.open.findIndex((inv) => inv.callId === event.callId && sameAgent(inv));
    if (index >= 0) return { index, correlation: 'call-id' };
    const any = state.open.findIndex((inv) => inv.callId === event.callId);
    if (any >= 0) return { index: any, correlation: 'call-id' };
  }
  const candidates = [];
  for (let index = 0; index < state.open.length; index += 1) {
    const inv = state.open[index];
    if (inv.toolName === event.toolName && sameAgent(inv)) candidates.push(index);
  }
  if (candidates.length === 0) return { index: -1, correlation: 'missing-pre' };
  if (candidates.length === 1) return { index: candidates[0], correlation: 'fifo-unique' };
  if (event.fingerprint) {
    const finger = candidates.filter((index) => state.open[index].fingerprint === event.fingerprint);
    if (finger.length === 1) return { index: finger[0], correlation: 'fingerprint-unique' };
    const pool = finger.length > 1 ? finger : candidates;
    return { index: pool[0], correlation: 'fifo-ambiguous' };
  }
  return { index: candidates[0], correlation: 'fifo-ambiguous' };
}

function durationBetween(inv, event, clocks) {
  if (
    inv.startedMono != null &&
    clocks.mono != null &&
    inv.bootId === (clocks.bootId || '') &&
    clocks.mono >= inv.startedMono
  ) {
    return { ms: clocks.mono - inv.startedMono, source: 'monotonic' };
  }
  if (inv.startedWall != null && event.wall != null && event.wall >= inv.startedWall) {
    return { ms: event.wall - inv.startedWall, source: 'wall' };
  }
  return { ms: null, source: 'unavailable' };
}

function closeInvocation(state, event, clocks, outcome) {
  const toolName = event.toolName || '(unknown)';
  const tool = ensureTool(state.session, toolName);
  const { index, correlation } = matchOpen(state, event);
  let durationMs = null;
  let durationSource = 'unavailable';
  let invocationId = '';
  let child = null;
  let subName = event.subName || '';
  if (index >= 0) {
    const inv = state.open[index];
    const duration = durationBetween(inv, event, clocks);
    durationMs = duration.ms;
    durationSource = duration.source;
    invocationId = inv.id;
    subName = inv.subName || subName;
    state.open.splice(index, 1);
    recordDuration(tool, durationMs);
    child = ensureChild(tool, subName);
    rememberCommand(child, inv.commandLine || event.commandLine);
    recordDuration(child, durationMs);
    if (correlation === 'fifo-ambiguous') tool.uncertain += 1;
  } else {
    tool.unmatched += 1;
    invocationId = `unmatched-${state.nextId}`;
    state.nextId += 1;
    tool.lastInvocationWall = event.wall;
    child = ensureChild(tool, event.subName);
    if (child) {
      rememberCommand(child, event.commandLine);
      child.unmatched += 1;
      child.lastInvocationWall = event.wall;
    }
  }
  recordOutcome(tool, outcome);
  recordOutcome(child, outcome);
  return { invocationId, durationMs, durationSource, correlation, subName: child ? subName : '' };
}

function checkThresholds(state, clocks) {
  const { config } = state;
  const session = state.session;
  if (session.startedAtWall != null && session.active) {
    const elapsed = clocks.wall - session.startedAtWall;
    if (!session.elapsedWarned && elapsed >= config.sessionElapsedWarnMs) {
      session.elapsedWarned = true;
      pushWarning(state, {
        atWall: clocks.wall,
        code: 'session-elapsed',
        toolName: '',
        message: `session elapsed-time warning: ${formatDuration(elapsed)} since the observed session start`,
      });
    }
  }
  if (session.promptStartedAtWall != null && session.turnOpen) {
    const elapsed = clocks.wall - session.promptStartedAtWall;
    if (!session.promptElapsedWarned && elapsed >= config.promptElapsedWarnMs) {
      session.promptElapsedWarned = true;
      pushWarning(state, {
        atWall: clocks.wall,
        code: 'prompt-elapsed',
        toolName: '',
        message: `prompt elapsed-time warning: ${formatDuration(elapsed)} since the current prompt was submitted`,
      });
    }
  }
  if (!session.promptCountWarned && session.promptToolAttempts >= config.promptToolCountWarn) {
    session.promptCountWarned = true;
    pushWarning(state, {
      atWall: clocks.wall,
      code: 'prompt-tool-count',
      toolName: '',
      message: `prompt tool-count warning: ${session.promptToolAttempts} tool attempts since the current prompt`,
    });
  }
  const windowMs = config.repeatWindowMs;
  session.attemptTimes = session.attemptTimes.filter((item) => {
    if (item.mono != null && clocks.mono != null && item.bootId === (clocks.bootId || '')) {
      return clocks.mono - item.mono <= windowMs;
    }
    return clocks.wall - item.wall <= windowMs;
  });
  const counts = new Map();
  for (const item of session.attemptTimes) counts.set(item.tool, (counts.get(item.tool) ?? 0) + 1);
  for (const [tool, count] of counts) {
    if (count < config.repeatCount) continue;
    const previous = session.repeatWarnedAt[tool] ?? 0;
    if (clocks.wall - previous < windowMs) continue;
    session.repeatWarnedAt[tool] = clocks.wall;
    pushWarning(state, {
      atWall: clocks.wall,
      code: 'repeated-call',
      toolName: tool,
      message: `repeated-call warning: ${tool} invoked ${count} times within ${formatDuration(windowMs)}`,
    });
  }
  for (const inv of state.open) {
    if (inv.longWarned || (inv.laneKey || state.focus) !== state.focus) continue;
    const age = invocationAge(inv, clocks);
    if (age == null || age < config.toolDurationWarnMs) continue;
    inv.longWarned = true;
    pushWarning(state, {
      atWall: clocks.wall,
      code: 'long-running',
      toolName: inv.toolName,
      message: `long-running warning: ${inv.toolName} invocation ${inv.id} exceeded ${formatDuration(config.toolDurationWarnMs)}`,
    });
  }
}

function invocationAge(inv, clocks) {
  if (inv.startedMono != null && clocks.mono != null && inv.bootId === (clocks.bootId || '') && clocks.mono >= inv.startedMono) {
    return clocks.mono - inv.startedMono;
  }
  if (inv.startedWall != null) return Math.max(0, clocks.wall - inv.startedWall);
  return null;
}

function closeOpenAsIncomplete(state, event, clocks, filter, durationSource) {
  const keep = [];
  for (const inv of state.open) {
    if ((inv.laneKey || state.focus) !== state.focus || !filter(inv)) {
      keep.push(inv);
      continue;
    }
    const tool = ensureTool(state.session, inv.toolName);
    tool.incomplete += 1;
    const child = ensureChild(tool, inv.subName);
    if (child) child.incomplete += 1;
    pushRecent(state, {
      atWall: event.wall,
      event: 'incomplete',
      toolName: inv.toolName,
      subName: inv.subName || '',
      invocationId: inv.id,
      durationMs: invocationAge(inv, clocks),
      durationSource,
      correlation: 'missing-post',
      outcome: 'incomplete',
    }, state.config.maxEvents);
  }
  state.open = keep;
}

function rememberId(list, id, cap = 400) {
  if (!id) return;
  if (!Array.isArray(list)) return;
  if (list.includes(id)) return;
  list.push(id);
  if (list.length > cap) list.splice(0, list.length - cap);
}

function applyCopilotEvent(state, event, clocks) {
  const maxEvents = state.config.maxEvents;
  if (event.truncated) state.truncatedPayloads += 1;
  state.harness = event.harness;
  if (!Array.isArray(state.harnessesSeen)) state.harnessesSeen = [];
  if (!state.harnessesSeen.includes(event.harness)) state.harnessesSeen.push(event.harness);
  if (state.seen.includes(event.dedupKey)) {
    state.duplicates += 1;
    return;
  }
  // Same tool call already counted by the SDK listener (shared toolCallId).
  if (
    event.callId
    && Array.isArray(state.sdkCallIds)
    && state.sdkCallIds.includes(event.callId)
    && (event.name === 'preToolUse' || event.name === 'postToolUse' || event.name === 'postToolUseFailure')
  ) {
    state.duplicates += 1;
    pushRecent(state, {
      atWall: event.wall,
      event: event.name,
      toolName: event.toolName || '',
      invocationId: event.callId,
      durationMs: null,
      durationSource: '',
      correlation: 'sdk-dedup',
      outcome: 'duplicate-hook',
    }, maxEvents);
    return;
  }
  state.seen.push(event.dedupKey);
  if (state.seen.length > 300) state.seen.splice(0, state.seen.length - 300);
  bindLane(state, event, clocks);

  if (event.name === 'sessionStart') {
    state.session.active = true;
    state.session.source = event.source || state.session.source;
    state.session.startObserved = true;
    if (!state.session.startedAtWall) state.session.startedAtWall = event.wall;
    if (event.source === 'new' || event.source === 'startup') {
      state.session.endedAtWall = null;
      state.session.endReason = null;
    }
    pushRecent(state, {
      atWall: event.wall,
      event: 'sessionStart',
      toolName: '',
      invocationId: '',
      durationMs: null,
      durationSource: '',
      correlation: 'n/a',
      outcome: event.source || 'start',
    }, maxEvents);
  }

  state.session.lastEventAtWall = event.wall;
  state.session.lastEventName = event.name;
  if (event.transcriptPath) state.session.transcriptPath = event.transcriptPath;

  if (event.name === 'sessionEnd') {
    state.session.active = false;
    state.session.endedAtWall = event.wall;
    state.session.endReason = event.reason || 'unknown';
    state.session.turnOpen = false;
    closeOpenPrompt(state.session, event.wall);
    pushRecent(state, {
      atWall: event.wall,
      event: 'sessionEnd',
      toolName: '',
      invocationId: '',
      durationMs: null,
      durationSource: '',
      correlation: 'n/a',
      outcome: state.session.endReason,
    }, maxEvents);
    closeOpenAsIncomplete(state, event, clocks, () => true, 'incomplete-at-session-end');
  }

  if (event.name === 'userPromptSubmitted') {
    closeOpenPrompt(state.session, event.wall);
    state.session.promptIndex += 1;
    state.session.promptStartedAtWall = event.wall;
    state.session.promptToolAttempts = 0;
    state.session.turnOpen = true;
    state.session.promptElapsedWarned = false;
    state.session.promptCountWarned = false;
    state.session.notificationWaiting = false;
    const chars = event.promptChars || 0;
    const text = event.promptText || '';
    state.session.prompts.unshift({
      index: state.session.promptIndex,
      atWall: event.wall,
      endedAtWall: null,
      durationMs: null,
      chars,
      text,
      truncated: chars > text.length,
      role: event.promptRole || 'user',
      response: '',
      responseChars: 0,
      responseTruncated: false,
      plan: null,
      todos: null,
      toolAttempts: 0,
      open: true,
      generationId: event.generationId || '',
      model: event.model || '',
      tokens: null,
      trailSavedTokens: null,
    });
    if (state.session.prompts.length > MAX_PROMPTS) state.session.prompts.length = MAX_PROMPTS;
    pushRecent(state, {
      atWall: event.wall,
      event: 'userPromptSubmitted',
      toolName: '',
      invocationId: '',
      durationMs: null,
      durationSource: '',
      correlation: 'n/a',
      outcome: 'prompt',
      note: chars ? `${chars} characters` : 'empty prompt',
    }, maxEvents);
  }

  if (event.name === 'preToolUse' || event.name === 'postToolUse' || event.name === 'postToolUseFailure') {
    if (!event.toolName) event.toolName = '(unknown)';
  }

  if (event.name === 'preToolUse') {
    const toolName = event.toolName;
    const tool = ensureTool(state.session, toolName);
    const id = event.callId || `inv-${state.nextId}`;
    state.nextId += 1;
    if (!Array.isArray(state.hookCallIds)) state.hookCallIds = [];
    rememberId(state.hookCallIds, event.callId);
    tool.total += 1;
    tool.lastInvocationWall = event.wall;
    const child = ensureChild(tool, event.subName);
    if (child) {
      rememberCommand(child, event.commandLine);
      child.total += 1;
      child.lastInvocationWall = event.wall;
    }
    state.session.promptToolAttempts += 1;
    const openPrompt = state.session.prompts.find((entry) => entry.open);
    if (openPrompt) openPrompt.toolAttempts = state.session.promptToolAttempts;
    if (event.planTodo) applyPlanTodoUpdate(state.session, event.planTodo, event.wall);
    state.open.push({
      id,
      callId: event.callId || '',
      harness: event.harness || 'github-copilot',
      laneKey: state.session.key,
      toolName,
      subName: event.subName || '',
      agentId: event.agentId || '',
      startedWall: event.wall,
      startedMono: clocks.mono,
      bootId: clocks.bootId || '',
      fingerprint: event.fingerprint,
      commandLine: event.commandLine || '',
      promptIndex: state.session.promptIndex,
      longWarned: false,
    });
    state.session.attemptTimes.push({
      tool: toolName,
      wall: event.wall,
      mono: clocks.mono,
      bootId: clocks.bootId || '',
    });
    pushRecent(state, {
      atWall: event.wall,
      event: 'preToolUse',
      toolName,
      subName: event.subName || '',
      invocationId: id,
      durationMs: null,
      durationSource: '',
      correlation: event.callId ? 'call-id' : 'pending',
      outcome: event.planTodo?.kind === 'todos' ? 'todos' : event.planTodo?.kind === 'plan' ? 'plan' : 'attempt',
    }, maxEvents);
  }

  if (event.name === 'postToolUse' || event.name === 'postToolUseFailure') {
    const outcome = event.name === 'postToolUse'
      ? (event.resultType === 'failure' ? 'failed' : 'success')
      : (event.failureClass === 'denied' ? 'denied' : 'failed');
    const closed = closeInvocation(state, event, clocks, outcome);
    // Attribute trail footers from tool output onto the open prompt. This is the
    // primary path for Copilot (and any harness without a Cursor-style reply tally).
    if (event.name === 'postToolUse' && event.trailSavedTokens > 0) {
      const openPrompt = state.session.prompts.find((entry) => entry.open);
      if (openPrompt) {
        openPrompt.trailSavedTokens = (openPrompt.trailSavedTokens || 0) + event.trailSavedTokens;
      }
      if (!state.session.trail || typeof state.session.trail !== 'object') state.session.trail = emptyTrail();
      const cachePath = join(repoRoot, '.trail', 'cache', '.cache', 'session', `${state.session.id}.json`);
      if (!existsSync(cachePath)) {
        state.session.trail.savedTokens = (state.session.trail.savedTokens || 0) + event.trailSavedTokens;
      }
      state.session.trail.vizUrl = TRAIL_VIZ_URL;
    }
    pushRecent(state, {
      atWall: event.wall,
      event: event.name,
      toolName: event.toolName || '(unknown)',
      subName: closed.subName,
      invocationId: closed.invocationId,
      durationMs: closed.durationMs,
      durationSource: closed.durationSource,
      correlation: closed.correlation,
      outcome: event.trailSavedTokens > 0 ? 'trail-saved' : outcome,
    }, maxEvents);
  }

  if (event.name === 'agentStop') {
    state.session.turnOpen = false;
    state.session.notificationWaiting = null;
    recordTokenUsage(state.session, event);
    closeOpenPrompt(state.session, event.wall);
    // The Local harness has no failure event, so a failed call never gets a
    // post-tool event. Once the main agent stops, its calls cannot complete.
    closeOpenAsIncomplete(state, event, clocks, (inv) => !inv.agentId, 'incomplete-at-agent-stop');
    pushRecent(state, {
      atWall: event.wall,
      event: 'agentStop',
      toolName: '',
      invocationId: '',
      durationMs: null,
      durationSource: '',
      correlation: 'n/a',
      outcome: event.stopReason || 'end_turn',
    }, maxEvents);
  }

  // Reply text + token fields — does not close the turn (stop / agentStop does that).
  if (event.name === 'afterAgentResponse') {
    recordTokenUsage(state.session, event);
    const prompt = promptForGeneration(state.session, event.generationId || '');
    if (prompt && typeof event.responseText === 'string') {
      prompt.response = event.responseText;
      prompt.responseChars = event.responseChars || event.responseText.length;
      prompt.responseTruncated = (event.responseChars || 0) > event.responseText.length;
    }
    pushRecent(state, {
      atWall: event.wall,
      event: 'afterAgentResponse',
      toolName: event.model || '',
      invocationId: event.generationId || '',
      durationMs: null,
      durationSource: '',
      correlation: event.generationId ? 'generation-id' : 'n/a',
      outcome: event.tokens ? 'tokens' : 'response',
    }, maxEvents);
  }

  if (event.name === 'subagentStart') {
    state.session.subagents.started += 1;
    pushRecent(state, {
      atWall: event.wall,
      event: 'subagentStart',
      toolName: event.agentName || '',
      invocationId: event.agentId || '',
      durationMs: null,
      durationSource: '',
      correlation: 'n/a',
      outcome: 'subagent-start',
    }, maxEvents);
  }

  if (event.name === 'subagentStop') {
    state.session.subagents.stopped += 1;
    pushRecent(state, {
      atWall: event.wall,
      event: 'subagentStop',
      toolName: event.agentName || '',
      invocationId: event.agentId || '',
      durationMs: null,
      durationSource: '',
      correlation: 'n/a',
      outcome: 'subagent-stop',
    }, maxEvents);
  }

  if (event.name === 'errorOccurred') {
    state.session.agentErrors += 1;
    pushRecent(state, {
      atWall: event.wall,
      event: 'errorOccurred',
      toolName: '',
      invocationId: '',
      durationMs: null,
      durationSource: '',
      correlation: 'n/a',
      outcome: event.errorContext || 'agent-error',
      note: 'agent/runtime error (message not stored)',
    }, maxEvents);
  }

  if (event.name === 'permissionRequest') {
    pushRecent(state, {
      atWall: event.wall,
      event: 'permissionRequest',
      toolName: event.toolName || '',
      invocationId: event.callId || '',
      durationMs: null,
      durationSource: '',
      correlation: event.callId ? 'call-id' : 'n/a',
      outcome: 'permission-requested',
      note: 'request observed; the allow/deny result is not in this payload',
    }, maxEvents);
  }

  if (event.name === 'notification') {
    state.session.notificationsSeen += 1;
    if (event.notificationType === 'agent_idle') state.session.notificationWaiting = true;
    if (event.notificationType === 'agent_completed') state.session.notificationWaiting = false;
    pushRecent(state, {
      atWall: event.wall,
      event: 'notification',
      toolName: '',
      invocationId: '',
      durationMs: null,
      durationSource: '',
      correlation: 'n/a',
      outcome: event.notificationType || 'notification',
    }, maxEvents);
  }

  if (!['sessionStart', 'sessionEnd', 'userPromptSubmitted', 'preToolUse', 'postToolUse', 'postToolUseFailure', 'agentStop', 'afterAgentResponse', 'subagentStart', 'subagentStop', 'errorOccurred', 'permissionRequest', 'notification'].includes(event.name)) {
    pushRecent(state, {
      atWall: event.wall,
      event: event.name,
      toolName: event.toolName || '',
      invocationId: '',
      durationMs: null,
      durationSource: '',
      correlation: 'n/a',
      outcome: 'observed',
    }, maxEvents);
  }

  checkThresholds(state, clocks);
  recompute(state);
}

/*
 * On-disk layout (inside the data folder):
 *
 *   index.json                        shared state: focus, current lane per harness,
 *                                     in-flight calls, dedup keys, monitoring errors
 *   <harness>/<session>.json          one record per session (counters, tools, warnings)
 *   <harness>/<session>.events.jsonl  that session's recent event metadata
 *   dashboard.{md,html,css}, monitor-data.js   derived views, rewritten on every event
 *
 * <harness> is the fixed harness id (github-copilot, vscode-local, cursor); <session> is
 * the session id when it is already a safe file name, otherwise a hash of it.
 */

const SAFE_NAME = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const EVENTS_SUFFIX = '.events.jsonl';
const LANE_ALIASES = ['session', 'tools', 'recent', 'warnings', 'subagents', 'agentErrors', 'attemptTimes', 'repeatWarnedAt', 'summary'];

/** File stem for a session id: the id itself when path-safe, else `h-<sha256 prefix>`. */
export function sessionFileStem(sessionId) {
  const id = sessionId || 'unknown';
  if (SAFE_NAME.test(id) && !id.endsWith('.events')) return id;
  return `h-${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
}

/** Folder for one harness under the data dir. */
function harnessDir(dir, harness) {
  const name = String(harness || 'github-copilot');
  return join(dir, SAFE_NAME.test(name) ? name : sessionFileStem(name));
}

/** `{ json, events, chat }` paths for a lane. `chat` is Kusă transcript sidecar. */
export function laneFiles(dir, lane) {
  const stem = sessionFileStem(lane.id);
  const folder = harnessDir(dir, lane.harness);
  return {
    json: join(folder, `${stem}.json`),
    events: join(folder, `${stem}${EVENTS_SUFFIX}`),
    chat: join(folder, `${stem}.chat.json`),
  };
}

/** Fill a lane read from disk with the fields the current code expects. */
function normalizeLane(lane, key) {
  if (!lane || typeof lane !== 'object' || Array.isArray(lane)) return null;
  // Migrate pre-rename graft → trail fields on persisted sessions.
  if (lane.graft && typeof lane.graft === 'object' && (!lane.trail || typeof lane.trail !== 'object')) {
    const g = lane.graft;
    lane.trail = {
      ...emptyTrail(),
      trailReads: Number.isFinite(g.trailReads) ? g.trailReads
        : Number.isFinite(g.graftReads) ? g.graftReads : 0,
      sourceReads: Number.isFinite(g.sourceReads) ? g.sourceReads : 0,
      savedTokens: Number.isFinite(g.savedTokens) ? g.savedTokens : 0,
      host: typeof g.host === 'string' ? g.host : '',
      vizUrl: typeof g.vizUrl === 'string' ? g.vizUrl : TRAIL_VIZ_URL,
    };
  }
  if (lane.graftTranscriptMtime != null && lane.trailTranscriptMtime == null) {
    lane.trailTranscriptMtime = lane.graftTranscriptMtime;
  }
  if (Array.isArray(lane.prompts)) {
    for (const prompt of lane.prompts) {
      if (prompt && prompt.trailSavedTokens == null && prompt.graftSavedTokens != null) {
        prompt.trailSavedTokens = prompt.graftSavedTokens;
      }
    }
  }
  const fresh = emptyLane(lane.harness, lane.id);
  for (const field of Object.keys(fresh)) {
    const value = lane[field];
    const expected = fresh[field];
    const bad = value === undefined
      || (Array.isArray(expected) && !Array.isArray(value))
      || (expected && typeof expected === 'object' && !Array.isArray(expected) && (!value || typeof value !== 'object'));
    if (bad) lane[field] = expected;
  }
  lane.key = key || laneKey(lane.harness, lane.id);
  return lane;
}

function setAside(path, suffix) {
  const target = path.replace(/\.json$/, `${suffix}.json`);
  try { renameSync(path, target === path ? `${path}${suffix}` : target); } catch { /* already moved */ }
}

function readJsonFile(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('unexpected shape');
  return parsed;
}

/** Shared (non-lane) fields, validated. Mutates and returns `index`. */
function normalizeIndex(index, config) {
  index.config = config;
  index.open = Array.isArray(index.open) ? index.open.filter((inv) => inv && typeof inv.toolName === 'string') : [];
  if (!Number.isInteger(index.nextId) || index.nextId < 1) index.nextId = 1;
  if (!Array.isArray(index.monitoringErrors)) index.monitoringErrors = [];
  if (!Array.isArray(index.seen)) index.seen = [];
  if (!Array.isArray(index.sdkCallIds)) index.sdkCallIds = [];
  if (!Array.isArray(index.hookCallIds)) index.hookCallIds = [];
  if (!Array.isArray(index.harnessesSeen)) index.harnessesSeen = [];
  if (!index.current || typeof index.current !== 'object' || Array.isArray(index.current)) index.current = {};
  if (!index.sdkListener || typeof index.sdkListener !== 'object') index.sdkListener = emptySdkListener();
  if (!index.settings || typeof index.settings !== 'object') {
    index.settings = publicSettings(defaultMonitorSettings());
  } else {
    // Never keep plaintext API keys in index.json (legacy writes).
    index.settings = publicSettings(index.settings);
  }
  for (const counter of ['nonCopilotPayloads', 'truncatedPayloads', 'duplicates']) {
    if (!Number.isInteger(index[counter])) index[counter] = 0;
  }
  return index;
}

/** Point the aliases at the focused lane and refresh derived numbers. */
function finishState(state) {
  if (state.focus && !state.sessions[state.focus]) state.focus = null;
  for (const [harness, key] of Object.entries(state.current)) {
    if (!state.sessions[key]) delete state.current[harness];
  }
  state.session = (state.focus && state.sessions[state.focus]) || emptyLane(state.harness, null);
  syncAliases(state);
  recompute(state);
  return state;
}

/**
 * Older single-file layout (`state.json`). Schema 1 predates sessions and cannot be
 * split; schema 2 carries `sessions` and is split into the new layout on the next
 * persist. Either way the old file is set aside, never deleted.
 */
function readLegacyState(dir, config, origin) {
  const path = join(dir, 'state.json');
  if (!existsSync(path)) return null;
  let state;
  try {
    const parsed = readJsonFile(path);
    if (parsed.schemaVersion === 2 && parsed.sessions && typeof parsed.sessions === 'object') {
      const { sessions, ...rest } = parsed;
      state = { ...emptyState(config, origin), ...normalizeIndex(rest, config), schemaVersion: 3, sessions: {} };
      for (const alias of LANE_ALIASES) delete state[alias];
      for (const [key, lane] of Object.entries(sessions)) {
        const normalized = normalizeLane(lane, key);
        if (normalized) state.sessions[key] = normalized;
      }
      setAside(path, '.legacy');
    } else {
      setAside(path, parsed.schemaVersion === 1 ? '.v1' : '.legacy');
      state = emptyState(config, origin);
    }
  } catch {
    setAside(path, '.corrupt');
    state = emptyState(config, origin);
    noteError(state, 'state file was corrupt and was replaced', Date.now());
    return { state: finishState(state), corrupted: true };
  }
  for (const name of ['events.jsonl']) {
    if (existsSync(join(dir, name))) setAside(join(dir, name), '.legacy');
  }
  return { state: finishState(state), corrupted: false };
}

function readState(dir, config, origin) {
  const legacy = readLegacyState(dir, config, origin);
  if (legacy) return legacy;

  const indexPath = join(dir, 'index.json');
  let state = emptyState(config, origin);
  let corrupted = false;
  if (existsSync(indexPath)) {
    try {
      const index = normalizeIndex(readJsonFile(indexPath), config);
      state = { ...state, ...index, schemaVersion: 3, sessions: {} };
    } catch {
      setAside(indexPath, '.corrupt');
      corrupted = true;
      noteError(state, 'index file was corrupt and was replaced', Date.now());
    }
  }
  for (const alias of LANE_ALIASES) delete state[alias];

  // Every <harness>/<session>.json is a lane. Folder and file names are not trusted;
  // the harness and id come from the record itself.
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { /* no data yet */ }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const folder = join(dir, entry.name);
    let files = [];
    try { files = readdirSync(folder); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.json') || /\.(corrupt|legacy)\.json$/.test(file)) continue;
      // Kusă chat transcripts live beside lane files as `<id>.chat.json`.
      if (file.endsWith('.chat.json')) continue;
      // Sidecars under the kusa harness folder (not session lanes).
      if (file === 'tasks.json' || file === 'queues.json') continue;
      const path = join(folder, file);
      try {
        const lane = normalizeLane(readJsonFile(path));
        if (!lane) throw new Error('unexpected shape');
        state.sessions[lane.key] = lane;
      } catch {
        setAside(path, '.corrupt');
        corrupted = true;
        noteError(state, `session file ${entry.name}/${file} was corrupt and was set aside`, Date.now());
      }
    }
  }
  // Overlay per-session Task Lists from kusa/tasks.json (newer wins).
  hydrateTasksFromSidecar(dir, state);
  return { state: finishState(state), corrupted };
}

function persist(dir, state) {
  // Shared index: everything except the lanes and the aliases that mirror the focused lane.
  const index = { ...state, generatedAtWall: state.generatedAtWall };
  delete index.sessions;
  delete index.pruned;
  for (const alias of LANE_ALIASES) delete index[alias];
  // Secrets stay in settings.json (encrypted); index only gets the public view.
  index.settings = publicSettings(state.settings || defaultMonitorSettings());
  index.sessionFiles = {};
  for (const lane of Object.values(state.sessions)) {
    syncPlanTodos(lane);
    syncTrailSavings(lane);
    syncPromptRoles(lane);
    syncPlansOntoPrompts(lane);
  }
  // Per-session Task List sidecar (prompt queue is the workspace-shared one).
  persistTasksSidecar(dir, state);
  for (const lane of Object.values(state.sessions)) {
    const files = laneFiles(dir, lane);
    index.sessionFiles[lane.key] = relative(dir, files.json).split('\\').join('/');
    atomicWrite(files.json, `${JSON.stringify(lane, null, 2)}\n`);
    const lines = lane.recent.slice().reverse().map((entry) => JSON.stringify(entry)).join('\n');
    atomicWrite(files.events, lines ? `${lines}\n` : '');
  }
  atomicWrite(join(dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  // Sessions dropped by the per-harness cap (or explicit delete) take lane files
  // with them. Kusă `.chat.json` transcripts are removed only on explicit delete
  // (lane._dropChat) so a monitor-lane prune cannot wipe chat history.
  for (const lane of state.pruned || []) {
    const files = laneFiles(dir, lane);
    const paths = [files.json, files.events];
    if (lane.harness !== 'kusa' || lane._dropChat) paths.push(files.chat);
    for (const path of paths) {
      try { unlinkSync(path); } catch { /* already gone */ }
    }
  }
  state.pruned = [];
  // Written in place on purpose: VS Code's Markdown preview tab refreshes on a
  // file *change* event, and a rename over the path is reported as a create.
  writeFileSync(join(dir, 'dashboard.md'), renderMarkdown(state), { mode: 0o600 });
  atomicWrite(join(dir, 'dashboard.html'), renderHtml(state));
  atomicWrite(join(dir, 'monitor-data.js'), renderDataScript(state));
  // The runtime page links dashboard.css / dashboard.js / favicon.svg next to itself; keep copies fresh.
  for (const name of ['dashboard.css', 'dashboard.js', 'favicon.svg']) {
    try {
      const body = readFileSync(join(moduleDir, name));
      const target = join(dir, name);
      let stale = true;
      try { stale = statSync(target).size !== body.length; } catch { stale = true; }
      if (stale) atomicWrite(target, body);
    } catch { /* asset not built yet; run npm run build */ }
  }
}

function atomicWrite(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * 'held'  – a live process owns the lock; wait.
 * 'gone'  – the lock vanished between our open and stat; retry at once.
 * number  – inode of a stale lock (dead owner or too old); safe to remove if
 *           that inode is still what sits at the path.
 */
function inspectLock(lockPath) {
  let info;
  try {
    info = statSync(lockPath);
  } catch {
    return 'gone';
  }
  const age = Date.now() - info.mtimeMs;
  let text = '';
  try {
    text = readFileSync(lockPath, 'utf8').split('\n')[0];
  } catch {
    return 'gone';
  }
  // The holder creates the file and then writes its pid. A waiter that reads
  // in between sees an empty file; that is a fresh lock, not a stale one.
  if (!/^\d+$/.test(text)) return age > STALE_LOCK_MS ? info.ino : 'held';
  if (!pidAlive(Number(text))) return info.ino;
  return age > STALE_LOCK_MS ? info.ino : 'held';
}

function removeStaleLock(lockPath, ino) {
  try {
    if (statSync(lockPath).ino !== ino) return; // someone else already replaced it
    unlinkSync(lockPath);
  } catch { /* already removed */ }
}

function withLock(dir, fn) {
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, 'monitor.lock');
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
      try {
        writeSync(fd, `${process.pid}\n`);
        return fn();
      } finally {
        closeSync(fd);
        try { unlinkSync(lockPath); } catch { /* released by the other side */ }
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const lock = inspectLock(lockPath);
      if (lock === 'gone') continue;
      if (lock !== 'held') {
        removeStaleLock(lockPath, lock);
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        const error = new Error('monitor lock timeout');
        error.code = 'ELOCK';
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

export function prepareInput(text, truncated) {
  let body = text;
  if (!truncated && body.length > 64_000) body = redactLongStrings(body, 160);
  if (!truncated) {
    try {
      return { raw: JSON.parse(body), truncated: false, malformed: false };
    } catch {
      return { raw: null, truncated: false, malformed: true };
    }
  }
  const head = body.slice(0, 64_000);
  return { raw: scrapePayload(head), truncated: true, malformed: false };
}

function redactLongStrings(text, maxChars) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const quote = text.indexOf('"', index);
    if (quote < 0) {
      out += text.slice(index);
      break;
    }
    out += text.slice(index, quote);
    let cursor = quote + 1;
    let length = 0;
    let closed = -1;
    while (cursor < text.length) {
      if (text[cursor] === '\\') {
        cursor += 2;
        length += 1;
        continue;
      }
      if (text[cursor] === '"') {
        closed = cursor;
        break;
      }
      cursor += 1;
      length += 1;
    }
    if (closed < 0) {
      out += text.slice(quote);
      break;
    }
    out += length > maxChars ? '""' : text.slice(quote, closed + 1);
    index = closed + 1;
  }
  return out;
}

function scrapePayload(head) {
  const grab = (key) => {
    const match = head.match(new RegExp(`"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|-?\\d+(?:\\.\\d+)?|true|false|null)`));
    if (!match) return undefined;
    try { return JSON.parse(match[1]); } catch { return undefined; }
  };
  const raw = {};
  for (const key of [
    'sessionId', 'timestamp', 'cwd', 'source', 'toolName', 'reason', 'stopReason', 'notification_type', 'agentName', 'agentId',
    'session_id', 'hook_event_name', 'tool_name', 'tool_use_id', 'agent_id', 'agent_type',
    'conversation_id', 'cursor_version', 'failure_type', 'status', 'composer_mode',
  ]) {
    const value = grab(key);
    if (value !== undefined) raw[key] = value;
  }
  if (Object.keys(raw).length === 0) return null;
  return raw;
}

function ensureLaneSdkFields(lane) {
  if (!lane.reasoning || typeof lane.reasoning !== 'object') {
    lane.reasoning = {
      seen: false,
      active: false,
      blocks: 0,
      lastAtWall: null,
      lastId: null,
      textPersisted: false,
    };
  }
  if (lane.currentIntent == null) lane.currentIntent = '';
  if (lane.turnCount == null) lane.turnCount = 0;
  if (lane.apiCallDurationMsSum == null) lane.apiCallDurationMsSum = 0;
  if (lane.apiCallDurationCount == null) lane.apiCallDurationCount = 0;
  if (lane.apiCallDurationMaxMs == null) lane.apiCallDurationMaxMs = 0;
  if (lane.sdkUsageTurns == null) lane.sdkUsageTurns = 0;
}

/**
 * Apply one normalized SDK monitor event (from sdk-normalize.mjs) into state.
 * Tool starts/completes reuse the same counters as hooks; usage/turn/reasoning
 * are SDK-only enrichments.
 */
function applySdkMonitorEvent(state, event, clocks) {
  const maxEvents = state.config.maxEvents;
  if (!Array.isArray(state.sdkCallIds)) state.sdkCallIds = [];
  if (!Array.isArray(state.hookCallIds)) state.hookCallIds = [];
  if (!Array.isArray(state.harnessesSeen)) state.harnessesSeen = [];
  if (!state.harnessesSeen.includes('github-copilot')) state.harnessesSeen.push('github-copilot');
  state.harness = 'github-copilot';

  const dedupKey = event.id ? `sdk:${event.id}` : `sdk:${event.type}:${event.sessionId || ''}:${event.turnId || ''}:${event.invocationId || ''}:${event.wall}`;
  if (state.seen.includes(dedupKey)) {
    state.duplicates += 1;
    return { applied: false, reason: 'duplicate' };
  }
  state.seen.push(dedupKey);
  if (state.seen.length > 300) state.seen.splice(0, state.seen.length - 300);

  bindLane(state, {
    harness: 'github-copilot',
    sessionId: event.sessionId,
    name: event.type,
    wall: event.wall,
  }, clocks);
  ensureLaneSdkFields(state.session);
  state.session.active = true;
  state.session.lastEventAtWall = event.wall;
  state.session.lastEventName = event.type;
  if (!state.session.startedAtWall) {
    state.session.startedAtWall = event.wall;
    state.session.startEstimated = true;
  }

  const skipToolCount = Boolean(
    event.invocationId
    && state.hookCallIds.includes(event.invocationId)
    && (event.type === 'tool.execution_start' || event.type === 'tool.execution_complete'),
  );

  if (event.type === 'assistant.turn_start') {
    state.session.turnCount += 1;
    state.session.currentTurnId = event.turnId || state.session.currentTurnId;
    state.session.turnStartedAtWall = event.wall;
    state.session.turnEndedAtWall = null;
    state.session.turnOpen = true;
    if (!state.session.promptStartedAtWall) state.session.promptStartedAtWall = event.wall;
    if (!state.session.promptIndex) state.session.promptIndex = 1;
    pushRecent(state, {
      atWall: event.wall,
      event: event.type,
      toolName: '',
      invocationId: event.turnId || '',
      durationMs: null,
      durationSource: '',
      correlation: event.turnId ? 'turn-id' : 'n/a',
      outcome: 'turn-start',
    }, maxEvents);
  }

  if (event.type === 'assistant.turn_end') {
    state.session.currentTurnId = event.turnId || state.session.currentTurnId;
    state.session.turnEndedAtWall = event.wall;
    const turnMs = state.session.turnStartedAtWall != null
      ? Math.max(0, event.wall - state.session.turnStartedAtWall)
      : null;
    pushRecent(state, {
      atWall: event.wall,
      event: event.type,
      toolName: '',
      invocationId: event.turnId || '',
      durationMs: turnMs,
      durationSource: turnMs != null ? 'wall' : '',
      correlation: event.turnId ? 'turn-id' : 'n/a',
      outcome: 'turn-end',
    }, maxEvents);
  }

  if (event.type === 'assistant.intent' && event.intent) {
    state.session.currentIntent = event.intent;
    pushRecent(state, {
      atWall: event.wall,
      event: event.type,
      toolName: '',
      invocationId: '',
      durationMs: null,
      durationSource: '',
      correlation: 'n/a',
      outcome: 'intent',
      note: event.intent.slice(0, 120),
    }, maxEvents);
  }

  if (event.type === 'assistant.message' || event.type === 'assistant.message_delta') {
    pushRecent(state, {
      atWall: event.wall,
      event: event.type,
      toolName: '',
      invocationId: '',
      durationMs: null,
      durationSource: '',
      correlation: 'n/a',
      outcome: event.type === 'assistant.message' ? 'message' : 'delta',
      note: event.messageChars != null ? `${event.messageChars} chars` : '',
    }, maxEvents);
  }

  if (event.type === 'assistant.reasoning' || event.type === 'assistant.reasoning_delta') {
    const r = state.session.reasoning;
    r.seen = true;
    r.lastAtWall = event.wall;
    r.lastId = event.reasoning?.id || r.lastId;
    if (event.type === 'assistant.reasoning_delta') {
      r.active = true;
    } else {
      r.active = false;
      r.blocks += 1;
      if (event.reasoning?.text) {
        r.textPersisted = true;
        // Intentionally not storing the text on the lane — only a flag.
      }
    }
    pushRecent(state, {
      atWall: event.wall,
      event: event.type,
      toolName: '',
      invocationId: event.reasoning?.id || '',
      durationMs: null,
      durationSource: '',
      correlation: event.reasoning?.id ? 'reasoning-id' : 'n/a',
      outcome: event.reasoning?.hasText ? 'reasoning-status' : 'reasoning-empty',
    }, maxEvents);
  }

  if (event.type === 'assistant.usage' && event.usage) {
    const u = event.usage;
    state.session.sdkUsageTurns += 1;
    if (u.durationMs != null) {
      state.session.apiCallDurationMsSum += u.durationMs;
      state.session.apiCallDurationCount += 1;
      if (u.durationMs > state.session.apiCallDurationMaxMs) {
        state.session.apiCallDurationMaxMs = u.durationMs;
      }
    }
    if (!state.session.tokens || typeof state.session.tokens !== 'object') {
      state.session.tokens = emptyTokens();
    }
    state.session.tokens.input += u.inputTokens || 0;
    state.session.tokens.output += u.outputTokens || 0;
    state.session.tokens.cacheRead += u.cacheReadTokens || 0;
    state.session.tokens.cacheWrite += u.cacheWriteTokens || 0;
    state.session.tokens.turns += 1;
    const generationId = u.apiCallId || `sdk-usage-${event.wall}`;
    if (!Array.isArray(state.session.tokenSeen)) state.session.tokenSeen = [];
    if (!state.session.tokenSeen.includes(generationId)) {
      state.session.tokenSeen.push(generationId);
      if (state.session.tokenSeen.length > 200) {
        state.session.tokenSeen.splice(0, state.session.tokenSeen.length - 200);
      }
      if (!Array.isArray(state.session.tokenTurns)) state.session.tokenTurns = [];
      state.session.tokenTurns.unshift({
        generationId,
        promptIndex: state.session.promptIndex,
        atWall: event.wall,
        model: u.model || event.model || '',
        input: u.inputTokens || 0,
        output: u.outputTokens || 0,
        cacheRead: u.cacheReadTokens || 0,
        cacheWrite: u.cacheWriteTokens || 0,
      });
      if (state.session.tokenTurns.length > 100) state.session.tokenTurns.length = 100;
    }
    // Estimate time outside tool execution for the open turn: turn wall elapsed
    // minus sum of known tool durations is not available here; expose API duration
    // separately so the UI never confuses it with total turn time.
    if (state.session.turnStartedAtWall != null && u.durationMs != null) {
      const turnElapsed = Math.max(0, event.wall - state.session.turnStartedAtWall);
      state.session.outsideToolMsEstimate = Math.max(0, turnElapsed - (state.session.apiCallDurationMsSum || 0));
    }
    pushRecent(state, {
      atWall: event.wall,
      event: event.type,
      toolName: '',
      invocationId: u.apiCallId || '',
      durationMs: u.durationMs,
      durationSource: u.durationMs != null ? 'sdk-api' : '',
      correlation: u.apiCallId ? 'api-call-id' : 'n/a',
      outcome: 'usage',
      note: `in ${u.inputTokens || 0} / out ${u.outputTokens || 0}`,
    }, maxEvents);
  }

  if (event.type === 'tool.execution_start') {
    rememberId(state.sdkCallIds, event.invocationId);
    if (skipToolCount) {
      state.duplicates += 1;
      pushRecent(state, {
        atWall: event.wall,
        event: event.type,
        toolName: event.toolName || '(unknown)',
        invocationId: event.invocationId || '',
        durationMs: null,
        durationSource: '',
        correlation: 'hook-dedup',
        outcome: 'duplicate-sdk',
      }, maxEvents);
    } else {
      const toolName = event.toolName || '(unknown)';
      const tool = ensureTool(state.session, toolName);
      const id = event.invocationId || `inv-${state.nextId}`;
      state.nextId += 1;
      tool.total += 1;
      tool.lastInvocationWall = event.wall;
      state.session.promptToolAttempts += 1;
      const openPrompt = state.session.prompts.find((entry) => entry.open);
      if (openPrompt) openPrompt.toolAttempts = state.session.promptToolAttempts;
      state.open.push({
        id,
        callId: event.invocationId || '',
        harness: 'github-copilot',
        laneKey: state.session.key,
        toolName,
        subName: '',
        agentId: event.agentId || '',
        startedWall: event.wall,
        startedMono: clocks.mono,
        bootId: clocks.bootId || '',
        fingerprint: '',
        promptIndex: state.session.promptIndex,
        longWarned: false,
        source: 'sdk',
      });
      pushRecent(state, {
        atWall: event.wall,
        event: event.type,
        toolName,
        invocationId: id,
        durationMs: null,
        durationSource: '',
        correlation: event.invocationId ? 'call-id' : 'pending',
        outcome: 'attempt',
      }, maxEvents);
    }
  }

  if (event.type === 'tool.execution_complete') {
    rememberId(state.sdkCallIds, event.invocationId);
    if (skipToolCount) {
      state.duplicates += 1;
      pushRecent(state, {
        atWall: event.wall,
        event: event.type,
        toolName: event.toolName || '(unknown)',
        invocationId: event.invocationId || '',
        durationMs: null,
        durationSource: '',
        correlation: 'hook-dedup',
        outcome: 'duplicate-sdk',
      }, maxEvents);
    } else {
      const outcome = event.success === false ? 'failed' : 'success';
      const closed = closeInvocation(state, {
        toolName: event.toolName || '(unknown)',
        callId: event.invocationId || '',
        agentId: event.agentId || '',
        wall: event.wall,
        fingerprint: '',
      }, clocks, outcome);
      pushRecent(state, {
        atWall: event.wall,
        event: event.type,
        toolName: event.toolName || '(unknown)',
        subName: closed.subName,
        invocationId: closed.invocationId,
        durationMs: closed.durationMs,
        durationSource: closed.durationSource,
        correlation: closed.correlation,
        outcome,
      }, maxEvents);
    }
  }

  if (event.type === 'session.idle') {
    state.session.turnOpen = false;
    state.session.notificationWaiting = true;
    state.session.notificationsSeen += 1;
    closeOpenPrompt(state.session, event.wall);
    pushRecent(state, {
      atWall: event.wall,
      event: event.type,
      toolName: '',
      invocationId: '',
      durationMs: null,
      durationSource: '',
      correlation: 'n/a',
      outcome: event.aborted ? 'aborted' : 'idle',
    }, maxEvents);
  }

  if (event.type === 'session.error') {
    state.session.agentErrors += 1;
    pushRecent(state, {
      atWall: event.wall,
      event: event.type,
      toolName: '',
      invocationId: '',
      durationMs: null,
      durationSource: '',
      correlation: 'n/a',
      outcome: 'error',
      note: event.errorMessage || '',
    }, maxEvents);
  }

  if (event.type === 'subagent.started') {
    state.session.subagents.started += 1;
    pushRecent(state, {
      atWall: event.wall,
      event: event.type,
      toolName: event.subagentName || '',
      invocationId: '',
      durationMs: null,
      durationSource: '',
      correlation: 'n/a',
      outcome: 'subagent-start',
    }, maxEvents);
  }

  if (event.type === 'subagent.completed' || event.type === 'subagent.failed') {
    state.session.subagents.stopped += 1;
    if (event.type === 'subagent.failed') state.session.agentErrors += 1;
    pushRecent(state, {
      atWall: event.wall,
      event: event.type,
      toolName: event.subagentName || '',
      invocationId: '',
      durationMs: event.durationMs,
      durationSource: event.durationMs != null ? 'sdk' : '',
      correlation: 'n/a',
      outcome: event.type === 'subagent.failed' ? 'failed' : 'stopped',
    }, maxEvents);
  }

  return { applied: true };
}

/**
 * Persist a normalized SDK event into the monitor state store (locked).
 */
export function runSdkEvent({
  dir,
  event,
  nowWall = Date.now(),
  nowMono = undefined,
  bootId = undefined,
  config,
  listenerStatus = null,
  origin = 'sdk',
}) {
  const clocks = {
    wall: nowWall,
    mono: nowMono === undefined ? readMonoClock().mono : nowMono,
    bootId: bootId === undefined ? readMonoClock().bootId : bootId,
  };
  return withLock(dir, () => {
    const loaded = loadThresholds(dir, config);
    const { state, corrupted } = readState(dir, loaded.config, origin);
    state.settings = loadMonitorSettings(dir);
    if (origin && state.origin !== 'synthetic-demo') {
      // Keep hooks origin if already set; otherwise mark sdk.
      if (state.origin === 'hooks' || !state.origin) state.origin = 'hooks+sdk';
      else if (!String(state.origin).includes('sdk')) state.origin = `${state.origin}+sdk`;
    }
    if (!event || typeof event !== 'object' || !event.type) {
      noteError(state, 'sdk listener received invalid event', clocks.wall);
      state.generatedAtWall = clocks.wall;
      recompute(state);
      persist(dir, state);
      return state;
    }
    try {
      applySdkMonitorEvent(state, event, clocks);
    } catch (err) {
      noteError(state, `monitor failed while applying sdk ${event.type}`, clocks.wall);
      try { recompute(state); } catch { /* keep */ }
      void err;
    }
    if (listenerStatus && typeof listenerStatus === 'object') {
      state.sdkListener = {
        ...emptySdkListener(),
        ...(state.sdkListener || {}),
        ...listenerStatus,
        updatedAtWall: clocks.wall,
      };
    }
    state.generatedAtWall = clocks.wall;
    if (corrupted) noteError(state, 'recovered after a corrupt state file', clocks.wall);
    recompute(state);
    persist(dir, state);
    return state;
  });
}

/** Update only the SDK listener connection status (no session event). */
export function updateSdkListenerStatus(dir, statusPatch = {}) {
  const clocks = { wall: Date.now(), mono: readMonoClock().mono, bootId: readMonoClock().bootId };
  return withLock(dir, () => {
    const loaded = loadThresholds(dir);
    const { state } = readState(dir, loaded.config, 'hooks');
    state.settings = loadMonitorSettings(dir);
    state.sdkListener = {
      ...emptySdkListener(),
      ...(state.sdkListener || {}),
      ...statusPatch,
      updatedAtWall: statusPatch.updatedAtWall || clocks.wall,
    };
    state.generatedAtWall = clocks.wall;
    recompute(state);
    persist(dir, state);
    return state;
  });
}

/**
 * Re-read state (including `kusa/tasks.json`), promote the workspace Task
 * List onto every session, and rewrite monitor-data / dashboard artifacts.
 * Used on `kusa serve` boot so a bounce shows the shared task list immediately.
 */
export function refreshMonitorArtifacts(dir, { config, origin = 'hooks', nowWall = Date.now() } = {}) {
  return withLock(dir, () => {
    const loaded = loadThresholds(dir, config);
    const { state } = readState(dir, loaded.config, origin);
    state.generatedAtWall = nowWall;
    recompute(state);
    persist(dir, state);
    return state;
  });
}

export function runHook({
  dir,
  eventName,
  stdinText = '',
  truncated = false,
  nowWall = Date.now(),
  nowMono = undefined,
  bootId = undefined,
  config,
  origin = 'hooks',
}) {
  const clocks = {
    wall: nowWall,
    mono: nowMono === undefined ? readMonoClock().mono : nowMono,
    bootId: bootId === undefined ? readMonoClock().bootId : bootId,
  };
  return withLock(dir, () => {
    const loaded = loadThresholds(dir, config);
    const { state, corrupted } = readState(dir, loaded.config, origin);
    if (origin && state.origin !== 'synthetic-demo') state.origin = origin;
    if (loaded.overrideError) noteError(state, loaded.overrideError, clocks.wall);
    const canonical = canonicalEventName(eventName);
    if (!canonical || !KNOWN_EVENTS.has(canonical)) {
      noteError(state, `unknown or missing hook event name: ${asString(eventName, 80) || '(empty)'}`, clocks.wall);
      state.generatedAtWall = clocks.wall;
      recompute(state);
      persist(dir, state);
      return state;
    }
    const prepared = prepareInput(stdinText, truncated);
    if (prepared.malformed || !prepared.raw) {
      noteError(state, 'malformed hook input', clocks.wall);
      state.generatedAtWall = clocks.wall;
      recompute(state);
      persist(dir, state);
      return state;
    }
    const event = normalizeEvent(prepared.raw, canonical, clocks, { truncated: prepared.truncated });
    if (event.ignore) {
      state.nonCopilotPayloads += 1;
      state.lastNonCopilotKeys = event.keys;
      noteError(state, `ignored ${event.reason} payload for declared ${event.declared}`, clocks.wall);
      state.generatedAtWall = clocks.wall;
      recompute(state);
      persist(dir, state);
      return state;
    }
    try {
      applyCopilotEvent(state, event, clocks);
    } catch (err) {
      noteError(state, `monitor failed while applying ${eventName}`, clocks.wall);
      try { recompute(state); } catch { /* keep the previous summary */ }
      void err;
    }
    state.generatedAtWall = clocks.wall;
    if (corrupted) noteError(state, 'recovered after a corrupt state file', clocks.wall);
    persist(dir, state);
    return state;
  });
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  if (abs < 1000) return `${sign}${Math.round(abs)} ms`;
  const seconds = abs / 1000;
  if (seconds < 60) return `${sign}${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  if (minutes < 60) return `${sign}${minutes} min ${rest} s`;
  const hours = Math.floor(minutes / 60);
  return `${sign}${hours} h ${minutes - hours * 60} min`;
}

function toRow(name, counter) {
  return { name, ...counter, avg: counter.durationCount ? counter.durationMsSum / counter.durationCount : null };
}

function toolRows(lane) {
  return Object.entries(lane.tools)
    .map(([name, tool]) => ({
      ...toRow(name, tool),
      children: Object.entries(tool.children ?? {})
        .map(([sub, counter]) => toRow(sub, counter))
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

function viewRow(row, depth = 0) {
  const view = {
    name: row.name,
    depth,
    total: row.total,
    running: row.running,
    success: row.success,
    failed: row.failed,
    denied: row.denied,
    incomplete: row.incomplete,
    avg: row.avg,
    max: row.maxDurationMs || null,
    last: row.lastInvocationWall,
  };
  if (Array.isArray(row.commands) && row.commands.length) view.commands = row.commands.slice();
  return view;
}

/** Parent rows followed by their command / file children, flattened for tables. */
function flatRows(lane) {
  const out = [];
  for (const row of toolRows(lane)) {
    out.push(viewRow(row, 0));
    for (const child of row.children ?? []) out.push(viewRow(child, 1));
  }
  return out;
}

export const HARNESS_LABELS = {
  kusa: 'Kusă',
  'github-copilot': 'GitHub Copilot',
  'vscode-local': 'VS Code Local',
  cursor: 'Cursor',
};

/**
 * ended    – sessionEnd seen.
 * busy     – at least one tool call is in flight.
 * thinking – a prompt is open with nothing in flight (model turn).
 * idle     – active session, no open turn.
 */
export function laneStatus(lane, running) {
  if (!lane.active) return 'ended';
  if (running > 0) return 'busy';
  if (lane.turnOpen) return 'thinking';
  return 'idle';
}

function qualityNotes(state, lane = state.session) {
  const notes = [];
  const summary = lane.summary || emptySummary();
  if (!lane.startObserved) notes.push('Session start was not observed. Elapsed time is incomplete.');
  if (lane.startEstimated) notes.push('Session start time is estimated from the first event that carried a session id.');
  if (summary.uncertain) notes.push(`${summary.uncertain} tool completion(s) were correlated without a unique in-flight match.`);
  if (summary.unmatched) notes.push(`${summary.unmatched} completion(s) had no matching pre-tool event.`);
  if (summary.incomplete) notes.push(`${summary.incomplete} pre-tool event(s) were still open when the session ended.`);
  if (summary.running) notes.push(`${summary.running} tool call(s) are still open. A missing post-tool event is not counted as success or failure.`);
  if (lane.harness === 'vscode-local') notes.push('Events came from the VS Code Local harness. It has no tool-failure or session-end event, so calls without a post-tool event are marked incomplete when the agent stops.');
  if (lane.harness === 'cursor') notes.push('Cursor session. Shell commands are grouped by program name and file tools by relative path. beforeShellExecution and the other specialized Cursor hooks are not registered, because preToolUse already counts every tool. Token counts come from stop / afterAgentResponse (parent agent only; input includes cache read/write). Plan and todos come from TodoWrite / CreatePlan / `*.plan.md` writes when hooked, otherwise from the agent transcript and `~/.cursor/plans`. Trail savings come from `[trail] tokens saved ≈` footers, the reply tally line, and `.trail/cache/.cache/session/<id>.json` when present.');
  if (lane.harness === 'kusa') notes.push('Kusă first-party chat agent. Hooks are emitted in-process (sessionStart, userPromptSubmitted, pre/post tool, afterAgentResponse, agentStop). Native backend records file-tool calls; OpenCode backend records turn lifecycle only.');
  if (lane.harness === 'github-copilot') notes.push('GitHub Copilot session. Tool calls correlate by id when present, otherwise FIFO / fingerprint. Trail savings come from `[trail] tokens saved ≈` footers in postToolUse results, the harness transcriptPath when readable, and `.trail/cache/.cache/session/<id>.json` when present. Plan/todos come from TodoWrite-style tool args when hooked, otherwise from the transcript when its format is recognized. Copilot command hooks do not send reply text or token totals; SDK assistant.usage can when the Copilot CLI extension listener is attached.');
  if (lane.harness !== 'cursor' && lane.harness !== 'kusa' && !(lane.tokens && lane.tokens.turns)) notes.push('Token usage is only reported by Cursor stop / afterAgentResponse hooks, or by Copilot SDK assistant.usage when the CLI session listener is connected. VS Code Copilot Chat hooks alone do not send token fields.');
  if (state.nonCopilotPayloads) notes.push(`${state.nonCopilotPayloads} payload(s) had an unrecognized shape and were not counted.`);
  if (state.truncatedPayloads) notes.push(`${state.truncatedPayloads} payload(s) were truncated before parsing. Arguments were not fingerprinted.`);
  if (state.duplicates) notes.push(`${state.duplicates} duplicate event(s) were ignored (including hook↔SDK tool-call dedupe).`);
  const listener = state.sdkListener;
  if (listener && (listener.status === 'unsupported' || listener.status === 'disconnected' || listener.status === 'error')) {
    notes.push(`SDK session listener: ${listener.status}${listener.detail ? ` — ${listener.detail}` : ''}`);
  } else if (listener && listener.status === 'connected') {
    notes.push(`SDK session listener connected (${listener.target || 'copilot-cli'}${listener.sessionId ? `, session ${listener.sessionId}` : ''}).`);
  }
  if (lane.reasoning?.seen) {
    notes.push('Reasoning events were observed from the SDK. The console records activity status/duration only; raw reasoning text is not persisted by default.');
  }
  if (!state.liveSessionVerified) notes.push('No check in this repository has confirmed that a live agent harness fired these hooks.');
  return notes;
}

export function renderMarkdown(state) {
  const session = state.session;
  const summary = state.summary;
  const elapsed = session.startedAtWall != null && state.generatedAtWall != null
    ? (session.active ? state.generatedAtWall : session.endedAtWall ?? state.generatedAtWall) - session.startedAtWall
    : null;
  const promptElapsed = session.promptStartedAtWall != null && session.turnOpen && state.generatedAtWall != null
    ? state.generatedAtWall - session.promptStartedAtWall
    : null;
  const idle = session.lastEventAtWall != null && state.generatedAtWall != null
    ? state.generatedAtWall - session.lastEventAtWall
    : null;
  const lines = [
    '# Kusă Console',
    '',
    state.origin === 'synthetic-demo'
      ? 'Synthetic demonstration data. This is not a live agent session.'
      : 'Figures below are hook and/or Copilot SDK session-listener events from connected agent harnesses, recorded in this folder. A live session has not been verified here.',
    '',
    `Snapshot written at ${state.generatedAtWall ? new Date(state.generatedAtWall).toLocaleTimeString() : '—'}. This view refreshes only when a hook or SDK event rewrites it; it has no ticking timer. For a live timer run \`kusa serve\` and open the dashboard in a browser.`,
    '',
    '## SDK listener',
    '',
    (() => {
      const L = state.sdkListener || emptySdkListener();
      return `- Status: **${L.status || 'idle'}**${L.target ? ` · target \`${L.target}\`` : ''}${L.sessionId ? ` · session \`${L.sessionId}\`` : ''}${L.lastEventType ? ` · last \`${L.lastEventType}\`` : ''}${L.detail ? ` — ${L.detail}` : ''}`;
    })(),
    '',
    '## Sessions',
    '',
  ];
  const statusMark = { busy: '●', thinking: '◐', idle: '○', ended: '◌' };
  for (const lane of Object.values(state.sessions || {}).sort((a, b) => (b.lastEventAtWall ?? 0) - (a.lastEventAtWall ?? 0))) {
    const running = state.open.filter((inv) => (inv.laneKey || state.focus) === lane.key).length;
    const status = laneStatus(lane, running);
    const marker = lane.key === state.focus ? ' ← latest' : '';
    lines.push(`- ${statusMark[status]} ${HARNESS_LABELS[lane.harness] || lane.harness} › \`${mdCell(lane.id || 'unknown')}\` · ${status} · ${lane.summary.attempts} tool calls${marker}`);
  }
  if (!Object.keys(state.sessions || {}).length) lines.push('None yet.');
  lines.push(
    '',
    `## Latest session: ${HARNESS_LABELS[session.harness] || session.harness} › ${mdCell(session.id || '(none)')}`,
    '',
    `- Session: ${session.id || '(none)'} · ${session.active ? 'active' : 'inactive'} · start ${session.startObserved ? 'observed' : 'not observed'}`,
    `- Session elapsed at last hook: ${formatDuration(elapsed)}`,
    `- Prompt elapsed at last hook: ${session.promptIndex ? formatDuration(promptElapsed) : '—'} (prompt ${session.promptIndex})`,
    `- Estimated idle at last hook: ${formatDuration(idle)} since \`${session.lastEventName || 'n/a'}\``,
    `- Turn: ${session.turnOpen ? 'open (prompt submitted, agentStop not seen)' : 'not open'}`,
    `- Notification waiting: ${session.notificationsSeen ? String(session.notificationWaiting) : 'not observed'}`,
    `- Attempts ${summary.attempts} · running ${summary.running} · success ${summary.success} · failed ${summary.failed} · denied ${summary.denied} · distinct ${summary.distinct}`,
    `- Subagents started ${session.subagents.started} · stopped ${session.subagents.stopped} · agent errors ${session.agentErrors} · console errors ${state.monitoringErrors.length}`,
    session.currentIntent ? `- Current intent: ${mdCell(session.currentIntent)}` : '- Current intent: (none)',
    session.turnStartedAtWall
      ? `- SDK turn: ${session.currentTurnId || '—'} · started ${new Date(session.turnStartedAtWall).toISOString()}${session.turnEndedAtWall ? ` · ended ${new Date(session.turnEndedAtWall).toISOString()}` : ' · open'}`
      : '- SDK turn: not observed',
    session.apiCallDurationCount
      ? `- Model API-call duration (SDK usage): avg ${formatDuration(session.apiCallDurationMsSum / session.apiCallDurationCount)} · max ${formatDuration(session.apiCallDurationMaxMs)} · n=${session.apiCallDurationCount}`
      : '- Model API-call duration (SDK usage): not observed',
    session.reasoning?.seen
      ? `- Reasoning activity: seen · blocks ${session.reasoning.blocks} · ${session.reasoning.active ? 'in progress' : 'idle'} (text ${session.reasoning.textPersisted ? 'persisted' : 'not persisted'})`
      : '- Reasoning activity: not observed',
    '',
    'Durations are time between observed hooks or SDK events. Model API-call duration comes only from assistant.usage. They are not hidden chain-of-thought.',
    '',
    '## Prompts',
    '',
  );
  const prompts = session.prompts || [];
  if (!prompts.length) {
    lines.push('None yet.', '');
  } else {
    for (const prompt of prompts.slice(0, 40)) {
      const preview = mdCell((prompt.text || '').replace(/\s+/g, ' ').slice(0, 160));
      const more = (prompt.text || '').length > 160 || prompt.truncated ? '…' : '';
      const trailSaved = prompt.trailSavedTokens != null ? ` · trail saved ~${prompt.trailSavedTokens}` : '';
      const replyChars = prompt.responseChars || (prompt.response || '').length;
      const replyNote = replyChars ? ` · reply ${replyChars} chars` : '';
      const roleNote = prompt.role === 'plan' || prompt.role === 'system' ? prompt.role : 'user';
      const planNote = prompt.plan?.name ? ` · plan ${mdCell(prompt.plan.name)}` : prompt.plan ? ' · plan' : '';
      lines.push(
        `- #${prompt.index} · ${roleNote} · ${prompt.atWall != null ? new Date(prompt.atWall).toISOString() : '—'} · ` +
        `${prompt.open ? 'open' : formatDuration(prompt.durationMs)} · ${prompt.toolAttempts} tools · ${prompt.chars} chars${trailSaved}${replyNote}${planNote}` +
        (preview ? ` — ${preview}${more}` : ''),
      );
    }
    lines.push('');
  }
  lines.push('## Plan & todos', '');
  if (session.plan) {
    lines.push(`### ${mdCell(session.plan.name || 'Plan')}`, '');
    if (session.plan.overview) lines.push(mdCell(session.plan.overview), '');
    const planPreview = mdCell((session.plan.body || '').replace(/\s+/g, ' ').slice(0, 240));
    if (planPreview) lines.push(`${planPreview}${(session.plan.body || '').length > 240 ? '…' : ''}`, '');
  } else {
    lines.push('No plan observed yet.', '');
  }
  if ((session.todos || []).length) {
    for (const todo of session.todos) {
      const mark = todo.status === 'completed' ? 'x' : todo.status === 'in_progress' ? '~' : todo.status === 'cancelled' ? '-' : ' ';
      lines.push(`- [${mark}] ${mdCell(todo.content)} (${todo.status})`);
    }
    lines.push('');
  } else {
    lines.push('No todo list yet.', '');
  }
  const trailReady = snapshotTrailStatus(repoRoot);
  const trail = session.trail || emptyTrail();
  lines.push('## Trail', '');
  if (!trailReady.ok) {
    lines.push(`- Not ready${trailReady.error ? `: ${mdCell(trailReady.error)}` : '.'}`);
    for (const step of trailReady.steps) lines.push(`  1. ${mdCell(step)}`);
    lines.push('');
  } else {
    lines.push(
      `- Ready · graph present`
        + (trail.savedTokens || trail.trailReads || trail.sourceReads
          ? ` · tokens saved ~${trail.savedTokens} · trail reads ${trail.trailReads} · source reads ${trail.sourceReads}`
          : ' · no session savings observed yet.'),
      '',
    );
  }
  const git = collectGitStatus(repoRoot);
  lines.push('## Git', '');
  if (!git.ok) {
    lines.push(`- Not ready${git.error ? `: ${mdCell(git.error)}` : '.'}`);
    for (const step of git.steps) lines.push(`  1. ${mdCell(step)}`);
    lines.push('');
  } else {
    const track = git.upstream
      ? `${git.upstream}${git.ahead || git.behind ? ` · ahead ${git.ahead} · behind ${git.behind}` : ''}`
      : 'no upstream';
    lines.push(
      `- ${git.clean ? 'Clean' : 'Dirty'} · ${git.detached ? 'detached ' : ''}${mdCell(git.branch || '—')}`
        + (git.head ? ` @ ${git.head}` : '')
        + ` · ${track}`,
    );
    if (git.subject) lines.push(`- HEAD: ${mdCell(git.subject)}`);
    lines.push(
      `- Staged ${git.staged.length} · unstaged ${git.unstaged.length}`
        + ` · untracked ${git.untracked.length} · conflicted ${git.conflicted.length}`
        + (git.truncated ? ' (list truncated)' : ''),
      '',
    );
    const showPaths = (label, rows) => {
      if (!rows.length) return;
      lines.push(`### ${label}`, '');
      for (const row of rows.slice(0, 40)) {
        lines.push(`- \`${mdCell(row.code)}\` ${mdCell(row.path)}`);
      }
      if (rows.length > 40) lines.push(`- … ${rows.length - 40} more`);
      lines.push('');
    };
    showPaths('Conflicted', git.conflicted);
    showPaths('Staged', git.staged);
    showPaths('Unstaged', git.unstaged);
    showPaths('Untracked', git.untracked);
  }
  const tokens = session.tokens || emptyTokens();
  lines.push(
    '## Token usage',
    '',
    tokens.turns
      ? `- Session totals: input ${tokens.input} · output ${tokens.output} · cache read ${tokens.cacheRead} · cache write ${tokens.cacheWrite} · ${tokens.turns} turn(s)`
      : '- No token fields observed yet (Cursor stop / afterAgentResponse only).',
    '',
  );
  for (const turn of (session.tokenTurns || []).slice(0, 40)) {
    lines.push(
      `- prompt #${turn.promptIndex ?? '—'} · ${turn.model || 'model?'} · in ${turn.input} · out ${turn.output} · cache r/w ${turn.cacheRead}/${turn.cacheWrite}`,
    );
  }
  if ((session.tokenTurns || []).length) lines.push('');
  lines.push(
    '| Tool | Total | Running | Success | Failed | Denied | Incomplete | Avg duration | Max | Last |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  );
  const rows = flatRows(session);
  if (!rows.length) lines.push('| (no tool calls yet) | 0 | 0 | 0 | 0 | 0 | 0 | — | — | — |');
  for (const row of rows) {
    const label = row.depth ? `&nbsp;&nbsp;&nbsp;↳ \`${mdCell(row.name)}\`` : mdCell(row.name);
    lines.push(`| ${label} | ${row.total} | ${row.running} | ${row.success} | ${row.failed} | ${row.denied} | ${row.incomplete} | ${formatDuration(row.avg)} | ${formatDuration(row.max)} | ${row.last ? new Date(row.last).toISOString() : '—'} |`);
  }
  if (rows.some((row) => row.depth)) {
    lines.push('', 'Indented rows are terminal commands (program name) or files (path relative to the workspace). The HTML dashboard expands a terminal name to the full command line. Other tool arguments are not recorded.');
  }
  lines.push('', '## In flight', '');
  const openHere = state.open.filter((inv) => (inv.laneKey || state.focus) === session.key);
  if (!openHere.length) lines.push('None.');
  for (const inv of openHere) {
    const age = invocationAge(inv, { wall: state.generatedAtWall, mono: null, bootId: inv.bootId });
    const overdue = age != null && age >= state.config.toolDurationWarnMs;
    lines.push(`- ${mdCell(inv.toolName)} \`${inv.id}\` age ${formatDuration(age)}${overdue ? ' · long-running' : ''} · correlation ${inv.callId ? 'call-id' : 'pending'}`);
  }
  lines.push('', '## Recent events', '');
  lines.push('| When | Event | Tool | Duration | Correlation | Outcome |');
  lines.push('| --- | --- | --- | ---: | --- | --- |');
  for (const entry of state.recent.slice(0, 40)) {
    lines.push(`| ${new Date(entry.atWall).toISOString()} | ${mdCell(entry.event)} | ${mdCell(entry.toolName || '')} | ${formatDuration(entry.durationMs)} | ${mdCell(entry.correlation)} | ${mdCell(entry.outcome)} |`);
  }
  lines.push('', '## Warnings', '');
  if (!state.warnings.length) lines.push('None.');
  for (const warning of state.warnings.slice(0, 30)) {
    lines.push(`- ${new Date(warning.atWall).toISOString()} · ${warning.message}`);
  }
  lines.push('', '## Data quality', '');
  for (const note of qualityNotes(state)) lines.push(`- ${note}`);
  if (state.monitoringErrors.length) {
    lines.push('', '## Console errors', '');
    lines.push('These are Kusă Console failures, not agent or tool failures.');
    for (const error of state.monitoringErrors.slice(0, 20)) {
      lines.push(`- ${new Date(error.atWall).toISOString()} · ${error.message}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function mdCell(value) {
  return String(value ?? '').replace(/\|/g, '/').replace(/[\r\n]+/g, ' ');
}

function sessionView(lane) {
  ensureLaneSdkFields(lane);
  return {
    key: lane.key,
    harness: lane.harness,
    id: lane.id,
    source: lane.source,
    active: lane.active,
    startObserved: lane.startObserved,
    startEstimated: lane.startEstimated,
    startedAtWall: lane.startedAtWall,
    endedAtWall: lane.endedAtWall,
    endReason: lane.endReason,
    promptIndex: lane.promptIndex,
    promptStartedAtWall: lane.promptStartedAtWall,
    turnOpen: lane.turnOpen,
    notificationWaiting: lane.notificationWaiting,
    notificationsSeen: lane.notificationsSeen,
    lastEventAtWall: lane.lastEventAtWall,
    lastEventName: lane.lastEventName,
    currentIntent: lane.currentIntent || '',
    currentTurnId: lane.currentTurnId || null,
    turnStartedAtWall: lane.turnStartedAtWall || null,
    turnEndedAtWall: lane.turnEndedAtWall || null,
    turnCount: lane.turnCount || 0,
    apiCallDurationMsSum: lane.apiCallDurationMsSum || 0,
    apiCallDurationCount: lane.apiCallDurationCount || 0,
    apiCallDurationMaxMs: lane.apiCallDurationMaxMs || 0,
    apiCallDurationAvgMs: lane.apiCallDurationCount
      ? lane.apiCallDurationMsSum / lane.apiCallDurationCount
      : null,
    outsideToolMsEstimate: lane.outsideToolMsEstimate,
    reasoning: {
      seen: Boolean(lane.reasoning?.seen),
      active: Boolean(lane.reasoning?.active),
      blocks: lane.reasoning?.blocks || 0,
      lastAtWall: lane.reasoning?.lastAtWall || null,
      textPersisted: Boolean(lane.reasoning?.textPersisted),
    },
  };
}

function laneView(state, lane) {
  const open = state.open.filter((inv) => (inv.laneKey || state.focus) === lane.key);
  const summary = lane.summary || emptySummary();
  return {
    key: lane.key,
    harness: lane.harness,
    label: HARNESS_LABELS[lane.harness] || lane.harness,
    status: laneStatus(lane, open.length),
    session: sessionView(lane),
    summary,
    subagents: lane.subagents,
    agentErrors: lane.agentErrors,
    rows: flatRows(lane),
    open: open.map((inv) => ({
      id: inv.id,
      toolName: inv.toolName,
      subName: inv.subName || '',
      startedWall: inv.startedWall,
      callId: Boolean(inv.callId),
    })),
    recent: lane.recent.slice(0, 40).map((entry) => ({
      atWall: entry.atWall,
      event: entry.event,
      toolName: entry.toolName,
      subName: entry.subName || '',
      durationMs: entry.durationMs,
      correlation: entry.correlation,
      outcome: entry.outcome,
    })),
    prompts: (lane.prompts || []).slice(0, 100).map((entry) => ({
      index: entry.index,
      atWall: entry.atWall,
      endedAtWall: entry.endedAtWall,
      durationMs: entry.durationMs,
      chars: entry.chars,
      text: entry.text || '',
      truncated: Boolean(entry.truncated),
      role: entry.role === 'plan' || entry.role === 'system' ? entry.role : 'user',
      response: entry.response || '',
      responseChars: entry.responseChars || 0,
      responseTruncated: Boolean(entry.responseTruncated),
      plan: entry.plan ? {
        name: entry.plan.name || '',
        overview: entry.plan.overview || '',
        body: entry.plan.body || '',
        path: entry.plan.path || '',
        source: entry.plan.source || '',
        atWall: entry.plan.atWall,
      } : null,
      todos: Array.isArray(entry.todos)
        ? entry.todos.map((todo) => ({
          id: todo.id || '',
          content: todo.content || '',
          status: todo.status || 'pending',
        }))
        : null,
      toolAttempts: entry.toolAttempts,
      open: Boolean(entry.open),
      model: entry.model || '',
      tokens: entry.tokens || null,
      trailSavedTokens: entry.trailSavedTokens ?? null,
    })),
    trail: (() => {
      const g = lane.trail && typeof lane.trail === 'object' ? lane.trail : emptyTrail();
      const trailReads = g.trailReads || 0;
      const sourceReads = g.sourceReads || 0;
      const total = trailReads + sourceReads;
      return {
        trailReads,
        sourceReads,
        savedTokens: g.savedTokens || 0,
        host: g.host || '',
        vizUrl: g.vizUrl || TRAIL_VIZ_URL,
        mixPct: total ? Math.round((trailReads / total) * 100) : null,
      };
    })(),
    plan: lane.plan ? {
      name: lane.plan.name || '',
      overview: lane.plan.overview || '',
      body: lane.plan.body || '',
      path: lane.plan.path || '',
      source: lane.plan.source || '',
      atWall: lane.plan.atWall,
    } : null,
    todos: (lane.todos || []).slice(0, 100).map((todo) => ({
      id: todo.id,
      content: todo.content,
      status: todo.status,
    })),
    tokens: (() => {
      const t = lane.tokens && typeof lane.tokens === 'object' ? lane.tokens : emptyTokens();
      return {
        input: t.input || 0,
        output: t.output || 0,
        cacheRead: t.cacheRead || 0,
        cacheWrite: t.cacheWrite || 0,
        turns: t.turns || 0,
        uncached: Math.max(0, (t.input || 0) - (t.cacheRead || 0) - (t.cacheWrite || 0)),
      };
    })(),
    tokenTurns: (lane.tokenTurns || []).slice(0, 100).map((entry) => ({
      generationId: entry.generationId || '',
      promptIndex: entry.promptIndex,
      atWall: entry.atWall,
      model: entry.model || '',
      input: entry.input || 0,
      output: entry.output || 0,
      cacheRead: entry.cacheRead || 0,
      cacheWrite: entry.cacheWrite || 0,
      uncached: entry.uncached ?? Math.max(0, (entry.input || 0) - (entry.cacheRead || 0) - (entry.cacheWrite || 0)),
    })),
    warnings: lane.warnings.slice(0, 30),
    notes: qualityNotes(state, lane),
  };
}

/**
 * Everything the dashboard page needs. `harnesses` is the sidebar tree
 * (harness > sessions, newest first); `lanes` holds the figures for each
 * session; the top-level `session`, `summary`, `rows`, … mirror the lane the
 * last hook event belonged to (`focus`).
 */
export function buildView(state) {
  const lanes = {};
  const byHarness = new Map();
  const ordered = Object.values(state.sessions || {}).sort((a, b) => (b.lastEventAtWall ?? 0) - (a.lastEventAtWall ?? 0));
  for (const lane of ordered) {
    const view = laneView(state, lane);
    lanes[lane.key] = view;
    if (!byHarness.has(lane.harness)) byHarness.set(lane.harness, []);
    byHarness.get(lane.harness).push({
      key: lane.key,
      id: lane.id,
      status: view.status,
      active: lane.active,
      turnOpen: lane.turnOpen,
      running: view.open.length,
      promptIndex: lane.promptIndex,
      attempts: view.summary.attempts,
      warnings: lane.warnings.length,
      startedAtWall: lane.startedAtWall,
      lastEventAtWall: lane.lastEventAtWall,
      lastEventName: lane.lastEventName,
      endedAtWall: lane.endedAtWall,
    });
  }
  const harnesses = [...byHarness.entries()].map(([harness, sessions]) => ({
    harness,
    label: HARNESS_LABELS[harness] || harness,
    current: state.current?.[harness] || null,
    sessions,
  }));
  const focus = (state.focus && lanes[state.focus]) || laneView(state, state.session);
  // settings.json is authoritative; publicSettings strips secrets for the browser payload.
  const settings = publicSettings(loadMonitorSettings(defaultMonitorDir()));
  const sdkListener = state.sdkListener && typeof state.sdkListener === 'object'
    ? state.sdkListener
    : emptySdkListener();
  return {
    origin: state.origin,
    harness: state.harness,
    harnessesSeen: Array.isArray(state.harnessesSeen) ? state.harnessesSeen : [],
    liveSessionVerified: state.liveSessionVerified,
    generatedAtWall: state.generatedAtWall,
    toolWarnMs: state.config.toolDurationWarnMs,
    focus: focus.key,
    harnesses,
    lanes,
    session: focus.session,
    summary: focus.summary,
    subagents: focus.subagents,
    agentErrors: focus.agentErrors,
    rows: focus.rows,
    open: focus.open,
    recent: focus.recent,
    prompts: focus.prompts,
    trail: focus.trail,
    plan: focus.plan,
    todos: focus.todos,
    tokens: focus.tokens,
    tokenTurns: focus.tokenTurns,
    warnings: focus.warnings,
    notes: focus.notes,
    monitoringErrors: state.monitoringErrors.length,
    errors: state.monitoringErrors.slice(0, 20),
    sdkListener,
    settings,
    git: settings.detectGit !== false
      ? collectGitStatus(repoRoot)
      : { ...emptyGitStatus('Git detection disabled in Settings'), ok: true, installed: true, initialized: true },
    // Filesystem snapshot only here — full CLI check is GET /ready on dashboard load.
    trailStatus: settings.detectTrail !== false
      ? snapshotTrailStatus(repoRoot)
      : { ...emptyTrailStatus('Trail detection disabled in Settings'), ok: true, installed: true, initialized: true },
  };
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');
}

export function renderDataScript(state) {
  return `(window.kusaUpdate||window.copilotMonitorUpdate)&&(window.kusaUpdate||window.copilotMonitorUpdate)(${safeJson(buildView(state))});\n`;
}

const BOOTSTRAP_OPEN = '<script id="monitor-bootstrap" type="application/json">';
let templateCache = null;

export function dashboardTemplate() {
  if (templateCache == null) {
    templateCache = readFileSync(join(moduleDir, 'dashboard.html'), 'utf8');
  }
  return templateCache;
}

/**
 * The runtime copy of the dashboard: the same React shell as
 * package `dashboard.html` with the current view inlined as bootstrap data, so
 * it renders before the first poll and even when the poll cannot run.
 * `dashboard.css` and `dashboard.js` are copied alongside by `persist`.
 */
export function renderHtml(state) {
  const template = dashboardTemplate();
  const start = template.indexOf(BOOTSTRAP_OPEN);
  if (start < 0) return template;
  const bodyStart = start + BOOTSTRAP_OPEN.length;
  const end = template.indexOf('</script>', bodyStart);
  if (end < 0) return template;
  return `${template.slice(0, bodyStart)}${safeJson(buildView(state))}${template.slice(end)}`;
}
