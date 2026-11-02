---
title: CAO is first built-in Extensions entry
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
CAO (CLI Agent Orchestrator / `kusa_cli`) is the first built-in extension under Sidebar › Extensions (`BUILTIN_EXTENSIONS` in `src/app/console/ui/features/extensions/registry.js`). Selecting it opens `CaoPanel` in the main pane (`monitor.activeExtension`). It is no longer a Dev Tools subtab — `DEVTOOLS_SUBTAB_IDS` is only `git` + `trail`.

## Tried and ruled out
Keeping CAO only under Dev Tools while Extensions stayed “Coming soon”; also dual-homing forever without a catalog entry.

## Watch out
Saved `monitor.devtoolsSubTab=cao` / `monitor.tab=cao` migrates to the Extensions selection. Rail tab clicks clear `activeExtensionId`. Add new built-ins to `BUILTIN_EXTENSIONS` (order = display order) and teach App how to render them.
