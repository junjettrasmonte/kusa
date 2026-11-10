---
title: "Extension deps live in extensions/*/package.json via workspaces compose-merge"
author: Junjet
date: 2026-11-10
branch: main
touches:
  - extensions/cursor-adapter/stream-turn.mjs
  - package-lock.json
  - package.json
  - scripts/capture-screenshots.mjs
  - src/app/console/serve-live.mjs
  - src/app/console/serve.mjs
  - src/app/console/sw.js
  - src/app/console/ui/App.jsx
  - src/app/console/ui/features/chat/SessionChat.jsx
  - src/app/console/ui/features/chat/TranscriptTurns.jsx
---

## Decided
Each extension that needs npm deps owns `extensions/<name>/package.json`. Root declares `"workspaces": ["extensions/*"]` so `npm install` auto-discovers them (Compose include/merge style). `npm run deps:extensions` (`scripts/merge-extension-deps.mjs`) folds those deps into the root manifest under `x-kusa-extension-deps` so the published single-package tarball still resolves `#extensions/…` imports. First package: `@kusa/atlassian-adapter` with `jira.js` + SVAR view packages. Dropped unused root-only `@svar-ui/react-core` / `react-tasklist`.

## Tried and ruled out
Putting a root `#imports` re-export in the extension package.json with `../../src/…` targets — Node rejects `..` in import map targets (`ERR_INVALID_PACKAGE_TARGET`).

## Watch out
A package.json in an extension is a Node package boundary: repo-root `#features/*` maps do **not** apply to Node-loaded files under that extension. Use relative imports into `src/` there (see `extensions/atlassian-adapter/http.mjs`). Vite UI `#ui/*` still works via `vite.config.mjs` aliases. After editing an extension’s dependencies, run `npm run deps:extensions` then `npm install`. Other adapters still use `#` imports and must switch to relative paths the moment they gain a package.json.
