/**
 * OpenAI-compatible endpoints, one collapsible card each — the Default endpoint first.
 *
 * The Default card is the endpoint the top-level agentBaseUrl / agentAuthMode /
 * agentApiKey fields describe, and it keeps writing exactly those fields: every
 * existing caller, and a settings file written before this page ever offered
 * another endpoint, still resolves to one working endpoint. The cards after it
 * come from agentEndpoints, and each one carries its OWN base URL, key, and
 * model ids — a card's edit can never move the Default endpoint's.
 *
 * A lucide plus beside the Endpoints heading opens the add form. A card is a
 * <details> disclosure with a lucide chevron on the right of the header:
 * collapsed it names the endpoint and states what it would send; open it is
 * editable. Every card starts collapsed so the page stays short until one is
 * opened.
 *
 * The ids typed here (comma-delimited) are what the chat Model picker lists,
 * grouped by these same names — and what resolveAgentEndpoint routes a pick
 * back through, so the group heading a model sits under is the credentials
 * that model would actually use.
 */
import { useState } from 'react';
import { Choice, Field } from '#ui/shared/SettingsControls.jsx';
import { IconButton, TrashIcon } from '#ui/shared/IconButton.jsx';
import { LucideIcon } from '#ui/shared/LucideIcons.jsx';

/** Must match monitor lib.mjs MAX_AGENT_ENDPOINTS — a thirteenth card would be dropped on save. */
const MAX_ENDPOINTS = 12;

function LucidePlusIcon({ className = 'h-3.5 w-3.5' }) {
  return <LucideIcon name="plus" className={className} strokeWidth={2} />;
}

/** Right-of-header disclosure glyph: points right when collapsed, down when open. */
function CardChevron({ open }) {
  return (
    <LucideIcon
      name="chevron-down"
      className={`h-4 w-4 shrink-0 text-gray-500 transition-transform ${open ? '' : '-rotate-90'}`}
      strokeWidth={2}
    />
  );
}

function CardSummary({ open, children }) {
  return (
    <summary className="cursor-pointer list-none px-3 py-2.5 [&::-webkit-details-marker]:hidden">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-gray-400">
          {children}
        </div>
        <CardChevron open={open} />
      </div>
    </summary>
  );
}

/**
 * @param {object} defaultEndpoint { baseUrl, model, authMode, apiKeySet, models }
 * @param {Array<object>} endpoints the extra endpoints (browser-safe: apiKeySet, never apiKey)
 * @param {boolean} [canPersist]
 * @param {boolean} [settingsBusy] another save is already running
 * @param {(patch) => void} [onSettingsChange] routes a committed change to POST /settings
 */
export function AgentEndpointsPanel({ defaultEndpoint, endpoints, canPersist, onSettingsChange, settingsBusy }) {
  const [collapsedDefault, setCollapsedDefault] = useState(true);
  const [expandedIds, setExpandedIds] = useState([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', baseUrl: '', models: '', apiKey: '' });

  const d = defaultEndpoint || { baseUrl: '', model: '', authMode: 'none', apiKeySet: false, models: [] };
  const extras = Array.isArray(endpoints) ? endpoints : [];
  // A save already running (App.jsx settingsBusy) is what makes a field read-only;
  // two writes at once would race on the same settings.json.
  const disabled = !canPersist || settingsBusy;
  const atLimit = extras.length >= MAX_ENDPOINTS;
  const authApiKey = (value) => value === 'apikey' || value === 'bearer';

  // One endpoint's fields, committed as one change set. The caller maps it to
  // the fields THAT endpoint owns — the top-level ones for the Default card, a
  // whole-list rewrite for an added card — so a card can never write into
  // another card's settings.
  function saveExtra(entry, changes) {
    if (!onSettingsChange) return;
    const next = extras.map((other) => (other?.id) === entry.id ? { ...other, ...changes } : other);
    onSettingsChange({ agentEndpoints: next });
  }

  function resetDraft() {
    setDraft({ name: '', baseUrl: '', models: '', apiKey: '' });
  }

  function startAdd() {
    if (!canPersist || atLimit || settingsBusy) return;
    setAdding(true);
  }

  function cancelAdd() {
    setAdding(false);
    resetDraft();
  }

  function addEndpoint(event) {
    event.preventDefault();
    if (!canPersist || atLimit) return;
    const name = String(draft.name || '').trim();
    const baseUrl = String(draft.baseUrl || '').trim();
    if (!name || !baseUrl) return; // a half-typed draft stays in the form
    onSettingsChange?.({
      agentEndpoints: [
        ...extras,
        {
          name,
          baseUrl,
          // A typed key is the only credential an added endpoint can have, so it
          // also states the auth class: no key means no Authorization header.
          authMode: draft.apiKey.trim() ? 'apikey' : 'none',
          apiKey: String(draft.apiKey || '').trim(),
          models: String(draft.models || ''),
        },
      ],
    });
    setAdding(false);
    resetDraft();
  }

  function toggleExtra(id, open) {
    if (!id) return;
    setExpandedIds((prev) => (
      open
        ? (prev.includes(id) ? prev : [...prev, id])
        : prev.filter((other) => other !== id)
    ));
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="mb-0 flex-1 text-sm font-medium text-gray-200">Endpoints</h3>
        <IconButton
          label="Add OpenAI-compatible endpoint"
          icon={LucidePlusIcon}
          variant="primary"
          disabled={disabled || atLimit || adding}
          onClick={startAdd}
        />
      </div>
      <p className="text-xs text-gray-500">
        Every OpenAI-compatible <code className="text-sky-300">/v1</code> endpoint a chat may use, each
        with its own base URL, key, and model ids. The <span className="font-medium text-gray-300">Default</span>{' '}
        endpoint is what a session runs on until its Model picker is used; the rest are listed under their own
        names in that picker, so a pick always says which credentials it would send. Click a card to open or
        collapse it.
      </p>
      {atLimit ? (
        <p className="text-xs text-amber-400">
          {MAX_ENDPOINTS} endpoints is the ceiling — remove one before adding another.
        </p>
      ) : null}

      {/*
       * The Default endpoint: same card shape as the rest, but its fields commit
       * to the top-level agent* fields, and it cannot be removed — a workspace
       * with no endpoint at all has nothing to answer with.
       */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/40">
        <details open={!collapsedDefault} onToggle={(event) => setCollapsedDefault(!event.currentTarget.open)}>
          <CardSummary open={!collapsedDefault}>
            <span className="font-semibold text-gray-200">Default</span>
            <span className="font-mono">{d.baseUrl || 'no base URL set'}</span>
            <span>{authApiKey(d.authMode) ? 'API key' : 'no auth'}</span>
            <span className="tabular-nums">
              {d.models.length ? `${d.models.length} declared models` : 'models from GET /models'}
            </span>
          </CardSummary>
          <div className="space-y-3 border-t border-gray-800 px-3 py-2.5">
            <Field
              label="Base URL"
              hint="Any OpenAI-compatible /v1 endpoint (cloud or local)."
              value={d.baseUrl || ''}
              disabled={disabled}
              placeholder="https://api.openai.com/v1"
              resetKey={d.baseUrl}
              onCommit={(v) => onSettingsChange?.({ agentBaseUrl: v })}
            />
            <div>
              <p className="mb-1 text-sm text-gray-300">Auth</p>
              <div className="flex flex-wrap gap-2">
                <Choice
                  active={!authApiKey(d.authMode)}
                  disabled={disabled}
                  onClick={() => onSettingsChange?.({ agentAuthMode: 'none' })}
                  label="None"
                />
                <Choice
                  active={authApiKey(d.authMode)}
                  disabled={disabled}
                  onClick={() => onSettingsChange?.({ agentAuthMode: 'apikey' })}
                  label="API key"
                />
              </div>
              <p className="mt-1 text-xs text-gray-500">
                None sends no auth. API key is sent as{' '}
                <code className="text-sky-300">Authorization: Bearer &lt;key&gt;</code>.
              </p>
            </div>
            {authApiKey(d.authMode) ? (
              <Field
                label="API key"
                hint="Encrypted at rest in .kusa/settings.json (master key in ~/.config/kusa/). Leave blank to keep the current key."
                value=""
                disabled={disabled}
                placeholder={d.apiKeySet ? '••••••••' : 'sk-…'}
                type="password"
                resetKey={d.apiKeySet ? 'set' : 'empty'}
                onCommit={(v) => {
                  const next = String(v || '').trim();
                  if (!next) return; // an empty blur leaves the encrypted secret unchanged
                  onSettingsChange?.({ agentApiKey: next });
                }}
              />
            ) : null}
            <Field
              label="Default model"
              hint="The model a session uses when its Model picker is not opened. It must be one this endpoint serves."
              value={d.model || 'gpt-4o-mini'}
              disabled={disabled}
              placeholder="gpt-4o-mini"
              resetKey={d.model}
              onCommit={(v) => onSettingsChange?.({ agentModel: v })}
            />
            <Field
              label="Models (comma-delimited)"
              hint="Model ids this endpoint serves. Leave blank to list whatever its GET /models advertises."
              value={(d.models || []).join(', ')}
              disabled={disabled}
              placeholder="gpt-4o-mini, o3-mini"
              resetKey={(d.models || []).join(', ')}
              onCommit={(v) => onSettingsChange?.({ agentModels: v })}
            />
          </div>
        </details>
      </div>

      {extras.map((entry, index) => {
        const open = expandedIds.includes(entry?.id);
        return (
          <div key={entry?.id || `endpoint-${index}`} className="rounded-xl border border-gray-800 bg-gray-900/40">
            <details
              open={open}
              onToggle={(event) => toggleExtra(entry?.id, event.currentTarget.open)}
            >
              <CardSummary open={open}>
                <span className="font-semibold text-gray-200">{entry.name || `Endpoint ${index + 1}`}</span>
                <span className="font-mono">{entry.baseUrl}</span>
                <span>{authApiKey(entry.authMode) ? 'API key' : 'no auth'}</span>
                <span className="tabular-nums">
                  {(entry.models || []).length ? `${entry.models.length} models` : 'probed models'}
                </span>
              </CardSummary>
              <div className="space-y-3 border-t border-gray-800 px-3 py-2.5">
                <Field
                  label="Name"
                  hint="How the Model picker will label this endpoint (max 40 characters)."
                  value={entry.name || ''}
                  disabled={disabled}
                  placeholder="Acme Proxy"
                  resetKey={entry.name}
                  onCommit={(v) => saveExtra(entry, { name: v })}
                />
                <Field
                  label="Base URL"
                  hint="This endpoint&apos;s own /v1 address — the Default one is untouched by it."
                  value={entry.baseUrl || ''}
                  disabled={disabled}
                  placeholder="https://api.acme.test/v1"
                  resetKey={entry.baseUrl}
                  onCommit={(v) => saveExtra(entry, { baseUrl: v })}
                />
                <div>
                  <p className="mb-1 text-sm text-gray-300">Auth</p>
                  <div className="flex flex-wrap gap-2">
                    <Choice
                      active={!authApiKey(entry.authMode)}
                      disabled={disabled}
                      onClick={() => saveExtra(entry, { authMode: 'none' })}
                      label="None"
                    />
                    <Choice
                      active={authApiKey(entry.authMode)}
                      disabled={disabled}
                      onClick={() => saveExtra(entry, { authMode: 'apikey' })}
                      label="API key"
                    />
                  </div>
                </div>
                {authApiKey(entry.authMode) ? (
                  <Field
                    label="API key"
                    hint="Encrypted at rest, one key per endpoint. Leave blank to keep the current key."
                    value=""
                    disabled={disabled}
                    placeholder={entry.apiKeySet ? '••••••••' : 'sk-…'}
                    type="password"
                    resetKey={entry.apiKeySet ? 'set' : 'empty'}
                    onCommit={(v) => {
                      const next = String(v || '').trim();
                      if (!next) return; // an empty blur leaves the stored key unchanged
                      saveExtra(entry, { apiKey: next });
                    }}
                  />
                ) : null}
                <Field
                  label="Models (comma-delimited)"
                  hint="The Model picker lists these under this endpoint&apos;s name. Leave blank to list whatever this endpoint&apos;s GET /models advertises."
                  value={(entry.models || []).join(', ')}
                  disabled={disabled}
                  placeholder="model-one, model-two"
                  resetKey={(entry.models || []).join(', ')}
                  onCommit={(v) => saveExtra(entry, { models: v })}
                />
                <div className="flex justify-end">
                  <IconButton
                    label="Remove this endpoint"
                    icon={TrashIcon}
                    onClick={() => onSettingsChange?.({
                      agentEndpoints: extras.filter((other) => (other?.id) !== entry?.id),
                    })}
                    disabled={disabled}
                  />
                </div>
              </div>
            </details>
          </div>
        );
      })}

      {adding ? (
        <form
          onSubmit={addEndpoint}
          className="space-y-3 rounded-xl border border-emerald-500/40 bg-gray-900/40 p-3"
        >
          <p className="text-sm font-medium text-gray-200">New endpoint</p>
          <Field
            label="Endpoint name"
            hint="How the Model picker will label this endpoint (max 40 characters)."
            value={draft.name}
            disabled={disabled || atLimit}
            placeholder="Acme Proxy"
            resetKey={draft.name}
            onCommit={(v) => setDraft((prev) => ({ ...prev, name: v }))}
          />
          <Field
            label="Base URL"
            hint="Example: https://api.acme.test/v1 or http://127.0.0.1:11434/v1"
            value={draft.baseUrl}
            disabled={disabled || atLimit}
            placeholder="https://api.acme.test/v1"
            resetKey={draft.baseUrl}
            onCommit={(v) => setDraft((prev) => ({ ...prev, baseUrl: v }))}
          />
          <Field
            label="Models (comma-delimited)"
            hint="Model ids this endpoint serves, e.g. gpt-4o-mini, llama-3.1-70b. Leave blank to list whatever its GET /models advertises."
            value={draft.models}
            disabled={disabled || atLimit}
            placeholder="model-one, model-two"
            resetKey={draft.models}
            onCommit={(v) => setDraft((prev) => ({ ...prev, models: v }))}
          />
          <Field
            label="API key (optional)"
            hint="Sent as Authorization: Bearer &lt;key&gt; and encrypted at rest in .kusa/settings.json. Leave blank for an endpoint with no auth."
            value=""
            disabled={disabled || atLimit}
            placeholder="sk-…"
            type="password"
            resetKey="empty"
            onCommit={(v) => {
              const next = String(v || '').trim();
              if (!next) return;
              setDraft((prev) => ({ ...prev, apiKey: next }));
            }}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={cancelAdd}
              className="rounded-md border border-gray-700 bg-gray-950 px-2.5 py-1 text-xs font-medium text-gray-400 hover:border-gray-600 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
            <IconButton
              type="submit"
              label="Save endpoint"
              icon={LucidePlusIcon}
              variant="primary"
              disabled={disabled || atLimit || !draft.name.trim() || !draft.baseUrl.trim()}
            />
          </div>
        </form>
      ) : null}

      {!extras.length && !adding ? (
        <p className="text-xs text-gray-500">
          No extra endpoints yet. The plus above adds one — its models then appear in the chat Model picker
          under this endpoint&apos;s name.
        </p>
      ) : null}
    </div>
  );
}
