#!/usr/bin/env node
/**
 * kusa serve --live — Vite Fast Refresh for the console, on the same localhost port.
 *
 *   kusa serve --live    -> http://127.0.0.1:1424/  (Vite + React Fast Refresh)
 *   kusa serve --hmr       alias
 *
 * Two processes, one supervisor:
 *   UI      `vite` (dev server) on the public port. React Fast Refresh updates
 *           modules in place — no full tab reload on JSX/CSS saves. API calls
 *           and WebSockets proxy to the Node child (see vite.config.mjs).
 *   Server  Node has no module reload, so a change to serve.mjs' own import
 *           graph restarts the API child on publicPort+1. In-flight turns,
 *           pending approvals and open SSE streams are lost; everything
 *           persisted under .kusa/ is re-read by the next child. The Vite
 *           process stays up across API restarts, so React state survives.
 *
 * Binds 127.0.0.1 only, exactly like plain `kusa serve`.
 */
import { spawn } from 'node:child_process';
import { watch as fsWatch } from 'node:fs';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServeOptions } from './serve.mjs';
import { pkgRoot, srcDir, resolveImportSpecifier } from '#shared/lib/pkg.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serveEntry = join(here, 'serve.mjs');
const viteConfig = join(here, 'vite.config.mjs');
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// A burst of saves (an editor writing several files) must cost one restart, not
// one per event.
const RESTART_DEBOUNCE_MS = 300;

/**
 * Relative and `#`-aliased `.mjs` imports in one file. A regex over a bounded
 * set of files, not a parser: the closure only has to be wide enough that a
 * change in it restarts the server, and a missed edge is a restart we would
 * have wanted anyway. Aliased specifiers are resolved through the map in
 * package.json (`importAliases`) so this stays the same graph Node walks.
 */
function importTargets(text) {
  const targets = new Set();
  const patterns = [
    /from\s+['"](\.[^'"]+\.mjs)['"]/g,
    /from\s+['"](#[^'"]+\.mjs)['"]/g,
    /import\s+['"](\.[^'"]+\.mjs|#[^'"]+\.mjs)['"]/g,
    /import\s*\(\s*['"](\.[^'"]+\.mjs|#[^'"]+\.mjs)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) targets.add(match[1]);
  }
  return [...targets];
}

/**
 * Files the running server depends on, transitively from serve.mjs. This is the
 * watch set: the UI graph (src/app/console/ui/**) is deliberately absent — Vite
 * owns Fast Refresh for those files, and a restart here must never loop on a
 * UI save.
 */
export function serverSourceClosure(entry = serveEntry) {
  const found = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (found.has(file)) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    found.add(file);
    for (const spec of importTargets(text)) {
      const abs = resolveImportSpecifier(spec, dirname(file));
      if (abs && abs.startsWith(srcDir + '/') && abs.endsWith('.mjs')) queue.push(abs);
    }
  }
  found.add(entry);
  return [...found].sort();
}

/** Where vite lives once the package is installed (devDependency, no download). */
function viteInvocation() {
  const shim = join(pkgRoot, 'node_modules', '.bin', 'vite');
  try {
    readdirSync(join(pkgRoot, 'node_modules', '.bin'));
    return { command: shim, args: [] };
  } catch { /* not installed via npm — fall back to the module entry */ }
  const entry = join(pkgRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  try {
    readFileSync(entry, 'utf8');
    return { command: process.execPath, args: [entry] };
  } catch {
    return null;
  }
}

/** API listens on publicPort+1 so Vite can own the bookmarked console URL. */
function apiPortFor(uiPort) {
  const next = uiPort + 1;
  if (next > 65535) return uiPort - 1;
  return next;
}

export function runLiveServe(argv = process.argv.slice(2)) {
  const { port: uiPort } = resolveServeOptions(argv);
  const apiPort = apiPortFor(uiPort);
  // Set before any signal is forwarded: it is what tells a planned teardown
  // (Ctrl-C, kill) apart from a watcher that died and must be brought back.
  let shuttingDown = false;
  const ui = viteInvocation();
  if (!ui) {
    // The server half still works; say so instead of silently serving a stale UI.
    process.stderr.write('kusa: --live needs vite (npm install vite) — falling back to API only\n');
  }

  /** Vite dev server: Fast Refresh on the public port. */
  let uiChild = null;
  let uiRestartPending = false;
  const startUi = () => {
    const inv = ui || viteInvocation();
    if (!inv) return;
    uiRestartPending = false;
    uiChild = spawn(
      inv.command,
      [
        ...inv.args,
        '--config', viteConfig,
        '--host', '127.0.0.1',
        '--port', String(uiPort),
        '--strictPort',
      ],
      {
        cwd: pkgRoot,
        stdio: 'inherit',
        env: {
          ...process.env,
          KUSA_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
        },
      },
    );
    uiChild.on('error', (err) => {
      process.stderr.write(`kusa: --live could not start vite (${err?.code || err}): UI HMR unavailable\n`);
    });
    uiChild.on('exit', (code, signal) => {
      if (shuttingDown) return;
      if (uiRestartPending) {
        startUi();
        return;
      }
      if (code !== 0) process.stderr.write(`kusa: vite exited ${code} — UI HMR stopped\n`);
    });
  };

  /** Server child: restarted, never patched. Listens on apiPort only. */
  let serverChild = null;
  let restartPending = false;
  const startServer = () => {
    restartPending = false;
    serverChild = spawn(process.execPath, [serveEntry, '--port', String(apiPort), '--no-live'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        KUSA_LIVE: '1',
        KUSA_SUPERVISED: '1',
        // MCP / SSO redirect URLs should advertise the public Vite port.
        KUSA_PUBLIC_PORT: String(uiPort),
      },
    });
    serverChild.on('error', (err) => {
      process.stderr.write(`kusa: serve child failed to start (${err?.code || err})\n`);
    });
    serverChild.on('exit', (code, signal) => {
      if (shuttingDown) return;
      // serve.mjs catches SIGTERM and closes with code 0, so the exit status
      // cannot tell a planned swap from a clean stop — the intent flag can.
      if (restartPending) {
        startServer();
        return;
      }
      if (code !== 0) process.stderr.write(`kusa: serve exited ${code}\n`);
    });
  };

  // API first so the first Vite proxy hits do not 502 the splash.
  startServer();
  if (ui) startUi();

  let pendingRestart;
  const restartServer = () => {
    if (shuttingDown || !serverChild) return;
    process.stdout.write(`kusa: server sources changed — restarting API on :${apiPort} (in-flight turns are lost)\n`);
    restartPending = true;
    serverChild.kill('SIGTERM');
  };
  const scheduleRestart = () => {
    if (shuttingDown || pendingRestart) return;
    pendingRestart = setTimeout(() => {
      pendingRestart = null;
      restartServer();
    }, RESTART_DEBOUNCE_MS);
  };

  const watchedFiles = new Set();
  const watchers = [];
  const armFileWatchers = (files, onChange) => {
    for (const file of files) {
      if (watchedFiles.has(file)) continue;
      watchedFiles.add(file);
      try {
        const watcher = fsWatch(file, { recursive: false });
        watchers.push(watcher);
        watcher.on('change', onChange);
      } catch {
        // Deleted or missing: the directory watcher re-arms it when it returns.
      }
    }
  };

  const arm = () => armFileWatchers(serverSourceClosure(), scheduleRestart);
  arm();
  // New modules are not in the closure yet, so watch the folders that hold it.
  const dirs = new Set([...watchedFiles].map((file) => dirname(file)));
  for (const dir of dirs) {
    try {
      const watcher = fsWatch(dir, { recursive: false });
      watchers.push(watcher);
      watcher.on('change', (event) => {
        if (event?.event === 'change' || event?.event === 'rename') arm();
      });
    } catch { /* keep the file watchers we already have */ }
  }
  // vite.config.mjs is not part of the server graph, but editing it must not
  // leave the UI watcher running the old one.
  try {
    const configWatcher = fsWatch(viteConfig, { recursive: false });
    watchers.push(configWatcher);
    configWatcher.on('change', () => {
      if (!uiChild || shuttingDown) return;
      process.stdout.write('kusa: vite.config.mjs changed — restarting Vite\n');
      uiRestartPending = true;
      uiChild.kill('SIGTERM');
    });
  } catch { /* no config to watch */ }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      shuttingDown = true;
      if (pendingRestart) clearTimeout(pendingRestart);
      serverChild?.kill('SIGTERM');
      uiChild?.kill('SIGTERM');
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch { /* already closed */ }
      }
      process.exit(0);
    });
  }

  process.stdout.write(
    `kusa: --live Fast Refresh on :${uiPort} (API :${apiPort}); watching ${watchedFiles.size} server files\n`,
  );
}

if (isMain) {
  try {
    runLiveServe();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
