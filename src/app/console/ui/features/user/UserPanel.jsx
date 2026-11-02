import { AuthSettingsPanel } from '#ui/features/settings/AuthSettingsPanel.jsx';
import { LucideIcon } from '#ui/shared/LucideIcons.jsx';

function initials(name) {
  const parts = String(name || '')
    .trim()
    .split(/[\s._@-]+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
}

/**
 * Account page — Appearance (dark mode) first, login settings below.
 * Opened from the right-rail avatar under the theme toggle.
 */
export function UserPanel({
  settings,
  canPersist,
  onSettingsChange,
  settingsBusy,
  theme = 'dark',
  onThemeChange,
}) {
  const username = settings?.authUsername || 'Account';
  const themeLabel = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';

  return (
    <div id="panel-user" role="tabpanel" aria-labelledby="tab-user" className="space-y-8">
      <header className="flex items-center gap-3">
        <span
          className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/20 text-sm font-semibold text-emerald-300"
          aria-hidden="true"
        >
          {initials(username)}
        </span>
        <div>
          <h1 className="text-base font-semibold text-gray-100">{username}</h1>
          <p className="text-xs text-gray-500">Account and sign-in</p>
        </div>
      </header>

      <section>
        <h2 className="mb-2 text-base font-semibold">Appearance</h2>
        <p className="mb-3 text-xs text-gray-500">
          Console color theme. The sun/moon control on the right rail does the same.
        </p>
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-800 bg-gray-900/60 p-3">
          <button
            type="button"
            title={themeLabel}
            aria-label={themeLabel}
            onClick={() => onThemeChange?.(theme === 'light' ? 'dark' : 'light')}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-gray-700 text-gray-300 hover:border-gray-500 hover:text-gray-100"
          >
            {theme === 'light' ? (
              <LucideIcon name="moon" />
            ) : (
              <LucideIcon name="sun" />
            )}
          </button>
          <div className="min-w-0 text-sm">
            <p className="font-medium text-gray-200">
              {theme === 'light' ? 'Light mode' : 'Dark mode'}
            </p>
            <p className="text-xs text-gray-500">Click to switch</p>
          </div>
        </div>
      </section>

      <AuthSettingsPanel
        settings={settings}
        canPersist={canPersist}
        onSettingsChange={onSettingsChange}
        settingsBusy={settingsBusy}
      />
    </div>
  );
}

export function userAvatarInitials(name) {
  return initials(name);
}
