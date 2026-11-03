# Live Chat (retired Pipecat bot)

**Voice now runs in the Kusă PWA** (browser Whisper / Kokoro / Silero). The
composer Live button no longer needs this Python bot, WebSocket, or WebRTC.

See [`src/app/console/ui/features/live-chat/VOICE.md`](../../src/app/console/ui/features/live-chat/VOICE.md)
for browser setup, model downloads, and limitations.

This `extensions/live-chat/` tree (Pipecat + Faster-Whisper + Piper/Kokoro) is
**retired**. Console routes `/live-chat/server/*`, `/live-chat/session`,
`/live-chat/rtc`, and `/live-chat/ws` return **410 Gone**. Preferences remain
under `GET|PUT /live-chat/settings` for browser providers.

You may delete this folder in a follow-up; it is kept temporarily for reference.
