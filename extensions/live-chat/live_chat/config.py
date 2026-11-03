"""Environment-driven Live Chat bot configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _env(name: str, default: str = "") -> str:
    return str(os.environ.get(name, default) or "").strip()


# Pipecat 1.x requires an explicit voice on local TTS services.
DEFAULT_PIPER_VOICE = "en_US-lessac-medium"
DEFAULT_KOKORO_VOICE = "af_heart"


@dataclass(frozen=True)
class LiveChatConfig:
    host: str = "127.0.0.1"
    port: int = 7860
    transport: str = "websocket"  # websocket | webrtc
    tts: str = "piper"  # piper | kokoro
    piper_voice: str = DEFAULT_PIPER_VOICE
    kokoro_voice: str = DEFAULT_KOKORO_VOICE
    strata_base_url: str = ""
    strata_api_key: str = ""
    strata_model: str = "gpt-4o-mini"
    whisper_model: str = "base"
    # Optional callback into kusa serve so transcripts land in chat-store.
    transcript_callback_url: str = ""
    # Spoken on client connect so TTS is audible before the first user turn.
    greeting: str = "Hey there, how can I help?"
    system_prompt: str = (
        "You are Kusă Live Chat. Reply briefly and clearly for spoken conversation. "
        "No markdown fences unless the user asks for code."
    )

    @classmethod
    def from_env(cls) -> "LiveChatConfig":
        transport = _env("TRANSPORT", "websocket").lower()
        if transport not in ("websocket", "webrtc"):
            transport = "websocket"
        tts = _env("TTS_ENGINE", "piper").lower()
        if tts not in ("piper", "kokoro"):
            tts = "piper"
        port_raw = _env("LIVE_CHAT_PORT", "7860")
        try:
            port = int(port_raw)
        except ValueError:
            port = 7860
        return cls(
            host=_env("LIVE_CHAT_HOST", "127.0.0.1") or "127.0.0.1",
            port=port,
            transport=transport,
            tts=tts,
            piper_voice=_env("PIPER_VOICE", DEFAULT_PIPER_VOICE) or DEFAULT_PIPER_VOICE,
            kokoro_voice=_env("KOKORO_VOICE", DEFAULT_KOKORO_VOICE) or DEFAULT_KOKORO_VOICE,
            strata_base_url=_env("STRATA_BASE_URL").rstrip("/"),
            strata_api_key=_env("STRATA_API_KEY"),
            strata_model=_env("STRATA_MODEL", "gpt-4o-mini") or "gpt-4o-mini",
            whisper_model=_env("WHISPER_MODEL", "base") or "base",
            transcript_callback_url=_env("LIVE_CHAT_TRANSCRIPT_URL"),
            greeting=_env("LIVE_CHAT_GREETING") or cls.greeting,
            system_prompt=_env("LIVE_CHAT_SYSTEM_PROMPT")
            or cls.system_prompt,
        )

    def public_status(self) -> dict:
        return {
            "ok": True,
            "serverUp": True,
            "transport": self.transport,
            "tts": self.tts,
            "model": self.strata_model,
            "strataConfigured": bool(self.strata_base_url),
            "whisperModel": self.whisper_model,
            "host": self.host,
            "port": self.port,
            "wsPath": "/ws",
            "rtcPath": "/rtc",
            "version": "0.1.0",
        }
