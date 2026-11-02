---
title: Sidebar top bar icons are 18×18
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
Left sidebar top-bar view glyphs (Agents, Explorer, Search, Extensions, plus more-views chevron and collapse) all render in an `h-[18px] w-[18px]` box. Lucide-sourced icons on a 24×24 grid use `strokeWidth={2}` at that size so ink stays ~1.5px (same as Extensions / ExtensionIcon). House-drawn 16×16 icons keep stroke 1.5. KusaLogo in that strip stays larger — brand mark, not a toolbar glyph.

## Tried and ruled out
Leaving Agents/Explorer/Search at `h-4 w-4` while Extensions alone was 18px — visible size mismatch in the view tab strip. Also not resizing the right-rail primary icons or the Agents filter/select row below the top bar; the ask was the sidebar top bar only.

## Watch out
When adding a new SIDEBAR_VIEW_IDS icon, default to `h-[18px] w-[18px]`. For lucide 24-grid art, stroke 2 at 18px (not 2.25, which was calibrated for 16px). RightRail.jsx icons are still `h-4 w-4` with lucide stroke 2.25 — do not assume they share the sidebar top-bar size.
