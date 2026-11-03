---
title: Detached bot starts must outlive serve --live restarts
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
CAO / Live Chat Start buttons spawn helpers with `spawnDetached` (`src/shared/lib/spawn-detached.mjs`): Unix `setsid` + Node `detached: true` + immediate `unref()`, so they are a new session and survive `kusa serve --live` SIGTERM restarts of the serve child. Concurrent Start calls share one in-flight promise per service (`startCaoServer` / `startLiveChatServer` are not `async` — returning a shared promise identity).

## Tried and ruled out
Plain `detached: true` alone — under `--live`, editing server sources restarts serve and was killing bot children that still shared the serve session/group. Marking the start wrappers `async` — each call got a new Promise wrapper so the coalesce lock never matched (`a === b` was false).

## Watch out
`--live` still restarts on every `src/features/{cao,live-chat}` save; bots should stay up, but an in-flight Start HTTP request can be aborted mid-wait (client should retry; health check no-ops if already up). Windows has no `setsid` — falls back to Node detached. Do not reintroduce `async` on the public start entrypoints.
