/**
 * Main-pane info & config for the extension selected in Sidebar › Extensions.
 * Catalog metadata comes from the registry; each id mounts its own panel.
 */
import { CaoPanel } from '#ui/features/cao/CaoPanel.jsx';
import { LiveChatPanel } from '#ui/features/live-chat/LiveChatPanel.jsx';
import { getBuiltinExtension } from './registry.js';

function ExtensionConfig({ extensionId, canPersist }) {
  if (extensionId === 'cao') {
    return <CaoPanel canPersist={canPersist} />;
  }
  if (extensionId === 'live-chat') {
    return <LiveChatPanel canPersist={canPersist} />;
  }
  return (
    <p className="text-sm text-gray-500">
      No configuration panel for this extension yet.
    </p>
  );
}

export function ExtensionPage({ extensionId, canPersist = false }) {
  const ext = getBuiltinExtension(extensionId);

  if (!ext) {
    return (
      <p className="text-sm text-gray-500">
        Unknown extension{extensionId ? ` “${extensionId}”` : ''}.
      </p>
    );
  }

  return (
    <div className="space-y-8" data-extension={ext.id}>
      <header className="space-y-2 border-b border-gray-800 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-gray-100">{ext.name}</h1>
          {ext.builtin ? (
            <span className="rounded bg-gray-900 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
              built-in
            </span>
          ) : null}
          {ext.shortName && ext.shortName !== ext.name ? (
            <span className="text-xs text-gray-500">{ext.shortName}</span>
          ) : null}
        </div>
        {ext.description ? (
          <p className="text-sm leading-relaxed text-gray-400">{ext.description}</p>
        ) : null}
        {ext.detail ? (
          <p className="text-xs leading-relaxed text-gray-500">{ext.detail}</p>
        ) : null}
        {ext.root ? (
          <p className="font-mono text-[11px] text-gray-600">{ext.root}</p>
        ) : null}
      </header>

      <ExtensionConfig extensionId={ext.id} canPersist={canPersist} />
    </div>
  );
}
