#!/usr/bin/env node
/**
 * Open the Agentic Development Console once per session. Pure Node, no dependencies.
 *
 * Runs from sessionStart hooks of any wired harness (e.g. Copilot
 * `.github/hooks/copilot-runtime-monitor.json`, Cursor `.cursor/hooks.json`).
 * Reads the hook payload on stdin only to learn the session id and cwd;
 * nothing from it is stored.
 *
 * Targets, in order:
 *   vscode   Markdown preview tab of `.kusa/dashboard.md` in the current
 *            editor window (`code`/`cursor --reuse-window`; `.vscode/settings.json` maps
 *            the file to the preview editor). Editors have no HTML preview their CLI can
 *            drive, so this is the only in-editor option.
 *   browser  The live console: http://127.0.0.1:1424/dashboard.html when `serve.mjs`
 *            is up, otherwise the file copy in `.kusa/` (polling needs the server).
 *
 * KUSA_OPEN / COPILOT_MONITOR_OPEN = vscode (default) | browser | none
 * KUSA_PORT / COPILOT_MONITOR_PORT, KUSA_DIR / COPILOT_MONITOR_DIR as for serve.mjs / hook.mjs.
 *
 * Always exits 0 and prints `{}`: the hook must never block the agent.
 */

import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir, platform, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { defaultMonitorDir } from './lib.mjs';

const moduleDir = fileURLToPath(new URL('.', import.meta.url));
const PLACEHOLDER = '# Kusă Console\n\nWaiting for the first hook event. This preview refreshes when the console rewrites the file.\n';

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

/** Editor CLI able to open a file in the connected window, or null. */
function findEditorCli() {
  // Prefer the CLI that matches the host harness so the tab lands in the right window.
  const names = process.argv.includes('--cursor') ? ['cursor', 'code', 'code-insiders'] : ['code', 'code-insiders', 'cursor'];
  for (const name of names) {
    const found = which(name);
    if (found) return found;
  }
  // Remote (WSL / SSH / container): the server ships a CLI that talks to the connected
  // window through VSCODE_IPC_HOOK_CLI.
  if (process.env.VSCODE_IPC_HOOK_CLI) {
    const candidates = [];
    for (const server of ['.cursor-server', '.vscode-server', '.vscode-server-insiders']) {
      const bin = join(homedir(), server, 'bin');
      if (!existsSync(bin)) continue;
      for (const hash of readdirSync(bin)) {
        const cli = join(bin, hash, 'bin', 'remote-cli', 'code');
        if (existsSync(cli)) candidates.push(cli);
      }
    }
    candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (candidates.length) return candidates[0];
  }
  return null;
}

/** Wait briefly for the console to create the file; create a placeholder otherwise. */
async function ensureMarkdown(path, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  if (existsSync(path)) return true;
  try {
    mkdirSync(resolve(path, '..'), { recursive: true });
    // 'wx' = O_EXCL so a concurrent monitor write is never clobbered.
    writeFileSync(path, PLACEHOLDER, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') log(`cannot create ${path}: ${error.message}`);
  }
  return existsSync(path);
}

function openInEditor(markdown) {
  const cli = findEditorCli();
  if (!cli) return false;
  try {
    execFileSync(cli, ['--reuse-window', markdown], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 4000 });
    return true;
  } catch (error) {
    const detail = error.stderr ? error.stderr.toString('utf8').trim() : error.message;
    log(`editor CLI failed: ${detail}`);
    return false;
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
  const mode = (process.env.KUSA_OPEN || process.env.COPILOT_MONITOR_OPEN || 'vscode').trim().toLowerCase();
  if (mode === 'none') return;

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
  const markdown = join(dataDir, 'dashboard.md');
  const port = Number(process.env.KUSA_PORT || process.env.COPILOT_MONITOR_PORT) || 1424;

  let opened = false;
  if (mode === 'vscode' && await ensureMarkdown(markdown, 1500)) opened = openInEditor(markdown);

  if (!opened) {
    const html = join(dataDir, 'dashboard.html');
    const url = await serverUp(port)
      ? `http://127.0.0.1:${port}/dashboard.html`
      : pathToFileURL(existsSync(html) ? html : join(moduleDir, 'dashboard.html')).href;
    opened = openInBrowser(url);
  }

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

main()
  .catch((error) => log(`error: ${error.message}`))
  .finally(() => {
    process.stdout.write('{}\n');
    process.exit(0);
  });
