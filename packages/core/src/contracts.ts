/**
 * SweepDeck — FROZEN CONTRACT between packages/core (engine + CLI) and
 * packages/app (Electron main/preload/renderer).
 *
 * Graph-engineering foundation:
 *  - The machine is modeled as a PROPERTY GRAPH (nodes + typed edges) in SQLite.
 *  - Every fact/verdict carries PROVENANCE {scanner, rule, evidence, confidence, extractedAt}.
 *  - Scans run as a TASK GRAPH (diamond): parallel scanners → verifier (separate
 *    step) → merge into CleanPlan → HUMAN GATE → executor → receipts.
 *  - All engine progress is a stream of WorkflowEvent (JSONL on the CLI,
 *    'workflow:event' over IPC in the app).
 *
 * Ownership: this file is owned by the manager. Backend and UI agents must NOT
 * edit it — build against it. Additive changes require manager sign-off.
 */

// ---------------------------------------------------------------------------
// Knowledge-graph ontology
// ---------------------------------------------------------------------------

export type NodeType =
  | 'File'
  | 'Directory'
  | 'Volume'
  | 'Application'
  | 'Process'
  | 'CacheLocation'
  | 'User';

export type EdgeType =
  | 'CONTAINS' // Directory → File/Directory
  | 'OWNED_BY' // File/Directory → Application
  | 'HELD_OPEN_BY' // File → Process
  | 'DUPLICATE_OF' // File → File (canonical)
  | 'DEPENDS_ON' // Application → Application/Framework
  | 'RUNS' // Application → Process
  | 'INSTALLS_TO'; // Application → Directory

export interface Provenance {
  scanner: string; // e.g. "junk-scanner@1"
  rule: string; // e.g. "mac.user-cache.older-than-7d"
  evidence: Record<string, unknown>; // matched glob, mtime, hash prefix, ...
  confidence: number; // 0..1
  extractedAt: number; // epoch ms
}

// ---------------------------------------------------------------------------
// Workflow (task-graph) event stream
// ---------------------------------------------------------------------------

export type WorkflowEventType =
  | 'run_started'
  | 'phase_started'
  | 'task_started'
  | 'task_progress'
  | 'task_finished'
  | 'task_failed'
  | 'phase_finished'
  | 'gate_waiting'
  | 'gate_resolved'
  | 'run_finished';

export interface WorkflowEvent {
  ts: number;
  runId: string;
  phase: string; // scan | verify | merge | gate | exec
  node: string; // e.g. "scanner.duplicates"
  type: WorkflowEventType;
  data: Record<string, unknown>; // task_progress: {done,total,bytes?} etc.
}

// ---------------------------------------------------------------------------
// Scanning & planning
// ---------------------------------------------------------------------------

export type ScanCategory = 'junk' | 'large' | 'duplicate' | 'apps' | 'processes' | 'disk';

export type VerdictCategory = 'junk' | 'large' | 'duplicate' | 'orphan' | 'process';
export type VerdictAction = 'trash' | 'uninstall' | 'kill' | 'advise';
export type VerdictStatus = 'proposed' | 'approved' | 'rejected' | 'executed' | 'undone';

export interface Verdict {
  id: number;
  runId: string;
  category: VerdictCategory;
  action: VerdictAction;
  status: VerdictStatus;
  /** Absolute path (files), bundle id / uninstall key (apps), or pid (processes). */
  subjectKey: string;
  subjectType: NodeType;
  /** Human-readable label, e.g. "Chrome GPU cache". */
  label: string;
  sizeBytes: number | null;
  /** True when the smart-select policy recommends this item. */
  smartSelected: boolean;
  provenance: Provenance;
  /** Extra per-category info: duplicate groupId & canonical path, app name, proc cpu/mem... */
  detail: Record<string, unknown>;
}

export interface CleanPlan {
  planId: string;
  runId: string;
  createdAt: number;
  verdicts: Verdict[];
  totalReclaimableBytes: number;
}

export interface ScanSummary {
  runId: string;
  categories: ScanCategory[];
  startedAt: number;
  finishedAt: number;
  scannedFiles: number;
  candidateCount: number;
  reclaimableBytes: number;
  planId: string | null; // null if scan produced no candidates
  errors: Array<{ node: string; message: string }>;
}

// ---------------------------------------------------------------------------
// Feature payloads
// ---------------------------------------------------------------------------

export interface AppInfo {
  key: string; // bundle id (mac) / registry uninstall key (win)
  name: string;
  version: string | null;
  publisher: string | null;
  installPath: string | null;
  sizeBytes: number | null;
  platform: 'darwin' | 'win32';
  /** Paths the graph traversal (OWNED_BY / INSTALLS_TO) attributes to this app. */
  ownedPaths: string[];
}

export interface ProcInfo {
  pid: number;
  name: string;
  command: string;
  cpuPercent: number;
  memBytes: number;
  user: string | null;
  started: string | null;
  /** Heuristic analysis with provenance — why this process may be unnecessary. */
  unnecessary: {
    score: number; // 0..1
    reasons: string[]; // e.g. "high memory", "login item", "not an OS process"
  } | null;
  isLoginItem: boolean;
  isSystem: boolean;
}

export interface VolumeStatus {
  mount: string;
  fsType: string;
  label: string;
  sizeBytes: number;
  usedBytes: number;
  availableBytes: number;
  usePercent: number;
  isSSD: boolean | null;
  smart: { status: string | null; raw?: Record<string, unknown> } | null;
}

export interface DiskStatus {
  volumes: VolumeStatus[];
  /** Largest top-level directories of the home volume for the treemap. */
  breakdown: Array<{ path: string; bytes: number }>;
  trimAdvice: {
    supported: boolean;
    autoTrimLikely: boolean;
    message: string;
    /** Command the app would run (with elevation + explicit consent). */
    command: string | null;
  };
}

export interface Receipt {
  id: number;
  verdictId: number | null;
  action: string;
  path: string | null;
  trashRef: string | null; // enables undo
  bytesFreed: number | null;
  executedAt: number;
  ok: boolean;
  error: string | null;
}

export interface ExecResult {
  runId: string;
  executed: number;
  failed: number;
  bytesFreed: number;
  receipts: Receipt[];
}

// ---------------------------------------------------------------------------
// Graph insight queries (canned — renderer never sends raw SQL)
// ---------------------------------------------------------------------------

export type GraphQueryId =
  | 'app-cache-aggregation' // "Chrome owns 4.2GB of cache across 3 locations"
  | 'duplicate-groups'
  | 'orphaned-files' // files OWNED_BY apps that no longer exist
  | 'top-space-owners'; // apps ranked by total owned bytes

export interface GraphInsight {
  queryId: GraphQueryId;
  rows: Array<Record<string, unknown>>;
  generatedAt: number;
}

// ---------------------------------------------------------------------------
// IPC channels (Electron)  — renderer → main via invoke/handle unless noted
// ---------------------------------------------------------------------------

export const IPC = {
  scanStart: 'scan:start', // {categories: ScanCategory[], roots?: string[]} → {runId}
  scanCancel: 'scan:cancel', // {runId} → {ok}
  workflowEvent: 'workflow:event', // main → renderer (send): WorkflowEvent
  planGet: 'plan:get', // {runId} → CleanPlan | null
  planApprove: 'plan:approve', // {planId, verdictIds: number[]} → ExecResult   (THE HUMAN GATE)
  appsList: 'apps:list', // {} → AppInfo[]
  appsUninstall: 'apps:uninstall', // {key} → {runId}
  procsList: 'procs:list', // {} → ProcInfo[]
  procsKill: 'procs:kill', // {pid} → {ok, error?}
  diskStatus: 'disk:status', // {} → DiskStatus
  diskTrim: 'disk:trim', // {consent: true} → {ok, output?, error?}
  graphQuery: 'graph:query', // {queryId, params?} → GraphInsight
  receiptsList: 'receipts:list', // {} → Receipt[]
  receiptsUndo: 'receipts:undo', // {receiptId} → {ok, error?}
} as const;

/** API surface exposed on window.sweepdeck by the preload script. */
export interface SweepdeckApi {
  scanStart(req: { categories: ScanCategory[]; roots?: string[] }): Promise<{ runId: string }>;
  scanCancel(req: { runId: string }): Promise<{ ok: boolean }>;
  onWorkflowEvent(cb: (ev: WorkflowEvent) => void): () => void;
  planGet(req: { runId: string }): Promise<CleanPlan | null>;
  planApprove(req: { planId: string; verdictIds: number[] }): Promise<ExecResult>;
  appsList(): Promise<AppInfo[]>;
  appsUninstall(req: { key: string }): Promise<{ runId: string }>;
  procsList(): Promise<ProcInfo[]>;
  procsKill(req: { pid: number }): Promise<{ ok: boolean; error?: string }>;
  diskStatus(): Promise<DiskStatus>;
  diskTrim(req: { consent: true }): Promise<{ ok: boolean; output?: string; error?: string }>;
  graphQuery(req: { queryId: GraphQueryId; params?: Record<string, unknown> }): Promise<GraphInsight>;
  receiptsList(): Promise<Receipt[]>;
  receiptsUndo(req: { receiptId: number }): Promise<{ ok: boolean; error?: string }>;
}

// ---------------------------------------------------------------------------
// CLI surface (Robot Framework test target)
// ---------------------------------------------------------------------------
//
//   sweepdeck-core scan  --categories junk,large,duplicate [--root <dir>] --db <file> --json
//        → JSONL WorkflowEvent stream on stdout; last line: {"type":"summary","summary":ScanSummary}
//   sweepdeck-core plan  --run <runId> --db <file> --json          → CleanPlan
//   sweepdeck-core exec  --plan <planId> --approve-ids 1,2 --db <file> --json [--dry-run]
//        → ExecResult ; refuses (exit 2) when --approve-ids missing
//   sweepdeck-core apps  list --json | uninstall --key <k> --json
//   sweepdeck-core procs list --json | kill --pid <n> --json
//   sweepdeck-core disk  status --json                             → DiskStatus
//   sweepdeck-core undo  --receipt <id> --db <file> --json
//
// Exit codes: 0 ok, 1 unexpected error, 2 refused (missing approval / protected path).
// --root confines every scanner to that directory (sandbox mode for tests).

export const CLI_EXIT = { OK: 0, ERROR: 1, REFUSED: 2 } as const;
