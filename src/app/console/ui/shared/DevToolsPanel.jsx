import { GitPanel } from '#ui/features/git/GitPanel.jsx';
import { TrailPanel } from '#ui/features/trail/TrailPanel.jsx';
import { CaoPanel } from '#ui/features/cao/CaoPanel.jsx';
import { extensionNavEntries } from '#ui/features/extensions/registry.js';

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
  canPersistCao = false,
}) {
  const caoNav = extensionNavEntries('devtools').some((e) => e.id === subTab && e.extensionId === 'cao');

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
      {caoNav ? <CaoPanel canPersist={canPersistCao} /> : null}
    </div>
  );
}
