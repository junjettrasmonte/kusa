---
title: CAO panel is not the old COA ambiguity
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
The Dev Tools CAO tab and `kusa_cli` provider are intentional: the user asked for AWS CLI Agent Orchestrator integration and then for Kusă as a local CAO provider. `dashboard.css` / console changes for that panel are expected.

## Tried and ruled out
Treating `trail check` hits that quote the older “do not start wiring a COA panel without scope” learning as a block on CAO UI — that learning was about the Compute-Optimizer vs orchestrator naming ambiguity before the user confirmed CAO = awslabs CLI Agent Orchestrator.

## Watch out
Lexical trail check may still flag `dashboard.css` against the Nov 2 COA ambiguity learning; cite this note (or the CAO/orchestrator learnings) in the commit/PR if it fires again.
