---
title: Sidebar session icons are 18×18 provider marks
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
Sidebar session-row indicators render in an `h-[18px] w-[18px]` box, tinted by session status (`ICON_COLOR`: busy emerald, thinking amber, idle sky, ended gray). Default shape is the provider `HarnessLogo` (kusa / cursor / github-copilot / vscode-local). Open ask → AskIcon, open approval → ApprovalIcon, idle (turn complete) → TurnDoneIcon — same priority as before. `SessionIndicator` takes `harness` from the sidebar group; `HarnessLogo` accepts optional `className` / `title` so status color and tooltips can ride on currentColor.

## Tried and ruled out
Keeping StatusDot for busy/thinking/ended — user asked for the provider mark instead, with status as color only. Leaving glyphs at `h-3 w-3` (12px) while the sidebar top bar / right rail are 18px.

## Watch out
Do not reintroduce StatusDot as the session-row fallback. Gate and idle overrides still outrank the provider mark. Pass `harness` whenever mounting `SessionIndicator` outside the harness map.
