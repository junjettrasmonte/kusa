---
title: AuthGate is UI-only; do not 401 monitor APIs
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
- Console login is enforced by the browser AuthGate only. `enforceAuthGate` must not 401 localhost APIs after auth is configured.
- Cursor/Copilot hooks write `.kusa` session files on disk; the dashboard live stream is `GET /monitor-data.js` (script poll). Session-cookie gating that path freezes Cursor/Copilot streams in the console.
- Incomplete OIDC/SAML config falls back to local login when a local admin is enrolled (`effectiveAuthMode`), so switching mode mid-setup cannot lock the UI behind a broken SSO redirect.

## Tried and ruled out
- Requiring `kusa_session` for all non-public HTTP routes once auth is configured — broke live monitor polling and looked like “Cursor/Copilot streams died.”

## Watch out
- MCP still has its own bearer on `/mcp/.../rpc`. Do not reintroduce a blanket API session gate without allowlisting `/monitor-data.js`, `/sessions/`, and other hook-fed read paths.
