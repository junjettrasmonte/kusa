/**
 * Cursor Agent (`agent` / `cursor-agent`) workspace-trust helpers.
 *
 * CAO's cursor_cli REPL cannot pass `--trust` (interactive-only rejection), so
 * first launch in a directory blocks on "Workspace Trust Required" until the
 * operator accepts once. We probe with a headless `-p` run (no --trust) and
 * grant with `-p --trust` when the user clicks Trust workspace in the console.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { cliAgentEnv } from '#features/chat/data/cli-agent-env.mjs';

export const CURSOR_TRUST_REQUIRED_RE =
  /Workspace Trust Required|Do you trust the contents of this directory|trust this workspace|ECAO_TRUST|workspace trust is usually blocking/i;

/**
 * @param {unknown} textOrCode
 */
export function looksLikeCursorTrustRequired(textOrCode) {
  if (textOrCode == null) return false;
  if (typeof textOrCode === 'object' && textOrCode.code === 'ECAO_TRUST') return true;
  return CURSOR_TRUST_REQUIRED_RE.test(String(textOrCode));
}

/**
 * Prefer `cursor-agent` (unambiguous) then `agent`, matching CAO's provider.
 * @returns {{ binary: string, path: string } | null}
 */
export function resolveCursorAgentBinary() {
  const names = ['cursor-agent', 'agent'];
  const pathDirs = String(process.env.PATH || '')
    .split(':')
    .filter(Boolean);
  for (const name of names) {
    for (const dir of pathDirs) {
      const full = `${dir.replace(/\/+$/, '')}/${name}`;
      try {
        accessSync(full, fsConstants.X_OK);
        return { binary: name, path: full };
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

/**
 * @param {string} binary
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, code: number | null, stdout: string, stderr: string, error?: string }>}
 */
function runCursorAgent(binary, args, { cwd, timeoutMs = 45_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(binary, args, {
        cwd: cwd || process.cwd(),
        env: cliAgentEnv(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish({
        ok: false,
        code: null,
        stdout: '',
        stderr: '',
        error: err?.message || String(err),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      finish({
        ok: false,
        code: null,
        stdout,
        stderr,
        error: `timed out after ${timeoutMs}ms`,
      });
    }, Math.max(1000, timeoutMs));

    child.once('error', (err) => {
      clearTimeout(timer);
      finish({
        ok: false,
        code: null,
        stdout,
        stderr,
        error: err?.code === 'ENOENT'
          ? 'Cursor Agent CLI not found on PATH'
          : (err?.message || String(err)),
      });
    });

    child.once('close', (code) => {
      clearTimeout(timer);
      finish({
        ok: code === 0,
        code: code == null ? null : Number(code),
        stdout,
        stderr,
      });
    });
  });
}

/**
 * Probe whether this workspace still needs Cursor Agent trust.
 * Uses headless print mode without `--trust` so it never grants trust.
 *
 * @param {{ cwd?: string, timeoutMs?: number }} [opts]
 */
export async function probeCursorWorkspaceTrust({
  cwd = process.cwd(),
  timeoutMs = 20_000,
} = {}) {
  const resolved = resolveCursorAgentBinary();
  if (!resolved) {
    return {
      ok: false,
      installed: false,
      needsTrust: false,
      error: 'Cursor Agent CLI not found (install from https://cursor.com/cli)',
      output: '',
    };
  }

  const result = await runCursorAgent(
    resolved.binary,
    ['-p', 'ok', '--output-format', 'text'],
    { cwd, timeoutMs },
  );
  const output = `${result.stdout || ''}\n${result.stderr || ''}\n${result.error || ''}`;
  const needsTrust = looksLikeCursorTrustRequired(output);

  return {
    ok: true,
    installed: true,
    binary: resolved.binary,
    needsTrust,
    error: needsTrust
      ? null
      : (result.ok ? null : (result.error || 'Cursor Agent probe failed')),
    output: output.trim().slice(0, 2000),
  };
}

/**
 * Grant workspace trust via headless `agent -p --trust`.
 * Safe to call repeatedly; Cursor records trust per directory.
 *
 * @param {{ cwd?: string, timeoutMs?: number }} [opts]
 */
export async function trustCursorWorkspace({
  cwd = process.cwd(),
  timeoutMs = 60_000,
} = {}) {
  const resolved = resolveCursorAgentBinary();
  if (!resolved) {
    return {
      ok: false,
      installed: false,
      needsTrust: true,
      error: 'Cursor Agent CLI not found (install from https://cursor.com/cli)',
      output: '',
    };
  }

  const result = await runCursorAgent(
    resolved.binary,
    ['-p', '--trust', 'ok', '--output-format', 'text'],
    { cwd, timeoutMs },
  );
  const output = `${result.stdout || ''}\n${result.stderr || ''}\n${result.error || ''}`;
  const stillNeeds = looksLikeCursorTrustRequired(output);

  if (stillNeeds) {
    return {
      ok: false,
      installed: true,
      binary: resolved.binary,
      needsTrust: true,
      error: 'Cursor Agent still requires workspace trust after --trust',
      output: output.trim().slice(0, 2000),
    };
  }

  // Re-probe so the UI can clear the banner even if the trust run's print
  // turn failed for an unrelated reason (auth/network) after accepting trust.
  const probe = await probeCursorWorkspaceTrust({ cwd, timeoutMs: Math.min(timeoutMs, 20_000) });
  if (probe.needsTrust) {
    return {
      ok: false,
      installed: true,
      binary: resolved.binary,
      needsTrust: true,
      error: result.error || probe.error || 'Workspace trust was not recorded',
      output: output.trim().slice(0, 2000),
    };
  }

  return {
    ok: true,
    installed: true,
    binary: resolved.binary,
    needsTrust: false,
    error: null,
    output: output.trim().slice(0, 2000),
  };
}
