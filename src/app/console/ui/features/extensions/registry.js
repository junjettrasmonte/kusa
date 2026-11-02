/**
 * Built-in console extensions. Order is display order.
 * Third-party / workspace extensions can append later; this list is the
 * always-shipped catalog under Sidebar › Extensions.
 *
 * Once an extension is installed it may declare `nav` — where its menu item
 * lives in the console chrome (today: right-rail Dev Tools). `nav.icon` is a
 * lucide icon name resolved by LucideIcons.jsx.
 *
 * The Kusă agent CLI (`kusa agent`) is a standalone first-class feature under
 * `src/features/kusa-cli/`. An optional CAO provider pack lives beside it at
 * `cao-provider/` — not an extension.
 */
import {
  DEVTOOLS_SUBTAB_IDS as CORE_DEVTOOLS_SUBTAB_IDS,
  DEVTOOLS_SUBTAB_LABELS as CORE_DEVTOOLS_SUBTAB_LABELS,
} from '#ui/shared/lib/format.js';

export const BUILTIN_EXTENSIONS = [
  {
    id: 'cao',
    name: 'CLI Agent Orchestrator',
    shortName: 'CAO',
    /** On-disk home: extensions/cli-agent-orchestrator/ */
    root: 'extensions/cli-agent-orchestrator',
    builtin: true,
    /** Built-ins ship installed; workspace extensions flip this after install. */
    installed: true,
    description:
      'Local multi-agent orchestration (awslabs CLI Agent Orchestrator). Manage cao-server, providers, and profiles.',
    detail:
      'Manage cao-server status, detected provider CLIs, and connection profiles. Requires cao-server on PATH. Kusă’s standalone CLI (`kusa agent`) can optionally register as provider kusa_cli (src/features/kusa-cli/cao-provider/).',
    nav: {
      /** Right-rail Developer Tools submenu. */
      placement: 'devtools',
      /** Sub-tab id under that placement (defaults to extension id). */
      id: 'cao',
      label: 'CAO',
      /** Lucide icon name — see LucideIcons.jsx. */
      icon: 'network',
    },
  },
];

export function getBuiltinExtension(id) {
  return BUILTIN_EXTENSIONS.find((ext) => ext.id === id) || null;
}

/** Built-ins count as installed; others need `installed: true`. */
export function isExtensionInstalled(ext) {
  return Boolean(ext && (ext.installed || ext.builtin));
}

export function installedExtensions() {
  return BUILTIN_EXTENSIONS.filter(isExtensionInstalled);
}

/**
 * Nav target for an extension — only its own `nav`.
 */
export function resolveExtensionNav(ext) {
  if (!ext || !isExtensionInstalled(ext) || !ext.nav) return null;
  return { ext, nav: ext.nav };
}

/**
 * Nav entries for installed extensions that place a menu item at `placement`.
 * @param {'devtools'} placement
 */
export function extensionNavEntries(placement) {
  return installedExtensions()
    .filter((ext) => ext.nav?.placement === placement)
    .map((ext) => ({
      id: ext.nav.id || ext.id,
      label: ext.nav.label || ext.shortName || ext.name,
      icon: ext.nav.icon || null,
      extensionId: ext.id,
    }));
}

/** Lucide icon name for a Dev Tools (or other) sub-tab contributed by an extension. */
export function extensionNavIcon(subTabId) {
  for (const ext of installedExtensions()) {
    const id = ext.nav?.id || ext.id;
    if (id === subTabId && ext.nav?.icon) return ext.nav.icon;
  }
  return null;
}

/** Core Dev Tools ids/labels plus installed extension nav placements. */
export function resolveDevtoolsSubTabs() {
  const ids = [...CORE_DEVTOOLS_SUBTAB_IDS];
  const labels = { ...CORE_DEVTOOLS_SUBTAB_LABELS };
  for (const entry of extensionNavEntries('devtools')) {
    if (!ids.includes(entry.id)) ids.push(entry.id);
    labels[entry.id] = entry.label;
  }
  return { ids, labels };
}
