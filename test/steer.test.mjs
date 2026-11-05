/**
 * Codex/OpenCode soft-steer: "Send now" soft-cancels the in-flight completion,
 * keeps partial text + thinking as model context, skips tools not yet started,
 * and injects the prompt before the next model call.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runOpenAiAgentLoop } from '#features/agent/openai-loop.mjs';
import {
  createTurnJob,
  ingestTurnEvent,
  persistTurnCompletion,
} from '#features/chat/data/chat-turn.mjs';
import { writeChatSession } from '#features/chat/data/chat-store.mjs';

const dirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'kusa-steer-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]));
      i += 1;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function sseData(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const settings = {
  agentBaseUrl: 'http://steer.test/v1',
  agentAuthMode: 'none',
  agentModel: 'test-model',
  agentMaxSteps: 8,
  agentApprovalMode: 'allow',
};

describe('soft-steer (Send now)', () => {
  it('soft-cancels the stream, keeps thinking + text, injects steer, re-issues', async () => {
    const root = tempDir();
    writeFileSync(join(root, 'note.txt'), 'hello', 'utf8');

    let steerArmed = false;
    let steered = false;
    /** @type {object[][]} */
    const requestBodies = [];
    /** @type {object[]} */
    const events = [];
    let call = 0;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      call += 1;
      const body = JSON.parse(String(init?.body || '{}'));
      requestBodies.push(body.messages);

      if (call === 1) {
        // Stream thinking + partial content; steer arms after the first content
        // event so the next onSteerPoll soft-cancels with both in hand.
        return sseResponse([
          sseData({
            choices: [{
              delta: { reasoning_content: 'I should look at note.txt first.' },
            }],
          }),
          sseData({
            choices: [{ delta: { content: 'Looking at the file…' } }],
          }),
          sseData({ choices: [{ delta: { content: ' more' } }] }),
          'data: [DONE]\n\n',
        ]);
      }

      // Re-issue after steer: final answer, no tools.
      return sseResponse([
        sseData({
          choices: [{ delta: { content: 'Stopped and switched: done.' } }],
        }),
        'data: [DONE]\n\n',
      ]);
    };

    try {
      const result = await runOpenAiAgentLoop({
        workspaceRoot: root,
        settings,
        messages: [{ role: 'user', content: 'read note.txt and summarize' }],
        stream: true,
        approvalMode: 'allow',
        mode: 'agent',
        onSteer: () => {
          if (steered || !steerArmed) return [];
          steered = true;
          return ['Actually skip the file — just say done.'];
        },
        onEvent: (ev) => {
          events.push(ev);
          if (ev.type === 'content' && !steerArmed) steerArmed = true;
        },
      });

      assert.equal(call, 2, 'expected soft-cancel then one re-issue');
      assert.ok(events.some((e) => e.type === 'interrupted'
        && String(e.thinking || '').includes('note.txt')
        && String(e.text || '').includes('Looking')));
      assert.ok(events.some((e) => e.type === 'steer'
        && e.text === 'Actually skip the file — just say done.'));

      const reissue = requestBodies[1];
      assert.ok(reissue, 're-issue body missing');
      const partial = reissue.find((m) => (
        m.role === 'assistant'
        && String(m.reasoning_content || '').includes('note.txt')
      ));
      assert.ok(partial, 'partial thinking must be model context on re-issue');
      assert.match(String(partial.content || ''), /Looking/);
      const steeredMsg = reissue.find((m) => (
        m.role === 'user'
        && String(m.content || '').includes('skip the file')
      ));
      assert.ok(steeredMsg, 'steered user prompt must land before the re-issue');

      assert.match(result.text, /Stopped and switched|done/i);
      assert.match(result.thinking || '', /note\.txt/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('lets a running tool finish and skips tools not yet started', async () => {
    const root = tempDir();
    writeFileSync(join(root, 'a.txt'), 'A', 'utf8');
    writeFileSync(join(root, 'b.txt'), 'B', 'utf8');

    let call = 0;
    let steerAfterFirstTool = false;
    /** @type {string[]} */
    const toolNames = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      call += 1;
      if (call === 1) {
        // Non-stream JSON with two tool calls — soft mid-stream cancel does
        // not apply; the tool-boundary poll does.
        return new Response(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: {
                    name: 'kusa_read_file',
                    arguments: JSON.stringify({ path: 'a.txt' }),
                  },
                },
                {
                  id: 'c2',
                  type: 'function',
                  function: {
                    name: 'kusa_read_file',
                    arguments: JSON.stringify({ path: 'b.txt' }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{
          message: { role: 'assistant', content: 'Only read A; B was skipped.' },
          finish_reason: 'stop',
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
      const result = await runOpenAiAgentLoop({
        workspaceRoot: root,
        settings,
        messages: [{ role: 'user', content: 'read both files' }],
        stream: false,
        approvalMode: 'allow',
        mode: 'agent',
        onSteer: () => {
          if (!steerAfterFirstTool) return [];
          steerAfterFirstTool = false;
          return ['Do not read b.txt'];
        },
        onEvent: (ev) => {
          if (ev.type === 'tool_start') {
            toolNames.push(ev.name);
            // After the first tool starts, arm steer so the post-tool poll
            // (and/or the pre-next-tool poll) skips the rest.
            if (toolNames.length === 1) steerAfterFirstTool = true;
          }
        },
      });

      assert.equal(call, 2);
      assert.deepEqual(toolNames, ['kusa_read_file']);
      const skipped = result.toolTrace.filter((t) => t.result?.interrupted);
      assert.equal(skipped.length, 1);
      assert.match(String(skipped[0].summary || ''), /skipped/i);
      assert.match(result.text, /Only read A|skipped/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('ingestTurnEvent freezes live text and persist keeps interrupted stub', () => {
    const dir = tempDir();
    const sessionId = 'steer-sess';
    writeChatSession(dir, {
      id: sessionId,
      key: `kusa:${sessionId}`,
      harness: 'kusa',
      messages: [{
        id: 'u1',
        role: 'user',
        text: 'go',
        at: 1,
        turnId: 't1',
      }],
      status: 'busy',
    });

    const job = createTurnJob({
      queueKey: `kusa:${sessionId}`,
      sessionId,
      harness: 'kusa',
      turnId: 't1',
      prompt: 'go',
    });
    job.live.text = 'Half a reply';
    job.live.parts = [{ type: 'thinking', text: 'Hmm…' }];
    job.live.thinking = 'Hmm…';

    ingestTurnEvent(job, {
      type: 'interrupted',
      text: 'Half a reply',
      thinking: 'Hmm…',
    });
    assert.equal(job.live.text, '');
    assert.equal(job.partials?.length, 1);
    assert.equal(job.partials[0].text, 'Half a reply');
    assert.ok(job.live.parts.some((p) => p.type === 'steer_break'));

    ingestTurnEvent(job, { type: 'steer', text: 'Change direction' });
    job.live.text = 'Final after steer';

    const saved = persistTurnCompletion(dir, job, {
      type: 'done',
      text: 'Final after steer',
      thinking: 'Hmm…\nNew thoughts',
      backend: 'openai-compatible',
    });
    assert.ok(saved);
    const roles = saved.messages.map((m) => ({
      role: m.role,
      interrupted: Boolean(m.interrupted),
      steered: Boolean(m.steered),
      text: m.text,
    }));
    assert.ok(roles.some((m) => m.role === 'assistant' && m.interrupted && m.text === 'Half a reply'));
    assert.ok(roles.some((m) => m.role === 'user' && m.steered && m.text === 'Change direction'));
    assert.ok(roles.some((m) => m.role === 'assistant' && !m.interrupted && m.text === 'Final after steer'));
  });
});
