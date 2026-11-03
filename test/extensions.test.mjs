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
  it('lists CAO, Live Chat, and provider adapters (Kusa CLI is a core feature)', () => {
    assert.equal(BUILTIN_EXTENSIONS.length, 4);
    const cao = BUILTIN_EXTENSIONS[0];
    assert.equal(cao.id, 'cao');
    assert.equal(cao.builtin, true);
    assert.equal(cao.root, 'extensions/cli-agent-orchestrator');
    assert.equal(cao.providerId, undefined);
    assert.equal(getBuiltinExtension('cao')?.name, 'CLI Agent Orchestrator');
    assert.equal(getBuiltinExtension('kusa-cli'), null);

    const live = BUILTIN_EXTENSIONS[1];
    assert.equal(live.id, 'live-chat');
    assert.equal(live.builtin, true);
    assert.equal(live.root, 'extensions/live-chat');
    assert.equal(getBuiltinExtension('live-chat')?.name, 'Live Chat');

    const cursor = getBuiltinExtension('cursor-adapter');
    assert.equal(cursor?.name, 'Cursor Adapter');
    assert.equal(cursor?.root, 'extensions/cursor-adapter');
    assert.equal(cursor?.nav, undefined);

    const copilot = getBuiltinExtension('github-copilot-adapter');
    assert.equal(copilot?.name, 'GitHub Copilot Adapter');
    assert.equal(copilot?.root, 'extensions/github-copilot-adapter');
    assert.equal(copilot?.nav, undefined);
  });

  it('places installed CAO and Live Chat on Dev Tools', () => {
    const cao = getBuiltinExtension('cao');
    assert.equal(isExtensionInstalled(cao), true);
    assert.equal(cao.nav?.placement, 'devtools');
    assert.equal(cao.nav?.id, 'cao');
    assert.equal(cao.nav?.label, 'CAO');
    assert.equal(cao.nav?.icon, 'network');
    assert.equal(extensionNavIcon('cao'), 'network');
    assert.ok(resolveExtensionNav(cao)?.nav);

    const live = getBuiltinExtension('live-chat');
    assert.equal(isExtensionInstalled(live), true);
    assert.equal(live.nav?.placement, 'devtools');
    assert.equal(live.nav?.id, 'live-chat');
    assert.equal(live.nav?.label, 'Live Chat');
    assert.equal(live.nav?.icon, 'audio-lines');
    assert.equal(extensionNavIcon('live-chat'), 'audio-lines');
    assert.ok(resolveExtensionNav(live)?.nav);

    const entries = extensionNavEntries('devtools');
    assert.ok(entries.some((e) => e.id === 'cao' && e.extensionId === 'cao'));
    assert.ok(entries.some((e) => e.id === 'live-chat' && e.extensionId === 'live-chat'));

    const { ids, labels } = resolveDevtoolsSubTabs();
    assert.deepEqual(ids.slice(0, 2), ['git', 'trail']);
    assert.ok(ids.includes('cao'));
    assert.ok(ids.includes('live-chat'));
    assert.equal(labels.cao, 'CAO');
    assert.equal(labels['live-chat'], 'Live Chat');
  });
});
