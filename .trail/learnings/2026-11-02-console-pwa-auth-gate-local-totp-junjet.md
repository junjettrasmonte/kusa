---
title: Console PWA auth gate (local TOTP + SSO)
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
- Console is a PWA (`manifest.webmanifest` + hand-written `sw.js` shell cache) installed from `kusa serve`; splash works offline and probes `GET /health`.
- Default auth is single local admin (username + scrypt password + TOTP) stored under `settings.auth` in `.kusa/settings.json`, with TOTP/OIDC secrets via `encryptSecret` (same master key as agent API keys).
- Settings → Auth can switch mode to OIDC or SAML; SSO trusts the IdP for MFA (no second TOTP).
- After auth is configured, console APIs require `kusa_session` cookie; MCP `/rpc` keeps its own bearer. Before setup, APIs stay open so hooks/tests work; AuthGate still blocks the browser UI.

## Tried and ruled out
- Hard-401 on all APIs before first setup — broke MCP/skills HTTP tests and local tooling; soft-open until configured is intentional.
- Relying solely on vite-plugin-pwa generateSW with the custom `dashboard.*` publish pipeline — injectManifest + hand-written SW is what actually ships.

## Watch out
- `publicSettings` merges auth flags from `#features/auth/shape.mjs` (no crypto) to avoid a secrets↔auth import cycle.
- Completing setup is a one-way gate for that workspace until settings.json auth is cleared.
