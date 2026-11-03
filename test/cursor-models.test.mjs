import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseContextTokenLimit,
  parseListModelsOutput,
} from '../extensions/cursor-adapter/models.mjs';

describe('cursor adapter models', () => {
  it('parses context windows from labels and bracket overrides', () => {
    assert.equal(parseContextTokenLimit('Claude Opus 5.5 1M High'), 1_000_000);
    assert.equal(parseContextTokenLimit('GPT-5.5 1M'), 1_000_000);
    assert.equal(parseContextTokenLimit('something 200k else'), 200_000);
    assert.equal(
      parseContextTokenLimit('claude-opus-4-8[context=1m,effort=high]'),
      1_000_000,
    );
    assert.equal(parseContextTokenLimit('auto - Auto (default)'), null);
  });

  it('parses agent --list-models lines into id/label/contextTokens', () => {
    const models = parseListModelsOutput(`
Available models

auto - Auto (default)
composer-2.5 - Composer 2.5
claude-opus-5-5-high - Claude Opus 5.5 1M High
gpt-5.5-medium - GPT-5.5 1M
muse-wonder-1.0-high - Muse Wonder  High
`);
    assert.equal(models[0].id, 'auto');
    assert.equal(models[0].label, 'Auto (default)');
    assert.equal(models[0].contextTokens, 128_000);
    assert.equal(models.find((m) => m.id === 'claude-opus-5-5-high')?.contextTokens, 1_000_000);
    assert.equal(models.find((m) => m.id === 'gpt-5.5-medium')?.contextTokens, 1_000_000);
    assert.ok(models.some((m) => m.id === 'muse-wonder-1.0-high'));
  });
});
