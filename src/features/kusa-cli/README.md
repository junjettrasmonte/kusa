# Kusa CLI

Standalone interactive agent CLI: **`kusa agent`**.

```bash
kusa agent [--workspace <dir>] [--model <id>]
```

Uses Settings → Kusă agent (OpenAI-compatible endpoint in `.kusa/settings.json`).
Idle prompt is `kusa❯ `; type a prompt or `/exit`.

This feature is **not** an extension and is **not** CAO-specific. CAO is one
optional consumer via the provider pack below.

## Layout

| Path | Role |
|------|------|
| `agent-repl.mjs` | `kusa agent` entry (also `pkg` entry point `agent`) |
| `cao-provider/` | Optional: register this CLI as CAO provider `kusa_cli` |

## Optional: CAO provider

To drive the same REPL from [CLI Agent Orchestrator](https://github.com/awslabs/cli-agent-orchestrator):

```bash
npm run cao:provider:install
# node src/features/kusa-cli/cao-provider/install.mjs
```

Restart `cao-server`, then `cao launch --agents developer --provider kusa_cli`,
or create a profile under **Extensions → CLI Agent Orchestrator**.

See `cao-provider/` for uninstall and marker details.
