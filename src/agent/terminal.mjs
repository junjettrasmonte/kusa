/**
 * Terminal tool for the Kusă agent: one shell command run inside the workspace.
 * Unlike the file tools this is NOT sandboxed by path, so it is approval-gated
 * (see approval.mjs) — the human yes is the safety boundary, not a path check.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createApprovalGate } from './approval.mjs';

const MAX_TERMINAL_OUT = 60_000;
const DEFAULT_TERMINAL_TIMEOUT_MS = 30_000;
const MAX_TERMINAL_TIMEOUT_MS = 120_000;
// Commands that wait for a TTY would hang until the timeout and stall the agent.
const INTERACTIVE = /^(sudo|su|ssh|scp|sftp|vim?|vi|nano|pico|emacs|less|more|most|top|htop|watch|htop|read|select|git\s+rebase\s+(-\w+\s+)*-i)\b/i;
const SECRET_ENV_KEY = /(?:^|_)(TOKEN|SECRET|KEY|AUTH|PASSWORD|CREDENTIAL|APIKEY|API_KEY)(?:$|_)/i;
const SECRET_FLAG = /--?(?:password|passwd|token|secret|api[-_]?key|auth|access[-_]?token)(?:=|\s+)(\S+)/gi;

export const TERMINAL_TOOL_DEFS = [
  {
    name: 'kusa_terminal',
    description:
      'Run one shell command in the workspace root (approval-gated: the user must allow it first). '
      + 'Non-interactive only — no sudo, no pagers, no editors, no commands that wait for input. '
      + 'Output is capped and secret-looking values are redacted.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        cwd: { type: 'string', description: 'Relative directory to run in (default ".")' },
        timeoutMs: { type: 'integer', description: 'Timeout in ms (default 30000, max 120000)' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
];

/**
 * @param {string} workspaceRoot
 * @param {{ approval?: object }} [options]
 */
export function createTerminalTools(workspaceRoot, { approval = createApprovalGate() } = {}) {
  const root = resolve(workspaceRoot);

  function redact(text = '') {
    let out = String(text || '');
    for (const [key, value] of Object.entries(process.env)) {
      if (!SECRET_ENV_KEY.test(key)) continue;
      const v = String(value || '');
      if (v.length < 6) continue;
      out = out.split(v).join('[redacted]');
    }
    return out.replace(SECRET_FLAG, (match, value) => match.replace(value, '[redacted]'));
  }

  function run(args = {}) {
    const command = String(args.command || '').trim();
    if (!command) return { ok: false, error: 'command is required' };
    if (INTERACTIVE.test(command)) {
      return {
        ok: false,
        error: `interactive command refused (${command.split(/\s+/)[0]}): it would wait for a TTY`,
      };
    }

    const rel = args.cwd == null ? '.' : String(args.cwd);
    const cwd = resolve(root, rel);
    if (cwd !== root && !String(cwd).startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)) {
      return { ok: false, error: `cwd escapes workspace: ${rel}` };
    }

    const requested = args.timeoutMs != null ? Number(args.timeoutMs) : DEFAULT_TERMINAL_TIMEOUT_MS;
    const timeout = Math.min(Math.max(Number.isFinite(requested) ? requested : DEFAULT_TERMINAL_TIMEOUT_MS, 1_000), MAX_TERMINAL_TIMEOUT_MS);

    const spawned = spawnSync(command, [], {
      cwd,
      shell: true,
      encoding: 'utf8',
      timeout,
      maxBuffer: MAX_TERMINAL_OUT * 2,
      windowsHide: true,
    });

    if (spawned.error) {
      const code = spawned.error.code || 'EXEC_FAILED';
      return {
        ok: false,
        error: code === 'ETIMEDOUT'
          ? `command timed out after ${timeout}ms`
          : (spawned.error.message || String(spawned.error)),
        code,
      };
    }

    const stdout = redact(spawned.stdout || '').slice(0, MAX_TERMINAL_OUT);
    const stderr = redact(spawned.stderr || '').slice(0, MAX_TERMINAL_OUT);
    const exitCode = spawned.status ?? spawned.exitCode ?? null;
    const truncated = (String(spawned.stdout || '').length > MAX_TERMINAL_OUT)
      || (String(spawned.stderr || '').length > MAX_TERMINAL_OUT);

    if (exitCode !== 0) {
      return {
        ok: false,
        error: `command exited ${exitCode}: ${stderr || stdout || '(no output)'}`.slice(0, MAX_TERMINAL_OUT),
        command,
        cwd: rel,
        exitCode,
        stdout,
        stderr,
        truncated,
      };
    }

    return {
      ok: true,
      command,
      cwd: rel,
      exitCode,
      stdout,
      stderr,
      truncated,
    };
  }

  async function call(name, args = {}, callId = null) {
    if (name !== 'kusa_terminal' && name !== 'terminal') {
      return { ok: false, error: `unknown terminal tool: ${name}` };
    }
    const verdict = await approval.request({
      name,
      args,
      callId,
    });
    if (!verdict.allowed) {
      // The gate always settles, so this is a real denial — say which rule
      // settled it and whether a retry is even possible (an unattended run has
      // no user to allow the call, so retrying would just deny again).
      const reason = verdict?.reason || `${name} was not approved`;
      const byRule = String(verdict?.decision || '').endsWith('-default');
      return {
        ok: false,
        denied: true,
        approval: verdict,
        error: verdict?.unattended === true
          ? `DENIED before running: no approver is wired for this run, so the rule default applied — ${reason}. Retrying will be denied again; ask the user to switch the approval rule to Allow if this must run.`
          : byRule
            ? `DENIED before running: nobody answered in time, so the rule default applied — ${reason}. The command was NOT run. Describe the exact command and why you need it, then retry once the user allows it.`
            : `DENIED by the user before running: ${reason} — the command was not run.`,
      };
    }
    return run(args);
  }

  return {
    root,
    defs: TERMINAL_TOOL_DEFS,
    call,
    run,
    approval,
  };
}
