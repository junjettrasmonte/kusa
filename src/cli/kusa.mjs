#!/usr/bin/env node
/**
 * kusa — Kusă CLI
 *
 *   kusa serve              Start the localhost dashboard
 *   kusa hook <event>       Record a harness hook event (stdin JSON)
 *   kusa open               Open dashboard.md / browser once per session
 *   kusa demo               Write synthetic events to a temp dir
 *   kusa build              Rebuild the React dashboard assets
 *   kusa init [dir]         Install hook templates into a project
 *   kusa mcp                Run the Kusă MCP server (stdio)
 *   kusa test               Run package tests
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, '..');
const pkgRoot = resolve(srcDir, '..');

function runNode(script, args = [], opts = {}) {
  const result = spawnSync(process.execPath, [join(srcDir, script), ...args], {
    stdio: 'inherit',
    cwd: opts.cwd || process.cwd(),
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

function usage() {
  process.stderr.write(`Kusă — live session monitor for AI coding agents

Kusă hooks into Cursor, GitHub Copilot, and VS Code agent sessions and
records what the agent does: prompts, tool calls, durations, failures,
token usage, plans, and warnings. Everything stays local in .kusa/ in
your project and shows up in a live dashboard.

Quick start:
  kusa init        Set up hooks in this repo
  kusa serve       Open the dashboard at http://127.0.0.1:1424/dashboard.html

Usage: kusa <command> [args]

Commands:
  serve [--port <n>] Start dashboard (default http://127.0.0.1:1424/dashboard.html)
  hook <event>       Harness hook entry (reads JSON on stdin)
  open               Open Markdown preview / browser for this session
  demo               Synthetic events → temp data dir
  build              vite build → dashboard.{html,js,css}
  init [dir]         Detect Cursor / Copilot, write hooks, add npm scripts
                     Flags: --cursor, --copilot
  mcp                MCP stdio server (skills, learnings, session)
  test               Run node:test suite
  version            Show installed version
  help               Show this help
`);
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeIfMissing(path, contents, { force = false } = {}) {
  if (!force && existsSync(path)) {
    process.stderr.write(`kusa: keep existing ${path}\n`);
    return false;
  }
  ensureDir(dirname(path));
  writeFileSync(path, contents);
  process.stderr.write(`kusa: wrote ${path}\n`);
  return true;
}

function hookEntryText(entry) {
  return [entry?.command, entry?.bash, entry?.powershell].filter(Boolean).join('\n');
}

function hookEntryInstalled(existing, entry) {
  const wanted = hookEntryText(entry);
  return existing.some((item) => {
    const text = hookEntryText(item);
    if (wanted.includes('kusa open') || wanted.includes('open.mjs')) {
      return text.includes('kusa open') || text.includes('open.mjs');
    }
    const event = wanted.match(/hook(?:\.mjs)?\s+(\S+)/)?.[1];
    if (!event) return text === wanted;
    return text.includes(`kusa hook ${event}`) || text.includes(`hook.mjs ${event}`);
  });
}

/** Create a hook file, or append kusa commands to the one already in the repo. */
function mergeHookFile(path, incoming, { replaceEntry } = {}) {
  if (!existsSync(path)) {
    writeIfMissing(path, `${JSON.stringify(incoming, null, 2)}\n`);
    return;
  }
  let current;
  try {
    current = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    process.stderr.write(`kusa: could not parse ${path}; left unchanged\n`);
    return;
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    process.stderr.write(`kusa: ${path} is not a JSON object; left unchanged\n`);
    return;
  }
  if (!current.hooks || typeof current.hooks !== 'object' || Array.isArray(current.hooks)) {
    current.hooks = {};
  }
  if (current.version == null) current.version = incoming.version;

  let added = 0;
  for (const [event, entries] of Object.entries(incoming.hooks)) {
    let list = Array.isArray(current.hooks[event]) ? current.hooks[event] : [];
    if (replaceEntry) {
      const kept = list.filter((entry) => !replaceEntry(entry, event));
      if (kept.length !== list.length) added += list.length - kept.length;
      list = kept;
    }
    for (const entry of entries) {
      if (hookEntryInstalled(list, entry)) continue;
      list.push(entry);
      added += 1;
    }
    current.hooks[event] = list;
  }
  if (!added) {
    process.stderr.write(`kusa: keep existing ${path}\n`);
    return;
  }
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
  process.stderr.write(`kusa: updated ${path}\n`);
}

function copyTemplate(fromRel, toAbs, { force = false } = {}) {
  const from = join(srcDir, 'templates', fromRel);
  if (!existsSync(from)) {
    process.stderr.write(`kusa: missing template ${fromRel}\n`);
    return false;
  }
  if (!force && existsSync(toAbs)) {
    process.stderr.write(`kusa: keep existing ${toAbs}\n`);
    return false;
  }
  ensureDir(dirname(toAbs));
  copyFileSync(from, toAbs);
  process.stderr.write(`kusa: wrote ${toAbs}\n`);
  return true;
}

const CURSOR_HOOK_REL = '.cursor/hooks/kusa.cjs';
const LEGACY_CURSOR_HOOK_REL = '.cursor/hooks/kusa.sh';
const CURSOR_EVENTS = [
  'sessionStart',
  'sessionEnd',
  'beforeSubmitPrompt',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'subagentStart',
  'subagentStop',
  'stop',
  'afterAgentResponse',
];
const CURSOR_HOOK_SCRIPT = `#!/usr/bin/env node
// Kusă project hook. .cursor/hooks.json registers this file once per event.
'use strict';

const { spawnSync } = require('node:child_process');

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const payload = Buffer.concat(chunks).toString('utf8');
  let event = process.argv[2] || '';
  if (!event) {
    try { event = JSON.parse(payload).hook_event_name || ''; } catch { event = ''; }
  }

  const run = (args, capture) => spawnSync('kusa', args, {
    input: payload,
    encoding: 'utf8',
    stdio: ['pipe', capture ? 'pipe' : 'ignore', 'ignore'],
    shell: process.platform === 'win32',
    windowsHide: true,
  });

  const hook = run(['hook', event, '--cursor'], true);
  if (event === 'sessionStart') run(['open', '--cursor'], false);

  const output = !hook.error && hook.status === 0 ? String(hook.stdout || '').trim() : '';
  process.stdout.write(\`\${output || '{}'}\\n\`);
});
`;

function cursorHookCommand(event) {
  return `node ${CURSOR_HOOK_REL} ${event}`;
}

function isReplacedCursorHook(entry, event) {
  const command = String(entry?.command || '');
  if (command === cursorHookCommand(event)) return false;
  if (command.includes(LEGACY_CURSOR_HOOK_REL)) return true;
  if (command.includes(`kusa hook ${event}`) || command.includes(`hook.mjs ${event}`)) return true;
  if (event === 'sessionStart' && (command.includes('kusa open') || /(^|\s)open\.mjs(\s|$)/.test(command))) {
    return true;
  }
  return false;
}

function writeCursorHookScript(root) {
  const path = join(root, CURSOR_HOOK_REL);
  if (existsSync(path) && readFileSync(path, 'utf8') === CURSOR_HOOK_SCRIPT) {
    process.stderr.write(`kusa: keep existing ${path}\n`);
    return;
  }
  ensureDir(dirname(path));
  writeFileSync(path, CURSOR_HOOK_SCRIPT, { mode: 0o755 });
  chmodSync(path, 0o755);
  process.stderr.write(`kusa: wrote ${path}\n`);

  const legacy = join(root, LEGACY_CURSOR_HOOK_REL);
  if (existsSync(legacy) && readFileSync(legacy, 'utf8').includes('# Kusă project hook.')) {
    unlinkSync(legacy);
    process.stderr.write(`kusa: removed ${legacy}\n`);
  }
}

function buildCursorHooks() {
  const hooks = {};
  for (const event of CURSOR_EVENTS) {
    hooks[event] = [{ command: cursorHookCommand(event), timeout: 10 }];
  }
  return { version: 1, hooks };
}

function buildCopilotHookBash(event) {
  return `if command -v kusa >/dev/null 2>&1; then kusa hook ${event}; else printf '{}\\n'; fi`;
}

function buildCopilotHookPwsh(event) {
  return `if (Get-Command kusa -ErrorAction SilentlyContinue) { kusa hook ${event} } else { Write-Output '{}' }`;
}

function buildCopilotHooksJson() {
  const names = [
    'sessionStart',
    'sessionEnd',
    'userPromptSubmitted',
    'preToolUse',
    'postToolUse',
    'postToolUseFailure',
    'agentStop',
    'subagentStart',
    'subagentStop',
    'errorOccurred',
    'permissionRequest',
    'notification',
  ];
  const hooks = {};
  for (const name of names) {
    const entries = [];
    if (name === 'sessionStart') {
      entries.push({
        type: 'command',
        bash: buildCopilotHookBash('sessionStart'),
        powershell: buildCopilotHookPwsh('sessionStart'),
        command: buildCopilotHookBash('sessionStart'),
      });
      entries.push({
        type: 'command',
        bash: 'if command -v kusa >/dev/null 2>&1; then kusa open; else exit 0; fi',
        powershell: 'if (Get-Command kusa -ErrorAction SilentlyContinue) { kusa open } else { exit 0 }',
        command: 'if command -v kusa >/dev/null 2>&1; then kusa open; else exit 0; fi',
      });
    } else {
      entries.push({
        type: 'command',
        bash: buildCopilotHookBash(name),
        powershell: buildCopilotHookPwsh(name),
        command: buildCopilotHookBash(name),
      });
    }
    hooks[name] = entries;
  }
  return {
    version: 1,
    hooks,
  };
}

const CURSOR_MARKERS = ['.cursor', '.cursorrules', '.cursorignore'];
const COPILOT_MARKERS = [
  '.github/copilot-instructions.md',
  '.github/copilot',
  '.github/hooks',
  '.github/agents',
  '.github/instructions',
  '.github/prompts',
  '.github/extensions',
];
const PACKAGE_SCRIPTS = {
  'kusa:serve': 'kusa serve',
};

function detectHarnesses(root) {
  const present = (markers) => markers.filter((rel) => existsSync(join(root, rel)));
  return {
    cursor: present(CURSOR_MARKERS),
    copilot: present(COPILOT_MARKERS),
  };
}

function parseInitArgs(args) {
  let dir;
  let cursor = false;
  let copilot = false;
  let explicit = false;
  for (const arg of args) {
    if (arg === '--cursor') {
      cursor = true;
      explicit = true;
    } else if (arg === '--copilot') {
      copilot = true;
      explicit = true;
    } else if (!arg.startsWith('-') && dir === undefined) {
      dir = arg;
    } else {
      process.stderr.write(`kusa: unknown init argument ${arg}\n`);
      process.exit(1);
    }
  }
  return {
    dir,
    cursor: explicit ? cursor : null,
    copilot: explicit ? copilot : null,
  };
}

function addPackageScripts(root) {
  const path = join(root, 'package.json');
  let pkg;
  let created = false;
  if (existsSync(path)) {
    try {
      pkg = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      process.stderr.write(`kusa: could not parse ${path}; add scripts manually\n`);
      return;
    }
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
      process.stderr.write(`kusa: ${path} is not a JSON object; add scripts manually\n`);
      return;
    }
  } else {
    pkg = { private: true };
    created = true;
  }
  if (pkg.scripts == null) pkg.scripts = {};
  if (!pkg.scripts || typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts)) {
    process.stderr.write('kusa: package.json scripts is not an object; left unchanged\n');
    return;
  }

  const added = [];
  for (const [name, command] of Object.entries(PACKAGE_SCRIPTS)) {
    if (pkg.scripts[name] == null) {
      pkg.scripts[name] = command;
      added.push(name);
    } else if (pkg.scripts[name] !== command) {
      process.stderr.write(`kusa: keep existing script ${name}\n`);
    }
  }
  if (!created && added.length === 0) return;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  process.stderr.write(created
    ? `kusa: wrote ${path}\n`
    : `kusa: added script(s) to ${path}: ${added.join(', ')}\n`);
}

function initProject(targetDir, { cursor = null, copilot = null } = {}) {
  const root = resolve(targetDir || process.cwd());
  process.stderr.write(`kusa: initializing Agentic Development Console in ${root}\n`);

  let installCursor = cursor;
  let installCopilot = copilot;
  if (installCursor === null && installCopilot === null) {
    const detected = detectHarnesses(root);
    if (detected.cursor.length) {
      process.stderr.write(`kusa: detected Cursor (${detected.cursor.join(', ')})\n`);
    }
    if (detected.copilot.length) {
      process.stderr.write(`kusa: detected GitHub Copilot (${detected.copilot.join(', ')})\n`);
    }
    if (!detected.cursor.length && !detected.copilot.length) {
      process.stderr.write('kusa: no Cursor or Copilot markers found; installing both hook sets\n');
      installCursor = true;
      installCopilot = true;
    } else {
      installCursor = detected.cursor.length > 0;
      installCopilot = detected.copilot.length > 0;
    }
  }

  if (installCursor) {
    writeCursorHookScript(root);
    mergeHookFile(join(root, '.cursor', 'hooks.json'), buildCursorHooks(), {
      replaceEntry: isReplacedCursorHook,
    });
  }

  if (installCopilot) {
    mergeHookFile(
      join(root, '.github', 'hooks', 'copilot-runtime-monitor.json'),
      buildCopilotHooksJson(),
    );
    copyTemplate(
      'github/extensions/kusa-session-listener/extension.mjs',
      join(root, '.github', 'extensions', 'kusa-session-listener', 'extension.mjs'),
    );
  }

  addPackageScripts(root);

  // VS Code Markdown preview association for dashboard.md
  const vscodeSettingsPath = join(root, '.vscode', 'settings.json');
  const associationKey = '**/.kusa/dashboard.md';
  const associationValue = 'vscode.markdown.preview.editor';
  if (existsSync(vscodeSettingsPath)) {
    try {
      const raw = readFileSync(vscodeSettingsPath, 'utf8');
      // Strip // comments for a best-effort merge
      const json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
      json['workbench.editorAssociations'] = {
        ...(json['workbench.editorAssociations'] || {}),
        [associationKey]: associationValue,
      };
      writeFileSync(vscodeSettingsPath, `${JSON.stringify(json, null, 2)}\n`);
      process.stderr.write(`kusa: updated ${vscodeSettingsPath}\n`);
    } catch {
      process.stderr.write(`kusa: could not merge ${vscodeSettingsPath}; add editorAssociations manually\n`);
    }
  } else {
    writeIfMissing(
      vscodeSettingsPath,
      `${JSON.stringify({
        'workbench.editorAssociations': {
          [associationKey]: associationValue,
        },
      }, null, 2)}\n`,
    );
  }

  // gitignore data dir
  const gi = join(root, '.gitignore');
  const ignoreLines = ['/.kusa/'];
  if (existsSync(gi)) {
    const text = readFileSync(gi, 'utf8');
    const missing = ignoreLines.filter((line) => !text.includes(line));
    if (missing.length) {
      writeFileSync(gi, `${text.replace(/\s*$/, '')}\n${missing.join('\n')}\n`);
      process.stderr.write(`kusa: appended ${missing.length} ignore rule(s) to .gitignore\n`);
    }
  } else {
    writeIfMissing(gi, `${ignoreLines.join('\n')}\n`);
  }

  process.stderr.write(`
Next:
  1. npm run kusa:serve
  2. Start a new session in the detected harness and use a tool

Data folder (gitignored): .kusa/
Override with KUSA_DIR or KUSA_WORKSPACE.
`);
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'serve':
    runNode('serve.mjs', rest);
    break;
  case 'hook':
    runNode('hook.mjs', rest);
    break;
  case 'open':
    runNode('open.mjs', rest);
    break;
  case 'demo':
    runNode('demo.mjs', rest);
    break;
  case 'build':
    runNode('build-css.mjs', rest);
    break;
  case 'init': {
    const options = parseInitArgs(rest);
    initProject(options.dir, options);
    break;
  }
  case 'mcp':
    runNode('mcp/server.mjs', rest);
    break;
  case 'test': {
    const result = spawnSync(process.execPath, ['--test', join(pkgRoot, 'test')], {
      stdio: 'inherit',
      cwd: pkgRoot,
    });
    process.exit(result.status ?? 1);
    break;
  }
  case 'version':
  case '--version':
  case '-v': {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    process.stdout.write(`${pkg.version}\n`);
    break;
  }
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    usage();
    process.exit(cmd ? 0 : 1);
    break;
  default:
    // Allow `kusa sessionStart` style by forwarding unknown first arg to hook
    if (cmd && !cmd.startsWith('-')) {
      runNode('hook.mjs', [cmd, ...rest]);
    } else {
      usage();
      process.exit(1);
    }
}
