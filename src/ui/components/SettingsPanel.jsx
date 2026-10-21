export function SettingsPanel({
  subTab,
  follow,
  onFollowChange,
  settings,
  sdkListener,
  canPersist,
  onSettingsChange,
  settingsBusy,
}) {
  const s = settings || {
    sdkListenerEnabled: true,
    collectReasoningEvents: true,
    persistReasoningText: false,
    detectTrail: true,
    enforceTrail: true,
    detectGit: true,
    enforceGit: true,
    agentBaseUrl: '',
    agentModel: 'gpt-4o-mini',
    agentMaxSteps: 100,
    agentAuthMode: 'none',
    agentApiKeySet: false,
    agentBackend: 'native',
    agentApprovalTimeoutMinutes: 2,
    agentAllowDenyRevertMinutes: 15,
  };
  const L = sdkListener || { status: 'idle' };
  const authApiKey = s.agentAuthMode === 'apikey' || s.agentAuthMode === 'bearer';
  const backendOpencode = s.agentBackend === 'opencode';
  const apiKeySet = s.agentApiKeySet === true;

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
              <code className="text-sky-300">/v1</code> endpoint. File tools are Kusă&apos;s own
              sandboxed read/write/list/grep (also advertised over MCP). OpenCode SDK mode needs the{' '}
              <code className="text-sky-300">opencode</code> CLI on PATH.
            </p>
            <div className="space-y-3 rounded-xl border border-gray-800 bg-gray-900/60 p-3">
              <Field
                label="Base URL"
                hint="Example: https://api.openai.com/v1 or http://127.0.0.1:11434/v1"
                value={s.agentBaseUrl || ''}
                disabled={!canPersist || settingsBusy}
                placeholder="https://api.openai.com/v1"
                onCommit={(v) => onSettingsChange?.({ agentBaseUrl: v })}
              />
              <Field
                label="Model"
                hint="Model id sent to the endpoint"
                value={s.agentModel || 'gpt-4o-mini'}
                disabled={!canPersist || settingsBusy}
                placeholder="gpt-4o-mini"
                onCommit={(v) => onSettingsChange?.({ agentModel: v })}
              />
              <div>
                <p className="mb-1 text-sm text-gray-300">Auth</p>
                <div className="flex flex-wrap gap-2">
                  <Choice
                    active={!authApiKey}
                    disabled={!canPersist || settingsBusy}
                    onClick={() => onSettingsChange?.({ agentAuthMode: 'none' })}
                    label="None"
                  />
                  <Choice
                    active={authApiKey}
                    disabled={!canPersist || settingsBusy}
                    onClick={() => onSettingsChange?.({ agentAuthMode: 'apikey' })}
                    label="API key"
                  />
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  None sends no auth. API key is sent as{' '}
                  <code className="text-sky-300">Authorization: Bearer &lt;key&gt;</code>{' '}
                  (OpenAI-compatible).
                </p>
              </div>
              {authApiKey ? (
                <Field
                  label="API key"
                  hint="Encrypted at rest in .kusa/settings.json (master key in ~/.config/kusa/). Leave blank to keep the current key."
                  value=""
                  disabled={!canPersist || settingsBusy}
                  placeholder={apiKeySet ? '••••••••' : 'sk-…'}
                  type="password"
                  resetKey={apiKeySet ? 'set' : 'empty'}
                  onCommit={(v) => {
                    const next = String(v || '').trim();
                    if (!next) return; // empty blur = leave encrypted secret unchanged
                    onSettingsChange?.({ agentApiKey: next });
                  }}
                />
              ) : null}
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

        {subTab === 'playback' ? (
          <section>
            <h2 className="mb-2 text-base font-semibold">Playback</h2>
            <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-3">
              <SliderToggle
                checked={follow}
                onChange={onFollowChange}
                label="Follow latest activity"
                hint="When on, the console tracks the newest session automatically. Turn off to keep the session you selected pinned."
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

        {subTab === 'sdk' ? (
          <section>
            <h2 className="mb-2 text-base font-semibold">SDK session listener</h2>
            <p className="mb-3 text-sm text-gray-400">
              Status:{' '}
              <span className={statusClass(L.status)}>{L.status || 'idle'}</span>
              {L.target ? ` · ${L.target}` : ''}
              {L.lastEventType ? ` · last ${L.lastEventType}` : ''}
            </p>
            {L.detail ? <p className="mb-3 text-xs text-gray-500">{L.detail}</p> : null}
            <div className="space-y-3 rounded-xl border border-gray-800 bg-gray-900/60 p-3">
              <SliderToggle
                checked={s.sdkListenerEnabled !== false}
                disabled={!canPersist || settingsBusy}
                onChange={(v) => onSettingsChange?.({ sdkListenerEnabled: v })}
                label="Enable Copilot CLI SDK listener"
                hint="Applies when Copilot CLI loads .github/extensions/kusa-session-listener/. VS Code Copilot Chat and Cursor cannot join via joinSession(); they stay hooks-only."
              />
              <SliderToggle
                checked={s.collectReasoningEvents !== false}
                disabled={!canPersist || settingsBusy}
                onChange={(v) => onSettingsChange?.({ collectReasoningEvents: v })}
                label="Collect reasoning events"
                hint="Records reasoning activity status and timing only. Raw reasoning text is not stored unless the option below is on."
              />
              <SliderToggle
                checked={s.persistReasoningText === true}
                disabled={!canPersist || settingsBusy || s.collectReasoningEvents === false}
                onChange={(v) => onSettingsChange?.({ persistReasoningText: v })}
                label="Persist raw reasoning text (off by default)"
                hint="Privacy-sensitive. Leave off unless you explicitly need the text on disk."
              />
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

function Choice({ active, disabled, onClick, label }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300'
          : 'border-gray-700 bg-gray-950 text-gray-400 hover:border-gray-600 hover:text-gray-200'
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {label}
    </button>
  );
}

function Field({ label, hint, value, disabled, placeholder, onCommit, type = 'text', resetKey }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-gray-300">{label}</span>
      <input
        type={type}
        defaultValue={value}
        key={`${label}:${resetKey ?? value}`}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onBlur={(e) => {
          const next = e.target.value;
          if (next !== value) onCommit?.(next);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          }
        }}
        className="w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-1.5 font-mono text-sm text-gray-100 placeholder:text-gray-600 disabled:opacity-50"
      />
      {hint ? <span className="mt-1 block text-xs text-gray-500">{hint}</span> : null}
    </label>
  );
}

function statusClass(status) {
  if (status === 'connected') return 'text-emerald-400';
  if (status === 'connecting') return 'text-sky-400';
  if (status === 'unsupported' || status === 'error') return 'text-amber-400';
  if (status === 'disconnected') return 'text-gray-400';
  return 'text-gray-500';
}
