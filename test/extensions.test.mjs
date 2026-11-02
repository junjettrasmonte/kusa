import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BUILTIN_EXTENSIONS,
  extensionNavEntries,
  extensionNavIcon,
  getBuiltinExtension,
  isExtensionInstalled,
  resolveDevtoolsSubTabs,
  resolveExtensionNav,
} from '../src/app/console/ui/features/extensions/registry.js';

describe('built-in extensions', () => {
  it('lists CLI Agent Orchestrator only (Kusa CLI is a core feature)', () => {
    assert.equal(BUILTIN_EXTENSIONS.length, 1);
    const cao = BUILTIN_EXTENSIONS[0];
    assert.equal(cao.id, 'cao');
    assert.equal(cao.builtin, true);
    assert.equal(cao.root, 'extensions/cli-agent-orchestrator');
    assert.equal(cao.providerId, undefined);
    assert.equal(getBuiltinExtension('cao')?.name, 'CLI Agent Orchestrator');
    assert.equal(getBuiltinExtension('kusa-cli'), null);
  });

  it('places installed CAO on Dev Tools', () => {
    const cao = getBuiltinExtension('cao');
    assert.equal(isExtensionInstalled(cao), true);
    assert.equal(cao.nav?.placement, 'devtools');
    assert.equal(cao.nav?.id, 'cao');
    assert.equal(cao.nav?.label, 'CAO');
    assert.equal(cao.nav?.icon, 'network');
    assert.equal(extensionNavIcon('cao'), 'network');
    assert.ok(resolveExtensionNav(cao)?.nav);

    const entries = extensionNavEntries('devtools');
    assert.ok(entries.some((e) => e.id === 'cao' && e.extensionId === 'cao'));

    const { ids, labels } = resolveDevtoolsSubTabs();
    assert.deepEqual(ids.slice(0, 2), ['git', 'trail']);
    assert.ok(ids.includes('cao'));
    assert.equal(labels.cao, 'CAO');
  });
});
