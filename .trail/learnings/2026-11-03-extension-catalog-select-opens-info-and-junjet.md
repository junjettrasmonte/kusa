---
title: Extension catalog select opens info and config page
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
  - src/app/console/ui/features/chat/AttachmentPanel.jsx
  - src/app/console/ui/features/chat/ChatHarness.jsx
  - src/app/console/ui/features/chat/ComposerControls.jsx
  - src/app/console/ui/features/chat/PopupList.jsx
---

## Decided
Clicking an extension in Sidebar › Extensions loads its **info & config page** in the main pane (`ExtensionPage` via `monitor.activeExtension` / `activeExtensionId`). Catalog metadata (name, description, detail, root) renders above the extension’s config panel (CAO → `CaoPanel`). Dev Tools nav placements remain a second entry point; selecting CAO on the rail still sets `activeExtensionId` and keeps the Dev Tools tab highlighted. Catalog select does **not** force `setTab('devtools')` — the rail is deselected unless the user was already on Dev Tools.

## Tried and ruled out
Only jumping to Dev Tools › CAO on catalog click (`openExtension` → `setTab('devtools')`) with no main-pane catalog page — the list highlight alone felt like a no-op next to a proper info/config surface. Dual-rendering CaoPanel only under DevToolsPanel without an Extensions-owned page.

## Watch out
Add new built-in panels inside `ExtensionPage` (switch on `ext.id`) in addition to any `nav` + `DevToolsPanel` branch. Rail uses `tab={activeExtensionId && tab !== 'devtools' ? null : tab}` so catalog select clears the rail unless already on Dev Tools. Rebuild the dashboard bundle after UI changes (`npm run build`).
