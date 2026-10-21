# Agentic Development Console — SDK Session Listener

Progress checklist for integrating a GitHub Copilot SDK session listener into the existing monitor. Do not replace hooks, create a second agent session, or inspect private APIs.

## Inspect

- [x] Confirm dashboard state format (`index.json`, per-session JSON, events.jsonl, monitor-data.js).
- [x] Confirm Copilot hook config (`.github/hooks/copilot-runtime-monitor.json`) and `hook.mjs` / `lib.mjs`.
- [x] Identify session target: standard Copilot Chat vs Copilot CLI vs VS Code Local.
- [x] Record installed VS Code / Copilot SDK versions if present.
- [x] Read official SDK docs + typings for `joinSession()`, event subscriptions, lifecycle.
- [x] Decide go/no-go: can a supported public API observe the *current* active session?

## Go / no-go

**Decision (confirmed against `@github/copilot-sdk` 1.0.22 docs + typings and vscode-server 1.0.19-unstable):**

| Session target | Can `joinSession()` observe it? | Path |
| --- | --- | --- |
| **Copilot CLI** (foreground session) | **Yes** — extension child process with `SESSION_ID` | `.github/extensions/kusa-session-listener/` |
| VS Code Copilot Chat (Session Target = Copilot) | **No** public join API | Hooks only (`.github/hooks/…`) |
| VS Code Local | **No** | Hooks only |
| Cursor | **No** | Hooks only (`.cursor/hooks.json`) |

- [x] If yes (CLI) → implement live listener against `joinSession()`.
- [x] If no (Chat / Local / Cursor) → implement listener interface + document missing integration point; hooks-only fallback remains primary.
- [x] Do **not** create a second agent session or call private internals as a workaround.

## Implement

- [x] Session listener module (start/stop, reconnect, disconnect state).
- [x] Subscribe only to event types confirmed in installed SDK typings/docs.
- [x] Normalize SDK events into shared monitor event format.
- [x] Feed into existing state store; dashboard counters / timeline / connection status.
- [x] Deduplicate hook vs SDK tool events when reliable IDs exist.
- [x] Reasoning: status/duration only by default; setting to disable; never fabricate.
- [x] Settings for reasoning collection and listener enablement.
- [x] Bounded history, validation, error logging, concurrent handling.
- [x] Visible indicator when listener cannot attach; graceful hooks-only fallback.

## Verify

- [x] Unit tests with simulated SDK events (turns, tools, failures, concurrency, usage, reasoning, missing ids, duplicates, disconnect, unsupported targets).
- [x] Real integration probe: extension dry-run without `SESSION_ID` → `disconnected` / `no-session-id` (no invented session). Live Copilot CLI attach not available in this environment (no `copilot` binary on PATH).
- [x] README setup + verification + capability matrix (confirmed vs unavailable / runtime-dependent).
- [x] Final report: session target tested, events observed, reasoning availability, limitations.
