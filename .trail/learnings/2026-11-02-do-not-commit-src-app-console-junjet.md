---
title: Do not commit src/app/console/.kusa cache
author: Junjet
date: 2026-11-02
branch: main
touches:
  - src/app/console/.kusa/dashboard.css
  - src/app/console/.kusa/dashboard.html
  - src/app/console/.kusa/dashboard.js
  - src/app/console/.kusa/dashboard.md
  - src/app/console/.kusa/favicon.svg
  - src/app/console/.kusa/index.json
  - src/app/console/.kusa/monitor-data.js
  - package.json
---

## Decided
`src/app/console/.kusa/` is a local serve/build cache of dashboard assets (css/html/js/md), not source. Leave it untracked when committing console/CAO/auth work. Root `/.kusa/` is already gitignored; the console path is not covered by that rule.

## Tried and ruled out
Staging with `git add -A` without a reset — it would ship the cache. Also treating `trail check` lexical hits on `package.json` / `dashboard.css` (old COA ambiguity, icon-size learnings) as a hard block on the intentional CAO Dev Tools + kusa_cli provider commit; cite Junjet's Nov 2 “CAO panel is not the old COA ambiguity” note in the commit message instead.

## Watch out
Before `git add -A` on console changes, `git reset -- src/app/console/.kusa/` (or add that path to `.gitignore`). Patch bumps still come from the pre-commit hook.
