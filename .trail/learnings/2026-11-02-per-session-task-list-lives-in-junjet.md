---
title: Per-session task list lives in the session folder
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
Each session's Task List is `.kusa/<harness>/<stem>/tasks.json` inside the session-named folder (alongside lane JSON, chat, settings, attachments). `loadTasks` / `saveTasks` still expose a per-key map; on disk they scan/write those per-session files. Legacy shared `.kusa/kusa/tasks.json` (v2 sessions map) is split into per-session files on the next load/save, then removed. `queues.json` stays workspace-shared under the harness root.

## Tried and ruled out
Leaving tasks in a shared sidecar keyed by session — it was the last per-session artifact outside the session folder, so deletes and backups could not treat a session as one directory. Reading `tasks.json` as a lane record inside the session folder — `readState` must skip it the same way it skips `.chat.json` / `.session.json`.

## Watch out
`tasksFilePath(dir, sessionKey)` now needs the session key; `tasksFilePath(dir)` alone still returns the legacy shared path for migration only. Callers that asserted `existsSync(tasksFilePath(dir))` must pass the key.
