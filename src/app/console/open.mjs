#!/usr/bin/env node
/**
 * Open the Agentic Development Console once per session. Pure Node, no dependencies.
 *
 * Runs from sessionStart hooks of any wired harness (e.g. Copilot
 * `.github/hooks/copilot-runtime-monitor.json`, Cursor `.cursor/hooks.json`).
 * Reads the hook payload on stdin only to learn the session id and cwd;
 * nothing from it is stored.
 *
 * Opens the live console in a browser: http://127.0.0.1:1424/dashboard.html when
 * `serve.mjs` is up, otherwise the file copy in `.kusa/` (polling needs the server).
 *
 * Off by default — sessionStart hooks call this on every chat, and opening the
 * console lands on AuthGate when login is configured. Set KUSA_OPEN=browser to
 * auto-open; a TTY `kusa open` still launches unless KUSA_OPEN=none.
 *
 * KUSA_OPEN / COPILOT_MONITOR_OPEN = none (default) | browser
 *   (`vscode` is treated as browser — the old in-editor markdown snapshot is gone.)
 * KUSA_PORT / COPILOT_MONITOR_PORT, KUSA_DIR / COPILOT_MONITOR_DIR as for serve.mjs / hook.mjs.
 *
 * Always exits 0 and prints `{}`: the hook must never block the agent.
 */

import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, utimesSync } from 'node:fs';
import { request } from 'node:http';
import { platform, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { defaultMonitorDir } from '#features/monitor/lib.mjs';
import { dashboardHtmlPath } from '#shared/lib/pkg.mjs';

const log = (message) => process.stderr.write(`kusa: ${message}\n`);

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 1_000_000) break;
  }
  return text;
}

function which(name) {
  try {
    const out = execFileSync(platform() === 'win32' ? 'where' : 'which', [name], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
    const first = out.toString('utf8').split(/\r?\n/).find((line) => line.trim());
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

/** True when serve.mjs answers on the console port. */
function serverUp(port) {
  return new Promise((done) => {
    const req = request({ host: '127.0.0.1', port, path: '/dashboard.html', method: 'HEAD', timeout: 500 }, (res) => {
      res.resume();
      done(res.statusCode === 200);
    });
    req.on('error', () => done(false));
    req.on('timeout', () => { req.destroy(); done(false); });
    req.end();
  });
}

function isWsl() {
  return platform() === 'linux' && (Boolean(process.env.WSL_DISTRO_NAME) || existsSync('/proc/sys/fs/binfmt_misc/WSLInterop'));
}

/** Launch the default browser for a URL, detached. Returns true when a launcher was found. */
function openInBrowser(url) {
  let argv;
  const os = platform();
  if (os === 'darwin') argv = ['open', url];
  else if (os === 'win32') argv = ['cmd', '/c', 'start', '', url];
  else if (isWsl()) argv = which('wslview') ? ['wslview', url] : ['cmd.exe', '/c', 'start', '', url.replace(/&/g, '^&')];
  else if (which('xdg-open')) argv = ['xdg-open', url];
  else return false;
  try {
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' });
    child.on('error', (error) => log(`browser launch failed: ${error.message}`));
    child.unref();
    return true;
  } catch (error) {
    log(`browser launch failed: ${error.message}`);
    return false;
  }
}

async function main() {
  let mode = (process.env.KUSA_OPEN || process.env.COPILOT_MONITOR_OPEN || 'none').trim().toLowerCase();
  // Legacy in-editor markdown preview; treat as browser when explicitly requested.
  if (mode === 'vscode') mode = 'browser';
  if (mode !== 'browser') return;

  let event = {};
  try {
    const text = await readStdin();
    if (text.trim()) event = JSON.parse(text);
  } catch { /* payload is optional here */ }
  if (!event || typeof event !== 'object') event = {};

  // Once per agent session, not once per prompt.
  const sessionId = String(event.conversation_id || event.sessionId || event.session_id || 'default');
  const key = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  const marker = join(tmpdir(), `kusa-${key}.opened`);
  if (existsSync(marker)) return;

  const roots = Array.isArray(event.workspace_roots) ? event.workspace_roots : [];
  const root = resolve(event.cwd || roots[0] || process.cwd());
  const dataDir = (() => {
    const dir = defaultMonitorDir(root);
    return isAbsolute(dir) ? dir : join(root, dir);
  })();
  const port = Number(process.env.KUSA_PORT || process.env.COPILOT_MONITOR_PORT) || 1424;

  const html = join(dataDir, 'dashboard.html');
  const url = await serverUp(port)
    ? `http://127.0.0.1:${port}/dashboard.html`
    : pathToFileURL(existsSync(html) ? html : dashboardHtmlPath).href;
  const opened = openInBrowser(url);

  if (opened) {
    try {
      closeSync(openSync(marker, 'a', 0o600));
      const now = new Date();
      utimesSync(marker, now, now);
    } catch (error) {
      log(`cannot write marker: ${error.message}`);
    }
  }
}

main().catch((error) => {
  log(error?.stack || String(error));
}).finally(() => {
  process.stdout.write('{}\n');
  process.exit(0);
});
