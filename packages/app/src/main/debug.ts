/**
 * debug.ts — BETA-CHANNEL ONLY diagnostics.
 *
 * Imported exclusively behind `if (__SWEEPDECK_BETA__)` (a build-time constant
 * derived from the release tag — see electron.vite.config.ts), so production
 * bundles never contain or register any of this.
 *
 * Provides:
 *   - a ring-buffer log (+ userData/logs/debug-YYYY-MM-DD.log) fed by workflow
 *     events, IPC handler failures, renderer console warnings/errors, renderer
 *     crashes and main-process uncaught errors;
 *   - IPC: debug:info, debug:logs, debug:export, debug:selftest;
 *   - runSelfTest(): automated checks for the known bug classes (disk
 *     measurement, protected/overlapping clean targets, advise verdicts,
 *     unresolved insight owners) — also reachable headless via `--selftest`.
 */
import { app, ipcMain, shell, type BrowserWindow } from 'electron';
import { join, dirname, basename, sep } from 'path';
import { appendFileSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import type { DiskStatus, WorkflowEvent } from '@contracts';
import type { Engine } from './engine';

export const DEBUG_IPC = {
  info: 'debug:info',
  logs: 'debug:logs',
  export: 'debug:export',
  selftest: 'debug:selftest',
  logEvent: 'debug:log-event', // main → renderer (send)
} as const;

export type DebugLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DebugLogEntry {
  ts: number;
  level: DebugLevel;
  source: string;
  message: string;
  data?: unknown;
}

export interface SelfTestCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface SelfTestReport {
  ok: boolean;
  startedAt: number;
  finishedAt: number;
  checks: SelfTestCheck[];
  errorsLogged: DebugLogEntry[];
  reportPath: string | null;
}

const MAX_ENTRIES = 2000;

export class DebugLog {
  private readonly entries: DebugLogEntry[] = [];
  private readonly listeners = new Set<(e: DebugLogEntry) => void>();

  constructor(private readonly dir: string) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* logging to memory only */
    }
  }

  private filePath(): string {
    return join(this.dir, `debug-${new Date().toISOString().slice(0, 10)}.log`);
  }

  log(level: DebugLevel, source: string, message: string, data?: unknown): void {
    const entry: DebugLogEntry = { ts: Date.now(), level, source, message, ...(data !== undefined ? { data } : {}) };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    try {
      appendFileSync(this.filePath(), `${JSON.stringify(entry)}\n`);
    } catch {
      /* disk full / readonly — keep the ring buffer */
    }
    for (const l of this.listeners) l(entry);
  }

  list(): DebugLogEntry[] {
    return [...this.entries];
  }

  errorsSince(ts: number): DebugLogEntry[] {
    return this.entries.filter((e) => e.ts >= ts && e.level === 'error');
  }

  subscribe(fn: (e: DebugLogEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get logDir(): string {
    return this.dir;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Pure disk sanity checks — the measurement bugs from the field report. */
export function checkDiskStatus(disk: DiskStatus, platform: NodeJS.Platform = process.platform): SelfTestCheck[] {
  const checks: SelfTestCheck[] = [];
  const vols = disk.volumes;
  checks.push({ id: 'disk.volumes-present', ok: vols.length > 0, detail: `${vols.length} volume(s)` });

  const bad = vols.filter((v) => {
    if (v.sizeBytes <= 0) return true;
    const drift = Math.abs(v.usedBytes + v.availableBytes - v.sizeBytes) / v.sizeBytes;
    return drift > 0.02 || v.usePercent < 0 || v.usePercent > 100.5;
  });
  checks.push({
    id: 'disk.used-plus-free-equals-size',
    ok: bad.length === 0,
    detail: bad.length ? `inconsistent: ${bad.map((v) => v.mount).join(', ')}` : 'all volumes consistent',
  });

  if (platform === 'darwin') {
    const sys = vols.filter((v) => v.mount.startsWith('/System/Volumes/'));
    checks.push({
      id: 'disk.no-apfs-system-volumes',
      ok: sys.length === 0,
      detail: sys.length ? `system-role volumes listed as disks: ${sys.map((v) => v.mount).join(', ')}` : 'none listed',
    });
    const boot = vols.find((v) => v.mount === '/');
    checks.push({
      id: 'disk.boot-is-container-level',
      ok: !!boot && boot.sizeBytes > 0 && boot.usedBytes >= boot.sizeBytes - boot.availableBytes - boot.sizeBytes * 0.02,
      detail: boot
        ? `/ size ${(boot.sizeBytes / 1e9).toFixed(1)} GB, used ${(boot.usedBytes / 1e9).toFixed(1)} GB, free ${(boot.availableBytes / 1e9).toFixed(1)} GB`
        : 'no "/" row',
    });
  }

  const home = vols[0];
  if (home) {
    const sum = disk.breakdown.reduce((s, b) => s + b.bytes, 0);
    const over = disk.breakdown.filter((b) => b.bytes > home.sizeBytes);
    checks.push({
      id: 'disk.breakdown-within-disk',
      ok: over.length === 0 && sum <= home.usedBytes * 1.05,
      detail: `breakdown ${(sum / 1e9).toFixed(1)} GB vs used ${(home.usedBytes / 1e9).toFixed(1)} GB${
        over.length ? `; larger than disk: ${over.map((b) => b.path).join(', ')}` : ''
      }`,
    });
  }
  return checks;
}

/** Candidate paths where one contains another → double count / ENOENT on exec. */
export function findOverlaps(paths: string[]): Array<[string, string]> {
  const sorted = [...new Set(paths)].sort();
  const out: Array<[string, string]> = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].startsWith(sorted[i] + sep) || sorted[j].startsWith(sorted[i] + '/')) out.push([sorted[i], sorted[j]]);
      else break;
    }
  }
  return out;
}

export interface DebugModule {
  log: DebugLog;
  onWorkflowEvent(ev: WorkflowEvent): void;
  onIpcError(channel: string, err: unknown): void;
  attachWindow(win: BrowserWindow): void;
  runSelfTest(): Promise<SelfTestReport>;
}

export function installDebug(engine: Engine, channel: string): DebugModule {
  const log = new DebugLog(join(app.getPath('userData'), 'logs'));
  log.log('info', 'app', `SweepDeck ${app.getVersion()} (${channel}) starting`, {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    os: `${os.type()} ${os.release()}`,
  });

  process.on('uncaughtException', (err) => log.log('error', 'main.uncaught', errMessage(err), { stack: (err as Error)?.stack }));
  process.on('unhandledRejection', (reason) =>
    log.log('error', 'main.unhandled-rejection', errMessage(reason), { stack: (reason as Error)?.stack }),
  );

  const onWorkflowEvent = (ev: WorkflowEvent): void => {
    if (ev.type === 'task_failed') {
      log.log('error', `workflow.${ev.node}`, String(ev.data.message ?? 'task failed'), { runId: ev.runId, phase: ev.phase });
    } else if (ev.type !== 'task_progress') {
      log.log('debug', `workflow.${ev.node}`, ev.type, { runId: ev.runId, phase: ev.phase, data: ev.data });
    }
  };

  const onIpcError = (ch: string, err: unknown): void => {
    log.log('error', `ipc.${ch}`, errMessage(err), { stack: (err as Error)?.stack });
  };

  const attachWindow = (win: BrowserWindow): void => {
    const wc = win.webContents;
    // Electron ≥ 35 passes a details object; older versions pass positional args.
    wc.on('console-message', (...args: unknown[]) => {
      const ev = args[0] as { level?: unknown; message?: unknown; lineNumber?: unknown; sourceId?: unknown };
      const rawLevel = ev?.level ?? args[1];
      const message = String(ev?.message ?? args[2] ?? '');
      const level =
        rawLevel === 'error' || rawLevel === 3 ? 'error' : rawLevel === 'warning' || rawLevel === 2 ? 'warn' : null;
      if (level) log.log(level, 'renderer.console', message, { source: ev?.sourceId ?? args[4], line: ev?.lineNumber ?? args[3] });
    });
    wc.on('render-process-gone', (_e, details) => log.log('error', 'renderer.gone', details.reason, details));
    wc.on('did-fail-load', (_e, code, desc, url) => log.log('error', 'renderer.load', `${code} ${desc}`, { url }));
    wc.on('preload-error', (_e, preloadPath, err) => log.log('error', 'preload', errMessage(err), { preloadPath }));
    const unsub = log.subscribe((entry) => {
      if (!win.isDestroyed()) wc.send(DEBUG_IPC.logEvent, entry);
    });
    win.on('closed', unsub);
  };

  async function info(): Promise<Record<string, unknown>> {
    const { core, dbPath } = await engine.debugHandles();
    let raw: unknown = null;
    try {
      raw = core.getRawDiskInputs ? await core.getRawDiskInputs() : null;
    } catch (err) {
      raw = { error: errMessage(err) };
    }
    return {
      version: app.getVersion(),
      channel,
      platform: process.platform,
      arch: process.arch,
      versions: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome },
      os: `${os.type()} ${os.release()}`,
      userData: app.getPath('userData'),
      dbPath,
      quarantineRoot: join(os.homedir(), '.sweepdeck', 'quarantine'),
      logDir: log.logDir,
      rawDisk: raw,
    };
  }

  async function runSelfTest(): Promise<SelfTestReport> {
    const startedAt = Date.now();
    const checks: SelfTestCheck[] = [];
    const record = (c: SelfTestCheck): void => {
      checks.push(c);
      log.log(c.ok ? 'info' : 'error', `selftest.${c.id}`, c.detail);
    };
    log.log('info', 'selftest', 'self-test started');
    const { core } = await engine.debugHandles();

    // 1. disk measurement
    try {
      const disk = await engine.diskStatus();
      for (const c of checkDiskStatus(disk)) record(c);
    } catch (err) {
      record({ id: 'disk.status', ok: false, detail: errMessage(err) });
    }

    // 2. junk scan → gate → dry-run exec, on a throwaway graph db
    const tmpDb = join(app.getPath('temp'), `sweepdeck-selftest-${startedAt}.db`);
    const db = new core.GraphStore(tmpDb);
    try {
      const failures: string[] = [];
      const summary = await core.runScan({ db, categories: ['junk'], runId: `selftest-${startedAt}` }, (ev) => {
        if (ev.type === 'task_failed') failures.push(`${ev.node}: ${String(ev.data.message)}`);
      });
      record({
        id: 'scan.junk.no-task-failures',
        ok: failures.length === 0 && summary.errors.length === 0,
        detail: failures.length ? failures.join('; ') : `${summary.scannedFiles} entries scanned, ${summary.candidateCount} candidates`,
      });
      const plan = summary.planId ? db.getPlan(summary.planId) : null;
      const proposed = plan?.verdicts.filter((v) => v.status === 'proposed') ?? [];
      const trash = proposed.filter((v) => v.action === 'trash');

      const overlaps = findOverlaps(proposed.map((v) => v.subjectKey));
      record({
        id: 'scan.junk.no-overlapping-targets',
        ok: overlaps.length === 0,
        detail: overlaps.length ? overlaps.slice(0, 5).map(([a, b]) => `${a} ⊃ ${b}`).join('; ') : 'no overlaps',
      });

      if (process.platform === 'darwin' && core.isMacProtectedCache) {
        const prot = proposed.filter((v) => core.isMacProtectedCache!(dirname(v.subjectKey), basename(v.subjectKey)));
        record({
          id: 'scan.junk.no-os-protected-targets',
          ok: prot.length === 0,
          detail: prot.length ? prot.map((v) => v.subjectKey).join(', ') : 'none',
        });
      }

      if (plan && proposed.length > 0) {
        const res = await core.execPlan({
          db,
          planId: plan.planId,
          approveIds: proposed.map((v) => v.id),
          dryRun: true,
        });
        record({
          id: 'exec.dry-run-all-proposed',
          ok: res.failed === 0 && res.receipts.length === trash.length,
          detail: `${res.executed} ok, ${res.failed} failed, ${proposed.length - trash.length} advise-only skipped${
            res.failed ? `: ${res.receipts.filter((r) => !r.ok).map((r) => r.error).slice(0, 3).join('; ')}` : ''
          }`,
        });
      } else {
        record({ id: 'exec.dry-run-all-proposed', ok: true, detail: 'nothing to execute' });
      }
    } catch (err) {
      record({ id: 'scan.junk', ok: false, detail: errMessage(err) });
    } finally {
      try {
        db.close();
        rmSync(tmpDb, { force: true });
        rmSync(`${tmpDb}-wal`, { force: true });
        rmSync(`${tmpDb}-shm`, { force: true });
      } catch {
        /* temp */
      }
    }

    // 3. graph insights resolve an owner name (no "Unknown owns …")
    try {
      for (const q of ['top-space-owners', 'app-cache-aggregation'] as const) {
        const rows = (await engine.graphQuery(q)).rows;
        const unnamed = rows.filter((r) => !(r.appName || r.appKey || r.name || r.path));
        record({ id: `insight.${q}.has-owner`, ok: unnamed.length === 0, detail: `${rows.length} row(s), ${unnamed.length} without owner` });
      }
    } catch (err) {
      record({ id: 'insight', ok: false, detail: errMessage(err) });
    }

    // 4. receipts table readable
    try {
      const receipts = await engine.receiptsList();
      record({ id: 'receipts.readable', ok: true, detail: `${receipts.length} receipt(s)` });
    } catch (err) {
      record({ id: 'receipts.readable', ok: false, detail: errMessage(err) });
    }

    const finishedAt = Date.now();
    const errorsLogged = log.errorsSince(startedAt).filter((e) => !e.source.startsWith('selftest.'));
    const report: SelfTestReport = {
      ok: checks.every((c) => c.ok) && errorsLogged.length === 0,
      startedAt,
      finishedAt,
      checks,
      errorsLogged,
      reportPath: null,
    };
    try {
      const p = join(log.logDir, `selftest-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}.json`);
      writeFileSync(p, JSON.stringify(report, null, 2));
      report.reportPath = p;
    } catch {
      /* report still returned */
    }
    log.log(report.ok ? 'info' : 'error', 'selftest', `self-test ${report.ok ? 'PASSED' : 'FAILED'}`, {
      failed: checks.filter((c) => !c.ok).map((c) => c.id),
    });
    return report;
  }

  async function exportReport(): Promise<{ ok: boolean; path?: string; error?: string }> {
    try {
      const receipts = await engine.receiptsList().catch(() => []);
      const p = join(log.logDir, `bug-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      writeFileSync(
        p,
        JSON.stringify({ generatedAt: Date.now(), info: await info(), failedReceipts: receipts.filter((r) => !r.ok), logs: log.list() }, null, 2),
      );
      shell.showItemInFolder(p);
      return { ok: true, path: p };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  }

  ipcMain.handle(DEBUG_IPC.info, () => info());
  ipcMain.handle(DEBUG_IPC.logs, () => log.list());
  ipcMain.handle(DEBUG_IPC.export, () => exportReport());
  ipcMain.handle(DEBUG_IPC.selftest, () => runSelfTest());

  return { log, onWorkflowEvent, onIpcError, attachWindow, runSelfTest };
}
