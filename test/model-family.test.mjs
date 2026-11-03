import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  modelFamilyBackLabel,
  modelFamilyKey,
  modelFamilyName,
  modelFamilyOptions,
  modelMenuRows,
} from '../src/app/console/ui/shared/lib/modelFamily.js';

describe('modelFamilyName', () => {
  it('keeps Auto as its own family', () => {
    assert.equal(modelFamilyName('auto', 'Auto (default)'), 'Auto');
  });

  it('strips effort and context so variants share a product-line family', () => {
    assert.equal(
      modelFamilyName('claude-opus-5-5-high', 'Claude Opus 5.5 1M High'),
      'Claude Opus 5.5',
    );
    assert.equal(
      modelFamilyName('claude-opus-5-5-medium', 'Claude Opus 5.5 1M Medium'),
      'Claude Opus 5.5',
    );
    assert.equal(modelFamilyName('gpt-5.5-medium', 'GPT-5.5 1M'), 'GPT-5.5');
    assert.equal(modelFamilyName('gpt-5.5-high', 'GPT-5.5 1M High'), 'GPT-5.5');
  });

  it('falls back to a cleaned id stem when no label is given', () => {
    assert.equal(modelFamilyName('claude-opus-5-5-high'), 'Claude Opus 5.5');
    assert.equal(modelFamilyName('composer-2.5'), 'Composer 2.5');
  });
});

describe('modelMenuRows', () => {
  it('keeps provider headings and nests multi-model families as submenus', () => {
    const rows = modelMenuRows([
      { id: 'auto', label: 'Auto (default)', group: 'Cursor' },
      { id: 'composer-2.5', label: 'Composer 2.5', group: 'Cursor' },
      { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 1M High', group: 'Cursor' },
      { id: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 1M Medium', group: 'Cursor' },
      { id: 'gpt-5.5-medium', label: 'GPT-5.5 1M', group: 'Cursor' },
      { id: 'gpt-5.5-high', label: 'GPT-5.5 1M High', group: 'Cursor' },
      { id: 'proxy-claude', label: 'claude-sonnet-4', group: 'Proxy' },
    ], 'claude-opus-5-5-high');

    assert.deepEqual(
      rows.map((row) => (
        row.heading ? { heading: row.heading }
          : row.family ? { family: row.family, selected: row.selected, n: row.options.length }
            : { id: row.option.id }
      )),
      [
        { heading: 'Cursor' },
        { id: 'auto' },
        { id: 'composer-2.5' },
        { family: 'Claude Opus 5.5', selected: true, n: 2 },
        { family: 'GPT-5.5', selected: false, n: 2 },
        { heading: 'Proxy' },
        { id: 'proxy-claude' },
      ],
    );
  });

  it('resolves family drill-in options and back labels', () => {
    const options = [
      { id: 'gpt-5.5-medium', label: 'GPT-5.5 1M', group: 'Cursor' },
      { id: 'gpt-5.5-high', label: 'GPT-5.5 1M High', group: 'Cursor' },
    ];
    const key = modelFamilyKey('Cursor', 'GPT-5.5');
    assert.equal(modelFamilyBackLabel(key), 'Cursor · GPT-5.5');
    assert.deepEqual(
      modelFamilyOptions(options, key).map((option) => option.id),
      ['gpt-5.5-medium', 'gpt-5.5-high'],
    );
  });
});
