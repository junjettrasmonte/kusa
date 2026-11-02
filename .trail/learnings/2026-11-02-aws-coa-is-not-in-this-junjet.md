---
title: AWS COA is not in this repo; Dev tools subtabs
author: Junjet
date: 2026-11-02
branch: main
touches:
  - src/app/console/dashboard.js
  - src/app/console/serve.mjs
  - src/app/console/ui/features/chat/ChatGlyphs.jsx
  - src/app/console/ui/features/chat/ChatHarness.jsx
  - src/app/console/ui/features/chat/ComposerControls.jsx
  - src/app/console/ui/features/monitor/SessionIndicator.jsx
  - src/app/console/ui/features/settings/SettingsPanel.jsx
  - src/app/console/ui/shared/AskIcon.jsx
  - src/features/agent/index.mjs
  - src/features/agent/openai-loop.mjs
---

## Decided
Dev Tools right-rail subitems are registered in three places: `DEVTOOLS_SUBTAB_IDS` / `DEVTOOLS_SUBTAB_LABELS` in `src/app/console/ui/shared/lib/format.js`, icons in `SUBTAB_ICONS` (`SubTabIcons.jsx`), and the panel switch in `DevToolsPanel.jsx` (today only `git` and `trail`). App persists the choice as `monitor.devtoolsSubTab`. Adding a new Dev Tools screen means those three spots plus a new feature panel, same shape as GitPanel/TrailPanel.

Outside this project, “AWS COA” usually means AWS Compute Optimizer Automation (aws-samples org-wide Step Functions + CloudFormation). It is not present in the Kusă codebase; there are no AWS/COA modules, routes, or UI panels here.

## Tried and ruled out
Treating `trail ask "AWS COA"` / `trail grep` hits for “coa” as product code — they only match agent Co-authored-by attribution helpers, not AWS. Do not start wiring a COA panel without the user picking scope (status/links vs live Compute Optimizer APIs vs managing a COA stack vs an external URL/tool).

## Watch out
If the user says “integrate AWS COA” while the workspace is `kusa`, confirm which of those four meanings they want before editing the rail. Org-wide COA deployment is far larger than a Dev Tools subtab; a thin status/link screen is the only shape that fits the existing git/trail pattern without new AWS credentials and APIs.
