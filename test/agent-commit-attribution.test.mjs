import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  filterCommitMessage,
  filterCommitMessageFile,
  isAgentCoAuthorTrailer,
  isAgentIdentity,
  subjectLine,
} from '../scripts/agent-commit-attribution.mjs';

describe('agent commit attribution', () => {
  it('detects Cursor and Copilot identities case-insensitively', () => {
    assert.equal(isAgentIdentity('Cursor', 'cursoragent@cursor.com'), true);
    assert.equal(isAgentIdentity('CURSOR AGENT', 'noreply@example.com'), true);
    assert.equal(isAgentIdentity('GitHub Copilot', 'copilot@github.com'), true);
    assert.equal(isAgentIdentity('copilot', 'x@y.z'), true);
    assert.equal(isAgentIdentity('Someone', 'cursoragent@cursor.com'), true);
    assert.equal(isAgentIdentity('Bot', 'copilot-swe-agent[bot]@users.noreply.github.com'), true);
  });

  it('preserves human identities', () => {
    assert.equal(isAgentIdentity('Jane Doe', 'jane@example.com'), false);
    assert.equal(isAgentIdentity('Junjet', 'junjet@users.noreply.github.com'), false);
    assert.equal(isAgentIdentity('Ada', 'ada@cursor.com'), false);
  });

  it('strips agent Co-authored-by and Made-with trailers only', () => {
    assert.equal(
      isAgentCoAuthorTrailer('Co-authored-by: Cursor <cursoragent@cursor.com>'),
      true,
    );
    assert.equal(
      isAgentCoAuthorTrailer('co-authored-by: GitHub Copilot <copilot@github.com>'),
      true,
    );
    assert.equal(isAgentCoAuthorTrailer('Made-with: Cursor'), true);
    assert.equal(
      isAgentCoAuthorTrailer('Co-authored-by: Jane Doe <jane@example.com>'),
      false,
    );
    assert.equal(
      isAgentCoAuthorTrailer('Discussed Co-authored-by: Cursor <cursoragent@cursor.com> in review'),
      false,
    );
  });

  it('filters messages while preserving subject, body, and human co-authors', () => {
    const input = [
      'fix: harden auth',
      '',
      'Details about the change.',
      '',
      '',
      'Co-authored-by: Jane Doe <jane@example.com>',
      'Co-authored-by: Cursor <cursoragent@cursor.com>',
      'Co-authored-by: GitHub Copilot <copilot@github.com>',
      'Made-with: Cursor',
      '',
    ].join('\n');

    const out = filterCommitMessage(input);
    assert.equal(
      out,
      [
        'fix: harden auth',
        '',
        'Details about the change.',
        '',
        'Co-authored-by: Jane Doe <jane@example.com>',
        '',
      ].join('\n'),
    );
    assert.equal(subjectLine(out), 'fix: harden auth');
  });

  it('fail-safes when filtering would remove the only subject line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kusa-attr-'));
    const file = join(dir, 'COMMIT_EDITMSG');
    // Pathological: subject itself is somehow only an agent trailer (should not rewrite away)
    writeFileSync(file, 'Co-authored-by: Cursor <cursoragent@cursor.com>\n', 'utf8');
    const result = filterCommitMessageFile(file);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'would-empty-subject');
    assert.equal(readFileSync(file, 'utf8'), 'Co-authored-by: Cursor <cursoragent@cursor.com>\n');
    rmSync(dir, { recursive: true, force: true });
  });

  it('rewrites a commit message file in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kusa-attr-'));
    const file = join(dir, 'COMMIT_EDITMSG');
    writeFileSync(
      file,
      'feat: x\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\n',
      'utf8',
    );
    const result = filterCommitMessageFile(file);
    assert.equal(result.ok, true);
    assert.equal(readFileSync(file, 'utf8'), 'feat: x\n');
    rmSync(dir, { recursive: true, force: true });
  });
});
