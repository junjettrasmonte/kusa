"""Build the Pipecat 1.15+ voice pipeline (Silero → Whisper → Strata → TTS)."""

from __future__ import annotations

import logging
from typing import Any, Callable, Optional

from .config import LiveChatConfig

log = logging.getLogger("live_chat.pipeline")

SAMPLE_RATE = 16000


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
    """Browser ↔ bot: raw PCM16 LE mono + JSON control/transcript messages."""
    import json

    from pipecat.frames.frames import (
        InputAudioRawFrame,
        OutputAudioRawFrame,
        OutputTransportMessageFrame,
        OutputTransportMessageUrgentFrame,
        TTSAudioRawFrame,
    )
    from pipecat.serializers.base_serializer import FrameSerializer

    class RawPcmSerializer(FrameSerializer):
        def __init__(self):
            super().__init__()
            self._sample_rate = sample_rate

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
                return None
            if not isinstance(data, (bytes, bytearray)) or not data:
                return None
            return InputAudioRawFrame(
                audio=bytes(data),
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
    log.info("Building TTS engine=%s", engine)
    if engine == "kokoro":
        try:
            from pipecat.services.kokoro.tts import KokoroTTSService

            # Pipecat ≥0.0.105 requires an explicit voice (no silent default).
            return KokoroTTSService(
                settings=KokoroTTSService.Settings(voice=kokoro_voice),
            )
        except Exception as err:  # noqa: BLE001
            log.warning("Kokoro TTS unavailable (%s); trying Piper", err)
    try:
        from pipecat.services.piper.tts import PiperTTSService

        return PiperTTSService(
            settings=PiperTTSService.Settings(voice=piper_voice),
        )
    except Exception as err:  # noqa: BLE001
        log.warning("Piper TTS unavailable (%s); trying OpenAI TTS", err)
    try:
        from pipecat.services.openai.tts import OpenAITTSService

        return OpenAITTSService(
            api_key=api_key or cfg.strata_api_key or "no-key",
            base_url=base_url or cfg.strata_base_url or None,
            voice="alloy",
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

    return OpenAILLMService(
        api_key=api_key if api_key is not None else (cfg.strata_api_key or "no-key"),
        base_url=base_url or cfg.strata_base_url or None,
        model=model or cfg.strata_model,
    )


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
    on_event: Optional[Callable[[dict], Any]] = None,
) -> None:
    """Attach a full-duplex Pipecat pipeline to an accepted WebSocket."""
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.frames.frames import (
        EndFrame,
        InterimTranscriptionFrame,
        LLMFullResponseEndFrame,
        LLMMessagesUpdateFrame,
        OutputTransportMessageUrgentFrame,
        TextFrame,
        TranscriptionFrame,
        TTSSpeakFrame,
    )
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.task import PipelineParams, PipelineTask
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import (
        LLMContextAggregatorPair,
        LLMUserAggregatorParams,
    )
    from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
    from pipecat.transports.websocket.fastapi import (
        FastAPIWebsocketParams,
        FastAPIWebsocketTransport,
    )

    class TranscriptTap(FrameProcessor):
        def __init__(self):
            super().__init__()
            self._assistant_buf: list[str] = []
            self._task: PipelineTask | None = None

        def bind_task(self, task: PipelineTask) -> None:
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
            # Also route through the transport serializer so the browser gets a
            # text WS frame even if the raw websocket callback races Pipecat.
            if self._task is not None:
                await self._task.queue_frame(
                    OutputTransportMessageUrgentFrame(
                        message={"type": "transcript", "role": role, "text": text},
                    )
                )

        async def process_frame(self, frame, direction: FrameDirection):  # noqa: ANN001
            await super().process_frame(frame, direction)
            text = getattr(frame, "text", None)
            # Whisper SegmentedSTT emits TranscriptionFrame (not Interim*).
            # `finalized` can be False if a newer segment already started — still
            # show the text in chat; it is the completed STT for that segment.
            if (
                isinstance(frame, TranscriptionFrame)
                and not isinstance(frame, InterimTranscriptionFrame)
                and text
            ):
                log.info("STT user transcript: %r", text[:120])
                await self._push_browser_transcript("user", text)
                await emit_transcript(
                    cfg.transcript_callback_url,
                    role="user",
                    text=text,
                    session_id=session_id,
                    queue_key=queue_key,
                )
            elif isinstance(frame, TTSSpeakFrame) and text:
                # Direct speak (e.g. connect greeting) — show in chat without waiting for LLM.
                log.info("TTS speak transcript: %r", text[:120])
                await self._push_browser_transcript("assistant", text)
                await emit_transcript(
                    cfg.transcript_callback_url,
                    role="assistant",
                    text=text,
                    session_id=session_id,
                    queue_key=queue_key,
                )
            elif isinstance(frame, TextFrame) and text and direction == FrameDirection.DOWNSTREAM:
                self._assistant_buf.append(text)
            elif isinstance(frame, LLMFullResponseEndFrame) and self._assistant_buf:
                full = "".join(self._assistant_buf).strip()
                self._assistant_buf.clear()
                if full:
                    log.info("LLM assistant transcript: %r", full[:120])
                    await self._push_browser_transcript("assistant", full)
                    await emit_transcript(
                        cfg.transcript_callback_url,
                        role="assistant",
                        text=full,
                        session_id=session_id,
                        queue_key=queue_key,
                    )
            await self.push_frame(frame, direction)

    # Silero must sit on the transport so SegmentedSTT (Whisper) receives
    # VADUserStarted/StoppedSpeaking frames on the audio path.
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=SAMPLE_RATE,
            audio_out_sample_rate=SAMPLE_RATE,
            vad_analyzer=SileroVADAnalyzer(),
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
    tap = TranscriptTap()

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            tap,
            context_agg.user(),
            llm,
            tts_svc,
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
        # Seed system prompt, then speak a fixed greeting so TTS is verifiable
        # before the first user utterance (does not wait on the LLM).
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
    """Attach the same pipeline to a SmallWebRTC connection."""
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

    transport = SmallWebRTCTransport(
        webrtc_connection=webrtc_connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=SAMPLE_RATE,
            audio_out_sample_rate=SAMPLE_RATE,
            vad_analyzer=SileroVADAnalyzer(),
        ),
    )

    stt = _build_stt(cfg)
    llm = _build_llm(
        cfg,
        model=session_kwargs.get("model"),
        base_url=session_kwargs.get("base_url"),
        api_key=session_kwargs.get("api_key"),
    )
    tts_svc = _build_tts(
        cfg,
        tts=session_kwargs.get("tts"),
        api_key=session_kwargs.get("api_key"),
        base_url=session_kwargs.get("base_url"),
    )
    messages = [
        {
            "role": "system",
            "content": session_kwargs.get("system_prompt") or cfg.system_prompt,
        }
    ]
    context = LLMContext(messages)
    context_agg = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            context_agg.user(),
            llm,
            tts_svc,
            transport.output(),
            context_agg.assistant(),
        ]
    )
    task = PipelineTask(pipeline, params=PipelineParams(allow_interruptions=True))

    @transport.event_handler("on_client_connected")
    async def _on_connected(_transport, _client):  # noqa: ANN001
        greeting = (cfg.greeting or "").strip()
        frames: list[Any] = [LLMMessagesUpdateFrame(messages=messages)]
        if greeting:
            log.info("WebRTC client connected; speaking greeting: %r", greeting[:80])
            frames.append(TTSSpeakFrame(text=greeting, append_to_context=True))
        await task.queue_frames(frames)

    @transport.event_handler("on_client_disconnected")
    async def _on_disconnected(_transport, _client):  # noqa: ANN001
        await task.queue_frame(EndFrame())

    runner = PipelineRunner(handle_sigint=False)
    await runner.run(task)
