# CLI Agent Orchestrator

Kusă console extension for [CLI Agent Orchestrator](https://github.com/awslabs/cli-agent-orchestrator) (awslabs CAO): server status, detected provider CLIs, and connection profiles.

Catalog id: `cao` · Folder: `extensions/cli-agent-orchestrator/` · Dev Tools nav label: **CAO**

## Prerequisites

- `cao` / `cao-server` installed (`uv tool install git+https://github.com/awslabs/cli-agent-orchestrator.git@main`)

## Console

**Extensions → CLI Agent Orchestrator** opens its info & config page in the main
pane (also reachable from Dev Tools › CAO).

Kusă’s agent shell is the standalone **`kusa agent`** CLI
(`src/features/kusa-cli/`). Optionally register it as CAO provider `kusa_cli`
with `npm run cao:provider:install` (`src/features/kusa-cli/cao-provider/`),
then create profiles here with provider **Kusa CLI**.
