/**
 * engine.ts — the ONE place in the app that touches @sweepdeck/core.
 *
 * Integrated against the real core API (packages/core/dist was built):
 *   runScan({db, categories, root?, signal?, runId?}, sink) → Promise<ScanSummary>
 *     — resolves AT the human gate (emits gate_waiting, then run_finished)
 *   execPlan({db, planId, approveIds, sink?})               → Promise<ExecResult>
 *   listApps(db) / listProcs() / diskStatus(db) / killProc(pid)
 *   graphQuery(db, queryId, params?)  (sync)
 *   undoReceipt(db, receiptId) / GraphStore#listReceipts()
 *   uninstallApp(db, key) — an EXECUTOR (runs immediately), so the gated
 *     appsUninstall flow is synthesized here: we create an 'uninstall' verdict
 *     + plan in the GraphStore and pause at gate_waiting; plan:approve then
 *     routes through execPlan → core's uninstaller. The human gate holds.
 *
 * Core is loaded lazily (dynamic import, non-literal specifier) so the window
 * still opens — and --smoke passes — when packages/core isn't built.
 */
import { app } from 'electron';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type {
  AppInfo,
  CleanPlan,
  DiskStatus,
  ExecResult,
  GraphInsight,
  GraphQueryId,
  ProcInfo,
  Provenance,
  Receipt,
  ScanCategory,
  ScanSummary,
  WorkflowEvent,
} from '@contracts';
// Type-only imports: erased at compile time, so the app still builds when core
// isn't; only `npm run typecheck` needs core's dist to exist.
import type {
  GraphStore as GraphStoreT,
  VerdictInput,
  RunScanOptions,
  ExecPlanOptions,
} from '@sweepdeck/core';

export type EventSink = (ev: WorkflowEvent) => void;

interface CoreModule {
  GraphStore: new (dbPath: string) => GraphStoreT;
  runScan: (opts: RunScanOptions, sink: EventSink) => Promise<ScanSummary>;
  execPlan: (opts: ExecPlanOptions) => Promise<ExecResult>;
  listApps: (db: GraphStoreT, root?: string) => Promise<AppInfo[]>;
  listProcs: () => Promise<ProcInfo[]>;
  diskStatus: (db?: GraphStoreT, root?: string) => Promise<DiskStatus>;
  killProc: (pid: number) => Promise<{ ok: boolean; error?: string }>;
  graphQuery: (db: GraphStoreT, queryId: GraphQueryId, params?: Record<string, unknown>) => GraphInsight;
  undoReceipt: (db: GraphStoreT, receiptId: number) => Promise<{ ok: boolean; error?: string }>;
  writeReceipt: (db: GraphStoreT, r: Omit<Receipt, 'id' | 'executedAt'> & { executedAt?: number }) => Receipt;
}

export class Engine {
  private core: CoreModule | null = null;
  private store: GraphStoreT | null = null;
  /** AbortControllers for cancellable runs, keyed by runId. */
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly broadcast: EventSink) {}

  private dbPath(): string {
    return join(app.getPath('userData'), 'graph.db');
  }

  private async load(): Promise<CoreModule> {
    if (this.core) return this.core;
    try {
      // Non-literal specifier: neither TS nor the bundler resolves core at
      // build time — it may not be built yet in a fresh checkout.
      const spec = '@sweepdeck/core';
      this.core = (await import(/* @vite-ignore */ spec)) as unknown as CoreModule;
    } catch (err) {
      throw new Error(
        `SweepDeck engine unavailable — @sweepdeck/core is not built yet (npm run build -w packages/core). ${String(
          (err as Error)?.message ?? err,
        )}`,
      );
    }
    return this.core;
  }

  private async db(): Promise<GraphStoreT> {
    const core = await this.load();
    if (!this.store) this.store = new core.GraphStore(this.dbPath());
    return this.store;
  }

  // --- IPC-facing surface -------------------------------------------------

  async scanStart(categories: ScanCategory[], roots?: string[]): Promise<{ runId: string }> {
    const core = await this.load();
    const db = await this.db();
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const controller = new AbortController();
    this.active.set(runId, controller);

    // runScan resolves at the gate; keep it running in the background and
    // surface failures as a task_failed broadcast so the UI never hangs.
    void core
      .runScan(
        {
          db,
          categories,
          root: roots?.[0], // contract allows several roots; core scopes to one
          signal: controller.signal,
          runId,
        },
        this.broadcast,
      )
      .catch((err: unknown) => {
        this.broadcast({
          ts: Date.now(),
          runId,
          phase: 'scan',
          node: 'engine',
          type: 'task_failed',
          data: { message: String((err as Error)?.message ?? err) },
        });
        this.broadcast({
          ts: Date.now(),
          runId,
          phase: 'gate',
          node: 'run',
          type: 'run_finished',
          data: { error: String((err as Error)?.message ?? err) },
        });
      })
      .finally(() => this.active.delete(runId));

    return { runId };
  }

  async scanCancel(runId: string): Promise<{ ok: boolean }> {
    const controller = this.active.get(runId);
    if (!controller) return { ok: false };
    controller.abort();
    this.active.delete(runId);
    return { ok: true };
  }

  async planGet(runId: string): Promise<CleanPlan | null> {
    const db = await this.db();
    return db.getPlan(runId);
  }

  async planApprove(planId: string, verdictIds: number[]): Promise<ExecResult> {
    const core = await this.load();
    const db = await this.db();
    return core.execPlan({ db, planId, approveIds: verdictIds, sink: this.broadcast });
  }

  async appsList(): Promise<AppInfo[]> {
    const core = await this.load();
    const db = await this.db();
    return core.listApps(db);
  }

  /**
   * Gated uninstall: creates an 'uninstall' verdict + plan, then pauses at
   * gate_waiting. Nothing executes until plan:approve names the verdict id.
   */
  async appsUninstall(key: string): Promise<{ runId: string }> {
    const core = await this.load();
    const db = await this.db();
    const apps = await core.listApps(db);
    const target = apps.find((a) => a.key === key);
    if (!target) throw new Error(`application not found: ${key}`);

    const runId = `uninst-${randomUUID().slice(0, 8)}`;
    const planId = `plan-${runId}`;
    const now = Date.now();
    const emit = (phase: string, node: string, type: WorkflowEvent['type'], data: Record<string, unknown>): void =>
      this.broadcast({ ts: Date.now(), runId, phase, node, type, data });

    emit('scan', 'uninstall.gate', 'run_started', { key });

    const provenance: Provenance = {
      scanner: 'app.uninstall-gate@1',
      rule: target.platform === 'win32' ? 'win.uninstall-key' : 'mac.app-bundle',
      evidence: { installPath: target.installPath, ownedPaths: target.ownedPaths.length },
      confidence: 0.95,
      extractedAt: now,
    };
    const verdict: VerdictInput = {
      runId,
      category: 'orphan',
      action: 'uninstall',
      status: 'proposed',
      subjectKey: target.key,
      subjectType: 'Application',
      label: `Uninstall ${target.name}${target.version ? ` ${target.version}` : ''}`,
      sizeBytes: target.sizeBytes,
      smartSelected: true,
      detail: {
        appName: target.name,
        installPath: target.installPath,
        ownedPaths: target.ownedPaths,
        edge: 'BUNDLE',
        note: 'Bundle and graph-owned support paths are removed together by the uninstaller.',
      },
    };
    db.addVerdict(verdict, provenance);
    db.createPlan(planId, runId, target.sizeBytes ?? 0);

    emit('gate', 'gate.human', 'gate_waiting', {
      planId,
      candidateCount: 1,
      reclaimableBytes: target.sizeBytes ?? 0,
    });

    return { runId };
  }

  async procsList(): Promise<ProcInfo[]> {
    const core = await this.load();
    return core.listProcs();
  }

  async procsKill(pid: number): Promise<{ ok: boolean; error?: string }> {
    const core = await this.load();
    const res = await core.killProc(pid);
    // Kills cannot be undone, only logged — write the receipt (best effort).
    try {
      const db = await this.db();
      core.writeReceipt(db, {
        verdictId: null,
        action: 'kill',
        path: `pid ${pid}`,
        trashRef: null,
        bytesFreed: null,
        ok: res.ok,
        error: res.error ?? null,
      });
    } catch {
      /* receipt is best-effort for direct kills */
    }
    return res;
  }

  async diskStatus(): Promise<DiskStatus> {
    const core = await this.load();
    const db = await this.db();
    return core.diskStatus(db);
  }

  async graphQuery(queryId: GraphQueryId, params?: Record<string, unknown>): Promise<GraphInsight> {
    const core = await this.load();
    const db = await this.db();
    return core.graphQuery(db, queryId, params);
  }

  async receiptsList(): Promise<Receipt[]> {
    const db = await this.db();
    return db.listReceipts();
  }

  async receiptsUndo(receiptId: number): Promise<{ ok: boolean; error?: string }> {
    const core = await this.load();
    const db = await this.db();
    const res = await core.undoReceipt(db, receiptId);
    return { ok: res.ok, error: res.error };
  }
}
