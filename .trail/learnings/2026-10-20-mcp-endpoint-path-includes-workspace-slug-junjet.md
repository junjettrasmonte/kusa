---
title: MCP endpoint path includes workspace slug
author: Junjet
date: 2026-10-20
branch: main
touches:
  - README.md
  - docs/logo.svg
  - package.json
  - src/cli/kusa.mjs
  - src/dashboard.css
  - src/dashboard.js
  - src/lib.mjs
  - src/serve.mjs
  - src/ui/App.jsx
  - src/ui/components/GraftPanel.jsx
---

HTTP MCP URL is http://127.0.0.1:<port>/mcp/<folder-hashslug>/rpc. Slug = sanitized basename + 8-char sha256 of absolute path. Cursor key is kusa-<slug>. Wrong slug or legacy /mcp/rpc returns 404 with expected path.
