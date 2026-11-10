---
title: "Extension deps stay only in extensions/*/package.json"
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
Extension npm deps are **not** mirrored into root `package.json`. Source of truth is only `extensions/<name>/package.json`; root `"workspaces": ["extensions/*"]` is the discovery mechanism. `deps:extensions:check` fails if root still lists an extension-owned dep or has obsolete `x-kusa-extension-deps`.

## Tried and ruled out
Compose-merging extension deps into root (and tracking them with `x-kusa-extension-deps`) so the published single-package tarball listed them — user wants deps to stay exclusively in extension directories.

## Watch out
`npm install kusa` from the registry will not install workspace-only deps unless those packages are also root dependencies. Local/git installs via workspaces are fine. Keep using relative imports for Node-loaded files inside an extension that has its own package.json.
