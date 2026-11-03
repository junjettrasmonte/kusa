import { PopupList } from '#ui/features/chat/PopupList.jsx';
import { LiveVoiceSpectrum } from './LiveVoiceSpectrum.jsx';

/**
 * Live Chat drawer — spectrum surface only (start/stop live from the composer).
 * Voice runs in the browser; turns go through the normal Kusă agent.
 */
export function LiveChatStack({
  expanded = false,
  voiceActive = false,
  voicePhase = 'idle',
  voiceError = '',
  liveChatUp = true,
  interimTranscript = '',
  getLevels = null,
  avatarUrl = '',
  dock = 'bottom',
  onDockToggle = null,
  onClose = null,
}) {
  if (!expanded) return null;

  const phaseLabel = voicePhase === 'thinking'
    ? 'agent working'
    : voicePhase === 'speaking'
      ? 'speaking reply'
      : voicePhase === 'listening'
        ? 'listening'
        : voicePhase === 'connecting'
          ? 'loading models'
          : voicePhase;

  const summary = voiceActive
    ? `Live voice · ${phaseLabel}`
    : liveChatUp
      ? 'Live voice ready — uses this chat’s model & tools'
      : (voiceError || 'Browser voice unavailable');

  const bottom = dock !== 'right';

  return (
    <PopupList
      expanded={expanded}
      count={1}
      summary={summary}
      ariaLabel="Live Chat"
      dock={dock}
      onDockToggle={onDockToggle}
      onClose={onClose}
    >
      <div
        className={
          bottom
            ? 'flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-2 py-1'
            : 'flex w-full max-w-full flex-col items-center justify-center gap-2 overflow-x-hidden py-2'
        }
      >
        <LiveVoiceSpectrum
          phase={voiceActive ? voicePhase : 'idle'}
          getLevels={voiceActive ? getLevels : null}
          avatarUrl={avatarUrl}
          dock={dock}
        />
        {interimTranscript ? (
          <p className="max-w-sm shrink-0 text-center text-[11px] text-gray-400">
            {interimTranscript}
          </p>
        ) : null}
        {voiceError ? (
          <p className="max-w-sm shrink-0 text-center text-[11px] text-amber-400">{voiceError}</p>
        ) : null}
        {voiceActive && voicePhase === 'listening' ? (
          <p className="max-w-sm shrink-0 text-center text-[11px] text-gray-500">
            Listening — speak when ready. Prompts go to this chat’s Kusă agent; the reply is spoken as it streams.
          </p>
        ) : null}
        {voiceActive && voicePhase === 'connecting' ? (
          <p className="max-w-sm shrink-0 text-center text-[11px] text-gray-500">
            Initializing local models (Whisper / Kokoro / VAD)…
          </p>
        ) : null}
      </div>
    </PopupList>
  );
}
