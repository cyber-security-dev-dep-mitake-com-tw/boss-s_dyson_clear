/**
 * Shared scanner types. A scanner NEVER grades its own homework — it only
 * emits Candidates (with provenance) and populates the graph; the verifier
 * turns candidates into verdicts.
 */
import type { GraphStore } from '../graph/store.js';
import type { NodeType, Provenance, VerdictAction, VerdictCategory } from '../contracts.js';
import type { WorkflowEmitter } from '../workflow/events.js';

export interface ScanContext {
  /** Sandbox root: when set, every scanner confines itself to this tree. */
  root?: string;
  db: GraphStore;
  emit: WorkflowEmitter;
  largeThresholdBytes: number;
  signal?: AbortSignal;
}

export interface Candidate {
  category: VerdictCategory;
  /** Action PROPOSED by the scanner — the verifier may downgrade/reject. */
  action: VerdictAction;
  subjectKey: string; // abs path | bundle id / uninstall key | pid
  subjectType: NodeType;
  label: string;
  sizeBytes: number | null;
  smartSelected: boolean;
  provenance: Provenance;
  detail: Record<string, unknown>;
  /** Graph node backing this candidate, when one was upserted. */
  nodeId?: number;
}

export interface ScannerResult {
  candidates: Candidate[];
  scannedFiles: number;
}

export type Scanner = (ctx: ScanContext) => Promise<ScannerResult>;

export const emptyResult = (): ScannerResult => ({ candidates: [], scannedFiles: 0 });
