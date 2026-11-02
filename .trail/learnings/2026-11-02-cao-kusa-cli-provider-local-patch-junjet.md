---
title: CAO kusa_cli provider local patch
author: Junjet
date: 2026-11-02
branch: main
touches:
  - package.json
  - src/app/console/dashboard.css
  - src/app/console/dashboard.js
  - src/app/console/serve.mjs
  - src/app/console/ui/App.jsx
  - src/app/console/ui/features/chat/ChatGlyphs.jsx
  - src/app/console/ui/features/chat/ChatHarness.jsx
  - src/app/console/ui/features/chat/ComposerControls.jsx
  - src/app/console/ui/features/monitor/SessionIndicator.jsx
  - src/app/console/ui/features/settings/SettingsPanel.jsx
---

## Decided
Register Kusă as CAO provider type `kusa_cli` via local site-packages patch (no upstream plugin API yet). Ship `kusa agent` REPL with markers `kusa❯ ` / `⏺ ` / `… thinking` / `ERROR: `, Python `KusaCliProvider`, and `cao-provider/kusa_cli/install.mjs` (`npm run cao:provider:install`). Console labels use `kusa_cli` → Kusă.

## Tried and ruled out
Resolving CAO package from `dirname(dirname(command -v cao-server))` without `realpath` — uv puts symlinks in `~/.local/bin`, so that lands on `~/.local` and misses `~/.local/share/uv/tools/cli-agent-orchestrator`. TOOL_MAPPING patch must not use `[^\]]+` on nested `Dict[...]` annotations.

## Watch out
Restart `cao-server` after install; verify `GET /agents/providers` shows `kusa_cli` installed. Uninstall restores `.kusa-bak` files. `KUSA_CAO_YOLO` defaults on so CAO is not blocked on tool approval.
