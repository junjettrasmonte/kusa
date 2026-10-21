/**
 * User-defined MCP tools stored under `.kusa/custom-tools.json`.
 * Built-ins live in catalog.mjs; custom tools return a templated body.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { TOOL_CATALOG } from './catalog.mjs';

const STORE_FILE = 'custom-tools.json';
const NAME_RE = /^kusa_[a-z][a-z0-9_]{1,62}$/;

const builtinNames = () => new Set(TOOL_CATALOG.map((t) => t.name));

export function customToolsPath(monitorDir) {
  return join(resolve(monitorDir), STORE_FILE);
}

function readStore(monitorDir) {
  const path = customToolsPath(monitorDir);
  if (!existsSync(path)) return { version: 1, tools: {} };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { version: 1, tools: {} };
    const tools = raw.tools && typeof raw.tools === 'object' && !Array.isArray(raw.tools)
      ? raw.tools
      : {};
    return { version: 1, tools };
  } catch {
    return { version: 1, tools: {} };
  }
}

function writeStore(monitorDir, store) {
  const path = customToolsPath(monitorDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`);
}

function normalizeSchema(input) {
  if (input == null || input === '') {
    return { type: 'object', properties: {}, additionalProperties: false };
  }
  let schema = input;
  if (typeof input === 'string') {
    try {
      schema = JSON.parse(input);
    } catch {
      const err = new Error('inputSchema must be valid JSON');
      err.code = 'EINVAL';
      throw err;
    }
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    const err = new Error('inputSchema must be a JSON object');
    err.code = 'EINVAL';
    throw err;
  }
  if (schema.type && schema.type !== 'object') {
    const err = new Error('inputSchema.type must be "object"');
    err.code = 'EINVAL';
    throw err;
  }
  return {
    type: 'object',
    properties: schema.properties && typeof schema.properties === 'object'
      ? schema.properties
      : {},
    ...(Array.isArray(schema.required) ? { required: schema.required.map(String) } : {}),
    additionalProperties: schema.additionalProperties === true,
  };
}

function validateName(name, { forCreate = false, existing = null } = {}) {
  const n = String(name || '').trim();
  if (!NAME_RE.test(n)) {
    const err = new Error(
      'Tool name must match kusa_[a-z][a-z0-9_]{1,62} (e.g. kusa_project_notes)',
    );
    err.code = 'EINVAL';
    throw err;
  }
  if (builtinNames().has(n)) {
    const err = new Error(`Name collides with a built-in tool: ${n}`);
    err.code = 'EEXIST';
    throw err;
  }
  if (forCreate && existing && existing[n]) {
    const err = new Error(`Tool already exists: ${n}`);
    err.code = 'EEXIST';
    throw err;
  }
  return n;
}

function publicTool(record, { builtin = false } = {}) {
  if (!record) return null;
  return {
    id: record.name,
    name: record.name,
    description: record.description,
    inputSchema: record.inputSchema,
    body: record.body || '',
    enabled: record.enabled !== false,
    builtin,
    createdAtWall: record.createdAtWall || null,
    updatedAtWall: record.updatedAtWall || null,
  };
}

/** List built-in + custom tools (for console). */
export function listAllTools(monitorDir, enabledFlags = {}) {
  const store = readStore(monitorDir);
  const builtins = TOOL_CATALOG.map((t) => ({
    id: t.name,
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    body: '',
    enabled: enabledFlags[t.name] !== false,
    builtin: true,
    createdAtWall: null,
    updatedAtWall: null,
  }));
  const custom = Object.values(store.tools)
    .map((t) => publicTool(t, { builtin: false }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { tools: [...builtins, ...custom] };
}

export function listCustomTools(monitorDir) {
  const store = readStore(monitorDir);
  return Object.values(store.tools)
    .map((t) => publicTool(t))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readCustomTool(monitorDir, name) {
  const store = readStore(monitorDir);
  const record = store.tools[name];
  if (!record) {
    const err = new Error(`Tool not found: ${name}`);
    err.code = 'ENOENT';
    throw err;
  }
  return publicTool(record);
}

export function createCustomTool(monitorDir, input = {}) {
  const store = readStore(monitorDir);
  const name = validateName(input.name, { forCreate: true, existing: store.tools });
  const description = String(input.description || '').trim();
  if (!description) {
    const err = new Error('description is required');
    err.code = 'EINVAL';
    throw err;
  }
  const now = Date.now();
  const record = {
    name,
    description,
    inputSchema: normalizeSchema(input.inputSchema),
    body: String(input.body || ''),
    enabled: input.enabled !== false,
    createdAtWall: now,
    updatedAtWall: now,
  };
  store.tools[name] = record;
  writeStore(monitorDir, store);
  return publicTool(record);
}

export function updateCustomTool(monitorDir, name, input = {}) {
  const store = readStore(monitorDir);
  const current = store.tools[name];
  if (!current) {
    // Allow toggling enable on built-ins via a different path; custom only here.
    if (builtinNames().has(name)) {
      const err = new Error('Built-in tools cannot be edited here; toggle enable from the list');
      err.code = 'EINVAL';
      throw err;
    }
    const err = new Error(`Tool not found: ${name}`);
    err.code = 'ENOENT';
    throw err;
  }

  let nextName = name;
  if (input.name != null && String(input.name).trim() !== name) {
    nextName = validateName(input.name, { forCreate: true, existing: store.tools });
  }

  const description = input.description !== undefined
    ? String(input.description || '').trim()
    : current.description;
  if (!description) {
    const err = new Error('description is required');
    err.code = 'EINVAL';
    throw err;
  }

  const record = {
    ...current,
    name: nextName,
    description,
    inputSchema: input.inputSchema !== undefined
      ? normalizeSchema(input.inputSchema)
      : current.inputSchema,
    body: input.body !== undefined ? String(input.body || '') : current.body,
    enabled: input.enabled !== undefined ? Boolean(input.enabled) : current.enabled !== false,
    updatedAtWall: Date.now(),
  };

  if (nextName !== name) delete store.tools[name];
  store.tools[nextName] = record;
  writeStore(monitorDir, store);
  return publicTool(record);
}

export function deleteCustomTool(monitorDir, name) {
  const store = readStore(monitorDir);
  if (!store.tools[name]) {
    if (builtinNames().has(name)) {
      const err = new Error('Cannot delete a built-in tool');
      err.code = 'EINVAL';
      throw err;
    }
    const err = new Error(`Tool not found: ${name}`);
    err.code = 'ENOENT';
    throw err;
  }
  delete store.tools[name];
  writeStore(monitorDir, store);
  return { deleted: name };
}

export function setCustomToolEnabled(monitorDir, name, enabled) {
  return updateCustomTool(monitorDir, name, { enabled: Boolean(enabled) });
}

/** Tools advertised on MCP tools/list (enabled built-ins + enabled customs). */
export function advertisedCustomTools(monitorDir) {
  return listCustomTools(monitorDir)
    .filter((t) => t.enabled !== false)
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
}

/** Render custom tool body with {{arg}} substitution. */
export function runCustomTool(monitorDir, name, args = {}) {
  const tool = readCustomTool(monitorDir, name);
  if (tool.enabled === false) {
    return { text: JSON.stringify({ error: `tool disabled: ${name}` }, null, 2), isError: true };
  }
  let body = tool.body || '';
  for (const [key, value] of Object.entries(args || {})) {
    const re = new RegExp(`\\{\\{\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'g');
    body = body.replace(re, value == null ? '' : String(value));
  }
  // Leave unmatched {{tokens}} as-is so authors can see missing args.
  return {
    text: body.trim()
      ? body
      : JSON.stringify({ ok: true, tool: name, args }, null, 2),
    isError: false,
  };
}

export function isBuiltinToolName(name) {
  return builtinNames().has(name);
}
