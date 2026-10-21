---
title: Kusă MCP server and console tab
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

Kusă ships its own stdio MCP server (`kusa mcp`), not only Trail's.

Console: MCP tab toggles registration in `.cursor/mcp.json`, enables/disables advertised tools (`.kusa/mcp.json`), embeds Skills management, and lists/adds Trail learnings under `.trail/learnings/`.

HTTP: GET/POST `/mcp`, GET/POST `/learnings`. Tools: kusa_list_skills, kusa_get_skill, kusa_list_learnings, kusa_add_learning, kusa_get_session.

When adding learnings programmatically, only call `trail note` if the workspace has its own `.git`; otherwise Trail walks up to a parent repo. Fall back to writing compatible markdown in `.trail/learnings/`.

After toggling MCP on, start a new Cursor chat so the host reloads mcp.json.
