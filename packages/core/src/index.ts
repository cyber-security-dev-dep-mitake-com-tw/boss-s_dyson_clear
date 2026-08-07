/**
 * @sweepdeck/core public API — everything the Electron main process needs to
 * back the SweepdeckApi IPC surface, so the app never re-implements engine
 * logic. No Electron imports live anywhere in this package.
 */

// The frozen contract (types + IPC channel map + CLI exit codes)
export * from './contracts.js';

// Knowledge graph
export { GraphStore, type VerdictInput } from './graph/store.js';
export * from './graph/ontology.js';
export { prov, type SubjectKind, type ProvenanceRow } from './graph/provenance.js';

// Workflow engine + event sinks
export { parallel, pipeline, phase, createLimiter, type Task, type TaskFailure, type Limiter } from './workflow/engine.js';
export { WorkflowEmitter, jsonlSink, callbackSink, teeSink, type EventSink } from './workflow/events.js';

// Orchestration (scan diamond + gated exec)
export {
  runScan,
  execPlan,
  ApprovalRequiredError,
  ALL_CATEGORIES,
  type RunScanOptions,
  type ExecPlanOptions,
} from './run.js';

// Scanners (direct feature APIs)
export { scanJunk } from './scanners/junk.js';
export { scanLargeFiles, DEFAULT_LARGE_THRESHOLD } from './scanners/largefiles.js';
export { scanDuplicates, pickCanonical } from './scanners/duplicates.js';
export { scanApps, parseRegUninstallOutput } from './scanners/apps.js';
export { scanProcesses, listProcesses, getLoginItems } from './scanners/processes.js';
export { scanDisk, getDiskStatus } from './scanners/disk.js';
export type { ScanContext, Candidate, ScannerResult, Scanner } from './scanners/types.js';
export { walk, treeSize, type WalkEntry, type WalkOptions } from './scanners/walk.js';

// Verifier
export { verify, type VerifiedCandidate, type VerifyOptions } from './verifier/verifier.js';
export { checkProtectedPath, isUnderUserContentDir, VERIFIER } from './verifier/rules.js';

// Executor
export { Deleter, ProtectedPathError, defaultQuarantineDir, type TrashResult } from './executor/deleter.js';
export { writeReceipt, undoReceipt, type UndoResult } from './executor/receipts.js';
export { uninstallApp, parseUninstallString, type UninstallResult } from './executor/uninstaller.js';
export { killProcess, type KillResult } from './executor/prockiller.js';

// Hashing (duplicate pipeline building blocks)
export { partialHash, fullHash, PARTIAL_CHUNK } from './hashing/hash.js';

// ---------------------------------------------------------------------------
// Convenience wrappers matching the SweepdeckApi surface 1:1
// ---------------------------------------------------------------------------

import os from 'node:os';
import { GraphStore } from './graph/store.js';
import { WorkflowEmitter } from './workflow/events.js';
import { scanApps } from './scanners/apps.js';
import { listProcesses } from './scanners/processes.js';
import { getDiskStatus } from './scanners/disk.js';
import { killProcess } from './executor/prockiller.js';
import { DEFAULT_LARGE_THRESHOLD } from './scanners/largefiles.js';
import type { AppInfo, DiskStatus, GraphInsight, GraphQueryId, ProcInfo } from './contracts.js';

/** apps:list — enumerate installed applications (and refresh the graph). */
export async function listApps(db: GraphStore, root?: string): Promise<AppInfo[]> {
  const emitter = new WorkflowEmitter('apps-list', () => void 0);
  const { apps } = await scanApps({ root, db, emit: emitter, largeThresholdBytes: DEFAULT_LARGE_THRESHOLD });
  return apps;
}

/** procs:list */
export async function listProcs(): Promise<ProcInfo[]> {
  return listProcesses();
}

/** disk:status */
export async function diskStatus(db?: GraphStore, root?: string): Promise<DiskStatus> {
  return getDiskStatus(root, db);
}

/** procs:kill */
export async function killProc(pid: number): Promise<{ ok: boolean; error?: string }> {
  const res = await killProcess(pid);
  return { ok: res.ok, ...(res.error ? { error: res.error } : {}) };
}

/** graph:query — canned insight queries only. */
export function graphQuery(db: GraphStore, queryId: GraphQueryId, params?: Record<string, unknown>): GraphInsight {
  return db.query(queryId, params);
}

/** Default DB path used by both CLI and app. */
export function defaultDbPath(): string {
  return `${os.homedir()}/.sweepdeck/graph.db`;
}
