#!/usr/bin/env node
/**
 * Optional CAO integration for the standalone Kusă CLI (`kusa agent`).
 * Patches the uv-installed CAO package so provider type `kusa_cli` is registered.
 *
 * Usage:
 *   node src/features/kusa-cli/cao-provider/install.mjs
 *   node src/features/kusa-cli/cao-provider/install.mjs --uninstall
 *
 * Restart cao-server after install/uninstall.
 */
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const PROVIDER_SRC = join(here, 'provider.py');
const BAK_SUFFIX = '.kusa-bak';

function die(msg) {
  process.stderr.write(`kusa cao: ${msg}\n`);
  process.exit(1);
}

function pkgFromLibRoot(toolRoot) {
  const lib = join(toolRoot, 'lib');
  if (!existsSync(lib)) return null;
  for (const name of readdirSync(lib)) {
    if (!name.startsWith('python')) continue;
    const pkg = join(lib, name, 'site-packages', 'cli_agent_orchestrator');
    if (existsSync(join(pkg, 'providers', 'manager.py'))) return pkg;
  }
  return null;
}

function pkgFromPython(bin) {
  const res = spawnSync(
    bin,
    ['-c', 'import cli_agent_orchestrator, os; print(os.path.dirname(cli_agent_orchestrator.__file__))'],
    { encoding: 'utf8' },
  );
  const path = (res.stdout || '').trim();
  if (res.status === 0 && path && existsSync(join(path, 'providers', 'manager.py'))) {
    return path;
  }
  return null;
}

function findCaoPackageRoot() {
  // uv tool installs symlink ~/.local/bin/cao-server → <tool>/bin/cao-server.
  // Resolve the real path so we land in the tool env, not ~/.local.
  const which = spawnSync('bash', ['-lc', 'command -v cao-server || command -v cao'], {
    encoding: 'utf8',
  });
  const caoBin = (which.stdout || '').trim();
  if (caoBin) {
    let realBin = caoBin;
    try {
      realBin = realpathSync(caoBin);
    } catch {
      /* keep caoBin */
    }
    const fromReal = pkgFromLibRoot(dirname(dirname(realBin)));
    if (fromReal) return fromReal;

    // Shebang: #!/…/cli-agent-orchestrator/bin/python
    try {
      const first = readFileSync(realBin, 'utf8').split('\n')[0] || '';
      const m = first.match(/^#!\s*(.+)\s*$/);
      if (m) {
        const fromPy = pkgFromPython(m[1].trim());
        if (fromPy) return fromPy;
      }
    } catch {
      /* ignore */
    }
  }

  const uvCandidates = [
    join(homedir(), '.local', 'share', 'uv', 'tools', 'cli-agent-orchestrator'),
    join(homedir(), '.uv', 'tools', 'cli-agent-orchestrator'),
  ];
  for (const root of uvCandidates) {
    const found = pkgFromLibRoot(root);
    if (found) return found;
  }

  for (const bin of [
    join(homedir(), '.local', 'share', 'uv', 'tools', 'cli-agent-orchestrator', 'bin', 'python'),
    'python3',
    'python',
  ]) {
    if (bin !== 'python3' && bin !== 'python' && !existsSync(bin)) continue;
    const found = pkgFromPython(bin);
    if (found) return found;
  }
  return null;
}

function backupOnce(path) {
  const bak = `${path}${BAK_SUFFIX}`;
  if (!existsSync(bak)) copyFileSync(path, bak);
  return bak;
}

function restoreBak(path) {
  const bak = `${path}${BAK_SUFFIX}`;
  if (!existsSync(bak)) return false;
  copyFileSync(bak, path);
  return true;
}

function patchProviderEnum(text) {
  if (text.includes('KUSA_CLI') || text.includes('"kusa_cli"')) {
    return { text, changed: false };
  }
  if (text.includes('MOCK_CLI')) {
    const next = text.replace(
      /(\s+)((?:# Credentials-free mock provider[^\n]*\n\s+)?)MOCK_CLI = "mock_cli"/,
      '$1KUSA_CLI = "kusa_cli"\n$1$2MOCK_CLI = "mock_cli"',
    );
    if (next !== text) return { text: next, changed: true };
  }
  const lines = text.split('\n');
  let lastMember = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s+[A-Z0-9_]+ = "/.test(lines[i])) lastMember = i;
  }
  if (lastMember < 0) die('could not find ProviderType members to patch');
  lines.splice(lastMember + 1, 0, '    KUSA_CLI = "kusa_cli"');
  return { text: `${lines.join('\n')}`, changed: true };
}

function patchManager(text) {
  let changed = false;
  let next = text;
  if (!next.includes('KusaCliProvider')) {
    next = next.replace(
      /(from cli_agent_orchestrator\.providers\.mock_cli import MockCliProvider\n)/,
      '$1from cli_agent_orchestrator.providers.kusa_cli import KusaCliProvider\n',
    );
    if (!next.includes('KusaCliProvider')) {
      next = next.replace(
        /(from cli_agent_orchestrator\.providers\.cursor_cli import CursorCliProvider\n)/,
        '$1from cli_agent_orchestrator.providers.kusa_cli import KusaCliProvider\n',
      );
    }
    if (!next.includes('KusaCliProvider')) die('could not insert KusaCliProvider import');
    changed = true;
  }
  if (!next.includes('ProviderType.KUSA_CLI')) {
    next = next.replace(
      /(ProviderType\.MOCK_CLI\.value: MockCliProvider,)/,
      'ProviderType.KUSA_CLI.value: KusaCliProvider,\n            $1',
    );
    if (!next.includes('ProviderType.KUSA_CLI')) {
      next = next.replace(
        /(ProviderType\.CURSOR_CLI\.value: CursorCliProvider,)/,
        '$1\n            ProviderType.KUSA_CLI.value: KusaCliProvider,',
      );
    }
    if (!next.includes('ProviderType.KUSA_CLI')) die('could not register provider_class map');
    changed = true;
  }
  if (!next.includes('provider_type == ProviderType.KUSA_CLI.value')) {
    const block = `
            elif provider_type == ProviderType.KUSA_CLI.value:
                provider = KusaCliProvider(
                    terminal_id,
                    tmux_session,
                    tmux_window,
                    agent_profile,
                    allowed_tools,
                    model=model,
                    skill_prompt=skill_prompt,
                )`;
    next = next.replace(
      /(\s+)((?:# --- Credentials-free mock provider[^\n]*\n\s+)?)elif provider_type == ProviderType\.MOCK_CLI\.value:/,
      `${block}\n$1$2elif provider_type == ProviderType.MOCK_CLI.value:`,
    );
    if (!next.includes('provider_type == ProviderType.KUSA_CLI.value')) {
      next = next.replace(
        /(\s+)(else:\n\s+raise ValueError\(f"Unknown provider type)/,
        `${block}\n$1$2`,
      );
    }
    if (!next.includes('provider_type == ProviderType.KUSA_CLI.value')) {
      die('could not insert create_provider branch');
    }
    changed = true;
  }
  return { text: next, changed };
}

function patchApiProviders(text) {
  if (text.includes('"kusa_cli"')) return { text, changed: false };
  if (!text.includes('provider_binaries')) die('provider_binaries dict not found in api/main.py');
  const next = text.replace(
    /(provider_binaries\s*=\s*\{)/,
    '$1\n        "kusa_cli": "kusa",',
  );
  if (next === text) die('could not patch provider_binaries');
  return { text: next, changed: true };
}

function patchLaunch(text) {
  if (text.includes('"kusa_cli"')) return { text, changed: false };
  if (!text.includes('PROVIDERS_REQUIRING_WORKSPACE_ACCESS')) {
    return { text, changed: false };
  }
  const next = text.replace(
    /(PROVIDERS_REQUIRING_WORKSPACE_ACCESS\s*=\s*\{)/,
    '$1\n    "kusa_cli",',
  );
  if (next === text) die('could not patch PROVIDERS_REQUIRING_WORKSPACE_ACCESS');
  return { text: next, changed: true };
}

function patchToolMapping(text) {
  if (text.includes('"kusa_cli"')) return { text, changed: false };
  const insert = `
    "kusa_cli": {
        "execute_bash": ["kusa_terminal"],
        "fs_read": ["kusa_read"],
        "fs_write": ["kusa_write"],
        "fs_list": ["kusa_list", "kusa_grep"],
        "fs_*": ["kusa_read", "kusa_write", "kusa_list", "kusa_grep"],
    },`;
  // Nested Dict[...] annotations break a naive [^\]]+ match — anchor on the name.
  const next = text.replace(
    /(TOOL_MAPPING\s*:\s*[^=\n]+=\s*\{)/,
    `$1${insert}`,
  );
  if (next === text) {
    process.stderr.write('kusa cao: warning: could not patch TOOL_MAPPING (skipped)\n');
    return { text, changed: false };
  }
  return { text: next, changed: true };
}

function patchAgentProfiles(text) {
  if (text.includes('"kusa_cli"')) return { text, changed: false };
  const next = text.replace(
    /(provider_source_labels\s*=\s*\{)/,
    '$1\n        "kusa_cli": "kusa",',
  );
  if (next === text) return { text, changed: false };
  return { text: next, changed: true };
}

function install(pkgRoot) {
  const destProvider = join(pkgRoot, 'providers', 'kusa_cli.py');
  copyFileSync(PROVIDER_SRC, destProvider);
  process.stdout.write(`kusa cao: wrote ${destProvider}\n`);

  const patches = [
    [join(pkgRoot, 'models', 'provider.py'), patchProviderEnum],
    [join(pkgRoot, 'providers', 'manager.py'), patchManager],
    [join(pkgRoot, 'api', 'main.py'), patchApiProviders],
    [join(pkgRoot, 'cli', 'commands', 'launch.py'), patchLaunch],
    [join(pkgRoot, 'utils', 'tool_mapping.py'), patchToolMapping],
    [join(pkgRoot, 'utils', 'agent_profiles.py'), patchAgentProfiles],
  ];

  for (const [path, fn] of patches) {
    if (!existsSync(path)) {
      process.stderr.write(`kusa cao: skip missing ${path}\n`);
      continue;
    }
    const before = readFileSync(path, 'utf8');
    const { text, changed } = fn(before);
    if (!changed) {
      process.stdout.write(`kusa cao: already patched ${path}\n`);
      continue;
    }
    backupOnce(path);
    writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`);
    process.stdout.write(`kusa cao: patched ${path}\n`);
  }

  process.stdout.write(`
kusa cao: install complete.
Restart cao-server, then:
  curl http://127.0.0.1:9889/agents/providers
  cao launch --agents developer --provider kusa_cli
`);
}

function uninstall(pkgRoot) {
  const destProvider = join(pkgRoot, 'providers', 'kusa_cli.py');
  const paths = [
    join(pkgRoot, 'models', 'provider.py'),
    join(pkgRoot, 'providers', 'manager.py'),
    join(pkgRoot, 'api', 'main.py'),
    join(pkgRoot, 'cli', 'commands', 'launch.py'),
    join(pkgRoot, 'utils', 'tool_mapping.py'),
    join(pkgRoot, 'utils', 'agent_profiles.py'),
  ];
  let restored = 0;
  for (const path of paths) {
    if (restoreBak(path)) {
      process.stdout.write(`kusa cao: restored ${path}\n`);
      restored += 1;
    }
  }
  if (existsSync(destProvider)) {
    unlinkSync(destProvider);
    process.stdout.write(`kusa cao: removed ${destProvider}\n`);
  }
  if (!restored) {
    process.stderr.write(
      'kusa cao: no .kusa-bak files found — reinstall CAO with:\n'
      + '  uv tool install git+https://github.com/awslabs/cli-agent-orchestrator.git@main --upgrade\n',
    );
  } else {
    process.stdout.write('kusa cao: uninstall complete. Restart cao-server.\n');
  }
}

const uninstallMode = process.argv.includes('--uninstall');
const pkgRoot = findCaoPackageRoot();
if (!pkgRoot) {
  die('CAO package not found. Install with: uv tool install git+https://github.com/awslabs/cli-agent-orchestrator.git@main');
}
process.stdout.write(`kusa cao: CAO package at ${pkgRoot}\n`);
if (!existsSync(PROVIDER_SRC)) die(`missing ${PROVIDER_SRC}`);
if (uninstallMode) uninstall(pkgRoot);
else install(pkgRoot);
