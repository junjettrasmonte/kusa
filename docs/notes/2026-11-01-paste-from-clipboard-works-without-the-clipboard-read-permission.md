---
name: 2026-11-01-paste-from-clipboard-works-without-the-clipboard-read-permission
description: Paste From Clipboard reads navigator.clipboard first, then falls back to a paste-event window — the only way Firefox and Safari can see a clipboard image at all
category: general
---

# Paste From Clipboard works without the clipboard-read permission

`ui/shared/lib/attachments.js` now reads the clipboard in two steps, and the second one is the reason the feature exists on non-Chrome browsers at all:

1. `readClipboardAttachment()` → `navigator.clipboard.read()` (Chrome/Edge; needs the `clipboard-read` permission prompt).
2. When that is missing or denied, `readClipboardViaPaste()` arms a `document`-level `paste` listener for `PASTE_READ_WINDOW_MS` (45s) and takes `event.clipboardData` off the user's next real paste gesture — **no permission prompt, works in Firefox and Safari**, which have no `navigator.clipboard.read`.

## Why it has to be a window, not a call

There is no API that synthesizes a paste gesture: `clipboardData` is only handed over while the user is actually pasting. So the composer note (`PASTE_REQUEST_NOTE` in ChatHarness) tells the user to press Ctrl+V while the window is open, and the window is cleared by a timeout that always removes the listener.

## Decisions that carry the cost

- **A captured paste is consumed, not inserted.** `event.preventDefault()` in the handler: taking the clipboard as an attachment and as typed text would put the same words on the message twice.
- **Text-only paste is attached, not typed** — the transcript and the chips then agree on one representation.
- **`document.addEventListener`, not `new EventHandler().onpaste`.** `EventHandler` is not a real DOM API (it is not in the spec, and the dashboard build does not polyfill it).
- **`dataTransferToAttachment()` is the single record builder** for both paths; the clipboard image path now builds a `DataTransfer` from the `ClipboardItem` and shares it, so the two paths cannot drift apart.
- **`clipboard.readText()` stays as a last fallback** inside the first step, for a clipboard whose image is not exposed as an item.

## Related files

- `src/app/console/ui/shared/lib/attachments.js` — `readClipboardViaPaste`, `dataTransferToAttachment`, `PASTE_READ_WINDOW_MS`
- `src/app/console/ui/features/chat/ChatHarness.jsx` — the clipboard branch of `attachRequested`, `PASTE_REQUEST_NOTE`
- `src/app/console/ui/features/chat/ComposerControls.jsx` — the `Paste From Clipboard` hint now names the Ctrl+V fallback

## Gotchas

- `test/attachments.test.mjs` covers the record builder (`dataTransferToAttachment`), not the live paste event — the browser gesture cannot be driven from node.
- The paste listener is document-wide on purpose: a paste into the textarea bubbles to `document`, and listening on the textarea alone would miss a paste made anywhere else on the page.
