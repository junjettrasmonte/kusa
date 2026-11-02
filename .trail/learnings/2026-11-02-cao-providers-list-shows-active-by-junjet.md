---
title: CAO providers list shows active by default
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
Dev Tools → CAO → Providers defaults to **active only** (`available` from GET /agents/providers). A “Show all supported providers” toggle merges in the known PROVIDER_FALLBACK set. Each tile has an info icon that opens a modal with install/auth steps (plus a link to the upstream CAO provider doc when one exists; kusa_cli points at `cao-provider/` / `npm run cao:provider:install`).

## Tried and ruled out
Always listing every known provider as unavailable chips — noisy when only one or two CLIs are installed. Embedding CAO’s own UI for this — still our CaoPanel.

## Watch out
Install step strings are curated in `CaoPanel.jsx` (`PROVIDER_INSTALL`); they can drift from upstream docs. After installing a CLI, cao-server must be restarted before the tile flips active.
