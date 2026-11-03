# Cursor Adapter

Built-in Kusă extension that integrates [Cursor Agent CLI](https://cursor.com/cli) as a standard chat provider.

Catalog id: `cursor-adapter` · Folder: `extensions/cursor-adapter/`

## Owns

- Headless stream turns (`agent -p --output-format stream-json`)
- Workspace trust probe / grant (`/adapters/cursor/trust`)
- IDE composer titles from Cursor `state.vscdb`
- Provider registration (`cursor` / harness `cursor` / CAO `cursor_cli`)

## Prerequisites

- Cursor Agent CLI on PATH (`cursor-agent` or `agent`)
