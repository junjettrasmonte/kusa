---
title: Account avatar replaces bottom settings cog
author: Junjet
date: 2026-11-02
branch: main
touches:
  - package-lock.json
  - package.json
  - src/app/console/dashboard.css
  - src/app/console/dashboard.html
  - src/app/console/dashboard.js
  - src/app/console/serve.mjs
  - src/app/console/ui/App.jsx
  - src/app/console/ui/features/chat/ChatGlyphs.jsx
  - src/app/console/ui/features/chat/ChatHarness.jsx
  - src/app/console/ui/features/chat/ComposerControls.jsx
---

## Decided
- Right-rail bottom icon (under dark-mode toggle) is the user avatar (initials), not the settings cog. Clicking it opens the Account (`user`) tab.
- Login/auth management (`AuthSettingsPanel`) lives on that Account page, below an Appearance / dark-mode section.
- Console Settings (agent, playback, workspace, sdk) stays as a primary rail tab with the cog; `auth` was removed from `SETTINGS_SUBTAB_IDS`.

## Tried and ruled out
- Dropping Settings from the rail entirely when adding Account — would orphan agent/SDK settings.

## Watch out
- Stale `monitor.settingsSubTab=auth` / `monitor.tab=auth` migrates to the Account tab / agent subtab.
