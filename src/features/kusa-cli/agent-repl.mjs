#!/usr/bin/env node
/**
 * Interactive `kusa agent` REPL — standalone Kusă CLI.
 *
 * Stable markers (single source of truth — also mirrored by the optional CAO
 * provider at src/features/kusa-cli/cao-provider/provider.py):
 *   IDLE_PROMPT      = "kusa❯ "
 *   RESPONSE_MARKER  = "⏺ "
 *   PROCESSING_LINE  = "… thinking"
 *   ERROR_PREFIX     = "ERROR: "
 *
 * Run directly for a local agent shell, or register as CAO provider `kusa_cli`
 * so an orchestrator can paste lines into this same REPL.
 */
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runKusaAgent } from '#features/agent/index.mjs';
import {
  defaultMonitorDir,
  defaultWorkspaceRoot,
  loadMonitorSettings,
} from '#features/monitor/lib.mjs';

/** @type {const} */
export const KUSA_CLI_MARKERS = {
  IDLE_PROMPT: 'kusa❯ ',
  RESPONSE_MARKER: '⏺ ',
  PROCESSING_LINE: '… thinking',
  ERROR_PREFIX: 'ERROR: ',
};

/** @deprecated Prefer KUSA_CLI_MARKERS — kept for CAO provider / older imports. */
export const CAO_MARKERS = KUSA_CLI_MARKERS;

function yoloEnabled(env = process.env) {
  const raw = String(env.KUSA_CAO_YOLO ?? '1').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'no' && raw !== 'off';
}

function parseArgs(argv) {
  const out = { help: false, workspace: null, model: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--workspace' || arg === '-C') {
      out.workspace = argv[i + 1] || null;
      i += 1;
    } else if (arg === '--model') {
      out.model = argv[i + 1] || null;
      i += 1;
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`Usage: kusa agent [--workspace <dir>] [--model <id>]

Interactive Kusă agent REPL (standalone CLI).
Prints "${KUSA_CLI_MARKERS.IDLE_PROMPT}" when idle. Type a prompt, or /exit to quit.

Also usable as CAO provider kusa_cli (see src/features/kusa-cli/cao-provider/).

Environment:
  KUSA_CAO_YOLO=1   Auto-approve gated tools (default on; set 0 to prompt)
`);
}

function writePrompt() {
  process.stdout.write(CAO_MARKERS.IDLE_PROMPT);
}

/**
 * @param {{ workspaceRoot?: string, model?: string, env?: NodeJS.ProcessEnv }} [opts]
 */
export async function runAgentRepl(opts = {}) {
  const env = opts.env || process.env;
  const workspaceRoot = resolve(opts.workspaceRoot || defaultWorkspaceRoot());
  const dataDir = defaultMonitorDir(workspaceRoot);
  const settings = loadMonitorSettings(dataDir);
  const modelOverride = opts.model || null;
  const yolo = yoloEnabled(env);
  /** @type {Array<{ role: string, text: string }>} */
  const history = [];

  process.stdout.write(`Kusă agent REPL · workspace ${workspaceRoot}\n`);
  if (!settings.agentBaseUrl) {
    process.stdout.write(
      `${CAO_MARKERS.ERROR_PREFIX}No agent base URL in .kusa/settings.json (Settings → Kusă agent).\n`,
    );
  }
  writePrompt();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
    crlfDelay: Infinity,
  });

  const onApprove = yolo
    ? async () => ({ allowed: true })
    : null;

  for await (const line of rl) {
    const text = String(line || '').replace(/\r$/, '');
    const trimmed = text.trim();
    if (!trimmed) {
      writePrompt();
      continue;
    }
    if (trimmed === '/exit' || trimmed === '/quit') {
      rl.close();
      break;
    }

    process.stdout.write(`${CAO_MARKERS.PROCESSING_LINE}\n`);
    let reply = '';
    try {
      const result = await runKusaAgent({
        workspaceRoot,
        settings,
        prompt: text,
        history,
        stream: false,
        mode: 'agent',
        modelOverride,
        approvalMode: yolo ? 'allow' : undefined,
        onApprove,
        onAsk: yolo
          ? async () => ({ optionIndex: 0, freeText: 'auto' })
          : null,
        onEvent: (ev) => {
          if (ev?.type === 'content' && ev.delta) {
            // Stream without markers; final block reprints with RESPONSE_MARKER.
          }
        },
        hooks: {
          dataDir,
          sessionKey: `kusa:agent-repl`,
        },
      });
      reply = String(result?.text || result?.content || '').trim();
      if (!reply) reply = '(empty response)';
      process.stdout.write(`${CAO_MARKERS.RESPONSE_MARKER}${reply.replace(/\n/g, '\n')}\n`);
      history.push({ role: 'user', text });
      history.push({ role: 'assistant', text: reply });
    } catch (err) {
      const message = err?.message || String(err);
      process.stdout.write(`${CAO_MARKERS.ERROR_PREFIX}${message}\n`);
    }
    writePrompt();
  }

  process.stdout.write('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  await runAgentRepl({
    workspaceRoot: args.workspace || undefined,
    model: args.model || undefined,
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${CAO_MARKERS.ERROR_PREFIX}${err?.message || err}\n`);
    process.exit(1);
  });
}
