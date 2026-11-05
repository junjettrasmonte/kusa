import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  foldDelegatesIntoTurns,
  peelTrailingDelegates,
  transcriptLaneKey,
} from '../src/app/console/ui/features/chat/mergeOrchestratedTranscript.js';

describe('transcriptLaneKey', () => {
  it('reads queueKey from speaker when _queueKey is absent', () => {
    assert.equal(
      transcriptLaneKey({ speaker: { queueKey: 'kusa:x', agentId: 'x' } }),
      'kusa:x',
    );
  });
});

describe('foldDelegatesIntoTurns', () => {
  it('folds a Delegated brief onto the prior orchestrator assistant turn', () => {
    const folded = foldDelegatesIntoTurns([
      {
        id: 'orch-1',
        role: 'assistant',
        text: 'Assigning planner',
        _queueKey: 'kusa:parent',
      },
      {
        id: 'delegate-1',
        role: 'delegate',
        text: 'Draft the plan',
        roleLabel: 'planner',
        speaker: { role: 'planner', queueKey: 'kusa:child' },
        _queueKey: 'kusa:child',
      },
      {
        id: 'child-1',
        role: 'assistant',
        text: 'Here is the plan',
        _queueKey: 'kusa:child',
      },
    ]);
    assert.equal(folded.length, 2);
    assert.equal(folded[0].id, 'orch-1');
    assert.equal(folded[0].delegates?.length, 1);
    assert.equal(folded[0].delegates[0].roleLabel, 'planner');
    assert.equal(folded[0].delegates[0].text, 'Draft the plan');
    assert.equal(folded[1].id, 'child-1');
    assert.equal(folded[1].delegates, undefined);
  });

  it('leaves unhosted delegates for the live peel path', () => {
    const folded = foldDelegatesIntoTurns([
      {
        id: 'user-1',
        role: 'user',
        text: 'Go',
        _queueKey: 'kusa:parent',
      },
      {
        id: 'delegate-pending',
        role: 'delegate',
        text: 'Still waiting',
        roleLabel: 'executor',
        _queueKey: 'kusa:child',
      },
    ]);
    assert.equal(folded.length, 2);
    assert.equal(folded[1].role, 'delegate');
  });
});

describe('peelTrailingDelegates', () => {
  it('peels trailing unhosted delegate rows', () => {
    const { messages, delegates } = peelTrailingDelegates([
      { id: 'user-1', role: 'user', text: 'Go', _queueKey: 'kusa:parent' },
      {
        id: 'delegate-pending',
        role: 'delegate',
        text: 'Run tests',
        roleLabel: 'executor',
        _queueKey: 'kusa:child',
      },
    ]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, 'user-1');
    assert.equal(delegates.length, 1);
    assert.equal(delegates[0].text, 'Run tests');
    assert.equal(delegates[0].roleLabel, 'executor');
  });
});
