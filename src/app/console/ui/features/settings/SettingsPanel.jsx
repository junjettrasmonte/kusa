import { AgentEndpointsPanel } from '#ui/features/settings/AgentEndpointsPanel.jsx';
import { Choice, Field } from '#ui/shared/SettingsControls.jsx';

export function SettingsPanel({
  subTab,
  settings,
  canPersist,
  onSettingsChange,
  settingsBusy,
}) {
  const s = settings || {
    detectTrail: true,
    enforceTrail: true,
    detectGit: true,
    enforceGit: true,
    agentBaseUrl: '',
    agentModel: 'gpt-4o-mini',
    agentModels: [],
    agentEndpoints: [],
    agentMaxSteps: 100,
    agentAuthMode: 'none',
    agentApiKeySet: false,
    agentBackend: 'native',
    agentApprovalTimeoutMinutes: 2,
    agentAllowDenyRevertMinutes: 15,
  };
  const backendOpencode = s.agentBackend === 'opencode';

  return (
    <div
      id={`settings-panel-${subTab}`}
      role="tabpanel"
      aria-labelledby={`settings-tab-${subTab}`}
    >
        {subTab === 'agent' ? (
          <section>
            <h2 className="mb-2 text-base font-semibold">Kusă agent</h2>
            <p className="mb-3 text-xs text-gray-500">
              Powers the Kusă chat harness. Connects to any OpenAI-compatible{' '}
              <code className="text-sky-300">/v1</code> endpoint — as many of them as you want, each with
              its own key and model ids below. File tools are Kusă&apos;s own
              sandboxed read/write/list/grep (also advertised over MCP). OpenCode SDK mode needs the{' '}
              <code className="text-sky-300">opencode</code> CLI on PATH.
            </p>
            <AgentEndpointsPanel
              defaultEndpoint={{
                baseUrl: s.agentBaseUrl || '',
                model: s.agentModel || 'gpt-4o-mini',
                authMode: s.agentAuthMode || 'none',
                apiKeySet: s.agentApiKeySet === true,
                models: s.agentModels || [],
              }}
              endpoints={s.agentEndpoints || []}
              canPersist={canPersist}
              settingsBusy={settingsBusy}
              onSettingsChange={onSettingsChange}
            />
            <hr className="my-6 border-0 border-t border-gray-700" />
            <div className="space-y-3">
              <div>
                <p className="mb-1 text-sm text-gray-300">Backend</p>
                <div className="flex flex-wrap gap-2">
                  <Choice
                    active={!backendOpencode}
                    disabled={!canPersist || settingsBusy}
                    onClick={() => onSettingsChange?.({ agentBackend: 'native' })}
                    label="Native (OpenAI tools loop)"
                  />
                  <Choice
                    active={backendOpencode}
                    disabled={!canPersist || settingsBusy}
                    onClick={() => onSettingsChange?.({ agentBackend: 'opencode' })}
                    label="OpenCode SDK"
                  />
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Native uses Kusă&apos;s tool loop against the endpoint. OpenCode SDK spawns{' '}
                  <code className="text-sky-300">opencode serve</code> and overrides file tools with
                  Kusă&apos;s; falls back to native if the CLI is missing.
                </p>
              </div>
              <Field
                label="Max tool steps"
                hint="Native backend only. Max model↔tool rounds before stopping (1–1000, default 100)."
                value={String(s.agentMaxSteps ?? 100)}
                disabled={!canPersist || settingsBusy || backendOpencode}
                type="number"
                placeholder="100"
                onCommit={(v) => {
                  const n = Number(v);
                  if (!Number.isFinite(n)) return;
                  onSettingsChange?.({ agentMaxSteps: Math.min(1000, Math.max(1, Math.floor(n))) });
                }}
              />
              <Field
                label="Approval timeout (minutes)"
                hint="Ask rules: how long a pending Allow/Deny prompt waits before the rule settles itself (1–60, default 2). Ask · deny denies; Ask · allow allows."
                value={String(s.agentApprovalTimeoutMinutes ?? 2)}
                disabled={!canPersist || settingsBusy}
                type="number"
                placeholder="2"
                onCommit={(v) => {
                  const n = Number(v);
                  if (!Number.isFinite(n)) return;
                  onSettingsChange?.({
                    agentApprovalTimeoutMinutes: Math.min(60, Math.max(1, Math.floor(n))),
                  });
                }}
              />
              <Field
                label="Allow / Deny revert (minutes)"
                hint="Composer Allow always auto-allows and Deny always auto-denies, then both revert to Ask · deny after this many minutes (1–240, default 15)."
                value={String(s.agentAllowDenyRevertMinutes ?? 15)}
                disabled={!canPersist || settingsBusy}
                type="number"
                placeholder="15"
                onCommit={(v) => {
                  const n = Number(v);
                  if (!Number.isFinite(n)) return;
                  onSettingsChange?.({
                    agentAllowDenyRevertMinutes: Math.min(240, Math.max(1, Math.floor(n))),
                  });
                }}
              />
            </div>
          </section>
        ) : null}

        {subTab === 'workspace' ? (
          <section>
            <h2 className="mb-2 text-base font-semibold">Workspace tools</h2>
            <p className="mb-3 text-xs text-gray-500">
              Detection checks whether Trail and Git are installed and initialized. Enforcement shows a red
              badge on that tab and the setup guide when something is missing. Turning detection off also
              clears enforcement for that tool.
            </p>
            <div className="space-y-4">
              <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-3">
                <h3 className="mb-2 text-sm font-medium text-gray-200">Trail</h3>
                <div className="space-y-3">
                  <SliderToggle
                    checked={s.detectTrail !== false}
                    disabled={!canPersist || settingsBusy}
                    onChange={(v) => onSettingsChange?.({ detectTrail: v, ...(v ? {} : { enforceTrail: false }) })}
                    label="Detect Trail CLI and .trail/cache graph"
                    hint="On dashboard load (and while the Trail tab is open), check for trail or the legacy graft CLI, plus .trail/cache/INDEX.md. Graft-only installs get upgrade steps."
                  />
                  <SliderToggle
                    checked={s.detectTrail !== false && s.enforceTrail !== false}
                    disabled={!canPersist || settingsBusy || s.detectTrail === false}
                    onChange={(v) => onSettingsChange?.({ enforceTrail: v })}
                    label="Enforce Trail (badge + setup guide)"
                    hint="When Trail is missing or uninitialized: red Trail-tab badge + setup steps, and Kusă chat is blocked until Trail is ready. Once ready, the agent must call kusa_trail_ask before file tools."
                  />
                </div>
              </div>
              <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-3">
                <h3 className="mb-2 text-sm font-medium text-gray-200">Git</h3>
                <div className="space-y-3">
                  <SliderToggle
                    checked={s.detectGit !== false}
                    disabled={!canPersist || settingsBusy}
                    onChange={(v) => onSettingsChange?.({ detectGit: v, ...(v ? {} : { enforceGit: false }) })}
                    label="Detect Git and working copy"
                    hint="On dashboard load (and while the Git tab is open), check that git is on PATH and this folder is a repository."
                  />
                  <SliderToggle
                    checked={s.detectGit !== false && s.enforceGit !== false}
                    disabled={!canPersist || settingsBusy || s.detectGit === false}
                    onChange={(v) => onSettingsChange?.({ enforceGit: v })}
                    label="Enforce Git (badge + setup guide)"
                    hint="When detection finds Git missing or the workspace is not a repo, mark the Git tab with a red badge and show install/init steps."
                  />
                </div>
              </div>
            </div>
            {!canPersist ? (
              <p className="mt-3 text-xs text-amber-400">
                Saving settings needs <code className="text-sky-300">npm run kusa:serve</code> (POST /settings).
                Opening the HTML from disk is view-only for these toggles.
              </p>
            ) : null}
          </section>
        ) : null}
    </div>
  );
}

function SliderToggle({ checked, disabled, onChange, label, hint }) {
  return (
    <div className={`flex items-start justify-between gap-4 text-sm ${disabled ? 'opacity-60' : ''}`}>
      <div className="min-w-0">
        <p className="font-medium text-gray-200">{label}</p>
        {hint ? <p className="mt-0.5 text-xs text-gray-500">{hint}</p> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange?.(!checked)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950 disabled:cursor-not-allowed ${
          checked ? 'bg-emerald-500' : 'bg-gray-700'
        }`}
      >
        <span
          aria-hidden="true"
          className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}
