import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripLeakedToolCalls,
  stripMarkdownForSpeech,
} from '#ui/shared/lib/chatText.js';

describe('stripLeakedToolCalls', () => {
  it('leaves normal prose alone', () => {
    assert.equal(stripLeakedToolCalls('Hello **world**'), 'Hello **world**');
  });

  it('strips a closed tool_call block and keeps surrounding prose', () => {
    const input = [
      'Now creating the single file:',
      '',
      '<tool_call>',
      '<function=kusa_write_file>',
      '<parameter=path>',
      'reg.html',
      '</parameter>',
      '<parameter=content>',
      '<!DOCTYPE html>',
      '<html><body><div class="x">hi</div></body></html>',
      '</parameter>',
      '</function>',
      '</tool_call>',
      '',
      'Done.',
    ].join('\n');
    const out = stripLeakedToolCalls(input);
    assert.match(out, /Now creating the single file:/);
    assert.match(out, /Done\./);
    assert.equal(out.includes('<tool_call>'), false);
    assert.equal(out.includes('<!DOCTYPE'), false);
    assert.equal(out.includes('<div'), false);
  });

  it('strips an unclosed tool_call through end of text (streaming)', () => {
    const input = 'Working…\n\n<tool_call>\n<function=kusa_write_file>\n<div>partial';
    const out = stripLeakedToolCalls(input);
    assert.equal(out.trim(), 'Working…');
    assert.equal(out.includes('<tool_call>'), false);
  });

  it('speech strip also drops tool_call dumps', () => {
    const spoken = stripMarkdownForSpeech(
      'Say hi.\n\n<tool_call>\n<script>alert(1)</script>\n</tool_call>',
    );
    assert.match(spoken, /Say hi/);
    assert.equal(spoken.includes('tool_call'), false);
    assert.equal(spoken.includes('script'), false);
  });
});
