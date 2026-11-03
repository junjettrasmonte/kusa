/**
 * Agentic Development Console — Copilot CLI session listener extension (retired).
 *
 * Copilot CLI / Cursor hooks replace the SDK joinSession() path. This file stays
 * under .github/extensions/ so older installs do not break discovery; it only
 * records that the listener is unavailable and exits.
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
const listenerUrl = pathToFileURL(join(pkgRoot, 'src/features/monitor/sdk-listener.mjs')).href;
const libUrl = pathToFileURL(join(pkgRoot, 'src/features/monitor/lib.mjs')).href;

async function main() {
  const { SessionListener } = await import(listenerUrl);
  const { defaultMonitorDir, defaultWorkspaceRoot } = await import(libUrl);

  const workspace = defaultWorkspaceRoot();
  const dir = defaultMonitorDir(workspace);
  const listener = new SessionListener({
    dir,
    target: 'copilot-cli',
    sessionId: process.env.SESSION_ID || null,
  });

  listener.markUnavailable(
    'disabled',
    'SDK session listener retired; use CLI/hooks monitoring instead.',
  );
}

main().catch((err) => {
  try {
    process.stderr.write(`kusa-session-listener: ${err?.stack || err}\n`);
  } catch { /* ignore */ }
});
