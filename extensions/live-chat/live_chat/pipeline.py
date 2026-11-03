"""Build the Pipecat 1.15+ voice pipeline (Silero → Whisper → Kusă LLM → TTS).

Turn-taking uses the in-pipeline LLM aggregator (what made voice reliable).
Spoken replies for agent work come from the browser as ``{type:speak}`` frames
(Kusă streams partial + final text). LLM text itself is marked ``skip_tts`` so
we do not double-speak the turn-taking flash and Kusă agent replies.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Optional

from .config import LiveChatConfig

log = logging.getLogger("live_chat.pipeline")

SAMPLE_RATE = 16000


def _vad_analyzer():
    """Silero VAD for turn segmentation (Whisper only runs after speech ends).

    Use permissive thresholds — browser mic PCM often arrives quiet even with
    AGC, and SegmentedSTT never runs without VAD start/stop frames.
    """
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.audio.vad.vad_analyzer import VADParams

    return SileroVADAnalyzer(
        params=VADParams(
            confidence=0.4,
            start_secs=0.15,
            stop_secs=0.25,
            min_volume=0.05,
        )
    )


def _user_mute_strategies():
    """Mute user frames while the bot is speaking (and until the greeting finishes).

    Without this, speaker→mic echo fires VAD interruptions that cancel TTS, so
    the browser only receives the last audio chunk ("last word of the sentence").
    """
    from pipecat.turns.user_mute import (
        AlwaysUserMuteStrategy,
        MuteUntilFirstBotCompleteUserMuteStrategy,
    )

    return [
        MuteUntilFirstBotCompleteUserMuteStrategy(),
        AlwaysUserMuteStrategy(),
    ]


async def emit_transcript(
    callback_url: str,
    *,
    role: str,
    text: str,
    session_id: str = "",
    queue_key: str = "",
) -> None:
    if not callback_url or not text.strip():
        return
    try:
        import httpx
    except ImportError:
        log.warning("httpx missing; cannot POST transcript")
        return
    payload = {
        "role": role,
        "text": text.strip(),
        "sessionId": session_id or None,
        "queueKey": queue_key or None,
        "source": "live-chat",
    }
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            res = await client.post(callback_url, json=payload)
        if res.status_code >= 400:
            log.warning(
                "transcript callback HTTP %s sessionId=%s queueKey=%s body=%s",
                res.status_code,
                session_id or "-",
                queue_key or "-",
                (res.text or "")[:200],
            )
        else:
            log.info(
                "transcript posted role=%s chars=%d sessionId=%s",
                role,
                len(text.strip()),
                session_id or "-",
            )
    except Exception as err:  # noqa: BLE001
        log.warning("transcript callback failed: %s", err)


def _make_pcm_serializer(sample_rate: int = SAMPLE_RATE):
    """Browser ↔ bot: raw PCM16 LE mono + JSON control/transcript messages.

    Text frames from the browser may carry ``{ "type": "speak", "text": "…" }``
    which becomes a ``TTSSpeakFrame`` so Kusă agent replies can be spoken without
    an in-pipeline LLM.
    """
    import json

    from pipecat.frames.frames import (
        InputAudioRawFrame,
        OutputAudioRawFrame,
        OutputTransportMessageFrame,
        OutputTransportMessageUrgentFrame,
        TTSAudioRawFrame,
        TTSSpeakFrame,
    )
    from pipecat.serializers.base_serializer import FrameSerializer

    class RawPcmSerializer(FrameSerializer):
        def __init__(self):
            super().__init__()
            self._sample_rate = sample_rate
            self._in_chunks = 0
            self._in_bytes = 0

        def should_ignore_frame(self, frame) -> bool:  # noqa: ANN001
            return False

        async def serialize(self, frame) -> bytes | str | None:  # noqa: ANN001
            if isinstance(frame, (OutputAudioRawFrame, TTSAudioRawFrame)):
                audio = getattr(frame, "audio", None)
                return audio if isinstance(audio, (bytes, bytearray)) else None
            if isinstance(frame, (OutputTransportMessageFrame, OutputTransportMessageUrgentFrame)):
                msg = getattr(frame, "message", None)
                if isinstance(msg, str):
                    return msg
                if msg is not None:
                    return json.dumps(msg)
            return None

        async def deserialize(self, data: str | bytes):
            if isinstance(data, str):
                try:
                    msg = json.loads(data)
                except json.JSONDecodeError:
                    return None
                if not isinstance(msg, dict):
                    return None
                if msg.get("type") == "speak":
                    text = str(msg.get("text") or "").strip()
                    if not text:
                        return None
                    # Agent-owned reply — do not append to a local LLM context.
                    return TTSSpeakFrame(text=text, append_to_context=False)
                return None
            if not isinstance(data, (bytes, bytearray)) or not data:
                return None
            raw = bytes(data)
            self._in_chunks += 1
            self._in_bytes += len(raw)
            # ~50 chunks/sec at 4096 samples; log ~every 2s so we can see mic audio.
            if self._in_chunks == 1 or self._in_chunks % 100 == 0:
                peak = 0
                for i in range(0, min(len(raw), 3200), 2):
                    sample = int.from_bytes(raw[i : i + 2], "little", signed=True)
                    peak = max(peak, abs(sample))
                log.info(
                    "mic pcm in: chunks=%d bytes=%d peak=%d",
                    self._in_chunks,
                    self._in_bytes,
                    peak,
                )
            return InputAudioRawFrame(
                audio=raw,
                sample_rate=self._sample_rate,
                num_channels=1,
            )

    return RawPcmSerializer()


def _build_tts(
    cfg: LiveChatConfig,
    *,
    tts: str | None = None,
    api_key: str | None = None,
    base_url: str | None = None,
):
    engine = (tts or cfg.tts or "piper").lower()
    if engine not in ("piper", "kokoro"):
        engine = "piper"
    piper_voice = getattr(cfg, "piper_voice", None) or "en_US-lessac-medium"
    kokoro_voice = getattr(cfg, "kokoro_voice", None) or "af_heart"
    try:
        tts_speed = float(getattr(cfg, "tts_speed", 1.0) or 1.0)
    except (TypeError, ValueError):
        tts_speed = 1.0
    tts_speed = max(0.5, min(2.0, tts_speed))
    log.info("Building TTS engine=%s voice=%s speed=%.2f", engine,
             kokoro_voice if engine == "kokoro" else piper_voice, tts_speed)
    if engine == "kokoro":
        try:
            from pipecat.services.kokoro.tts import KokoroTTSService

            # Pipecat ≥0.0.105 requires an explicit voice (no silent default).
            # Pass voice_id as well — some builds only honor the init arg.
            return KokoroTTSService(
                voice_id=kokoro_voice,
                settings=KokoroTTSService.Settings(voice=kokoro_voice, speed=tts_speed),
            )
        except Exception as err:  # noqa: BLE001
            log.warning("Kokoro TTS unavailable (%s); trying Piper", err)
    try:
        from pipecat.services.piper.tts import PiperTTSService

        return PiperTTSService(
            voice_id=piper_voice,
            settings=PiperTTSService.Settings(voice=piper_voice),
        )
    except Exception as err:  # noqa: BLE001
        log.warning("Piper TTS unavailable (%s); trying OpenAI TTS", err)
    try:
        from pipecat.services.openai.tts import OpenAITTSService

        return OpenAITTSService(
            api_key=(api_key or cfg.llm_api_key or "").strip() or "no-key",
            base_url=base_url or cfg.llm_base_url or None,
            voice="alloy",
            sample_rate=SAMPLE_RATE,
        )
    except Exception as err:  # noqa: BLE001
        log.warning("OpenAI TTS unavailable (%s); using null TTS", err)

    from pipecat.frames.frames import Frame
    from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

    class _NullTTS(FrameProcessor):
        async def process_frame(self, frame: Frame, direction: FrameDirection):
            await super().process_frame(frame, direction)
            await self.push_frame(frame, direction)

    return _NullTTS()


def _build_stt(cfg: LiveChatConfig):
    from pipecat.services.whisper.stt import WhisperSTTService

    try:
        return WhisperSTTService(model=cfg.whisper_model)
    except TypeError:
        return WhisperSTTService(model_size=cfg.whisper_model)  # type: ignore[call-arg]


def _build_llm(
    cfg: LiveChatConfig,
    *,
    model: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
):
    from pipecat.services.openai.llm import OpenAILLMService

    # OpenAI SDK rejects empty string; treat blank as missing (LM Studio often needs any sentinel).
    key = (api_key if api_key not in (None, "") else None) or (cfg.llm_api_key or "") or "no-key"
    return OpenAILLMService(
        api_key=key,
        base_url=base_url or cfg.llm_base_url or None,
        model=model or cfg.llm_model,
    )


def _make_client_bridge_processors(*, on_event: Optional[Callable[[dict], Any]] = None):
    """Processors shared by WebSocket and WebRTC: speak → TTS, STT → browser, skip LLM TTS."""
    from pipecat.frames.frames import (
        InterimTranscriptionFrame,
        InputTransportMessageFrame,
        LLMFullResponseEndFrame,
        LLMTextFrame,
        OutputTransportMessageUrgentFrame,
        TextFrame,
        TranscriptionFrame,
        TTSSpeakFrame,
        TTSStartedFrame,
        TTSStoppedFrame,
    )
    from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

    class SpeakRouter(FrameProcessor):
        """Route speak frames straight to TTS — never through STT/LLM (those drop them).

        WebSocket deserializes ``{type:speak}`` to ``TTSSpeakFrame``.
        WebRTC delivers the same JSON as ``InputTransportMessageFrame`` on the data channel.
        """

        def __init__(self):
            super().__init__()
            self._tts: FrameProcessor | None = None

        def bind_tts(self, tts: FrameProcessor) -> None:
            self._tts = tts

        async def process_frame(self, frame, direction: FrameDirection):  # noqa: ANN001
            await super().process_frame(frame, direction)
            if direction != FrameDirection.DOWNSTREAM:
                await self.push_frame(frame, direction)
                return

            speak_text: str | None = None
            append_ctx = False
            if isinstance(frame, TTSSpeakFrame):
                speak_text = getattr(frame, "text", "") or ""
                append_ctx = bool(getattr(frame, "append_to_context", False))
                speak_frame = frame
            elif isinstance(frame, InputTransportMessageFrame):
                msg = frame.message if isinstance(frame.message, dict) else {}
                if msg.get("type") == "speak":
                    speak_text = str(msg.get("text") or "").strip()
                    speak_frame = TTSSpeakFrame(text=speak_text, append_to_context=False) if speak_text else None
                else:
                    # Control/signalling leftovers — do not feed STT/LLM.
                    return
            else:
                await self.push_frame(frame, direction)
                return

            if not speak_text or self._tts is None:
                return
            log.info("SpeakRouter → TTS direct: %r", speak_text[:120])
            await self._tts.queue_frame(speak_frame, FrameDirection.DOWNSTREAM)
            # Greeting still needs a browser transcript row (never hits TranscriptTap).
            if append_ctx:
                await self._tts.queue_frame(
                    OutputTransportMessageUrgentFrame(
                        message={"type": "transcript", "role": "assistant", "text": speak_text},
                    ),
                    FrameDirection.DOWNSTREAM,
                )

    class TranscriptTap(FrameProcessor):
        """STT → browser (Kusă onSend). Greeting → browser. Skip LLM assistant rows."""

        def __init__(self):
            super().__init__()
            self._task = None

        def bind_task(self, task) -> None:  # noqa: ANN001
            self._task = task

        async def _push_browser_transcript(self, role: str, text: str) -> None:
            evt = {
                "type": "user_transcript" if role == "user" else "assistant_transcript",
                "text": text,
            }
            if on_event:
                maybe = on_event(evt)
                if hasattr(maybe, "__await__"):
                    await maybe
            await self.push_frame(
                OutputTransportMessageUrgentFrame(
                    message={"type": "transcript", "role": role, "text": text},
                ),
                FrameDirection.DOWNSTREAM,
            )

        async def process_frame(self, frame, direction: FrameDirection):  # noqa: ANN001
            await super().process_frame(frame, direction)
            text = getattr(frame, "text", None)
            if (
                isinstance(frame, TranscriptionFrame)
                and not isinstance(frame, InterimTranscriptionFrame)
                and text
            ):
                log.info("STT user transcript: %r", text[:120])
                await self._push_browser_transcript("user", text)
            elif isinstance(frame, TTSSpeakFrame) and text:
                if getattr(frame, "append_to_context", False):
                    log.info("TTS greeting transcript: %r", text[:120])
                    await self._push_browser_transcript("assistant", text)
                else:
                    log.info("TTS speak (Kusă reply): %r", text[:120])
            await self.push_frame(frame, direction)

    class SkipLlmTts(FrameProcessor):
        """Mark in-pipeline LLM text as skip_tts — Kusă speak frames still play."""

        async def process_frame(self, frame, direction: FrameDirection):  # noqa: ANN001
            await super().process_frame(frame, direction)
            if isinstance(frame, TTSSpeakFrame):
                await self.push_frame(frame, direction)
                return
            if isinstance(frame, LLMTextFrame):
                try:
                    frame.skip_tts = True  # type: ignore[attr-defined]
                except Exception:  # noqa: BLE001
                    pass
                await self.push_frame(frame, direction)
                return
            if isinstance(frame, TextFrame) and not isinstance(
                frame, (TranscriptionFrame, InterimTranscriptionFrame)
            ):
                try:
                    frame.skip_tts = True
                except Exception:  # noqa: BLE001
                    pass
            if isinstance(frame, LLMFullResponseEndFrame):
                try:
                    frame.skip_tts = True  # type: ignore[attr-defined]
                except Exception:  # noqa: BLE001
                    pass
            await self.push_frame(frame, direction)

    class TtsPhaseSignal(FrameProcessor):
        """Tell the browser when TTS starts/stops (needed for WebRTC phase + mic mute)."""

        async def process_frame(self, frame, direction: FrameDirection):  # noqa: ANN001
            await super().process_frame(frame, direction)
            if direction == FrameDirection.DOWNSTREAM:
                if isinstance(frame, TTSStartedFrame):
                    await self.push_frame(
                        OutputTransportMessageUrgentFrame(
                            message={"type": "bot-started-speaking"},
                        ),
                        direction,
                    )
                elif isinstance(frame, TTSStoppedFrame):
                    await self.push_frame(
                        OutputTransportMessageUrgentFrame(
                            message={"type": "bot-stopped-speaking"},
                        ),
                        direction,
                    )
            await self.push_frame(frame, direction)

    speak_router = SpeakRouter()
    tap = TranscriptTap()
    skip_llm_tts = SkipLlmTts()
    phase_signal = TtsPhaseSignal()
    return speak_router, tap, skip_llm_tts, phase_signal


async def run_websocket_bot(
    websocket: Any,
    cfg: LiveChatConfig,
    *,
    session_id: str = "",
    queue_key: str = "",
    model: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    system_prompt: str | None = None,
    tts: str | None = None,
    history_messages: list[dict[str, str]] | None = None,  # noqa: ARG001
    on_event: Optional[Callable[[dict], Any]] = None,
) -> None:
    """Whisper → Kusă LLM (turn-taking) → TTS.

    User STT is forwarded to the browser (→ POST /kusa/chat). Spoken agent
    replies are ``TTSSpeakFrame`` from the browser (Kusă partial + final text).
    In-pipeline LLM text is ``skip_tts`` so only greeting + Kusă speak aloud.
    """
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.frames.frames import EndFrame, LLMMessagesUpdateFrame, TTSSpeakFrame
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.task import PipelineParams, PipelineTask
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import (
        LLMContextAggregatorPair,
        LLMUserAggregatorParams,
    )
    from pipecat.transports.websocket.fastapi import (
        FastAPIWebsocketParams,
        FastAPIWebsocketTransport,
    )

    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=SAMPLE_RATE,
            audio_out_sample_rate=SAMPLE_RATE,
            vad_analyzer=_vad_analyzer(),
            serializer=_make_pcm_serializer(SAMPLE_RATE),
        ),
    )

    stt = _build_stt(cfg)
    llm = _build_llm(cfg, model=model, base_url=base_url, api_key=api_key)
    tts_svc = _build_tts(cfg, tts=tts, api_key=api_key, base_url=base_url)
    messages = [
        {
            "role": "system",
            "content": system_prompt or cfg.system_prompt,
        }
    ]
    context = LLMContext(messages)
    context_agg = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )
    speak_router, tap, skip_llm_tts, phase_signal = _make_client_bridge_processors(on_event=on_event)
    speak_router.bind_tts(tts_svc)

    # SpeakRouter sits first so browser/Kusă TTSSpeakFrame never enters STT/LLM.
    pipeline = Pipeline(
        [
            transport.input(),
            speak_router,
            stt,
            tap,
            context_agg.user(),
            llm,
            skip_llm_tts,
            tts_svc,
            phase_signal,
            transport.output(),
            context_agg.assistant(),
        ]
    )

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=False,
        ),
    )
    tap.bind_task(task)

    @transport.event_handler("on_client_connected")
    async def _on_connected(_transport, _client):  # noqa: ANN001
        greeting = (cfg.greeting or "").strip()
        frames: list[Any] = [LLMMessagesUpdateFrame(messages=messages)]
        if greeting:
            log.info("Client connected; speaking greeting: %r", greeting[:80])
            frames.append(TTSSpeakFrame(text=greeting, append_to_context=True))
        else:
            log.info("Client connected; greeting disabled")
        await task.queue_frames(frames)

    @transport.event_handler("on_client_disconnected")
    async def _on_disconnected(_transport, _client):  # noqa: ANN001
        await task.queue_frame(EndFrame())

    runner = PipelineRunner(handle_sigint=False)
    await runner.run(task)


async def run_webrtc_bot(
    webrtc_connection: Any,
    cfg: LiveChatConfig,
    **session_kwargs: Any,
) -> None:
    """Same client-bridged pipeline over SmallWebRTC (audio track + data channel).

    Browser ``createDataChannel`` carries ``{type:speak}`` and transcript/phase
    JSON; mic/TTS audio use the WebRTC media tracks.
    """
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.frames.frames import EndFrame, LLMMessagesUpdateFrame, TTSSpeakFrame
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.task import PipelineParams, PipelineTask
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import (
        LLMContextAggregatorPair,
        LLMUserAggregatorParams,
    )
    from pipecat.transports.base_transport import TransportParams
    from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

    session_id = str(session_kwargs.get("session_id") or "")
    queue_key = str(session_kwargs.get("queue_key") or "")
    model = session_kwargs.get("model")
    base_url = session_kwargs.get("base_url")
    api_key = session_kwargs.get("api_key")
    system_prompt = session_kwargs.get("system_prompt")
    tts = session_kwargs.get("tts")
    on_event = session_kwargs.get("on_event")

    transport = SmallWebRTCTransport(
        webrtc_connection=webrtc_connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=SAMPLE_RATE,
            audio_out_sample_rate=SAMPLE_RATE,
            vad_analyzer=_vad_analyzer(),
        ),
    )

    stt = _build_stt(cfg)
    llm = _build_llm(cfg, model=model, base_url=base_url, api_key=api_key)
    tts_svc = _build_tts(cfg, tts=tts, api_key=api_key, base_url=base_url)
    messages = [
        {
            "role": "system",
            "content": system_prompt or cfg.system_prompt,
        }
    ]
    context = LLMContext(messages)
    context_agg = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )
    speak_router, tap, skip_llm_tts, phase_signal = _make_client_bridge_processors(on_event=on_event)
    speak_router.bind_tts(tts_svc)

    pipeline = Pipeline(
        [
            transport.input(),
            speak_router,
            stt,
            tap,
            context_agg.user(),
            llm,
            skip_llm_tts,
            tts_svc,
            phase_signal,
            transport.output(),
            context_agg.assistant(),
        ]
    )
    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=False,
        ),
    )
    tap.bind_task(task)

    @transport.event_handler("on_client_connected")
    async def _on_connected(_transport, _client):  # noqa: ANN001
        greeting = (cfg.greeting or "").strip()
        frames: list[Any] = [LLMMessagesUpdateFrame(messages=messages)]
        if greeting:
            log.info(
                "WebRTC client connected; speaking greeting: %r (sessionId=%s queueKey=%s)",
                greeting[:80],
                session_id or "-",
                queue_key or "-",
            )
            frames.append(TTSSpeakFrame(text=greeting, append_to_context=True))
        else:
            log.info("WebRTC client connected; greeting disabled")
        await task.queue_frames(frames)

    @transport.event_handler("on_client_disconnected")
    async def _on_disconnected(_transport, _client):  # noqa: ANN001
        await task.queue_frame(EndFrame())

    runner = PipelineRunner(handle_sigint=False)
    await runner.run(task)
