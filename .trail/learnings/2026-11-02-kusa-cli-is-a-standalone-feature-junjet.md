---
title: Kusa CLI is a standalone feature with optional CAO provider
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
**Kusa CLI** is a standalone first-class feature at `src/features/kusa-cli/` (`kusa agent` / `agent-repl.mjs`). It is not CAO-specific and not an extension. CAO integration is optional under `src/features/kusa-cli/cao-provider/` (`npm run cao:provider:install`). Markers export as `KUSA_CLI_MARKERS` (`CAO_MARKERS` kept as alias). `pkg` entry `agent` points at `features/kusa-cli/agent-repl.mjs`.

## Tried and ruled out
Housing the REPL under `src/features/cao/` or treating Kusa CLI as only a CAO provider pack — user clarified it can run as a standalone CLI.

## Watch out
Do not move the REPL back under `cao/` or list it in Extensions. Docs/help should lead with standalone `kusa agent`; mention CAO provider as optional. Dashboard bundle may lag until rebuild.
