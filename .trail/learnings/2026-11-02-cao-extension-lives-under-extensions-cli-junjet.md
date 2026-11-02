---
title: CAO extension lives under extensions/cli-agent-orchestrator
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
Built-in extension display name is **CLI Agent Orchestrator** (catalog id stays `cao`; Dev Tools nav label stays `CAO`). On-disk home is `extensions/cli-agent-orchestrator/` (moved from repo-root `cao-provider/`), with `root: 'extensions/cli-agent-orchestrator'` on the registry entry. `npm run cao:provider:install|uninstall` points at `extensions/cli-agent-orchestrator/kusa_cli/install.mjs`. Package `files` includes `extensions/` so the provider ships with npm.

## Tried and ruled out
Keeping the display name “Kusa CLI CAO Provider” or leaving provider assets at `cao-provider/` — user asked for the CAO product name and an `/extensions/{extensionname}` folder. Renaming registry `id` away from `cao` was skipped to avoid breaking `monitor.activeExtension` / Dev Tools subtab migrations.

## Watch out
Installer log prefix is now `kusa cao:` (was `kusa cao-provider:`). Do not reintroduce a top-level `cao-provider/`. New built-ins should land under `extensions/<kebab-name>/` and set `root` + catalog `name` accordingly; keep short `id`/`nav.id` if storage/nav already depend on them.
