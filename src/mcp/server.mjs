#!/usr/bin/env node
/**
 * Kusă MCP server — newline-delimited JSON-RPC 2.0 over stdio.
 * stdout is protocol-only; diagnostics go to stderr.
 *
 * Prefer the localhost HTTP endpoint from `kusa serve` (Harness → MCP).
 * This stdio entry remains for hosts that cannot use URL transport.
 *
 *   kusa mcp
 */
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultMonitorDir, defaultWorkspaceRoot } from '../lib.mjs';
import { handleMcpMessage, packageVersion } from './protocol.mjs';

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

export function startMcpServer({
  workspaceRoot = defaultWorkspaceRoot(),
  dataDir = defaultMonitorDir(workspaceRoot),
  version = packageVersion(),
} = {}) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    handleMcpMessage(msg, { workspaceRoot, dataDir, version }).then((result) => {
      if (result.kind === 'notification') return;
      if (result.message) send(result.message);
    }, (err) => {
      const id = msg?.id;
      send({
        jsonrpc: '2.0',
        id: id === undefined ? null : id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      });
    });
  });
  process.stdin.on('end', () => process.exit(0));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) startMcpServer();
