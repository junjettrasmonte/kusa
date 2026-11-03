/**
 * Spawn a long-lived helper that must outlive `kusa serve --live` restarts.
 *
 * `kusa serve --live` SIGTERMs its serve child on every server-source save.
 * Helpers started from that child (cao-server, Live Chat bot) must not share
 * the serve process group/session, or they die with each restart.
 *
 * On Unix we wrap with `setsid` so the child is a new session leader. On
 * Windows we rely on Node's `detached: true`. Always `unref()` immediately.
 */
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

/**
 * @param {string} command
 * @param {string[]} [args]
 * @param {import('node:child_process').SpawnOptions} [options]
 * @returns {Promise<{ ok: boolean, pid: number|null, error?: string }>}
 */
export function spawnDetached(command, args = [], options = {}) {
  const unix = platform() !== 'win32';

  const attempt = (useSetsid) => new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const cmd = useSetsid ? 'setsid' : command;
    const argv = useSetsid ? [command, ...args] : args;
    const { env, cwd, stdio = 'ignore' } = options;

    let child;
    try {
      child = spawn(cmd, argv, {
        cwd,
        env,
        detached: true,
        stdio,
        windowsHide: true,
      });
    } catch (err) {
      finish({ ok: false, pid: null, error: err?.message || String(err) });
      return;
    }

    child.once('error', (err) => {
      finish({
        ok: false,
        pid: null,
        error: err?.code === 'ENOENT'
          ? `${cmd} not found on PATH`
          : (err?.message || String(err)),
        enoent: err?.code === 'ENOENT',
        usedSetsid: useSetsid,
      });
    });

    try { child.unref(); } catch { /* ignore */ }

    // Brief window so a sync ENOENT can fire before we claim success.
    setTimeout(() => {
      if (settled) return;
      finish({ ok: true, pid: child.pid || null });
    }, 40);
  });

  return attempt(unix).then(async (first) => {
    if (first.ok) return first;
    // No setsid on this host — fall back to Node detached alone.
    if (unix && first.enoent && first.usedSetsid) {
      return attempt(false);
    }
    return first;
  });
}
