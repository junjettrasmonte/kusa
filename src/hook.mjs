#!/usr/bin/env node
/**
 * Agentic Development Console command hook for any agent harness.
 * Always exits 0 and writes one `{}`. Some harnesses (e.g. Copilot) treat a
 * non-zero preToolUse exit as deny, so a console failure must not block the
 * tool. Cursor reads stdout as the hook protocol, so this process never
 * returns permission, continue, or followup_message. `--cursor` marks the
 * Cursor entrypoint; the payload itself identifies the harness.
 */
import { runHook, readMonoClock, defaultMonitorDir } from './lib.mjs';

const MAX_BYTES = 1024 * 1024;

async function readStdin() {
  if (process.stdin.isTTY) return { text: '', truncated: false, tty: true };
  const chunks = [];
  let kept = 0;
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (kept < MAX_BYTES) {
      const room = MAX_BYTES - kept;
      chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      kept += Math.min(chunk.length, room);
    }
  }
  return {
    text: Buffer.concat(chunks).toString('utf8'),
    truncated: total > MAX_BYTES,
    tty: false,
  };
}

async function main() {
  const eventName = process.argv[2] || '';
  let code = 0;
  try {
    const input = await readStdin();
    if (input.tty) {
      process.stderr.write('usage: kusa hook <event> < payload.json\n');
    } else {
      const clock = readMonoClock();
      runHook({
        dir: defaultMonitorDir(),
        eventName,
        stdinText: input.text,
        truncated: input.truncated,
        nowWall: Date.now(),
        nowMono: clock.mono,
        bootId: clock.bootId,
      });
    }
  } catch (err) {
    const message = err && err.code === 'ELOCK' ? 'kusa lock timeout' : 'kusa hook failed';
    process.stderr.write(`kusa: ${message}\n`);
    code = 0;
  }
  process.stdout.write('{}\n');
  process.exitCode = code;
}

await main();
