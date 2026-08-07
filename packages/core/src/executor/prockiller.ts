/**
 * Process killer. Refuses pid < 100, pid 0/1 and our own process.
 * darwin/linux: SIGTERM, escalate to SIGKILL after 3s if still alive.
 * win32: taskkill /PID via execFile (never a shell).
 */
import { execFileBounded } from '../util/exec.js';

export interface KillResult {
  ok: boolean;
  escalated?: boolean;
  error?: string;
}

const ESCALATE_AFTER_MS = 3000;

export async function killProcess(
  pid: number,
  opts: {
    escalateAfterMs?: number;
    exec?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  } = {},
): Promise<KillResult> {
  if (!Number.isInteger(pid)) return { ok: false, error: 'pid must be an integer' };
  if (pid === 0 || pid === 1) return { ok: false, error: `refusing to kill pid ${pid}` };
  if (pid < 100) return { ok: false, error: `refusing to kill low pid ${pid} (system process range)` };
  if (pid === process.pid || pid === process.ppid) {
    return { ok: false, error: 'refusing to kill sweepdeck itself' };
  }

  if (process.platform === 'win32') {
    try {
      // Bounded so a wedged taskkill can never hang the executor (BUG-002 class).
      await (opts.exec
        ? opts.exec('taskkill', ['/PID', String(pid), '/T', '/F'])
        : execFileBounded('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10_000 }));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { ok: false, error: `no such process: ${pid}` };
    return { ok: false, error: String(err) };
  }

  const deadline = Date.now() + (opts.escalateAfterMs ?? ESCALATE_AFTER_MS);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    if (!isAlive(pid)) return { ok: true };
  }
  // still alive → SIGKILL
  try {
    process.kill(pid, 'SIGKILL');
    return { ok: true, escalated: true };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return { ok: true, escalated: true };
    return { ok: false, escalated: true, error: String(err) };
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
