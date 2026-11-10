import { CountersPanel } from '#ui/features/monitor/CountersPanel.jsx';
import { EventsPanel } from '#ui/features/monitor/EventsPanel.jsx';
import { QualityPanel } from '#ui/features/monitor/QualityPanel.jsx';
import { TokensPanel } from '#ui/features/monitor/TokensPanel.jsx';
import { WarningsPanel } from '#ui/features/monitor/WarningsPanel.jsx';
import { KnowledgebasePanel } from '#ui/features/trail/KnowledgebasePanel.jsx';
import { McpPanel } from '#ui/features/mcp/McpPanel.jsx';
import { McpToolsPanel } from '#ui/features/mcp/McpToolsPanel.jsx';
import { SkillsPanel } from '#ui/features/skills/SkillsPanel.jsx';

export function HarnessPanel({
  subTab,
  canPersist = true,
  lane = null,
  now = Date.now(),
  tokens = null,
  tokenTurns = null,
  recent = null,
  warnings = null,
  notes = null,
  errors = null,
}) {
  return (
    <div
      id={`harness-panel-${subTab}`}
      role="tabpanel"
      aria-labelledby={`harness-tab-${subTab}`}
    >
      {subTab === 'counters' && <CountersPanel lane={lane} now={now} />}
      {subTab === 'tokens' && <TokensPanel tokens={tokens} tokenTurns={tokenTurns} />}
      {subTab === 'events' && <EventsPanel recent={recent} />}
      {subTab === 'warnings' && <WarningsPanel warnings={warnings} />}
      {subTab === 'quality' && <QualityPanel notes={notes} errors={errors} />}
      {subTab === 'mcp' && <McpPanel canPersist={canPersist} />}
      {subTab === 'tools' && <McpToolsPanel canPersist={canPersist} />}
      {subTab === 'knowledgebase' && <KnowledgebasePanel canPersist={canPersist} />}
      {subTab === 'skills' && <SkillsPanel canPersist={canPersist} />}
    </div>
  );
}
