#!/usr/bin/env node
/**
 * Discover extension package.json workspaces (Compose include / merge style).
 *
 * Root declares `"workspaces": ["extensions/*"]`. Each extension that needs
 * npm deps owns them only in `extensions/<name>/package.json` — they are not
 * mirrored into the root manifest. `npm install` at the repo root installs
 * them via workspaces.
 *
 *   node scripts/merge-extension-deps.mjs          # list discovered packages
 *   node scripts/merge-extension-deps.mjs --check  # fail if workspaces missing
 *                                                  # or root still lists an
 *                                                  # extension-owned dep
 *   node scripts/merge-extension-deps.mjs --json
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionsDir = join(root, 'extensions');
const rootPkgPath = join(root, 'package.json');
const checkOnly = process.argv.includes('--check');
const asJson = process.argv.includes('--json');

function discoverExtensionPackages() {
  if (!existsSync(extensionsDir)) return [];
  const out = [];
  for (const name of readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const pkgPath = join(extensionsDir, name.name, 'package.json');
    if (!existsSync(pkgPath)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch (err) {
      throw new Error(`Invalid JSON: ${pkgPath}: ${err.message}`);
    }
    out.push({
      dir: name.name,
      name: pkg.name || name.name,
      path: `extensions/${name.name}/package.json`,
      dependencies: pkg.dependencies || {},
      optionalDependencies: pkg.optionalDependencies || {},
      devDependencies: pkg.devDependencies || {},
    });
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

function main() {
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
  const workspaces = rootPkg.workspaces;
  const globOk = Array.isArray(workspaces) && workspaces.includes('extensions/*');
  const extensions = discoverExtensionPackages();

  const extensionDepNames = new Set();
  for (const ext of extensions) {
    for (const name of Object.keys(ext.dependencies)) extensionDepNames.add(name);
    for (const name of Object.keys(ext.optionalDependencies)) extensionDepNames.add(name);
  }

  const rootDeps = {
    ...(rootPkg.dependencies || {}),
    ...(rootPkg.optionalDependencies || {}),
  };
  const leaked = [...extensionDepNames].filter((name) => rootDeps[name] != null).sort();

  if (asJson) {
    process.stdout.write(`${JSON.stringify({
      workspaces,
      extensions: extensions.map((ext) => ({
        dir: ext.dir,
        name: ext.name,
        path: ext.path,
        dependencies: ext.dependencies,
      })),
      leakedInRoot: leaked,
    }, null, 2)}\n`);
    return;
  }

  let failed = false;
  if (!globOk) {
    process.stderr.write(
      'merge-extension-deps: root package.json must declare "workspaces": ["extensions/*"]\n',
    );
    failed = true;
  }
  if (rootPkg['x-kusa-extension-deps'] != null) {
    process.stderr.write(
      'merge-extension-deps: remove obsolete x-kusa-extension-deps from root package.json '
      + '(extension deps stay only in extensions/*/package.json)\n',
    );
    failed = true;
  }
  if (leaked.length) {
    process.stderr.write(
      'merge-extension-deps: root package.json must not list extension-owned deps; '
      + `move/remove: ${leaked.join(', ')}\n`,
    );
    failed = true;
  }

  process.stderr.write(
    `merge-extension-deps: workspaces ${JSON.stringify(workspaces)} → `
    + `${extensions.length} extension package(s)\n`,
  );
  for (const ext of extensions) {
    const deps = Object.keys(ext.dependencies);
    process.stderr.write(
      `  - ${ext.path} (${ext.name}): ${deps.length ? deps.join(', ') : '(no dependencies)'}\n`,
    );
  }

  if (failed || (checkOnly && failed)) {
    process.exit(1);
  }
  if (checkOnly && !failed) {
    process.stderr.write('merge-extension-deps: ok\n');
  }
}

main();
