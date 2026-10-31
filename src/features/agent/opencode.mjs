/**
 * OpenCode SDK harness — spawns `opencode serve` via @opencode-ai/sdk and
 * points it at an OpenAI-compatible endpoint from Kusă settings.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgentEndpoint } from './openai-loop.mjs';
import { AGENT_MODE_AGENT, normalizeAgentMode } from './modes.mjs';
import { normalizeApprovalMode } from './approval.mjs';

const PROVIDER_ID = 'kusa-openai';
const PLUGIN_PATH = fileURLToPath(new URL('./opencode-plugin.mjs', import.meta.url));
const FILES_PATH = fileURLToPath(new URL('./files.mjs', import.meta.url));

/**
 * The composer's approval Rule, resolved for this run: the picker wins, then
 * Settings, then the native default. OpenCode has no gate we wrap — its own
 * permission system IS the rule — so every layer below reads this value.
 * @param {object} settings
 * @param {string} [override] composer picker value ('' = follow settings)
 */
export function resolveApprovalRule(settings = {}, override = '') {
  return normalizeApprovalMode(override || settings?.agentApprovalMode);
}

/**
 * Coarse rule identity for the cached OpenCode server. Only the ask/allow/deny
 * CLASS changes what the config can express, so ask-deny ↔ ask-allow (which
 * differ only in the timeout default our native gate owns) must NOT restart it.
 * @param {string} rule normalized approval rule
 */
export function ruleClassOf(rule) {
  if (rule === 'deny') return 'deny';
  if (rule === 'allow') return 'allow';
  return 'ask';
}

/** @param {string} rule normalized approval rule */
export function permissionForRule(rule) {
  return rule === 'deny' ? 'deny' : rule === 'allow' ? 'allow' : 'ask';
}

/**
 * One tool-flag map, used BOTH in the server config (agent.build.tools) and in
 * every prompt body (`tools`). Sending the full set per request — not just the
 * overridden keys — means the current Rule wins for that call whatever the
 * merge semantics, so allow/deny take effect without rebuilding the server.
 * @param {boolean} writable Agent mode only (Ask/Plan are read-only)
 * @param {string} rule normalized approval rule
 */
export function agentToolFlags({ writable = false, rule = 'ask-deny' } = {}) {
  const terminalAllowed = rule !== 'deny';
  return {
    bash: terminalAllowed,
    webfetch: terminalAllowed,
    delete: writable,
    kusa_delete_file: writable,
    read: true,
    write: writable,
    edit: writable,
    list: true,
    grep: true,
  };
}

/** @type {Promise<{ client: import('@opencode-ai/sdk').OpencodeClient, server: { url: string, close(): void }, workspaceRoot: string }> | null} */
let shared = null;
/** @type {string | null} */
let sharedKey = null;

export function opencodeCliAvailable(env = process.env) {
  const pathEnv = String(env.PATH || '');
  const parts = pathEnv.split(env.delimiter || ':').filter(Boolean);
  const names = process.platform === 'win32' ? ['opencode.exe', 'opencode.cmd', 'opencode'] : ['opencode'];
  for (const dir of parts) {
    for (const name of names) {
      try {
        accessSync(join(dir, name), constants.X_OK);
        return true;
      } catch {
        /* continue */
      }
    }
  }
  return false;
}

/**
 * Build OpenCode config from Kusă agent settings.
 * @param {object} settings
 * @param {string} [workspaceRoot]
 */
export function buildOpencodeConfig(settings = {}, workspaceRoot = process.cwd()) {
  const { baseUrl, model, authMode, apiKey } = resolveAgentEndpoint(settings);
  if (!baseUrl) {
    const err = new Error('Set an OpenAI-compatible base URL under Settings → Kusă agent.');
    err.code = 'EINVAL';
    throw err;
  }

  /** @type {Record<string, unknown>} */
  const options = {
    baseURL: baseUrl,
  };
  /** @type {Record<string, string>} */
  const headers = {};
  if (authMode === 'apikey' && apiKey) {
    options.apiKey = apiKey;
    headers.Authorization = `Bearer ${apiKey}`;
  }
  // Local / open endpoints often still require a non-empty apiKey field.
  if (authMode === 'none') {
    options.apiKey = 'no-auth';
  }
  if (Object.keys(headers).length) {
    options.headers = headers;
  }

  const modelId = model || 'default';
  // Ask/Plan modes get a read-only permission set; Agent keeps write + edit.
  // The approval Rule maps onto OpenCode's own permission set for bash/webfetch:
  // deny = tool off, allow = runs as-is, ask-* = needs a yes first. 'ask' is the
  // one class that needs the server config, which is why instanceKey hashes the
  // rule CLASS, not the exact rule.
  const agentMode = normalizeAgentMode(settings?.agentMode);
  const writable = agentMode === AGENT_MODE_AGENT;
  const rule = resolveApprovalRule(settings);
  const terminalPermission = permissionForRule(rule);
  const toolFlags = agentToolFlags({ writable, rule });
  return {
    model: `${PROVIDER_ID}/${modelId}`,
    enabled_providers: [PROVIDER_ID],
    disabled_providers: undefined,
    plugin: [PLUGIN_PATH],
    provider: {
      [PROVIDER_ID]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Kusă OpenAI',
        options,
        models: {
          [modelId]: {
            name: modelId,
            tool_call: true,
          },
        },
      },
    },
    permission: {
      // Follow the composer/Settings Rule — this is what makes the Rule apply
      // at all in this backend.
      bash: terminalPermission,
      webfetch: terminalPermission,
      edit: writable ? 'allow' : 'deny',
      // Plugin-provided sandboxed delete (see opencode-plugin.mjs).
      delete: writable ? 'allow' : 'deny',
      doom_loop: 'ask',
      external_directory: 'deny',
    },
    agent: {
      build: {
        model: `${PROVIDER_ID}/${modelId}`,
        permission: {
          bash: terminalPermission,
          webfetch: terminalPermission,
          edit: writable ? 'allow' : 'deny',
          delete: writable ? 'allow' : 'deny',
        },
        tools: { ...toolFlags },
      },
    },
    // Hint for humans reading generated config — OpenCode ignores unknown keys safely in merge.
    directory: workspaceRoot,
  };
}

function pluginStamp() {
  // Bust the shared OpenCode server when file-tool sources change.
  try {
    const a = statSync(PLUGIN_PATH).mtimeMs;
    const b = statSync(FILES_PATH).mtimeMs;
    return `${a}:${b}`;
  } catch {
    return '0';
  }
}

function instanceKey(workspaceRoot, settings) {
  const { baseUrl, model, authMode, apiKey } = resolveAgentEndpoint(settings);
  // Mode changes the permission set, so switching Ask/Plan/Agent must restart the
  // server. So does the approval Rule's ask/allow/deny class — the Rule must take
  // effect as soon as it is changed, and the config is the only place OpenCode
  // reads it. The class (not the exact rule) is hashed so ask-deny ↔ ask-allow,
  // which the config cannot tell apart, never tears the server down.
  const mode = normalizeAgentMode(settings?.agentMode);
  const ruleClass = ruleClassOf(resolveApprovalRule(settings));
  return `${workspaceRoot}|${baseUrl}|${model}|${authMode}|${apiKey ? 'auth' : 'none'}|${mode}|${ruleClass}|${pluginStamp()}`;
}

/**
 * Lazily start (or reuse) an OpenCode server+client for this workspace/settings.
 */
export async function getOpencodeInstance({ workspaceRoot, settings, port = 0 }) {
  const key = instanceKey(workspaceRoot, settings);
  if (shared && sharedKey === key) return shared;

  if (shared) {
    try {
      (await shared).server.close();
    } catch {
      /* ignore */
    }
    shared = null;
    sharedKey = null;
  }

  if (!opencodeCliAvailable()) {
    const err = new Error(
      'OpenCode CLI (`opencode`) not found on PATH. Install it, or set agent backend to "native".',
    );
    err.code = 'ENOENT';
    throw err;
  }

  const config = buildOpencodeConfig(settings, workspaceRoot);
  const listenPort = Number(port) > 0 ? Number(port) : 0;

  sharedKey = key;
  shared = (async () => {
    const { createOpencode } = await import('@opencode-ai/sdk');
    const { client, server } = await createOpencode({
      hostname: '127.0.0.1',
      // 0 → let OS pick; SDK still passes --port=
      port: listenPort || 4096 + Math.floor(Math.random() * 1000),
      timeout: 20_000,
      config,
    });
    // Best-effort: set cwd via path API if available.
    try {
      await client.path.get?.();
    } catch {
      /* optional */
    }
    return { client, server, workspaceRoot };
  })();

  try {
    return await shared;
  } catch (err) {
    shared = null;
    sharedKey = null;
    throw err;
  }
}

export function closeOpencodeInstance() {
  if (!shared) return;
  const pending = shared;
  shared = null;
  sharedKey = null;
  pending.then((inst) => {
    try {
      inst.server.close();
    } catch {
      /* ignore */
    }
  }, () => {});
}

function partsToText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim();
}

/**
 * Send a prompt through OpenCode SDK.
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @param {object} options.settings
 * @param {string} options.prompt
 * @param {string} [options.opencodeSessionId]
 * @param {string} [options.title]
 * @param {string} [options.approvalMode] composer Rule override ('' = settings)
 */
export async function runOpencodePrompt({
  workspaceRoot,
  settings,
  prompt,
  opencodeSessionId,
  title,
  approvalMode = null,
}) {
  const { client } = await getOpencodeInstance({ workspaceRoot, settings });
  const { model } = resolveAgentEndpoint(settings);
  const modelId = model || 'default';
  // The Rule as it stands for THIS prompt. A running server's config cannot
  // change mid-session, but the prompt body can — so the current Rule is
  // re-sent on every call and a picker change lands on the next prompt without
  // restarting the server (only an ask/allow/deny CLASS change rebuilds it,
  // through instanceKey).
  const rule = resolveApprovalRule(settings, approvalMode);
  const toolFlags = agentToolFlags({
    writable: normalizeAgentMode(settings?.agentMode) === AGENT_MODE_AGENT,
    rule,
  });

  let sessionId = opencodeSessionId || '';
  if (sessionId) {
    try {
      await client.session.get({ path: { id: sessionId } });
    } catch {
      sessionId = '';
    }
  }
  if (!sessionId) {
    const created = await client.session.create({
      body: { title: title || 'Kusă chat' },
    });
    sessionId = created?.data?.id || created?.id;
    if (!sessionId) {
      const err = new Error('OpenCode session.create returned no id');
      err.code = 'EPROTO';
      throw err;
    }
  }

  const result = await client.session.prompt({
    path: { id: sessionId },
    body: {
      model: { providerID: PROVIDER_ID, modelID: modelId },
      // Per-request Rule enforcement (see agentToolFlags): the full map, so this
      // call is self-describing rather than relying on a merge with an agent
      // config that may be stale.
      tools: { ...toolFlags },
      parts: [{ type: 'text', text: String(prompt || '') }],
    },
  });

  const data = result?.data ?? result;
  const info = data?.info;
  const parts = data?.parts;
  let text = partsToText(parts);
  if (!text && info?.error) {
    text = info.error?.data?.message || info.error?.name || 'OpenCode error';
  }
  if (!text) text = '(empty response)';

  return {
    backend: 'opencode',
    text,
    opencodeSessionId: sessionId,
    toolTrace: [],
    model: `${PROVIDER_ID}/${modelId}`,
  };
}
