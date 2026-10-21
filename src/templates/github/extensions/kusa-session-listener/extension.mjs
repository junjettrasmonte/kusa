/**
 * Agentic Development Console — Copilot CLI session listener extension.
 *
 * Discovered by Copilot CLI under .github/extensions/<name>/extension.mjs.
 * Calls the official joinSession() API so this process attaches to the
 * same foreground CLI session (SESSION_ID injected by the CLI). It does
 * not create a new agent session and registers no tools.
 *
 * Install via: npm install --global kusa && kusa init
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

function resolveKusaRoot() {
  try {
    // A global package is outside Node's normal module lookup paths.
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const globalRoot = execFileSync(npm, ['root', '--global'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const packageRoot = join(globalRoot, 'kusa');
    if (existsSync(join(packageRoot, 'package.json'))) return packageRoot;
  } catch { /* fall through to local/file installs */ }

  return dirname(require.resolve('kusa/package.json'));
}

const pkgRoot = resolveKusaRoot();
const listenerUrl = pathToFileURL(join(pkgRoot, 'src/sdk-listener.mjs')).href;
const libUrl = pathToFileURL(join(pkgRoot, 'src/lib.mjs')).href;

async function main() {
  const { SessionListener } = await import(listenerUrl);
  const { defaultMonitorDir, defaultWorkspaceRoot, loadMonitorSettings } = await import(libUrl);

  const workspace = defaultWorkspaceRoot();
  const dir = defaultMonitorDir(workspace);
  const settings = loadMonitorSettings(dir);
  const listener = new SessionListener({
    dir,
    target: 'copilot-cli',
    sessionId: process.env.SESSION_ID || null,
    settings,
  });

  if (!settings.sdkListenerEnabled) {
    listener.markUnavailable('disabled', 'SDK listener disabled in .kusa/settings.json');
    return;
  }

  if (!process.env.SESSION_ID) {
    listener.markUnavailable(
      'no-session-id',
      'joinSession() requires SESSION_ID from the Copilot CLI parent process. This file is only live when Copilot CLI loads .github/extensions/kusa-session-listener/.',
    );
    return;
  }

  let joinSession;
  try {
    ({ joinSession } = await import('@github/copilot-sdk/extension'));
  } catch (err) {
    listener.markUnavailable(
      'sdk-missing',
      `Could not import @github/copilot-sdk/extension (${err?.message || err}). Copilot CLI normally resolves this module for extensions.`,
    );
    return;
  }

  let session;
  try {
    session = await joinSession({ tools: [] });
  } catch (err) {
    listener.markUnavailable('join-failed', err?.message || String(err));
    return;
  }

  listener.start(session, { sessionId: process.env.SESSION_ID, settings });

  const shutdown = () => {
    try { listener.stop({ reason: 'shutdown' }); } catch { /* ignore */ }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  try {
    process.stderr.write(`kusa-session-listener: ${err?.stack || err}\n`);
  } catch { /* ignore */ }
});
