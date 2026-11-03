# Browser-native Live Voice

Kusă Live Chat runs **entirely in the PWA**: microphone capture, VAD, STT, TTS,
and playback. The agent runtime only sees text via `POST /kusa/chat` (same
session as typed chat). No WebRTC to WSL and no separate voice daemon.

## Architecture

```text
PWA  AudioCapture → VAD → STT → onTranscript → /kusa/chat (SSE)
                              ← sentence chunks ← live.text
                         TTS → AudioPlayback
```

Providers are selected independently in **Dev Tools › Live Chat**:

| Engine | Offline default | Alternatives |
|--------|-----------------|--------------|
| STT | `whisper` (`@huggingface/transformers`) | `webSpeech`, `mock` |
| TTS | `kokoro` (`kokoro-js`) | `browserSpeech`, `mock` |
| VAD | `silero` (`@ricky0123/vad-web`) | `energy`, `mock` |

## Supported browsers

- **Best:** Chromium / Edge with WebGPU (faster Whisper + Kokoro).
- **Fallback:** Any modern browser with WebAssembly (WASM backends).
- **Required:** `getUserMedia`, `AudioContext`.
- **Optional:** `SpeechRecognition` / `speechSynthesis` (cloud-capable — blocked when Offline-only is on).

WebGPU is **probed at runtime** (`navigator.gpu.requestAdapter`). A Windows NVIDIA
GPU does not imply WebGPU inside WSL-served Chromium; check the capabilities panel.

## Model downloads (bundled into the PWA)

Weights are **predownloaded into the app** — Live Chat does not fetch Hugging Face
from the browser (HF often returns 403 to `localhost`).

```bash
npm run voice:models   # → src/app/console/ui/public/voice-models/
npm run build          # runs voice:models first (prebuild)
```

Bundled set:

- Whisper Tiny EN (`onnx-community/whisper-tiny.en`, quantized)
- Kokoro 82M q8 + curated voices
- Silero VAD v5 + ONNX Runtime WASM

Served at `/voice-models/…` (Vite public dir in `--live`; `kusa serve` static route).
Providers rewrite any Hugging Face resolve URL onto that same-origin path.

Large `.onnx` / `.bin` / `.wasm` files are gitignored — run `voice:models` after clone.

## Settings

Persisted in `.kusa/settings.json` → `liveChat` (also `GET|PUT /live-chat/settings`):

- `sttProvider`, `ttsProvider`, `vadProvider`
- `offlineOnly`, `autoSpeak`, `interruptible`
- `voice`, `gender`, `speechRate`, `language`, `whisperModel`

## Limitations

- First model load can take tens of seconds and needs network once.
- Whisper-tiny is fast but less accurate than server Faster-Whisper large models.
- `ScriptProcessorNode` is used for mic frames (broad compatibility); AudioWorklet
  can be added later without changing the VoiceManager API.
- Tab suspension may pause `AudioContext` — resume by interacting with the page.
- Browser Speech APIs are **not** claimed offline; Offline-only refuses them.
- The retired Pipecat extension under `extensions/live-chat/` is unused.
- Production build code-splits Whisper / Kokoro / ONNX WASM (~20–25 MB wasm assets).
  Those chunks load only when a Live session initializes the matching provider — they
  are not required for normal chat.

## Tests

Unit coverage (mock providers, no weight downloads):

```bash
npm test -- test/voice-browser.test.mjs test/live-chat.test.mjs
```
