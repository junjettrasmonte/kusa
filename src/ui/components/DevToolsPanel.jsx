import { GitPanel } from './GitPanel.jsx';
import { TrailPanel } from './TrailPanel.jsx';

export function DevToolsPanel({
  subTab,
  trail,
  trailStatus,
  detectTrail,
  enforceTrail,
  canLiveRefreshTrail,
  git,
  detectGit,
  enforceGit,
  canLiveRefreshGit,
}) {
  return (
    <div
      id={`devtools-panel-${subTab}`}
      role="tabpanel"
      aria-labelledby={`devtools-tab-${subTab}`}
    >
      {subTab === 'git' && (
        <GitPanel
          git={git}
          detect={detectGit}
          enforce={enforceGit}
          canLiveRefresh={canLiveRefreshGit}
        />
      )}
      {subTab === 'trail' && (
        <TrailPanel
          trail={trail}
          status={trailStatus}
          detect={detectTrail}
          enforce={enforceTrail}
          canLiveRefresh={canLiveRefreshTrail}
        />
      )}
    </div>
  );
}
