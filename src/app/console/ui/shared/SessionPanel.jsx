import { SessionChat } from '#ui/features/chat/SessionChat.jsx';
import { PromptsPanel } from '#ui/features/chat/PromptsPanel.jsx';
import { ToolsPanel } from '#ui/features/chat/ToolsPanel.jsx';

export function SessionPanel({
  subTab,
  prompts,
  expandedPrompts,
  onTogglePrompt,
  lane,
  toolWarnMs,
  now,
  expandedTools,
  onToggleTool,
  chatSession = null,
  peerSessions = null,
  lanes = null,
  chatQueue = null,
  onSendMessage,
  onQueueMessage,
  onStopTurn = null,
  onApproval,
  onAsk = null,
  onTurnOptions = null,
  onSessionOptions = null,
  agentDefaults = null,
  onOpenAgent = null,
}) {
  // Chat transcript for provider chat sessions (Kusă BYOK or CAO-backed).
  const fillHeight = Boolean(chatSession);
  const chatFill = fillHeight && subTab === 'chat';

  return (
    <div className={`flex min-h-0 flex-col ${fillHeight ? 'h-full' : ''}`}>
      <div
        id={`session-panel-${subTab}`}
        role="tabpanel"
        aria-labelledby={`session-tab-${subTab}`}
        className={
          chatFill
            ? 'min-h-0 flex-1'
            : fillHeight
              ? 'min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-4'
              : undefined
        }
      >
        {subTab === 'chat' && chatSession && (
          <SessionChat
            session={chatSession}
            peerSessions={peerSessions}
            queued={chatQueue}
            tasks={lane?.todos || []}
            onSend={onSendMessage}
            onQueue={onQueueMessage}
            onStop={onStopTurn}
            onApproval={onApproval}
            onAsk={onAsk}
            onTurnOptions={onTurnOptions}
            onSessionOptions={onSessionOptions}
            agentDefaults={agentDefaults}
            onOpenAgent={onOpenAgent}
          />
        )}
        {subTab === 'prompts' && (
          <PromptsPanel
            prompts={prompts}
            expanded={expandedPrompts}
            onToggle={onTogglePrompt}
          />
        )}
        {subTab === 'tools' && (
          <ToolsPanel
            lane={lane}
            toolWarnMs={toolWarnMs}
            now={now}
            expandedTools={expandedTools}
            onToggleTool={onToggleTool}
            chatSession={chatSession}
            peerSessions={peerSessions}
            lanes={lanes}
          />
        )}
      </div>
    </div>
  );
}
