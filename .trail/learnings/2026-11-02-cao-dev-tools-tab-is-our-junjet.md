---
title: "CAO Dev Tools tab is our CaoPanel, not CAO UI"
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
  - src/app/console/ui/features/settings/SettingsPanel.jsx
---

## Decided
The Dev Tools CAO tab is Kusa’s own React UI (`CaoPanel` in `src/app/console/ui/features/cao/CaoPanel.jsx`), mounted from `DevToolsPanel`. It talks to cao-server via our `/cao` and `/cao/profiles` APIs (status, providers, profile CRUD). CAO’s native web UI is separate at `http://localhost:9889` (`CAO_WEB_UI_URL`); the panel only links out when `serverUp` is true.

## Tried and ruled out
Treating the console CAO screen as an embed or fork of awslabs CAO’s own UI — it is not; dig starts at our panel, not their package.

## Watch out
Without cao-server the panel shows our setup steps and keeps profiles empty (503); don’t confuse that empty state with “CAO shipped no UI.” The link target (`webUiUrl`) is CAO’s UI; the chrome around it is ours.
