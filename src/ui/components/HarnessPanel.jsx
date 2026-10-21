import { KnowledgebasePanel } from './KnowledgebasePanel.jsx';
import { McpPanel } from './McpPanel.jsx';
import { McpToolsPanel } from './McpToolsPanel.jsx';
import { SkillsPanel } from './SkillsPanel.jsx';

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
