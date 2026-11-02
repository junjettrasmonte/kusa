import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildProfileDocument,
  emptyCaoStatus,
  parseProfileDocument,
  resolveCaoBaseUrl,
  CAO_PROVIDER_LABELS,
} from '../src/features/cao/index.mjs';
import { CAO_MARKERS, KUSA_CLI_MARKERS } from '../src/features/kusa-cli/agent-repl.mjs';

describe('cao profile documents', () => {
  it('round-trips frontmatter fields', () => {
    const doc = buildProfileDocument({
      name: 'security_review',
      provider: 'claude_code',
      model: 'opus',
      description: 'Flags risky diffs',
      body: 'Review for secrets and auth bugs.\n',
    });
    const parsed = parseProfileDocument(doc);
    assert.equal(parsed.name, 'security_review');
    assert.equal(parsed.provider, 'claude_code');
    assert.equal(parsed.model, 'opus');
    assert.equal(parsed.description, 'Flags risky diffs');
    assert.match(parsed.body, /Review for secrets/);
  });

  it('defaults provider when frontmatter is missing', () => {
    const parsed = parseProfileDocument('plain body only');
    assert.equal(parsed.provider, 'claude_code');
    assert.equal(parsed.body, 'plain body only');
  });
});

describe('cao status helpers', () => {
  it('resolves base URL from env', () => {
    assert.equal(resolveCaoBaseUrl({}), 'http://127.0.0.1:9889');
    assert.equal(
      resolveCaoBaseUrl({ CAO_BASE_URL: 'http://127.0.0.1:9999/' }),
      'http://127.0.0.1:9999',
    );
  });

  it('empty status is not ok', () => {
    const status = emptyCaoStatus('down');
    assert.equal(status.ok, false);
    assert.equal(status.error, 'down');
    assert.equal(status.serverUp, false);
  });

  it('labels kusa_cli', () => {
    assert.equal(CAO_PROVIDER_LABELS.kusa_cli, 'Kusa CLI');
  });
});

describe('kusa-cli agent REPL markers', () => {
  it('exports stable standalone CLI markers (CAO alias kept)', () => {
    assert.equal(KUSA_CLI_MARKERS.IDLE_PROMPT, 'kusa❯ ');
    assert.equal(KUSA_CLI_MARKERS.RESPONSE_MARKER, '⏺ ');
    assert.match(KUSA_CLI_MARKERS.PROCESSING_LINE, /thinking/);
    assert.equal(KUSA_CLI_MARKERS.ERROR_PREFIX, 'ERROR: ');
    assert.equal(CAO_MARKERS, KUSA_CLI_MARKERS);
  });
});
