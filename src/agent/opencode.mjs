/**
 * OpenCode SDK harness — spawns `opencode serve` via @opencode-ai/sdk and
 * points it at an OpenAI-compatible endpoint from Kusă settings.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgentEndpoint } from './openai-loop.mjs';
import { AGENT_MODE_AGENT, normalizeAgentMode } from './modes.mjs';

const PROVIDER_ID = 'kusa-openai';
const PLUGIN_PATH = fileURLToPath(new URL('./opencode-plugin.mjs', import.meta.url));
const FILES_PATH = fileURLToPath(new URL('./files.mjs', import.meta.url));

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
  const agentMode = normalizeAgentMode(settings?.agentMode);
  const writable = agentMode === AGENT_MODE_AGENT;
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
      bash: 'deny',
      webfetch: 'deny',
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
          bash: 'deny',
          webfetch: 'deny',
          edit: writable ? 'allow' : 'deny',
          delete: writable ? 'allow' : 'deny',
        },
        tools: {
          bash: false,
          webfetch: false,
          // KusaFilesPlugin registers sandboxed delete (+ alias).
          delete: writable,
          kusa_delete_file: writable,
          read: true,
          write: writable,
          edit: writable,
          list: true,
          grep: true,
        },
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
  // Mode changes the permission set, so switching Ask/Plan/Agent must restart the server.
  const mode = normalizeAgentMode(settings?.agentMode);
  return `${workspaceRoot}|${baseUrl}|${model}|${authMode}|${apiKey ? 'auth' : 'none'}|${mode}|${pluginStamp()}`;
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
 */
export async function runOpencodePrompt({
  workspaceRoot,
  settings,
  prompt,
  opencodeSessionId,
  title,
}) {
  const { client } = await getOpencodeInstance({ workspaceRoot, settings });
  const { model } = resolveAgentEndpoint(settings);
  const modelId = model || 'default';

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
