import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTranscriptHandoff,
  transcriptLaneKey,
} from '../src/app/console/ui/features/chat/mergeOrchestratedTranscript.js';

describe('isTranscriptHandoff', () => {
  it('marks delegate and meta rows as handoffs', () => {
    assert.equal(isTranscriptHandoff(null, { role: 'delegate', _queueKey: 'a' }), true);
    assert.equal(isTranscriptHandoff({ _queueKey: 'a' }, { role: 'meta', _queueKey: 'b' }), true);
  });

  it('marks a lane switch (assign / escalate / return)', () => {
    assert.equal(
      isTranscriptHandoff(
        { role: 'assistant', _queueKey: 'kusa:parent' },
        { role: 'assistant', _queueKey: 'kusa:child' },
      ),
      true,
    );
  });

  it('does not mark same-lane turns', () => {
    assert.equal(
      isTranscriptHandoff(
        { role: 'user', _queueKey: 'kusa:parent' },
        { role: 'assistant', _queueKey: 'kusa:parent' },
      ),
      false,
    );
  });

  it('reads queueKey from speaker when _queueKey is absent', () => {
    assert.equal(
      transcriptLaneKey({ speaker: { queueKey: 'kusa:x', agentId: 'x' } }),
      'kusa:x',
    );
  });
});
