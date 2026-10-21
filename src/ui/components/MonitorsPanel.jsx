import { CountersPanel } from './CountersPanel.jsx';
import { EventsPanel } from './EventsPanel.jsx';
import { QualityPanel } from './QualityPanel.jsx';
import { TokensPanel } from './TokensPanel.jsx';
import { WarningsPanel } from './WarningsPanel.jsx';

export function MonitorsPanel({
  subTab,
  lane,
  now,
  sdkListener,
  tokens,
  tokenTurns,
  recent,
  warnings,
  notes,
  errors,
}) {
  return (
    <div
      id={`monitors-panel-${subTab}`}
      role="tabpanel"
      aria-labelledby={`monitors-tab-${subTab}`}
    >
      {subTab === 'counters' && (
        <CountersPanel lane={lane} now={now} sdkListener={sdkListener} />
      )}
      {subTab === 'tokens' && (
        <TokensPanel tokens={tokens} tokenTurns={tokenTurns} />
      )}
      {subTab === 'events' && <EventsPanel recent={recent} />}
      {subTab === 'warnings' && <WarningsPanel warnings={warnings} />}
      {subTab === 'quality' && <QualityPanel notes={notes} errors={errors} />}
    </div>
  );
}
