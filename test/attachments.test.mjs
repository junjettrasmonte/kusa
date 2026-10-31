import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachmentLabels,
  attachmentTextBlock,
  normalizeAttachments,
  splitAttachments,
} from '#features/chat/data/attachments.mjs';
import { supportsVision, visionLabel } from '#features/agent/model-capabilities.mjs';
import {
  dataTransferToAttachment,
  stageAttachments,
} from '#ui/shared/lib/attachments.js';
import { createTurnJob, turnUserMessage } from '#features/chat/data/chat-turn.mjs';
import { attachmentPayload, composeUserTurn } from '#features/agent/openai-loop.mjs';

describe('attachments', () => {
  it('an inline image keeps its bytes, a name-only file keeps its note', () => {
    const list = normalizeAttachments([
      { name: 'shot.png', kind: 'image', size: 8, mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' },
      { name: 'notes.md', kind: 'text', size: 5, text: 'hello' },
      { name: 'archive.zip', kind: 'other', size: 900, note: 'not readable in the browser — only the name is sent' },
      { name: '', kind: 'text', text: 'no name, so no record' },
      'not an object',
    ]);
    assert.equal(list.length, 3);
    assert.equal(list[0].dataUrl, 'data:image/png;base64,AAAA');
    assert.equal(list[1].text, 'hello');
    assert.match(list[2].note, /only the name is sent/);
    // A picture with no inline data is a reference, never a claim of content.
    const bare = normalizeAttachments([{ name: 'ghost.png', kind: 'image', size: 10 }]);
    assert.equal(bare.length, 1);
    assert.equal(bare[0].note, 'image not included');
  });

  it('the caps hold: file count and inline payload budget', () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      name: `f${index}.txt`,
      kind: 'text',
      size: 4,
      text: 'abcd',
    }));
    assert.equal(normalizeAttachments(many).length, 5);
    const huge = [
      { name: 'big.txt', kind: 'text', size: 2_000_000, text: 'x'.repeat(2_000_000) },
      { name: 'small.txt', kind: 'text', size: 4, text: 'abcd' },
    ];
    // One oversized pick cannot push the rest of a message off the wire.
    const kept = normalizeAttachments(huge);
    assert.equal(kept.length, 2);
    assert.equal(kept[0].text.length, 20_000);
  });

  it('a text-only model gets a named note instead of the picture', () => {
    const list = normalizeAttachments([
      { name: 'shot.png', kind: 'image', size: 8, mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' },
      { name: 'notes.md', kind: 'text', size: 5, text: 'hello' },
    ]);
    const { images, readable, named } = splitAttachments(list);
    assert.equal(images.length, 1);
    assert.equal(readable.length, 1);
    assert.equal(named.length, 0);
    const block = attachmentTextBlock(list);
    assert.match(block, /hello/);
    assert.match(block, /notes\.md/);
    // The judgement lives in one place so the composer and the loop agree.
    assert.equal(supportsVision('gpt-4o'), true);
    assert.equal(supportsVision('o3-mini'), false);
    assert.equal(supportsVision('gpt-4.1-mini'), false);
    assert.equal(supportsVision('something-unknown'), null);
    assert.equal(visionLabel('o3-mini'), 'text only — images are not sent');
    // Unknown is never answered for: dropping the picture would be a guess.
    assert.equal(visionLabel('something-unknown'), '');
  });

  it('labels name what was attached, and say when it was not sent', () => {
    const labels = attachmentLabels([
      { name: 'shot.png', kind: 'image', size: 8, dataUrl: 'data:image/png;base64,AAAA' },
      { name: 'archive.zip', kind: 'other', size: 900, note: 'not readable in the browser' },
    ]);
    assert.equal(labels[0], 'shot.png');
    assert.equal(labels[1], 'archive.zip (not sent)');
  });

  it('the composer stages files without stacking the same one up', () => {
    const held = [{ name: 'a.txt', kind: 'text', size: 4, text: 'abcd' }];
    const staged = stageAttachments(held, [
      { name: 'a.txt', kind: 'text', size: 4, text: 'abcd' },
      { name: 'b.txt', kind: 'text', size: 4, text: 'wxyz' },
    ]);
    assert.equal(staged.list.length, 2);
    assert.equal(staged.rejected.length, 0);
    // Pressing Add Files twice on the same selection cannot reach the cap.
    const again = stageAttachments(staged.list, [{ name: 'b.txt', kind: 'text', size: 4, text: 'wxyz' }]);
    assert.equal(again.list.length, 2);
    const overflow = stageAttachments(staged.list, Array.from({ length: 6 }, (_, i) => ({
      name: `x${i}.txt`,
      kind: 'text',
      size: 4,
      text: 'abcd',
    })));
    assert.equal(overflow.list.length, 5);
    assert.equal(overflow.rejected.length, 3);
  });

  it('a picture is sent as an image part only to a model that can see it', () => {
    const image = { name: 'shot.png', kind: 'image', size: 8, mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' };
    // A vision model: the typed words stay first, the picture follows as parts.
    const vision = composeUserTurn('what is in this?', [image], 'gpt-4o');
    assert.ok(Array.isArray(vision.content));
    assert.equal(vision.content[0].type, 'text');
    assert.match(vision.content[0].text, /what is in this\?/);
    assert.equal(vision.content[1].image_url.url, image.dataUrl);
    assert.equal(vision.images, 1);
    assert.deepEqual(vision.dropped, []);
    // An attachment-only prompt has no typed words: no empty text part is
    // invented to hold them.
    const pictureOnly = composeUserTurn('', [image], 'gpt-4o');
    assert.equal(pictureOnly.content.length, 1);
    assert.equal(pictureOnly.content[0].type, 'image_url');
    // A text-only model keeps the request shape the endpoint has always taken,
    // and the prompt still says what the user attached.
    const textOnly = composeUserTurn('describe this', [image], 'o3-mini');
    assert.equal(typeof textOnly.content, 'string');
    assert.match(textOnly.content, /this model is text-only, so the picture was not sent/);
    assert.deepEqual(textOnly.dropped, [image]);
    assert.equal(textOnly.images, 0);
    // Unknown capability is not answered for: the picture goes, and the model
    // either reads it or says it cannot.
    const unknown = composeUserTurn('describe this', [image], 'something-unknown');
    assert.ok(Array.isArray(unknown.content));
    assert.deepEqual(unknown.dropped, []);
    // No files at all leaves the prompt exactly as it was typed.
    const bare = composeUserTurn('just words', [], 'gpt-4o');
    assert.equal(bare.content, 'just words');
    assert.equal(bare.files, 0);
  });

  it('a prompt that is nothing but a picture still owns a user row', () => {
    const job = createTurnJob({
      queueKey: 'kusa:pic',
      sessionId: 'pic',
      prompt: '',
      attachments: [{ name: 'shot.png', kind: 'image', size: 8, mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }],
    });
    const row = turnUserMessage(job);
    assert.equal(row.text, '');
    assert.equal(row.attachments.length, 1);
    // No text and no files is not a prompt at all.
    assert.equal(turnUserMessage(createTurnJob({ queueKey: 'kusa:none', sessionId: 'none' })), null);
  });

  it('a clipboard paste becomes the same record a pasted file would make', async () => {
    // The paste-event path (Firefox / Safari) hands over a DataTransfer; the
    // clipboard-read path builds the plain record. One builder, one shape —
    // neither may claim bytes it was not given.
    const text = await dataTransferToAttachment({ kind: 'text', text: 'pasted words' });
    assert.equal(text.name, 'clipboard.txt');
    assert.equal(text.kind, 'text');
    assert.equal(text.text, 'pasted words');
    // Whitespace-only clipboard is nothing to take.
    assert.equal(await dataTransferToAttachment({ kind: 'text', text: '  \n ' }), null);
    // A clipboard with neither half is nothing to take.
    assert.equal(await dataTransferToAttachment(null), null);
    // An image with no bytes is a name, never a claim of content.
    assert.equal(await dataTransferToAttachment({ kind: 'image', size: 12, mime: 'image/png' }), null);
    // A real File goes through the same caps as any other source.
    const file = new File(['hello'], 'clipboard-abc.txt', { type: 'text/plain' });
    const record = await dataTransferToAttachment({
      kind: 'text',
      name: file.name,
      size: file.size,
      mime: file.type,
      text: 'hello',
    });
    assert.equal(record.name, 'clipboard-abc.txt');
    assert.equal(record.size, 5);
  });
});
