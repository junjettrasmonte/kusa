import { KnowledgebasePanel } from '#ui/features/trail/KnowledgebasePanel.jsx';
import { McpPanel } from '#ui/features/mcp/McpPanel.jsx';
import { McpToolsPanel } from '#ui/features/mcp/McpToolsPanel.jsx';
import { SkillsPanel } from '#ui/features/skills/SkillsPanel.jsx';

export function HarnessPanel({ subTab, canPersist = true }) {
  return (
    <div
      id={`harness-panel-${subTab}`}
      role="tabpanel"
      aria-labelledby={`harness-tab-${subTab}`}
    >
      {subTab === 'mcp' && <McpPanel canPersist={canPersist} />}
      {subTab === 'tools' && <McpToolsPanel canPersist={canPersist} />}
      {subTab === 'knowledgebase' && <KnowledgebasePanel canPersist={canPersist} />}
      {subTab === 'skills' && <SkillsPanel canPersist={canPersist} />}
    </div>
  );
}
