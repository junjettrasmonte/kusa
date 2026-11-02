---
title: Right rail icons are 18×18 lucide
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
All right-rail glyphs (Monitors, Chat Session, Harness, Dev Tools, Settings, and the theme moon/sun toggle) render as lucide icons in an `h-[18px] w-[18px]` box at strokeWidth 2 via `LucideIcon` in LucideIcons.jsx. Paths are verbatim from lucide; tab ids map to `chart-column`, `bot-message-square`, `orbit`, `tool-case`, `cog`, `moon`, `sun`.

## Tried and ruled out
Leaving rail icons at `h-4 w-4` with stroke 2.25 (the prior 16px calibration) or keeping hand-drawn monitors/theme SVGs on a 16×16 grid — mismatched the left sidebar top-bar 18×18 lucide set.

## Watch out
Do not reintroduce inline rail SVGs or stroke 2.25 for 18px lucide art. Add new rail icons to LucideIcons.jsx PATHS and reference them with `<LucideIcon name="…" />` (default size/stroke).
