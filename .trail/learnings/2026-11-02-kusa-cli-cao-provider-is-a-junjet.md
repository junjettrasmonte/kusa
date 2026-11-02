---
title: Kusa CLI CAO provider is a first-class feature
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
  - src/app/console/ui/features/monitor/Sidebar.jsx
---

## Decided
**Kusa CLI** (`kusa_cli` CAO provider) is a **first-class feature**, not an extension. Lives at `src/features/cao/kusa-cli/` next to `agent-repl.mjs`. Only **CLI Agent Orchestrator** remains in `BUILTIN_EXTENSIONS` / `extensions/cli-agent-orchestrator/`. Install via `npm run cao:provider:install` → `src/features/cao/kusa-cli/install.mjs`. CAO catalog badge can show “Kusa CLI ready” when that provider is detected.

## Tried and ruled out
Keeping Kusa CLI as a built-in extension (with or without menu / `dependsOn: ['cao']`) — user wants it as a core citizen that simply registers a provider into CAO.

## Watch out
Do not re-add `kusa-cli` to the Extensions catalog. Provider patches must not live under `extensions/`. Future external provider packs may still be extensions; Kusă’s own provider stays in `src/features/cao/`.
