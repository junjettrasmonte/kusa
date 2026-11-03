"""FastAPI shell: health, session mint, WebSocket + WebRTC signaling."""

from __future__ import annotations

import logging
import uuid
from typing import Any, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .config import LiveChatConfig

log = logging.getLogger("live_chat.server")


class HistoryMessage(BaseModel):
    role: str
    content: str


class SessionRequest(BaseModel):
    sessionId: Optional[str] = None
    queueKey: Optional[str] = None
    model: Optional[str] = None
    baseUrl: Optional[str] = None
    apiKey: Optional[str] = None
    transport: Optional[str] = None
    tts: Optional[str] = None
    systemPrompt: Optional[str] = None
    # Prior chat turns from kusa serve (OpenAI-style) so voice has session context.
    messages: Optional[list[HistoryMessage]] = None


class SessionResponse(BaseModel):
    ok: bool = True
    voiceSessionId: str
    transport: str
    tts: str
    wsUrl: str = "/ws"
    rtcUrl: str = "/rtc"
    sessionId: Optional[str] = None
    queueKey: Optional[str] = None


class OfferRequest(BaseModel):
    sdp: str
    type: str = "offer"
    voiceSessionId: Optional[str] = None
    sessionId: Optional[str] = None
    queueKey: Optional[str] = None
    model: Optional[str] = None
    baseUrl: Optional[str] = None
    apiKey: Optional[str] = None
    tts: Optional[str] = None


# In-memory session overrides keyed by voiceSessionId.
_SESSIONS: dict[str, dict[str, Any]] = {}


def create_app(cfg: LiveChatConfig | None = None) -> FastAPI:
    config = cfg or LiveChatConfig.from_env()
    app = FastAPI(title="Kusă Live Chat", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.live_chat_config = config

    @app.get("/health")
    async def health() -> dict:
        status = config.public_status()
        status["activeSessions"] = len(_SESSIONS)
        return status

    @app.get("/")
    async def root() -> dict:
        return await health()

    @app.post("/session", response_model=SessionResponse)
    async def mint_session(body: SessionRequest) -> SessionResponse:
        voice_id = str(uuid.uuid4())
        transport = (body.transport or config.transport).lower()
        if transport not in ("websocket", "webrtc"):
            transport = config.transport
        tts = (body.tts or config.tts).lower()
        if tts not in ("piper", "kokoro"):
            tts = config.tts
        history: list[dict[str, str]] = []
        for item in body.messages or []:
            role = (item.role or "").strip().lower()
            content = (item.content or "").strip()
            if not content:
                continue
            if role not in ("user", "assistant", "system"):
                role = "user"
            # System rows from history are ignored — bot owns the spoken system prompt.
            if role == "system":
                continue
            history.append({"role": role, "content": content})
        _SESSIONS[voice_id] = {
            "sessionId": body.sessionId or "",
            "queueKey": body.queueKey or "",
            "model": body.model or config.llm_model,
            "baseUrl": body.baseUrl or config.llm_base_url,
            "apiKey": body.apiKey if body.apiKey is not None else config.llm_api_key,
            "transport": transport,
            "tts": tts,
            "systemPrompt": body.systemPrompt or config.system_prompt,
            "messages": history,
        }
        log.info(
            "minted voiceSessionId=%s sessionId=%s history=%d",
            voice_id,
            body.sessionId or "-",
            len(history),
        )
        return SessionResponse(
            voiceSessionId=voice_id,
            transport=transport,
            tts=tts,
            sessionId=body.sessionId,
            queueKey=body.queueKey,
        )

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        # Read query params explicitly — FastAPI dependency injection for WS
        # query args is easy to miss through the kusa serve upgrade proxy.
        qp = websocket.query_params
        voice_id = (qp.get("voiceSessionId") or qp.get("voice_session_id") or "").strip()
        session = dict(_SESSIONS.get(voice_id, {}) or {})
        # Browser may also pass chat ids directly (avoids relying on in-memory mint).
        if qp.get("sessionId"):
            session["sessionId"] = qp.get("sessionId") or session.get("sessionId", "")
        if qp.get("queueKey"):
            session["queueKey"] = qp.get("queueKey") or session.get("queueKey", "")
        log.info(
            "ws connect voiceSessionId=%s sessionId=%s queueKey=%s known=%s",
            voice_id or "-",
            session.get("sessionId") or "-",
            session.get("queueKey") or "-",
            bool(voice_id and voice_id in _SESSIONS),
        )
        await websocket.accept()
        try:
            from .pipeline import run_websocket_bot

            await run_websocket_bot(
                websocket,
                config,
                session_id=session.get("sessionId", "") or "",
                queue_key=session.get("queueKey", "") or "",
                model=session.get("model"),
                base_url=session.get("baseUrl"),
                api_key=session.get("apiKey"),
                system_prompt=session.get("systemPrompt"),
                tts=session.get("tts"),
                history_messages=session.get("messages") or [],
            )
        except WebSocketDisconnect:
            log.info("client disconnected")
        except Exception as err:  # noqa: BLE001
            log.exception("websocket bot failed: %s", err)
            try:
                await websocket.close(code=1011)
            except Exception:  # noqa: BLE001
                pass

    @app.post("/rtc")
    async def rtc_offer(body: OfferRequest) -> dict:
        """SmallWebRTC signaling: browser POSTs an SDP offer, gets an answer."""
        session = _SESSIONS.get(body.voiceSessionId or "", {})
        try:
            from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
            from .pipeline import run_webrtc_bot
            import asyncio

            connection = SmallWebRTCConnection()
            await connection.initialize(sdp=body.sdp, type=body.type)

            async def _run() -> None:
                await run_webrtc_bot(
                    connection,
                    config,
                    session_id=session.get("sessionId") or body.sessionId or "",
                    queue_key=session.get("queueKey") or body.queueKey or "",
                    model=session.get("model") or body.model,
                    base_url=session.get("baseUrl") or body.baseUrl,
                    api_key=session.get("apiKey") if session else body.apiKey,
                    system_prompt=session.get("systemPrompt"),
                    tts=session.get("tts") or body.tts,
                    history_messages=session.get("messages") or [],
                )

            asyncio.create_task(_run())
            answer = connection.get_answer()
            return {"ok": True, "sdp": answer.get("sdp"), "type": answer.get("type", "answer")}
        except Exception as err:  # noqa: BLE001
            log.exception("webrtc offer failed: %s", err)
            return {"ok": False, "error": str(err)}

    return app


def run(cfg: LiveChatConfig | None = None) -> None:
    import uvicorn

    config = cfg or LiveChatConfig.from_env()
    app = create_app(config)
    log.info(
        "Live Chat listening on http://%s:%s (transport=%s tts=%s)",
        config.host,
        config.port,
        config.transport,
        config.tts,
    )
    uvicorn.run(app, host=config.host, port=config.port, log_level="info")
