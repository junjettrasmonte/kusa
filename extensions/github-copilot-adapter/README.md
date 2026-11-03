# GitHub Copilot Adapter

Built-in Kusă extension that integrates the [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/use-copilot-agent-mode) as a standard chat provider.

Catalog id: `github-copilot-adapter` · Folder: `extensions/github-copilot-adapter/`

## Owns

- Headless stream turns (`copilot -p --output-format json --stream on`)
- Provider registration (`copilot` / harness `github-copilot` / CAO `copilot_cli`)

## Prerequisites

- `npm i -g @github/copilot` and `copilot login`
