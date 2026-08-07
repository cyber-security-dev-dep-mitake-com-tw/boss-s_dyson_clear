/**
 * execFileBounded — execFile with an ENFORCED deadline (BUG-002).
 *
 * Node's execFile timeout sends killSignal ONCE (default SIGTERM) and never
 * escalates; a child blocked in an uninterruptible request (e.g. osascript
 * waiting on a TCC automation-consent prompt) ignores SIGTERM, and the
 * callback also waits for the child's stdio to close — so the promise can
 * hang forever. This wrapper:
 *   1. passes killSignal 'SIGKILL' so the built-in timeout is uncatchable,
 *   2. races a hard deadline (timeout + grace) that re-kills with SIGKILL and
 *      settles the promise even if stdio is held open by a grandchild.
 * Callers must treat rejection as "command unavailable" (best-effort data).
 */
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const GRACE_MS = 1000;

export interface ExecBoundedOptions {
  /** Hard deadline in ms — the promise settles within timeout + 1s. */
  timeout: number;
  maxBuffer?: number;
}

export function execFileBounded(
  cmd: string,
  args: string[],
  opts: ExecBoundedOptions,
): Promise<{ stdout: string; stderr: string }> {
  const pending = execFileP(cmd, args, {
    timeout: opts.timeout,
    killSignal: 'SIGKILL',
    ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
  });
  const child: ChildProcess = pending.child;
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      reject(new Error(`${cmd} did not settle within ${opts.timeout + GRACE_MS}ms (killed)`));
    }, opts.timeout + GRACE_MS);
    pending.then(
      (v) => {
        clearTimeout(deadline);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(deadline);
        reject(e);
      },
    );
  });
}
