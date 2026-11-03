/**
 * Browser Live voice client — mints a session via /live-chat/session, then
 * opens WebSocket (PCM/media) or WebRTC (SDP via /live-chat/rtc).
 */

/**
 * @typedef {'idle'|'connecting'|'listening'|'thinking'|'speaking'|'error'} VoicePhase
 */

/**
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} [opts.queueKey]
 * @param {string} [opts.model]
 * @param {string} [opts.endpointId]
 * @param {(phase: VoicePhase, detail?: string) => void} [opts.onPhase]
 * @param {(err: Error) => void} [opts.onError]
 * @param {() => void} [opts.onEnded]
 * @param {(msg: { role: string, text: string }) => void} [opts.onTranscript]
 */
export async function startLiveVoiceSession(opts = {}) {
  const {
    sessionId,
    queueKey = null,
    model = null,
    endpointId = null,
    onPhase = null,
    onError = null,
    onEnded = null,
    onTranscript = null,
  } = opts;

  onPhase?.('connecting');

  const statusRes = await fetch('/live-chat', { headers: { Accept: 'application/json' } });
  const status = statusRes.ok ? await statusRes.json() : null;
  if (!status?.serverUp) {
    const err = new Error(status?.error || 'Live Chat bot is not running');
    onPhase?.('error', err.message);
    onError?.(err);
    throw err;
  }

  const mintRes = await fetch('/live-chat/session', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      queueKey: queueKey || undefined,
      model: model || undefined,
      endpointId: endpointId || undefined,
    }),
  });
  const minted = await mintRes.json().catch(() => ({}));
  if (!mintRes.ok) {
    const err = new Error(minted?.error || `HTTP ${mintRes.status}`);
    onPhase?.('error', err.message);
    onError?.(err);
    throw err;
  }

  const transport = minted.transport === 'webrtc' ? 'webrtc' : 'websocket';
  const voiceSessionId = minted.voiceSessionId || '';

  const media = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });

  let closed = false;
  /** @type {WebSocket|null} */
  let ws = null;
  /** @type {RTCPeerConnection|null} */
  let pc = null;
  /** @type {AudioContext|null} */
  let audioCtx = null;
  /** @type {ScriptProcessorNode|MediaStreamAudioSourceNode|null} */
  let processor = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { processor?.disconnect?.(); } catch { /* ignore */ }
    try { audioCtx?.close?.(); } catch { /* ignore */ }
    try { ws?.close?.(); } catch { /* ignore */ }
    try { pc?.close?.(); } catch { /* ignore */ }
    for (const track of media.getTracks()) {
      try { track.stop(); } catch { /* ignore */ }
    }
    onPhase?.('idle');
    onEnded?.();
  };

  try {
    if (transport === 'webrtc') {
      pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      for (const track of media.getAudioTracks()) {
        pc.addTrack(track, media);
      }
      pc.ontrack = (ev) => {
        onPhase?.('speaking');
        const [stream] = ev.streams;
        if (!stream) return;
        const el = new Audio();
        el.srcObject = stream;
        el.autoplay = true;
        void el.play().catch(() => {});
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') onPhase?.('listening');
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') cleanup();
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const rtcRes = await fetch('/live-chat/rtc', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sdp: offer.sdp,
          type: offer.type,
          voiceSessionId,
          sessionId,
          queueKey: queueKey || undefined,
        }),
      });
      const answer = await rtcRes.json().catch(() => ({}));
      if (!rtcRes.ok || !answer?.sdp) {
        throw new Error(answer?.error || 'WebRTC signaling failed');
      }
      await pc.setRemoteDescription({ type: answer.type || 'answer', sdp: answer.sdp });
      onPhase?.('listening');
    } else {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const params = new URLSearchParams();
      if (voiceSessionId) params.set('voiceSessionId', voiceSessionId);
      // Also pass chat ids so the bot can POST transcripts without relying on mint memory.
      if (sessionId) params.set('sessionId', sessionId);
      if (queueKey) params.set('queueKey', queueKey);
      const qs = params.toString() ? `?${params.toString()}` : '';
      ws = new WebSocket(`${proto}//${window.location.host}/live-chat/ws${qs}`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        onPhase?.('listening');
        // Stream mic PCM16 @ 16kHz — common Pipecat websocket expectation.
        audioCtx = new AudioContext({ sampleRate: 16000 });
        const source = audioCtx.createMediaStreamSource(media);
        // ScriptProcessor is deprecated but widely available without AudioWorklet bundling.
        const bufferSize = 4096;
        const script = audioCtx.createScriptProcessor(bufferSize, 1, 1);
        script.onaudioprocess = (ev) => {
          if (closed || ws?.readyState !== WebSocket.OPEN) return;
          const input = ev.inputBuffer.getChannelData(0);
          const pcm = new Int16Array(input.length);
          for (let i = 0; i < input.length; i += 1) {
            const s = Math.max(-1, Math.min(1, input[i]));
            pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          ws.send(pcm.buffer);
        };
        source.connect(script);
        script.connect(audioCtx.destination);
        processor = script;
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            const msg = JSON.parse(ev.data);
            if (msg?.type === 'thinking') onPhase?.('thinking');
            if (msg?.type === 'speaking' || msg?.type === 'audio') onPhase?.('speaking');
            if (msg?.type === 'listening') onPhase?.('listening');
            if (msg?.type === 'transcript' && msg.text) {
              onTranscript?.({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                text: String(msg.text),
              });
            }
          } catch { /* ignore non-json */ }
          return;
        }
        // Binary audio from bot — play via AudioContext
        if (ev.data instanceof ArrayBuffer && audioCtx) {
          onPhase?.('speaking');
          const pcm = new Int16Array(ev.data);
          const f32 = new Float32Array(pcm.length);
          for (let i = 0; i < pcm.length; i += 1) f32[i] = pcm[i] / 0x8000;
          const buf = audioCtx.createBuffer(1, f32.length, audioCtx.sampleRate || 16000);
          buf.copyToChannel(f32, 0);
          const node = audioCtx.createBufferSource();
          node.buffer = buf;
          node.connect(audioCtx.destination);
          node.start();
        }
      };
      ws.onerror = () => {
        // Browsers hide the real reason on error; onclose usually has the code.
        const err = new Error('Live voice WebSocket error — check the Live Chat bot logs');
        onPhase?.('error', err.message);
        onError?.(err);
      };
      ws.onclose = (ev) => {
        if (!closed && ev && ev.code && ev.code !== 1000 && ev.code !== 1001) {
          const detail = ev.reason
            ? `Live voice closed (${ev.code}: ${ev.reason})`
            : `Live voice closed (code ${ev.code})`;
          onPhase?.('error', detail);
          onError?.(new Error(detail));
        }
        cleanup();
      };
    }
  } catch (err) {
    cleanup();
    onPhase?.('error', err?.message || String(err));
    onError?.(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }

  return {
    transport,
    voiceSessionId,
    stop: cleanup,
  };
}
