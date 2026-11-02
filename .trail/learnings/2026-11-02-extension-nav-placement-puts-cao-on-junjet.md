---
title: Extension nav.placement puts CAO on Dev Tools rail
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
Installed extensions declare `nav: { placement, id, label, icon }` in `BUILTIN_EXTENSIONS`. Kusa CLI CAO Provider uses `placement: 'devtools'`, `label: 'CAO'`, lucide `icon: 'network'`. `resolveDevtoolsSubTabs()` merges those into the right-rail Dev Tools submenu; `DevToolsPanel` renders `CaoPanel` for that subtab. Lucide artwork lives in `LucideIcons.jsx` keyed by name. Selecting the extension in the catalog opens its nav placement (not a separate overlay).

## Tried and ruled out
Keeping CAO only as an Extensions overlay with no Dev Tools item; hardcoding `cao` back into `DEVTOOLS_SUBTAB_IDS` without a registry `nav` config.

## Watch out
Core Dev Tools ids stay `git` + `trail` in `format.js`; extension appends come from the registry. Add new lucide glyphs to `LucideIcons.jsx` before referencing them in `nav.icon`. Built-ins set `installed: true`; future workspace extensions flip that after install.
