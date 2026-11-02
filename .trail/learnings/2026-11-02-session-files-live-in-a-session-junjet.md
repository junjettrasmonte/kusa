---
title: Session files live in a session-named folder with attachments/
author: Junjet
date: 2026-11-02
branch: main
touches:
  - src/app/console/dashboard.css
  - src/app/console/dashboard.js
  - src/app/console/serve.mjs
  - src/app/console/ui/features/chat/ChatGlyphs.jsx
  - src/app/console/ui/features/chat/ChatHarness.jsx
  - src/app/console/ui/features/chat/ComposerControls.jsx
  - src/app/console/ui/features/monitor/SessionIndicator.jsx
  - src/app/console/ui/features/settings/SettingsPanel.jsx
  - src/app/console/ui/shared/AskIcon.jsx
  - src/app/console/ui/shared/AttachmentChips.jsx
---

## Decided
Each monitor/chat session owns a folder at `.kusa/<harness>/<stem>/` holding its lane JSON, events, chat transcript, settings sidecar, and an `attachments/` subfolder. Attachment bytes are written there on save; chat.json keeps slim `{file}` pointers and readers hydrate dataUrl/text back for the UI and agent. Flat pre-folder files are migrated on read/write via `migrateFlatSessionFiles`.

## Tried and ruled out
Embedding dataUrls in chat.json forever — the transcript grows with every picture and attachments cannot outlive a deleted chat as real files. Deleting the whole session folder from `deleteChatFiles` — that helper must leave the monitor lane so lane-only hydration still works; full folder removal belongs to `deleteSessions`.

## Watch out
`laneFiles` / `chatFilePath` / `sessionConfigPath` always resolve the folder layout; callers that still assume flat `<harness>/<stem>.json` paths will miss files after migration. Session HTTP routes accept both `/sessions/<harness>/<stem>/<file>` and legacy flat URLs.
