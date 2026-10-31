import { ChatHarness } from '#ui/features/chat/ChatHarness.jsx';
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
  kusaSession = null,
  kusaQueue = null,
  onSendKusaMessage,
  onQueueKusaMessage,
  onStopKusaTurn = null,
  onKusaApproval,
  onKusaAsk = null,
  onKusaTurnOptions = null,
  onKusaSessionOptions = null,
  agentDefaults = null,
}) {
  // Kusă Chat only exists for Kusă sessions — other harnesses have no chat transcript.
  const fillHeight = Boolean(kusaSession);
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
        {subTab === 'chat' && kusaSession && (
          <ChatHarness
            session={kusaSession}
            queued={kusaQueue}
            tasks={lane?.todos || []}
            onSend={onSendKusaMessage}
            onQueue={onQueueKusaMessage}
            onStop={onStopKusaTurn}
            onApproval={onKusaApproval}
            onAsk={onKusaAsk}
            onTurnOptions={onKusaTurnOptions}
            onSessionOptions={onKusaSessionOptions}
            agentDefaults={agentDefaults}
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
          />
        )}
      </div>
    </div>
  );
}
