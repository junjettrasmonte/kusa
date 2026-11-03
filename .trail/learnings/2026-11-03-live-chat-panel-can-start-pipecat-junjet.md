---
title: Live Chat panel can start Pipecat bot from SetupGuide
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
Live Chat mirrors CAO’s start button. `collectLiveChatStatus` reports `installed` via `probeLiveChatInstall` (`.venv` python or `uv` + `extensions/live-chat`). When installed but down, SetupGuide shows **Start Live Chat bot** → `POST /live-chat/server/start` → `startLiveChatServer()` spawns `python -m live_chat` (venv) or `uv run python -m live_chat` detached with host/port/transport/TTS/Strata/transcript env, then polls `/health`. Explicit `baseUrl` on collect/start wins over settings/env.

## Tried and ruled out
Leaving bot start as copy-paste steps only. Node-managed long-term supervisor with stop — v1 only launches detached like CAO. Preferring install-button that runs `uv sync` from the UI (too heavy / interactive).

## Watch out
First boot can exceed the 30s health wait (Whisper/TTS model download) — button returns 504 with `started: true`. Transcript callback uses `http://127.0.0.1:<serve-port>/live-chat/transcript`. Extensions catalog badge uses `installed` then `serverUp`. Rebuild dashboard after UI changes.
