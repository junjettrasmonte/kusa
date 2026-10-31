---
title: Org registration is not in this repo
author: Junjet
date: 2026-10-27
branch: main
touches:
  - README.md
  - package-lock.json
  - src/cli/kusa.mjs
---

## Decided
Kusă (this repo) has no organization registration form, approval email, or signup success page. Requests about "new organization registers / awaiting approval / activate account" belong in a different product codebase; do not implement them here.

## Tried and ruled out
- `trail ask "organization registration…"` only hit agent approval / MCP registration / form helpers — false friends.
- `trail grep "organiz"`: no hits across the indexed graph.
- `trail grep "registration"`: only Cursor MCP registration (`syncCursorMcpRegistration`), not tenant/org signup.

## Watch out
If the user asks for org signup email + success redirect while the workspace is `kusa`, stop and confirm the correct project path instead of forcing a feature into the agent console.
