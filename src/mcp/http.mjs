/**
 * Localhost Streamable HTTP MCP endpoint (POST /mcp/<workspace-slug>/rpc).
 * Auth: optional Bearer token from `.kusa/mcp.json`.
 */
import { timingSafeEqual } from 'node:crypto';
import { handleMcpMessage } from './protocol.mjs';
import {
  loadMcpState,
  mcpRpcPath,
  parseMcpRpcPath,
  workspaceMcpSlug,
} from './config.mjs';

export { mcpRpcPath, parseMcpRpcPath };

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function extractBearer(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (!header || typeof header !== 'string') return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** Reject non-localhost Origin when present (DNS rebinding). */
export function isAllowedMcpOrigin(origin) {
  if (origin == null || origin === '' || origin === 'null') return true;
  try {
    const u = new URL(origin);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  } catch {
    return false;
  }
}

export function checkMcpAuth(req, state) {
  const token = String(state?.authToken || '').trim();
  if (!token) return { ok: true, required: false };
  const presented = extractBearer(req);
  if (!presented || !safeEqual(presented, token)) {
    return { ok: false, required: true };
  }
  return { ok: true, required: true };
}

function sendRpcJson(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * Handle /mcp/<slug>/rpc for this workspace. Returns true if consumed.
 * Wrong-slug /mcp/.../rpc paths get a 404 (still consumed). Legacy /mcp/rpc → 404 with hint.
 */
export async function handleMcpRpcRequest(req, res, {
  url,
  dataDir,
  workspaceRoot,
  readBody,
  enabled,
}) {
  const expectedSlug = workspaceMcpSlug(workspaceRoot);
  const expectedPath = mcpRpcPath(workspaceRoot);
  const pathSlug = parseMcpRpcPath(url.pathname);
  const legacy = url.pathname === '/mcp/rpc';

  if (!pathSlug && !legacy) return false;

  if (legacy || pathSlug !== expectedSlug) {
    sendRpcJson(res, 404, {
      error: 'mcp endpoint not found for this path',
      expected: expectedPath,
      workspace: expectedSlug,
    });
    return true;
  }

  const state = loadMcpState(dataDir);
  const live = enabled !== undefined ? Boolean(enabled) : state.enabled === true;

  if (!live) {
    sendRpcJson(res, 404, {
      error: 'mcp endpoint disabled — enable under Harness → MCP',
      path: expectedPath,
    });
    return true;
  }

  if (!isAllowedMcpOrigin(req.headers.origin)) {
    sendRpcJson(res, 403, { error: 'forbidden origin' });
    return true;
  }

  const auth = checkMcpAuth(req, state);
  if (!auth.ok) {
    res.writeHead(401, {
      'Content-Type': 'application/json; charset=utf-8',
      'WWW-Authenticate': 'Bearer realm="kusa-mcp"',
      'Cache-Control': 'no-store',
    });
    res.end(`${JSON.stringify({ error: 'unauthorized', message: 'Bearer token required' })}\n`);
    return true;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    sendRpcJson(res, 200, {
      ok: true,
      transport: 'streamable-http',
      path: expectedPath,
      workspace: expectedSlug,
      authRequired: Boolean(String(state.authToken || '').trim()),
    });
    return true;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': req.headers.origin || 'http://127.0.0.1',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
      'Access-Control-Max-Age': '600',
    });
    res.end();
    return true;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'GET, HEAD, POST, OPTIONS' });
    res.end('method not allowed\n');
    return true;
  }

  let raw;
  try {
    raw = await readBody(req, 2_000_000);
  } catch (err) {
    sendRpcJson(res, err?.code === 'ELARGE' ? 413 : 400, { error: err?.code === 'ELARGE' ? 'body too large' : 'read error' });
    return true;
  }

  let msg;
  try {
    msg = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    sendRpcJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return true;
  }

  const result = await handleMcpMessage(msg, { workspaceRoot, dataDir });
  if (result.kind === 'notification') {
    res.writeHead(202, { 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }
  if (result.kind === 'error') {
    sendRpcJson(res, result.httpStatus || 400, result.message);
    return true;
  }
  sendRpcJson(res, 200, result.message);
  return true;
}
