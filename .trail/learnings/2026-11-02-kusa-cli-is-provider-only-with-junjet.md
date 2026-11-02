---
title: Kusa CLI is provider-only with no menu
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
Kusa CLI (`kusa-cli`) has **no `nav` and does not inherit CAO’s menu**. Selecting it in the Extensions catalog only highlights the row (`activeExtensionId`); it does not open Dev Tools. Its job is solely to register CAO provider `kusa_cli` (install patch under `extensions/kusa-cli/`). Profiles/UI stay under CLI Agent Orchestrator. `resolveExtensionNav()` returns only an extension’s own `nav`.

## Tried and ruled out
Walking `dependsOn` to open CAO’s Dev Tools when selecting Kusa CLI — user clarified it needs no menu, just adds a provider into CAO.

## Watch out
Do not add `nav` to provider packs unless they gain their own panel. Catalog copy should say the provider appears under CAO, not that selecting the pack opens a menu.
