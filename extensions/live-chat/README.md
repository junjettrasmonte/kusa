# Live Chat

Kusă console extension for voice live chat via [Pipecat](https://github.com/pipecat-ai/pipecat):

Silero VAD → Faster Whisper STT → Strata (OpenAI-compatible LLM) → Piper or Kokoro TTS.

Catalog id: `live-chat` · Folder: `extensions/live-chat/` · Dev Tools nav label: **Live Chat**

## Prerequisites

- Python 3.11+ and [uv](https://docs.astral.sh/uv/) (recommended) or pip
- A Strata / OpenAI-compatible base URL (`…/v1`) with a model id
- Local models for Whisper / Piper or Kokoro (downloaded on first run)

## Install & start

From this directory:

```bash
uv sync
# or: pip install -e .

export STRATA_BASE_URL="https://your-strata.example/v1"
export STRATA_API_KEY="…"          # optional if the endpoint needs it
export STRATA_MODEL="gpt-4o-mini"
export TTS_ENGINE="piper"          # or kokoro
export PIPER_VOICE="en_US-lessac-medium"   # required by Pipecat local TTS
export KOKORO_VOICE="af_heart"             # used when TTS_ENGINE=kokoro
export TRANSPORT="websocket"       # or webrtc
export LIVE_CHAT_HOST="127.0.0.1"
export LIVE_CHAT_PORT="7860"
# Optional: POST transcripts into the open console session
export LIVE_CHAT_TRANSCRIPT_URL="http://127.0.0.1:1424/live-chat/transcript"

uv run python -m live_chat
```

Health check:

```bash
curl http://127.0.0.1:7860/health
```

Point Kusă at the bot if you change the port:

```bash
export LIVE_CHAT_BASE_URL="http://127.0.0.1:7860"
kusa serve
```

## Console

**Extensions → Live Chat** opens its info & config page (also Dev Tools › Live Chat).

When the extension is installed (`uv sync` / `.venv` present) but the bot is down, the panel offers a **Start Live Chat bot** button — `kusa serve` spawns `python -m live_chat` detached and polls `/health`.

With the bot up, the empty-composer **Live voice** button in a chat session connects through `kusa serve` (`/live-chat/ws` or `/live-chat/rtc/*`) and writes transcripts into that session.

Changing `TTS_ENGINE` or `TRANSPORT` on the bot requires a restart. Console preferences in Dev Tools › Live Chat are sent when minting a voice session and should match the running bot.
