# CAO provider for Kusa CLI (optional)

Registers the standalone **`kusa agent`** REPL with CLI Agent Orchestrator as
provider type **`kusa_cli`**. Parent feature: `src/features/kusa-cli/`.

```bash
npm run cao:provider:install
npm run cao:provider:uninstall
```

Requires `cao` / `cao-server` and `kusa` on `PATH`. Restart `cao-server` after
install. Markers match `agent-repl.mjs` (`kusa❯ `, `⏺ `, `… thinking`, `ERROR: `).
