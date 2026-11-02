/**
 * The one place that knows where this package's own files live.
 *
 * Before the feature-first move, entry points derived paths from their own
 * `import.meta.url` — "the built dashboard.* assets sit next to me". That held
 * only because every entry point happened to sit in `src/` beside them. In this
 * layout features live under `src/features/<feature>/` and the console shell
 * (plus its committed build output) lives under `src/app/console/`, so that
 * assumption is gone: anything needing a path inside *this package* imports it
 * from here instead of guessing from its own directory.
 *
 * Paths to files inside the *consumer* project (`.kusa/`, workspaces) do not
 * belong here — those are resolved by `src/features/monitor/lib.mjs`.
 */
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

/** src/shared/lib — this file's own folder. */
const moduleDir = dirname(fileURLToPath(import.meta.url));

/** The installed package root (where `package.json` lives). */
export const pkgRoot = pathResolve(moduleDir, '..', '..', '..');
export const packageJsonPath = join(pkgRoot, 'package.json');

/** This package's source and test trees. */
export const srcDir = join(pkgRoot, 'src');
export const testDir = join(pkgRoot, 'test');

/**
 * The console app shell — infrastructure, not a feature. It owns the Vite entry,
 * the localhost server, and the committed build output below.
 */
export const consoleDir = join(srcDir, 'app', 'console');
export const consoleUiDir = join(consoleDir, 'ui');
export const viteConfigPath = join(consoleDir, 'vite.config.mjs');

/** Hook/config templates installed into a consumer project (the `setup` feature). */
export const templatesDir = join(srcDir, 'features', 'setup', 'templates');

/** Built console assets: committed output of `npm run build`, read by serve + hooks. */
export const dashboardHtmlPath = join(consoleDir, 'dashboard.html');
export const dashboardJsPath = join(consoleDir, 'dashboard.js');
export const dashboardCssPath = join(consoleDir, 'dashboard.css');
export const faviconSvgPath = join(consoleDir, 'favicon.svg');

/** Any other asset published beside the console shell (stable filename). */
export function consoleAsset(name) {
  return join(consoleDir, name);
}

/**
 * The `#`-prefixed specifiers declared in package.json (`imports`), as
 * `{ alias: '#features/', dir: '<installed pkg>/src/features' }` longest-alias-
 * first. Node resolves those specifiers itself; anything that walks the import
 * graph by hand (the `--live` restart watcher) asks this instead of
 * re-declaring the map, so the two can never disagree about what an edge is.
 */
function packageImportAliases() {
  let map;
  try {
    map = JSON.parse(readFileSync(packageJsonPath, 'utf8')).imports;
  } catch {
    return [];
  }
  if (!map) return [];
  return Object.entries(map)
    .map(([key, value]) => {
      const keyAt = key.indexOf('*');
      const valAt = typeof value === 'string' ? value.indexOf('*') : -1;
      if (!key.startsWith('#') || keyAt !== key.length - 1 || valAt !== value.length - 1) return null;
      const dir = value.startsWith('/') ? value.slice(0, valAt) : join(pkgRoot, value.slice(0, valAt));
      return { alias: key.slice(0, keyAt), dir: pathResolve(dir) };
    })
    .filter(Boolean)
    .sort((a, b) => b.alias.length - a.alias.length);
}
export const importAliases = packageImportAliases();

/** Absolute path a `#alias/…` specifier resolves to, or null if unmapped. */
export function resolveImportSpecifier(spec, fromDir = '') {
  for (const { alias, dir } of importAliases) {
    if (spec.startsWith(alias)) return join(dir, spec.slice(alias.length));
  }
  return fromDir ? pathResolve(fromDir, spec) : null;
}

/**
 * Runnable entry points, keyed by what the user asks for rather than by path.
 * `kusa <command>` and the hook templates look a name up here instead of
 * guessing which feature folder an entry point lives in.
 */
export const entryPoints = {
  cli: join(srcDir, 'shared', 'cli', 'kusa.mjs'),
  serve: join(consoleDir, 'serve.mjs'),
  'serve-live': join(consoleDir, 'serve-live.mjs'),
  open: join(consoleDir, 'open.mjs'),
  build: join(consoleDir, 'build-css.mjs'),
  hook: join(srcDir, 'features', 'monitor', 'hook.mjs'),
  demo: join(srcDir, 'features', 'monitor', 'demo.mjs'),
  mcp: join(srcDir, 'features', 'mcp', 'server.mjs'),
  agent: join(srcDir, 'features', 'kusa-cli', 'agent-repl.mjs'),
  'sdk-listener': join(srcDir, 'features', 'monitor', 'sdk-listener.mjs'),
};
export const entryPoint = (name) => {
  const at = entryPoints[name];
  if (!at) throw new Error(`unknown kusa entry point: ${name}`);
  return at;
};
