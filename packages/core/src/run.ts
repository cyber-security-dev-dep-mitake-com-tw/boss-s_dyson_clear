/**
 * Run orchestration — the DIAMOND task graph:
 *
 *   phase 'scan'   parallel scanners (failures → null, siblings continue)
 *   phase 'verify' independent verifier over ALL candidates
 *   phase 'merge'  persist verdicts + CleanPlan
 *   gate_waiting   THE HUMAN GATE — runScan always stops here
 *   phase 'exec'   execPlan(): approved verdicts only → Deleter → receipts
 */
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GraphStore } from './graph/store.js';
import { WorkflowEmitter, type EventSink } from './workflow/events.js';
import { parallel, phase, type Task, type TaskFailure } from './workflow/engine.js';
import { scanJunk } from './scanners/junk.js';
import { scanLargeFiles, DEFAULT_LARGE_THRESHOLD } from './scanners/largefiles.js';
import { scanDuplicates } from './scanners/duplicates.js';
import { scanApps } from './scanners/apps.js';
import { scanProcesses } from './scanners/processes.js';
import { scanDisk } from './scanners/disk.js';
import { verify } from './verifier/verifier.js';
import { Deleter, defaultQuarantineDir, ProtectedPathError } from './executor/deleter.js';
import { writeReceipt } from './executor/receipts.js';
import { uninstallApp } from './executor/uninstaller.js';
import { killProcess } from './executor/prockiller.js';
import type { ScanContext, ScannerResult } from './scanners/types.js';
import type { ExecResult, Receipt, ScanCategory, ScanSummary, Verdict } from './contracts.js';

export const ALL_CATEGORIES: ScanCategory[] = ['junk', 'large', 'duplicate', 'apps', 'processes', 'disk'];

export interface RunScanOptions {
  db: GraphStore;
  categories?: ScanCategory[];
  root?: string;
  largeThresholdBytes?: number;
  signal?: AbortSignal;
  runId?: string;
}

const SCANNERS: Record<ScanCategory, { node: string; fn: (ctx: ScanContext) => Promise<ScannerResult> }> = {
  junk: { node: 'scanner.junk', fn: scanJunk },
  large: { node: 'scanner.large', fn: scanLargeFiles },
  duplicate: { node: 'scanner.duplicates', fn: scanDuplicates },
  apps: { node: 'scanner.apps', fn: scanApps },
  processes: { node: 'scanner.processes', fn: scanProcesses },
  disk: { node: 'scanner.disk', fn: scanDisk },
};

export async function runScan(opts: RunScanOptions, sink: EventSink): Promise<ScanSummary> {
  const runId = opts.runId ?? randomUUID();
  const categories = opts.categories && opts.categories.length > 0 ? opts.categories : ALL_CATEGORIES;
  const emitter = new WorkflowEmitter(runId, sink);
  const startedAt = Date.now();
  const failures: TaskFailure[] = [];

  emitter.emit('scan', 'run', 'run_started', { categories, root: opts.root ?? null });

  const ctx: ScanContext = {
    root: opts.root,
    db: opts.db,
    emit: emitter,
    largeThresholdBytes: opts.largeThresholdBytes ?? DEFAULT_LARGE_THRESHOLD,
    signal: opts.signal,
  };

  // -- phase: scan (parallel fan-out) --
  const tasks: Array<Task<ScannerResult>> = categories.map((cat) => ({
    name: SCANNERS[cat].node,
    run: () => SCANNERS[cat].fn(ctx),
  }));
  const results = await phase(emitter, 'scan', () => parallel(emitter, 'scan', tasks, failures));

  const candidates = results.flatMap((r) => r?.candidates ?? []);
  const scannedFiles = results.reduce((n, r) => n + (r?.scannedFiles ?? 0), 0);

  // -- phase: verify (independent safety step) --
  const verified = await phase(emitter, 'verify', async () => {
    emitter.emit('verify', 'verifier', 'task_started', { candidates: candidates.length });
    const v = await verify(candidates, { root: opts.root, dbPath: opts.db.dbPath });
    emitter.emit('verify', 'verifier', 'task_finished', {
      proposed: v.filter((c) => c.status === 'proposed').length,
      rejected: v.filter((c) => c.status === 'rejected').length,
    });
    return v;
  });

  // -- phase: merge (persist verdicts + plan) --
  const { planId, reclaimable, candidateCount } = await phase(emitter, 'merge', async () => {
    emitter.emit('merge', 'merge.plan', 'task_started');
    let reclaimable = 0;
    let candidateCount = 0;
    for (const c of verified) {
      const id = opts.db.addVerdict(
        {
          runId,
          nodeId: c.nodeId ?? null,
          category: c.category,
          action: c.action,
          status: c.status,
          subjectKey: c.subjectKey,
          subjectType: c.subjectType,
          label: c.label,
          sizeBytes: c.sizeBytes,
          smartSelected: c.smartSelected,
          detail: c.detail,
        },
        c.provenance,
      );
      for (const p of c.verifierProvenance) opts.db.addProvenance('verdict', id, p);
      if (c.status === 'proposed') {
        candidateCount++;
        if ((c.action === 'trash' || c.action === 'uninstall') && c.sizeBytes) reclaimable += c.sizeBytes;
      }
    }
    let planId: string | null = null;
    if (candidateCount > 0) {
      planId = `plan-${runId.slice(0, 8)}`;
      opts.db.createPlan(planId, runId, reclaimable);
    }
    emitter.emit('merge', 'merge.plan', 'task_finished', { planId, verdicts: verified.length });
    return { planId, reclaimable, candidateCount };
  });

  // -- THE HUMAN GATE: runScan always stops here; exec is a separate call --
  emitter.emit('gate', 'gate.human', 'gate_waiting', { planId, candidateCount, reclaimableBytes: reclaimable });

  const summary: ScanSummary = {
    runId,
    categories,
    startedAt,
    finishedAt: Date.now(),
    scannedFiles,
    candidateCount,
    reclaimableBytes: reclaimable,
    planId,
    errors: failures,
  };
  emitter.emit('gate', 'run', 'run_finished', { summary: summary as unknown as Record<string, unknown> });
  return summary;
}

// ---------------------------------------------------------------------------
// exec — runs AFTER the human gate, only over explicitly approved verdict ids
// ---------------------------------------------------------------------------

export interface ExecPlanOptions {
  db: GraphStore;
  planId: string;
  approveIds: number[];
  dryRun?: boolean;
  root?: string;
  quarantineDir?: string;
  sink?: EventSink;
}

export class ApprovalRequiredError extends Error {
  constructor() {
    super('approval required');
    this.name = 'ApprovalRequiredError';
  }
}

/** Per-category allowRoots the verifier's policy implies for real runs. */
function categoryAllowRoots(category: string, home: string): string[] {
  switch (category) {
    case 'junk':
      return [path.join(home, 'Library'), path.join(home, '.Trash'), '/private/tmp', os.tmpdir()];
    case 'large':
    case 'duplicate':
    case 'orphan':
      return [home];
    default:
      return [home];
  }
}

export async function execPlan(opts: ExecPlanOptions): Promise<ExecResult> {
  if (!opts.approveIds || opts.approveIds.length === 0) throw new ApprovalRequiredError();

  const plan = opts.db.getPlan(opts.planId);
  if (!plan) throw new Error(`plan not found: ${opts.planId}`);

  const emitter = new WorkflowEmitter(plan.runId, opts.sink ?? (() => void 0));
  emitter.emit('gate', 'gate.human', 'gate_resolved', {
    planId: plan.planId,
    approvedIds: opts.approveIds,
    dryRun: opts.dryRun ?? false,
  });

  const approved = new Set(opts.approveIds);
  // advise verdicts are information only — they are never executed, so they
  // never produce a (failed) receipt even if a client sends their ids.
  const targets = plan.verdicts.filter(
    (v) => approved.has(v.id) && v.status === 'proposed' && v.action !== 'advise',
  );
  const home = os.homedir();
  const quarantineDir =
    opts.quarantineDir ??
    (opts.root ? path.join(opts.root, '.sweepdeck-quarantine') : defaultQuarantineDir(home));

  const receipts: Receipt[] = [];
  let executed = 0;
  let failed = 0;
  let bytesFreed = 0;

  await phase(emitter, 'exec', async () => {
    for (const v of targets) {
      emitter.emit('exec', `exec.verdict.${v.id}`, 'task_started', { action: v.action, subject: v.subjectKey });
      const receipt = await executeVerdict(v, opts, quarantineDir, home);
      receipts.push(receipt);
      if (receipt.ok) {
        executed++;
        bytesFreed += receipt.bytesFreed ?? 0;
        if (!opts.dryRun) opts.db.updateVerdictStatus(v.id, 'executed');
        emitter.emit('exec', `exec.verdict.${v.id}`, 'task_finished', { receiptId: receipt.id });
      } else {
        failed++;
        emitter.emit('exec', `exec.verdict.${v.id}`, 'task_failed', { message: receipt.error });
      }
    }
  });

  emitter.emit('exec', 'run', 'run_finished', { executed, failed, bytesFreed, dryRun: opts.dryRun ?? false });
  return { runId: plan.runId, executed, failed, bytesFreed, receipts };
}

async function executeVerdict(
  v: Verdict,
  opts: ExecPlanOptions,
  quarantineDir: string,
  home: string,
): Promise<Receipt> {
  const db = opts.db;

  if (opts.dryRun) {
    // Validate only — nothing on disk is touched.
    let ok = true;
    let error: string | null = null;
    if (v.action === 'advise') {
      ok = false;
      error = 'advise-only verdict; nothing to execute';
    }
    return writeReceipt(db, {
      verdictId: v.id,
      action: 'dry-run',
      path: v.subjectKey,
      trashRef: null,
      bytesFreed: ok ? v.sizeBytes : null,
      ok,
      error,
    });
  }

  try {
    switch (v.action) {
      case 'trash': {
        const allowRoots = opts.root ? [opts.root] : categoryAllowRoots(v.category, home);
        const deleter = new Deleter({ allowRoots, quarantineDir });
        const res = await deleter.trash(v.subjectKey);
        return writeReceipt(db, {
          verdictId: v.id,
          action: 'trash',
          path: v.subjectKey,
          trashRef: res.trashRef,
          bytesFreed: res.bytesFreed,
          ok: true,
          error: null,
        });
      }
      case 'uninstall': {
        const res = await uninstallApp(db, v.subjectKey, { root: opts.root, quarantineDir });
        const first = res.receipts[0];
        if (first) return first;
        return writeReceipt(db, {
          verdictId: v.id, action: 'uninstall', path: null, trashRef: null,
          bytesFreed: null, ok: res.ok, error: res.error ?? null,
        });
      }
      case 'kill': {
        const res = await killProcess(Number(v.subjectKey));
        return writeReceipt(db, {
          verdictId: v.id, action: 'kill', path: null, trashRef: null,
          bytesFreed: null, ok: res.ok, error: res.error ?? null,
        });
      }
      case 'advise':
      default:
        return writeReceipt(db, {
          verdictId: v.id, action: v.action, path: v.subjectKey, trashRef: null,
          bytesFreed: null, ok: false, error: 'advise-only verdict; nothing to execute',
        });
    }
  } catch (err) {
    const message = describeExecError(err);
    const code = (err as NodeJS.ErrnoException)?.code;
    // OS-protected or already-gone targets won't succeed on retry: retire the
    // verdict so it is not offered again.
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOENT' || err instanceof ProtectedPathError) {
      db.updateVerdictStatus(v.id, 'rejected');
    }
    return writeReceipt(db, {
      verdictId: v.id,
      action: v.action,
      path: v.subjectKey,
      trashRef: null,
      bytesFreed: null,
      ok: false,
      error: message,
    });
  }
}

/** Human-readable executor errors (receipts are shown verbatim in the UI). */
export function describeExecError(err: unknown): string {
  if (err instanceof ProtectedPathError) {
    if (/cannot resolve/.test(err.message)) return 'already gone — nothing to do';
    return err.message;
  }
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'EPERM' || code === 'EACCES') {
    return 'protected by macOS (SIP / Full Disk Access) — skipped, nothing changed';
  }
  if (code === 'ENOENT') return 'already gone — nothing to do';
  if (code === 'EBUSY') return 'in use by another process — skipped, nothing changed';
  return err instanceof Error ? err.message : String(err);
}
