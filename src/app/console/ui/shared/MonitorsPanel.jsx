import { CountersPanel } from '#ui/features/monitor/CountersPanel.jsx';
import { EventsPanel } from '#ui/features/monitor/EventsPanel.jsx';
import { QualityPanel } from '#ui/features/monitor/QualityPanel.jsx';
import { TokensPanel } from '#ui/features/monitor/TokensPanel.jsx';
import { WarningsPanel } from '#ui/features/monitor/WarningsPanel.jsx';

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
