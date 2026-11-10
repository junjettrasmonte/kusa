import { useState } from 'react';
import { Choice, Field } from '#ui/shared/SettingsControls.jsx';

export function AuthSettingsPanel({ settings, canPersist, onSettingsChange, settingsBusy }) {
  const s = settings || {};
  const mode = s.authMode || 'local';
  const oidc = s.authOidc || {};
  const saml = s.authSaml || {};
  const disabled = !canPersist || settingsBusy;
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [oidcSecret, setOidcSecret] = useState('');
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:1424';

  function patchAuth(partial) {
    onSettingsChange?.({ auth: partial });
  }

  function savePassword(event) {
    event.preventDefault();
    if (!password || password !== password2) return;
    patchAuth({ local: { password } });
    setPassword('');
    setPassword2('');
  }

  return (
    <section>
      <h2 className="mb-2 text-base font-semibold">Authentication</h2>
      <p className="mb-3 text-xs text-gray-500">
        Gate the console behind a local password + TOTP (default), or switch to OIDC / SAML SSO.
        Credentials use the same secrets store as agent API keys — encrypted in{' '}
        <code className="text-sky-300">.kusa/settings.json</code> (
        <code className="text-sky-300">~/.config/kusa/master.key</code>).
      </p>

      <div className="mb-6">
        <p className="mb-1 text-sm text-gray-300">Sign-in mode</p>
        <div className="flex flex-wrap gap-2">
          <Choice
            active={mode === 'local'}
            disabled={disabled}
            onClick={() => patchAuth({ mode: 'local' })}
            label="Username + password + TOTP"
          />
          <Choice
            active={mode === 'oidc'}
            disabled={disabled}
            onClick={() => patchAuth({ mode: 'oidc' })}
            label="OIDC"
          />
          <Choice
            active={mode === 'saml'}
            disabled={disabled}
            onClick={() => patchAuth({ mode: 'saml' })}
            label="SAML"
          />
        </div>
      </div>

      {mode === 'local' ? (
        <div className="space-y-4 rounded-xl border border-gray-800 bg-gray-900/60 p-3">
          <p className="text-sm text-gray-300">
            Admin user:{' '}
            <span className="font-medium text-gray-100">{s.authUsername || '(not set)'}</span>
            {s.totpEnabled ? (
              <span className="ml-2 text-xs text-emerald-400">TOTP on</span>
            ) : (
              <span className="ml-2 text-xs text-amber-400">TOTP off</span>
            )}
          </p>
          <Field
            label="Username"
            value={s.authUsername || ''}
            disabled={disabled}
            onCommit={(value) => patchAuth({ local: { username: value } })}
          />
          <form onSubmit={savePassword} className="space-y-3">
            <label className="block text-xs text-gray-400">
              New password
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                disabled={disabled}
                onChange={(event) => setPassword(event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-emerald-500"
                minLength={8}
              />
            </label>
            <label className="block text-xs text-gray-400">
              Confirm password
              <input
                type="password"
                autoComplete="new-password"
                value={password2}
                disabled={disabled}
                onChange={(event) => setPassword2(event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-emerald-500"
                minLength={8}
              />
            </label>
            <button
              type="submit"
              disabled={disabled || password.length < 8 || password !== password2}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
            >
              Update password
            </button>
          </form>
          <p className="text-xs text-gray-500">
            To rotate TOTP, sign out and run setup again is not supported yet — clear auth from
            settings.json or re-enroll by resetting the local block (advanced).
          </p>
        </div>
      ) : null}

      {mode === 'oidc' ? (
        <div className="space-y-3 rounded-xl border border-gray-800 bg-gray-900/60 p-3">
          <Field
            label="Issuer URL"
            value={oidc.issuer || ''}
            disabled={disabled}
            onCommit={(value) => patchAuth({ oidc: { issuer: value } })}
          />
          <Field
            label="Client ID"
            value={oidc.clientId || ''}
            disabled={disabled}
            onCommit={(value) => patchAuth({ oidc: { clientId: value } })}
          />
          <Field
            label="Scopes"
            value={oidc.scopes || 'openid profile email'}
            disabled={disabled}
            onCommit={(value) => patchAuth({ oidc: { scopes: value } })}
          />
          <label className="block text-xs text-gray-400">
            Client secret {oidc.clientSecretSet ? '(set)' : '(not set)'}
            <input
              type="password"
              autoComplete="off"
              value={oidcSecret}
              disabled={disabled}
              placeholder={oidc.clientSecretSet ? '•••••••• (leave blank to keep)' : ''}
              onChange={(event) => setOidcSecret(event.target.value)}
              onBlur={() => {
                if (!oidcSecret) return;
                patchAuth({ oidc: { clientSecret: oidcSecret } });
                setOidcSecret('');
              }}
              className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-emerald-500"
            />
          </label>
          <p className="text-xs text-gray-500">
            Callback URL:{' '}
            <code className="text-sky-300">{origin}/auth/oidc/callback</code>
          </p>
        </div>
      ) : null}

      {mode === 'saml' ? (
        <div className="space-y-3 rounded-xl border border-gray-800 bg-gray-900/60 p-3">
          <Field
            label="SP entity ID"
            value={saml.entityId || ''}
            disabled={disabled}
            onCommit={(value) => patchAuth({ saml: { entityId: value } })}
          />
          <Field
            label="IdP metadata URL"
            value={saml.idpMetadataUrl || ''}
            disabled={disabled}
            onCommit={(value) => patchAuth({ saml: { idpMetadataUrl: value } })}
          />
          <label className="block text-xs text-gray-400">
            IdP metadata XML {saml.idpMetadataXmlSet ? '(set)' : '(optional if URL set)'}
            <textarea
              rows={4}
              disabled={disabled}
              defaultValue=""
              placeholder="Paste IdP metadata XML…"
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (!value) return;
                patchAuth({ saml: { idpMetadataXml: value } });
                event.target.value = '';
              }}
              className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-xs text-gray-100 outline-none focus:border-emerald-500"
            />
          </label>
          <p className="text-xs text-gray-500">
            ACS URL: <code className="text-sky-300">{origin}/auth/saml/acs</code>
            <br />
            SP metadata:{' '}
            <a className="text-sky-300 underline" href="/auth/saml/metadata" target="_blank" rel="noreferrer">
              /auth/saml/metadata
            </a>
          </p>
        </div>
      ) : null}

      <div className="mt-6">
        <button
          type="button"
          disabled={disabled}
          onClick={async () => {
            await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
            window.location.reload();
          }}
          className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:border-gray-500 hover:text-gray-100 disabled:opacity-40"
        >
          Sign out
        </button>
      </div>

      {!canPersist ? (
        <p className="mt-3 text-xs text-amber-400">
          Saving settings needs <code className="text-sky-300">kusa serve</code>.
        </p>
      ) : null}
    </section>
  );
}
