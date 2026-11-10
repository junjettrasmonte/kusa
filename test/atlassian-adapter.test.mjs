import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeAtlassianSettingsPatch,
  normalizeAtlassianSettings,
  publicAtlassianSettings,
  textToAdf,
  adfToText,
} from '#extensions/atlassian-adapter/index.mjs';
import { loadMonitorSettings, saveMonitorSettings } from '#features/monitor/lib.mjs';
import { publicSettings } from '#features/settings/secrets.mjs';

describe('atlassian adapter settings', () => {
  it('normalizes host/email/project and strips trailing slash', () => {
    const n = normalizeAtlassianSettings({
      host: 'https://acme.atlassian.net/',
      email: ' you@acme.com ',
      projectKey: 'eng',
      apiToken: 'secret',
    });
    assert.equal(n.host, 'https://acme.atlassian.net');
    assert.equal(n.email, 'you@acme.com');
    assert.equal(n.projectKey, 'ENG');
    assert.equal(n.apiToken, 'secret');
  });

  it('public view never includes the token', () => {
    const pub = publicAtlassianSettings({
      host: 'https://acme.atlassian.net',
      email: 'you@acme.com',
      apiToken: 'secret',
      projectKey: 'ENG',
    });
    assert.equal(pub.apiTokenSet, true);
    assert.equal(pub.configured, true);
    assert.equal('apiToken' in pub, false);
    assert.equal('apiTokenEnc' in pub, false);
  });

  it('merge keeps an omitted token and clears an explicit empty string', () => {
    const current = normalizeAtlassianSettings({
      host: 'https://acme.atlassian.net',
      email: 'you@acme.com',
      apiToken: 'keep-me',
      projectKey: 'ENG',
    });
    const kept = mergeAtlassianSettingsPatch(current, { projectKey: 'OPS' });
    assert.equal(kept.apiToken, 'keep-me');
    assert.equal(kept.projectKey, 'OPS');
    const cleared = mergeAtlassianSettingsPatch(current, { apiToken: '' });
    assert.equal(cleared.apiToken, '');
  });

  it('encrypts apiToken on disk like agent API keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kusa-atlassian-'));
    try {
      saveMonitorSettings(dir, {
        atlassian: {
          host: 'https://acme.atlassian.net',
          email: 'you@acme.com',
          apiToken: 'tok-123',
          projectKey: 'ENG',
        },
      });
      const disk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
      assert.equal(disk.atlassian.apiToken, undefined);
      assert.ok(disk.atlassian.apiTokenEnc?.ct);
      const memory = loadMonitorSettings(dir);
      assert.equal(memory.atlassian.apiToken, 'tok-123');
      const pub = publicSettings(memory);
      assert.equal(pub.atlassian.apiTokenSet, true);
      assert.equal(pub.atlassian.apiToken, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips ADF helpers', () => {
    const adf = textToAdf('hello jira');
    assert.equal(adf.type, 'doc');
    assert.equal(adfToText(adf).trim(), 'hello jira');
  });
});
