---
title: CAO panel can start cao-server from SetupGuide
author: Junjet
date: 2026-11-03
branch: main
touches:
  - extensions/cli-agent-orchestrator/README.md
  - scripts/capture-screenshots.mjs
  - src/app/console/dashboard.css
  - src/app/console/dashboard.js
  - src/app/console/serve.mjs
  - src/app/console/ui/App.jsx
  - src/app/console/ui/features/cao/CaoPanel.jsx
  - src/app/console/ui/features/chat/AttachmentPanel.jsx
  - src/app/console/ui/features/chat/ChatHarness.jsx
  - src/app/console/ui/features/chat/ComposerControls.jsx
---

## Decided
When CLI Agent Orchestrator is installed but `cao-server` is down, the SetupGuide shows a **Start cao-server** button. It POSTs `/cao/server/start`, which calls `startCaoServer()` in `src/features/cao/index.mjs` to spawn `cao-server --host … --port …` detached (stdio ignored, unref’d), then polls `/health` briefly and returns refreshed status. Install-missing still shows steps only (no button). `SetupGuide` gained an optional `action` prop for this pattern.

## Tried and ruled out
Leaving start as copy-paste terminal steps only. Spawning through `cao` instead of the `cao-server` binary named in the guide. Supervising the process from `kusa serve` (start/stop lifecycle) — v1 only launches detached like a user would in a terminal.

## Watch out
Host/port come from `CAO_BASE_URL` via `caoListenFromBaseUrl`. Multiple clicks can spawn extra servers if the first has not bound yet — button disables while `starting`. Rebuild the dashboard after UI changes. A 504 means the process started but health did not pass in time.
