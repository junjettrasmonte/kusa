---
title: Localhost MCP HTTP endpoint with bearer auth
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

When Harness → MCP is on, kusa serve exposes Streamable HTTP at http://127.0.0.1:<port>/mcp/rpc (127.0.0.1 only). Console status stays at GET/POST /mcp.

Auth: bearer token in .kusa/mcp.json; required when set. Enabling with empty token auto-generates one and writes Authorization into .cursor/mcp.json. Clear token for unauthenticated localhost.

stdio `kusa mcp` remains for hosts that cannot use URL transport.
