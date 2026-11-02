---
title: Multi OpenAI-compatible endpoints with grouped Model picker
author: Junjet
date: 2026-11-02
branch: main
touches:
  - package.json
  - src/app/console/dashboard.css
  - src/app/console/dashboard.js
  - src/app/console/serve.mjs
  - src/app/console/ui/App.jsx
  - src/app/console/ui/features/chat/ChatGlyphs.jsx
  - src/app/console/ui/features/chat/ChatHarness.jsx
  - src/app/console/ui/features/chat/ComposerControls.jsx
  - src/app/console/ui/features/monitor/SessionIndicator.jsx
  - src/app/console/ui/features/monitor/Sidebar.jsx
---

## Decided
Settings → Kusă agent supports multiple OpenAI-compatible endpoints via `agentEndpoints[]` (extras) plus the Default endpoint still owned by top-level `agentBaseUrl` / `agentAuthMode` / `agentApiKey` / `agentModels`. UI is `AgentEndpointsPanel`: lucide plus opens an add form; each endpoint is a collapsible card; models are comma-delimited. Keys are encrypted per endpoint (`apiKeyEnc`) and carried across whole-list rewrites by id. `listAgentModelGroups` / GET `/kusa/models` returns one group per active endpoint (has base URL), merging declared + probed models; ChatHarness Model dropdown draws those group headings and reloads when `agentDefaults.modelsRevision` changes. `resolveAgentEndpoint` routes a pick to the endpoint that declared that model id.

## Tried and ruled out
Always-visible add form at the top of Endpoints — noisy; plus-in-header matches MCP/Skills/CAO create pattern. Declared-only listing for extras (skip probe when any model is typed) — hid models the active provider still advertises. Treating CAO CLI "providers" as Model picker sources — those are Dev Tools orchestration, not chat endpoint credentials.

## Watch out
An id declared on an extra endpoint owns that id for routing even if Default also probes it. Empty `agentEndpoints` entry (no base URL) is dropped on normalize. Cap is 12 extras (`MAX_AGENT_ENDPOINTS`). Collapsible extra cards use controlled `expandedIds` — keep open/close in sync with `<details onToggle>`.
