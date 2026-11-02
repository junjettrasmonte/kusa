---
title: Kusa CLI is a CAO-dependent extension
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
**Kusa CLI** is its own built-in extension (`id: kusa-cli`, folder `extensions/kusa-cli/`) that registers CAO provider `kusa_cli`. It declares `dependsOn: ['cao']`. **CLI Agent Orchestrator** (`cao` / `extensions/cli-agent-orchestrator/`) no longer owns `providerId` or the provider patch files — only server/profiles UI + Dev Tools nav. `resolveExtensionNav()` walks `dependsOn` so selecting Kusa CLI opens CAO’s Dev Tools panel. Installer path is `extensions/kusa-cli/install.mjs` (`npm run cao:provider:install`).

## Tried and ruled out
Keeping `kusa_cli/` under `extensions/cli-agent-orchestrator/` as part of the CAO extension — user asked for a separate extension that depends on CAO. Giving Kusa CLI its own Dev Tools subtab was skipped; it inherits CAO nav via dependency.

## Watch out
Catalog order: CAO first, then Kusa CLI. Status badges: CAO = server up/down; Kusa CLI = provider detect + deps. Do not put provider patches back under the CAO folder. Future provider packs should follow the same `dependsOn: ['cao']` + `providerId` pattern without their own `nav` unless they need a distinct panel.
