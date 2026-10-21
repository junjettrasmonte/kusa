/**
 * Shared JSON-RPC handlers for stdio and localhost HTTP MCP transports.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advertisedTools, callTool } from './tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..');

export function packageVersion() {
  try {
    return JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version || '0';
  } catch {
    return '0';
  }
}

export const MCP_INSTRUCTIONS = [
  'Kusă MCP: skills, Trail learnings (team memory), and session status for this workspace.',
  '',
  '- kusa_list_skills / kusa_get_skill — agent skills from .kusa/skills',
  '- kusa_list_learnings / kusa_add_learning — Trail memory in .trail/learnings',
  '- kusa_get_session — latest monitor focus session summary',
  '',
  'Manage enablement, auth, and tools from the Kusă Console (Harness → MCP / Tools).',
].join('\n');

/**
 * Handle one JSON-RPC message. Returns:
 *   { kind: 'response', message }
 *   { kind: 'notification' }  — accepted, no body
 *   { kind: 'error', httpStatus?, message }
 */
export async function handleMcpMessage(msg, {
  workspaceRoot,
  dataDir,
  version = packageVersion(),
} = {}) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return {
      kind: 'error',
      httpStatus: 400,
      message: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } },
    };
  }

  const { id, method, params } = msg;
  const isNotification = id === undefined;

  if (!method || typeof method !== 'string') {
    if (isNotification) return { kind: 'notification' };
    return {
      kind: 'response',
      message: { jsonrpc: '2.0', id, error: { code: -32600, message: 'invalid request' } },
    };
  }

  switch (method) {
    case 'initialize':
      return {
        kind: 'response',
        message: {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'kusa', version },
            instructions: MCP_INSTRUCTIONS,
          },
        },
      };

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { kind: 'notification' };

    case 'ping':
      if (isNotification) return { kind: 'notification' };
      return { kind: 'response', message: { jsonrpc: '2.0', id, result: {} } };

    case 'tools/list': {
      if (isNotification) return { kind: 'notification' };
      return {
        kind: 'response',
        message: {
          jsonrpc: '2.0',
          id,
          result: {
            tools: advertisedTools(dataDir).map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        },
      };
    }

    case 'tools/call': {
      if (isNotification) return { kind: 'notification' };
      const name = String(params?.name ?? '');
      const args = params?.arguments ?? {};
      try {
        const r = await callTool(name, args, workspaceRoot);
        return {
          kind: 'response',
          message: {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: r.text }],
              isError: r.isError,
            },
          },
        };
      } catch (err) {
        return {
          kind: 'response',
          message: {
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          },
        };
      }
    }

    default:
      if (isNotification) return { kind: 'notification' };
      return {
        kind: 'response',
        message: {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `method not found: ${method}` },
        },
      };
  }
}
