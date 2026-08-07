/**
 * store.ts — zustand store.
 * Scan state machine: idle → scanning (event stream, per-phase progress) →
 * gate (plan loaded, selection = smartSelected defaults) → executing →
 * done (receipts). Plus apps / procs / disk / receipts / insights slices.
 */
import { create } from 'zustand';
import type {
  AppInfo,
  CleanPlan,
  DiskStatus,
  ExecResult,
  GraphInsight,
  GraphQueryId,
  ProcInfo,
  Receipt,
  ScanCategory,
  WorkflowEvent,
} from '@contracts';

export type ScanStatus = 'idle' | 'scanning' | 'gate' | 'executing' | 'done' | 'error';
export type FlowKind = 'clean' | 'uninstall' | 'large' | 'duplicate';
export type ViewId =
  | 'dashboard'
  | 'smart-clean'
  | 'uninstaller'
  | 'large-files'
  | 'duplicates'
  | 'disk-status'
  | 'processes'
  | 'receipts'
  | 'settings';

export interface PhaseInfo {
  state: 'wait' | 'run' | 'done' | 'failed';
  done: number;
  total: number;
  bytes?: number;
}

export interface ToastInfo {
  kind: 'success' | 'error' | 'info';
  title: string;
  detail?: string;
  receiptIds?: number[];
  undoable?: boolean;
}

export const PHASE_ORDER = ['scan', 'verify', 'merge', 'gate', 'exec'] as const;

function smartSelection(plan: CleanPlan): Record<number, boolean> {
  const sel: Record<number, boolean> = {};
  for (const v of plan.verdicts) {
    if (v.smartSelected && v.status === 'proposed') sel[v.id] = true;
  }
  return sel;
}

interface SweepStore {
  view: ViewId;
  setView(view: ViewId): void;

  // --- scan / plan / gate state machine ---
  status: ScanStatus;
  flow: FlowKind | null;
  runId: string | null;
  phases: Record<string, PhaseInfo>;
  lastEvent: WorkflowEvent | null;
  scanErrors: Array<{ node: string; message: string }>;
  scannedFiles: number;
  plan: CleanPlan | null;
  selected: Record<number, boolean>;
  execResult: ExecResult | null;
  scanError: string | null;
  toast: ToastInfo | null;

  handleEvent(ev: WorkflowEvent): void;
  startScan(flow: FlowKind, categories: ScanCategory[], roots?: string[]): Promise<void>;
  startUninstall(key: string): Promise<void>;
  cancelScan(): Promise<void>;
  resetScan(): void;
  toggle(id: number, on?: boolean): void;
  setMany(ids: number[], on: boolean): void;
  clearSelection(): void;
  applySmartSelection(): void;
  approveSelected(): Promise<void>;
  setToast(toast: ToastInfo | null): void;

  // --- feature slices ---
  apps: AppInfo[] | null;
  appsLoading: boolean;
  appsError: string | null;
  loadApps(force?: boolean): Promise<void>;

  procs: ProcInfo[] | null;
  procsError: string | null;
  loadProcs(): Promise<void>;
  killProc(pid: number): Promise<{ ok: boolean; error?: string }>;

  disk: DiskStatus | null;
  diskLoading: boolean;
  diskError: string | null;
  loadDisk(force?: boolean): Promise<void>;

  receipts: Receipt[] | null;
  loadReceipts(): Promise<void>;
  undoReceipt(id: number): Promise<void>;

  insights: Partial<Record<GraphQueryId, GraphInsight>>;
  loadInsight(queryId: GraphQueryId): Promise<void>;
}

export const useStore = create<SweepStore>((set, get) => ({
  view: 'dashboard',
  setView: (view) => set({ view }),

  status: 'idle',
  flow: null,
  runId: null,
  phases: {},
  lastEvent: null,
  scanErrors: [],
  scannedFiles: 0,
  plan: null,
  selected: {},
  execResult: null,
  scanError: null,
  toast: null,

  handleEvent: (ev) => {
    const st = get();
    // Adopt the run id from the first event if the invoke reply hasn't landed.
    if (st.runId && ev.runId !== st.runId) return;
    if (!st.runId && (st.status === 'scanning' || st.status === 'executing')) {
      set({ runId: ev.runId });
    } else if (!st.runId) {
      return;
    }

    const phases = { ...get().phases };
    const cur = phases[ev.phase] ?? { state: 'wait', done: 0, total: 0 };

    switch (ev.type) {
      case 'run_started':
        break;
      case 'phase_started':
        phases[ev.phase] = { ...cur, state: 'run' };
        break;
      case 'task_started':
        phases[ev.phase] = { ...cur, state: 'run' };
        break;
      case 'task_progress': {
        const done = typeof ev.data.done === 'number' ? ev.data.done : cur.done;
        const total = typeof ev.data.total === 'number' ? ev.data.total : cur.total;
        const bytes = typeof ev.data.bytes === 'number' ? ev.data.bytes : cur.bytes;
        phases[ev.phase] = { state: 'run', done, total, bytes };
        if (ev.phase === 'scan' && typeof ev.data.done === 'number') {
          set({ scannedFiles: Math.max(get().scannedFiles, ev.data.done) });
        }
        break;
      }
      case 'task_finished':
        break;
      case 'task_failed': {
        const message = typeof ev.data.message === 'string' ? ev.data.message : JSON.stringify(ev.data);
        set({ scanErrors: [...get().scanErrors, { node: ev.node, message }] });
        break;
      }
      case 'phase_finished':
        phases[ev.phase] = { ...cur, state: 'done', done: cur.total || cur.done, total: cur.total || cur.done };
        break;
      case 'gate_waiting': {
        // planId === null in the gate event means the scan found nothing.
        if (ev.data.planId === null) {
          phases['gate'] = { state: 'done', done: 1, total: 1 };
          set({ phases, lastEvent: ev, status: 'done', plan: null });
          return;
        }
        phases['gate'] = { state: 'run', done: 0, total: 0 };
        set({ phases, lastEvent: ev, status: 'gate' });
        void window.sweepdeck.planGet({ runId: ev.runId }).then((plan) => {
          if (get().runId !== ev.runId) return;
          if (plan && plan.verdicts.some((v) => v.status === 'proposed')) {
            set({ plan, selected: smartSelection(plan) });
          } else {
            set({ status: 'done', plan: plan ?? null });
          }
        });
        return;
      }
      case 'gate_resolved':
        phases['gate'] = { state: 'done', done: 1, total: 1 };
        break;
      case 'run_finished': {
        set({ phases, lastEvent: ev });
        const status = get().status;
        if (status === 'scanning') {
          // No gate event seen — either nothing to clean or the plan is ready.
          void window.sweepdeck.planGet({ runId: ev.runId }).then((plan) => {
            if (get().runId !== ev.runId) return;
            if (plan && plan.verdicts.length > 0) {
              set({ plan, selected: smartSelection(plan), status: 'gate' });
            } else {
              set({ status: 'done', plan: plan ?? null });
            }
          });
        }
        return;
      }
    }
    set({ phases, lastEvent: ev });
  },

  startScan: async (flow, categories, roots) => {
    set({
      status: 'scanning',
      flow,
      runId: null,
      phases: { scan: { state: 'run', done: 0, total: 0 } },
      lastEvent: null,
      scanErrors: [],
      scannedFiles: 0,
      plan: null,
      selected: {},
      execResult: null,
      scanError: null,
    });
    try {
      const { runId } = await window.sweepdeck.scanStart({ categories, roots });
      if (get().status === 'scanning' && !get().runId) set({ runId });
    } catch (err) {
      set({
        status: 'error',
        scanError: String((err as Error)?.message ?? err),
      });
    }
  },

  startUninstall: async (key) => {
    set({
      status: 'scanning',
      flow: 'uninstall',
      runId: null,
      phases: { scan: { state: 'run', done: 0, total: 0 } },
      lastEvent: null,
      scanErrors: [],
      scannedFiles: 0,
      plan: null,
      selected: {},
      execResult: null,
      scanError: null,
    });
    try {
      const { runId } = await window.sweepdeck.appsUninstall({ key });
      if (get().status === 'scanning' && !get().runId) set({ runId });
    } catch (err) {
      set({ status: 'error', scanError: String((err as Error)?.message ?? err) });
    }
  },

  cancelScan: async () => {
    const { runId } = get();
    if (runId) {
      try {
        await window.sweepdeck.scanCancel({ runId });
      } catch {
        // best effort
      }
    }
    get().resetScan();
  },

  resetScan: () =>
    set({
      status: 'idle',
      flow: null,
      runId: null,
      phases: {},
      lastEvent: null,
      scanErrors: [],
      scannedFiles: 0,
      plan: null,
      selected: {},
      execResult: null,
      scanError: null,
    }),

  toggle: (id, on) => {
    const selected = { ...get().selected };
    const next = on ?? !selected[id];
    if (next) selected[id] = true;
    else delete selected[id];
    set({ selected });
  },

  setMany: (ids, on) => {
    const selected = { ...get().selected };
    for (const id of ids) {
      if (on) selected[id] = true;
      else delete selected[id];
    }
    set({ selected });
  },

  clearSelection: () => set({ selected: {} }),

  applySmartSelection: () => {
    const { plan } = get();
    if (plan) set({ selected: smartSelection(plan) });
  },

  approveSelected: async () => {
    const { plan, selected } = get();
    if (!plan) return;
    const verdictIds = plan.verdicts.filter((v) => selected[v.id]).map((v) => v.id);
    if (verdictIds.length === 0) return;
    set({ status: 'executing' });
    try {
      const result = await window.sweepdeck.planApprove({ planId: plan.planId, verdictIds });
      set({
        execResult: result,
        status: 'done',
        toast: {
          kind: result.failed > 0 ? 'info' : 'success',
          title:
            result.failed > 0
              ? `Executed ${result.executed} of ${result.executed + result.failed} items`
              : `Cleaned ${formatGB(result.bytesFreed)}`,
          detail: `${result.executed} item${result.executed === 1 ? '' : 's'} processed${
            result.receipts.length ? ` · receipt #${result.receipts[0].id}` : ''
          }${result.failed ? ` · ${result.failed} failed safe` : ''}`,
          receiptIds: result.receipts.filter((r) => r.ok && r.trashRef).map((r) => r.id),
          undoable: result.receipts.some((r) => r.ok && r.trashRef),
        },
      });
      void get().loadReceipts();
      void get().loadDisk(true);
    } catch (err) {
      set({
        status: 'gate',
        toast: { kind: 'error', title: 'Execution refused', detail: String((err as Error)?.message ?? err) },
      });
    }
  },

  setToast: (toast) => set({ toast }),

  // --- apps ---
  apps: null,
  appsLoading: false,
  appsError: null,
  loadApps: async (force) => {
    if (get().apps && !force) return;
    set({ appsLoading: true, appsError: null });
    try {
      const apps = await window.sweepdeck.appsList();
      set({ apps, appsLoading: false });
    } catch (err) {
      set({ appsLoading: false, appsError: String((err as Error)?.message ?? err) });
    }
  },

  // --- procs ---
  procs: null,
  procsError: null,
  loadProcs: async () => {
    try {
      const procs = await window.sweepdeck.procsList();
      set({ procs, procsError: null });
    } catch (err) {
      set({ procsError: String((err as Error)?.message ?? err) });
    }
  },
  killProc: async (pid) => {
    try {
      const res = await window.sweepdeck.procsKill({ pid });
      void get().loadProcs();
      void get().loadReceipts();
      return res;
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err) };
    }
  },

  // --- disk ---
  disk: null,
  diskLoading: false,
  diskError: null,
  loadDisk: async (force) => {
    if (get().disk && !force) return;
    set({ diskLoading: true, diskError: null });
    try {
      const disk = await window.sweepdeck.diskStatus();
      set({ disk, diskLoading: false });
    } catch (err) {
      set({ diskLoading: false, diskError: String((err as Error)?.message ?? err) });
    }
  },

  // --- receipts ---
  receipts: null,
  loadReceipts: async () => {
    try {
      const receipts = await window.sweepdeck.receiptsList();
      set({ receipts });
    } catch {
      // engine may not be built yet; receipts stay null
    }
  },
  undoReceipt: async (id) => {
    try {
      const res = await window.sweepdeck.receiptsUndo({ receiptId: id });
      if (res.ok) {
        set({ toast: { kind: 'success', title: 'Restored', detail: `Receipt #${id} undone — files back at their original paths` } });
      } else {
        set({ toast: { kind: 'error', title: 'Undo failed', detail: res.error ?? 'unknown error' } });
      }
      void get().loadReceipts();
    } catch (err) {
      set({ toast: { kind: 'error', title: 'Undo failed', detail: String((err as Error)?.message ?? err) } });
    }
  },

  // --- graph insights ---
  insights: {},
  loadInsight: async (queryId) => {
    try {
      const insight = await window.sweepdeck.graphQuery({ queryId });
      set({ insights: { ...get().insights, [queryId]: insight } });
    } catch {
      // insight cards render an empty state when the engine isn't available
    }
  },
}));

function formatGB(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
