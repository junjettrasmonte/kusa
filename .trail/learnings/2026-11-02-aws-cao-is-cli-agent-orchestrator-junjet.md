---
title: AWS CAO is CLI Agent Orchestrator Dev Tools tab
author: Junjet
date: 2026-11-02
branch: main
touches:
  - src/app/console/dashboard.css
  - src/app/console/dashboard.js
  - src/app/console/serve.mjs
  - src/app/console/ui/App.jsx
  - src/app/console/ui/features/chat/ChatGlyphs.jsx
  - src/app/console/ui/features/chat/ChatHarness.jsx
  - src/app/console/ui/features/chat/ComposerControls.jsx
  - src/app/console/ui/features/monitor/SessionIndicator.jsx
  - src/app/console/ui/features/settings/SettingsPanel.jsx
  - src/app/console/ui/shared/AskIcon.jsx
---

## Decided
AWS CAO (not COA) is awslabs CLI Agent Orchestrator — local supervisor/worker multi-agent orchestration over MCP. It lives under Dev Tools as subtab `cao` (format.js + SubTabIcons + DevToolsPanel), with `CaoPanel` at `src/app/console/ui/features/cao/CaoPanel.jsx` and backend in `src/features/cao/index.mjs`. Kusă serve proxies `GET /cao`, `GET /cao/providers`, and CRUD `/cao/profiles` to cao-server (default `http://127.0.0.1:9889`, override with `CAO_BASE_URL`). Writable “connections” are CAO agent profiles (name + provider + model + instructions); provider availability from `/agents/providers` is read-only detection of installed CLIs.

## Tried and ruled out
Treating “AWS COA” as Compute Optimizer Automation or Bedrock multi-agent collaboration — wrong product. Do not invent a second provider store inside Kusă settings when cao-server already owns profile CRUD; proxy it. Built-in / provider-managed profiles are not deletable via CAO’s API — the panel marks them read-only.

## Watch out
cao-server must be running for connection CRUD; without it the panel shows the SetupGuide (install `cao` via uv tool, then `cao-server`). Profile create/update sends Markdown with YAML frontmatter (`buildProfileDocument` / `parseProfileDocument`) — keep frontmatter `name` equal to the storage key or CAO returns 400.
