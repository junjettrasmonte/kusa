import { AtlassianPanel } from '#extensions/atlassian-adapter/ui/AtlassianPanel.jsx';
import { GitPanel } from '#ui/features/git/GitPanel.jsx';
import { TrailPanel } from '#ui/features/trail/TrailPanel.jsx';
import { StrataPanel } from '#ui/features/strata/StrataPanel.jsx';
import { CaoPanel } from '#ui/features/cao/CaoPanel.jsx';
import { LiveChatPanel } from '#ui/features/live-chat/LiveChatPanel.jsx';
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
  canLiveRefreshStrata = false,
}) {
  const caoNav = extensionNavEntries('devtools').some((e) => e.id === subTab && e.extensionId === 'cao');
  const liveChatNav = extensionNavEntries('devtools').some(
    (e) => e.id === subTab && e.extensionId === 'live-chat',
  );
  const atlassianNav = extensionNavEntries('devtools').some(
    (e) => e.id === subTab && e.extensionId === 'atlassian-adapter',
  );

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
      {subTab === 'strata' && (
        <StrataPanel canLiveRefresh={canLiveRefreshStrata} />
      )}
      {caoNav ? <CaoPanel canPersist={canPersistCao} /> : null}
      {liveChatNav ? <LiveChatPanel canPersist={canPersistCao} /> : null}
      {atlassianNav ? <AtlassianPanel canPersist={canPersistCao} /> : null}
    </div>
  );
}
