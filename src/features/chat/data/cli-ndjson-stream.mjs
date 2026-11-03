/**
 * Spawn a CLI and consume newline-delimited JSON from stdout, one object per
 * line. Shared by Cursor (`stream-json`) and Copilot (`--output-format json`).
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { cliAgentEnv } from './cli-agent-env.mjs';

/**
 * @param {object} opts
 * @param {string} opts.command
 * @param {string[]} opts.args
 * @param {string} [opts.cwd]
 * @param {Record<string, string | undefined>} [opts.env]
 * @param {AbortSignal} [opts.signal]
 * @param {(ev: object, raw: string) => void} opts.onJson
 * @returns {Promise<{ code: number | null, stderr: string }>}
 */
export function runNdjsonCli({
  command,
  args,
  cwd = process.cwd(),
  env,
  signal,
  onJson,
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try { signal?.removeEventListener?.('abort', onAbort); } catch { /* ignore */ }
      fn(value);
    };

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        // Default: strip HTTP(S)_PROXY so Cursor/Copilot do not hit MITM TLS failures.
        env: env ? { ...env } : cliAgentEnv(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish(reject, err);
      return;
    }

    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => { stderr += chunk; });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const raw = String(line || '').trim();
      if (!raw) return;
      let ev;
      try {
        ev = JSON.parse(raw);
      } catch {
        return;
      }
      if (!ev || typeof ev !== 'object') return;
      try {
        onJson?.(ev, raw);
      } catch (err) {
        // Mapper bugs must not kill the CLI process mid-turn.
        console.error('[cli-ndjson] onJson failed:', err?.message || err);
      }
    });

    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      finish(reject, Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    child.once('error', (err) => {
      finish(reject, err?.code === 'ENOENT'
        ? Object.assign(new Error(`${command} not found on PATH`), { code: 'ENOENT' })
        : err);
    });

    child.once('close', (code) => {
      try { rl.close(); } catch { /* ignore */ }
      finish(resolve, { code: code == null ? null : Number(code), stderr: stderr.trim() });
    });
  });
}

/**
 * Summarise a tool result payload for the harness tool row.
 * @param {unknown} result
 */
export function summariseToolResult(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result.slice(0, 4000);
  try {
    return JSON.stringify(result).slice(0, 4000);
  } catch {
    return String(result).slice(0, 4000);
  }
}
