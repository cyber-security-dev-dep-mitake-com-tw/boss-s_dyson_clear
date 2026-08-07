/**
 * Provenance helpers — every fact and verdict in the graph carries a record of
 * which scanner produced it, under which rule, with what evidence/confidence.
 */
import type { Provenance } from '../contracts.js';

export type SubjectKind = 'node' | 'edge' | 'verdict';

export interface ProvenanceRow extends Provenance {
  id: number;
  subjectKind: SubjectKind;
  subjectId: number;
}

/** Build a Provenance record stamped now. */
export function prov(
  scanner: string,
  rule: string,
  evidence: Record<string, unknown>,
  confidence: number,
): Provenance {
  return { scanner, rule, evidence, confidence, extractedAt: Date.now() };
}

export function rowToProvenance(row: {
  scanner: string;
  rule: string;
  evidence: string;
  confidence: number;
  extracted_at: number;
}): Provenance {
  return {
    scanner: row.scanner,
    rule: row.rule,
    evidence: safeParse(row.evidence),
    confidence: row.confidence,
    extractedAt: row.extracted_at,
  };
}

export function safeParse(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
