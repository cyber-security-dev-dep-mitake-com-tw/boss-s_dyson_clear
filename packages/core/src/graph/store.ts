/**
 * GraphStore — the single owner of the SQLite knowledge graph.
 * All reads/writes from scanners, verifier, executor and CLI go through here;
 * the renderer only ever sees canned insight queries (GraphQueryId).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './schema.js';
import { rowToProvenance, safeParse, type SubjectKind } from './provenance.js';
import type {
  CleanPlan,
  EdgeType,
  GraphInsight,
  GraphQueryId,
  NodeType,
  Provenance,
  Receipt,
  Verdict,
  VerdictStatus,
} from '../contracts.js';

export interface VerdictInput {
  runId: string;
  nodeId?: number | null;
  category: Verdict['category'];
  action: Verdict['action'];
  status?: VerdictStatus;
  subjectKey: string;
  subjectType: NodeType;
  label: string;
  sizeBytes: number | null;
  smartSelected: boolean;
  detail: Record<string, unknown>;
}

interface VerdictRow {
  id: number;
  run_id: string;
  node_id: number | null;
  category: string;
  action: string;
  status: string;
  subject_key: string;
  subject_type: string;
  label: string;
  size_bytes: number | null;
  smart_selected: number;
  detail: string;
}

interface ReceiptRow {
  id: number;
  verdict_id: number | null;
  action: string;
  path: string | null;
  trash_ref: string | null;
  bytes_freed: number | null;
  executed_at: number;
  ok: number;
  error: string | null;
}

const FALLBACK_PROV: Provenance = {
  scanner: 'unknown',
  rule: 'unknown',
  evidence: {},
  confidence: 0,
  extractedAt: 0,
};

export class GraphStore {
  readonly db: Database.Database;
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    migrate(this.db);
  }

  close(): void {
    this.db.close();
  }

  // -- nodes / edges --------------------------------------------------------

  /** Insert or update a node by (type,key); returns node id. */
  upsertNode(type: NodeType, key: string, props: Record<string, unknown> = {}): number {
    const row = this.db
      .prepare(
        `INSERT INTO nodes (type, key, props, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(type, key) DO UPDATE SET
           props = json_patch(nodes.props, excluded.props),
           updated_at = excluded.updated_at
         RETURNING id`,
      )
      .get(type, key, JSON.stringify(props), Date.now()) as { id: number };
    return row.id;
  }

  getNodeId(type: NodeType, key: string): number | null {
    const row = this.db
      .prepare('SELECT id FROM nodes WHERE type = ? AND key = ?')
      .get(type, key) as { id: number } | undefined;
    return row?.id ?? null;
  }

  getNode(id: number): { id: number; type: NodeType; key: string; props: Record<string, unknown> } | null {
    const row = this.db.prepare('SELECT id, type, key, props FROM nodes WHERE id = ?').get(id) as
      | { id: number; type: NodeType; key: string; props: string }
      | undefined;
    return row ? { ...row, props: safeParse(row.props) } : null;
  }

  /** Insert or update an edge by (src,dst,type); returns edge id. */
  upsertEdge(src: number, dst: number, type: EdgeType, props: Record<string, unknown> = {}): number {
    const row = this.db
      .prepare(
        `INSERT INTO edges (src, dst, type, props) VALUES (?, ?, ?, ?)
         ON CONFLICT(src, dst, type) DO UPDATE SET props = json_patch(edges.props, excluded.props)
         RETURNING id`,
      )
      .get(src, dst, type, JSON.stringify(props)) as { id: number };
    return row.id;
  }

  countNodes(type?: NodeType): number {
    const row = (
      type
        ? this.db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE type = ?').get(type)
        : this.db.prepare('SELECT COUNT(*) AS n FROM nodes').get()
    ) as { n: number };
    return row.n;
  }

  // -- provenance -----------------------------------------------------------

  addProvenance(kind: SubjectKind, subjectId: number, p: Provenance): number {
    const res = this.db
      .prepare(
        `INSERT INTO provenance (subject_kind, subject_id, scanner, rule, evidence, confidence, extracted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(kind, subjectId, p.scanner, p.rule, JSON.stringify(p.evidence), p.confidence, p.extractedAt);
    return Number(res.lastInsertRowid);
  }

  listProvenance(kind: SubjectKind, subjectId: number): Provenance[] {
    const rows = this.db
      .prepare(
        `SELECT scanner, rule, evidence, confidence, extracted_at
         FROM provenance WHERE subject_kind = ? AND subject_id = ? ORDER BY id`,
      )
      .all(kind, subjectId) as Array<{
      scanner: string;
      rule: string;
      evidence: string;
      confidence: number;
      extracted_at: number;
    }>;
    return rows.map(rowToProvenance);
  }

  // -- verdicts / plans -----------------------------------------------------

  addVerdict(v: VerdictInput, provenance: Provenance): number {
    const res = this.db
      .prepare(
        `INSERT INTO verdicts (run_id, node_id, category, action, status, subject_key, subject_type,
                               label, size_bytes, smart_selected, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        v.runId,
        v.nodeId ?? null,
        v.category,
        v.action,
        v.status ?? 'proposed',
        v.subjectKey,
        v.subjectType,
        v.label,
        v.sizeBytes,
        v.smartSelected ? 1 : 0,
        JSON.stringify(v.detail),
      );
    const id = Number(res.lastInsertRowid);
    this.addProvenance('verdict', id, provenance);
    return id;
  }

  private verdictFromRow(row: VerdictRow): Verdict {
    const provs = this.listProvenance('verdict', row.id);
    return {
      id: row.id,
      runId: row.run_id,
      category: row.category as Verdict['category'],
      action: row.action as Verdict['action'],
      status: row.status as VerdictStatus,
      subjectKey: row.subject_key,
      subjectType: row.subject_type as NodeType,
      label: row.label,
      sizeBytes: row.size_bytes,
      smartSelected: row.smart_selected === 1,
      provenance: provs[0] ?? FALLBACK_PROV,
      detail: safeParse(row.detail),
    };
  }

  getVerdict(id: number): Verdict | null {
    const row = this.db.prepare('SELECT * FROM verdicts WHERE id = ?').get(id) as VerdictRow | undefined;
    return row ? this.verdictFromRow(row) : null;
  }

  listVerdicts(runId: string): Verdict[] {
    const rows = this.db
      .prepare('SELECT * FROM verdicts WHERE run_id = ? ORDER BY id')
      .all(runId) as VerdictRow[];
    return rows.map((r) => this.verdictFromRow(r));
  }

  updateVerdictStatus(id: number, status: VerdictStatus): void {
    this.db.prepare('UPDATE verdicts SET status = ? WHERE id = ?').run(status, id);
  }

  createPlan(planId: string, runId: string, totalReclaimable: number): void {
    this.db
      .prepare('INSERT INTO plans (plan_id, run_id, created_at, total_reclaimable) VALUES (?, ?, ?, ?)')
      .run(planId, runId, Date.now(), totalReclaimable);
  }

  getPlan(planIdOrRunId: string): CleanPlan | null {
    const row = this.db
      .prepare('SELECT * FROM plans WHERE plan_id = ? OR run_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(planIdOrRunId, planIdOrRunId) as
      | { plan_id: string; run_id: string; created_at: number; total_reclaimable: number }
      | undefined;
    if (!row) return null;
    return {
      planId: row.plan_id,
      runId: row.run_id,
      createdAt: row.created_at,
      verdicts: this.listVerdicts(row.run_id),
      totalReclaimableBytes: row.total_reclaimable,
    };
  }

  // -- receipts ---------------------------------------------------------------

  addReceipt(r: Omit<Receipt, 'id'>): number {
    const res = this.db
      .prepare(
        `INSERT INTO receipts (verdict_id, action, path, trash_ref, bytes_freed, executed_at, ok, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.verdictId, r.action, r.path, r.trashRef, r.bytesFreed, r.executedAt, r.ok ? 1 : 0, r.error);
    return Number(res.lastInsertRowid);
  }

  getReceipt(id: number): Receipt | null {
    const row = this.db.prepare('SELECT * FROM receipts WHERE id = ?').get(id) as ReceiptRow | undefined;
    return row ? receiptFromRow(row) : null;
  }

  listReceipts(): Receipt[] {
    const rows = this.db.prepare('SELECT * FROM receipts ORDER BY id').all() as ReceiptRow[];
    return rows.map(receiptFromRow);
  }

  updateReceipt(id: number, patch: Partial<Pick<Receipt, 'trashRef' | 'ok' | 'error'>>): void {
    const cur = this.getReceipt(id);
    if (!cur) return;
    this.db
      .prepare('UPDATE receipts SET trash_ref = ?, ok = ?, error = ? WHERE id = ?')
      .run(
        patch.trashRef !== undefined ? patch.trashRef : cur.trashRef,
        (patch.ok !== undefined ? patch.ok : cur.ok) ? 1 : 0,
        patch.error !== undefined ? patch.error : cur.error,
        id,
      );
  }

  // -- canned insight queries -------------------------------------------------

  query(queryId: GraphQueryId, params: Record<string, unknown> = {}): GraphInsight {
    let rows: Array<Record<string, unknown>>;
    switch (queryId) {
      case 'app-cache-aggregation':
        // "Chrome owns 4.2GB of cache across 3 locations"
        rows = this.db
          .prepare(
            `SELECT a.key AS appKey,
                    json_extract(a.props, '$.name') AS appName,
                    COUNT(DISTINCT c.id) AS locations,
                    COALESCE(SUM(json_extract(c.props, '$.sizeBytes')), 0) AS totalBytes
             FROM nodes a
             JOIN edges e ON e.dst = a.id AND e.type = 'OWNED_BY'
             JOIN nodes c ON c.id = e.src AND c.type IN ('CacheLocation','File','Directory')
             WHERE a.type = 'Application'
             GROUP BY a.id
             ORDER BY totalBytes DESC`,
          )
          .all() as Array<Record<string, unknown>>;
        break;
      case 'duplicate-groups':
        rows = this.db
          .prepare(
            `SELECT canon.key AS canonicalPath,
                    COUNT(dup.id) AS copies,
                    COALESCE(SUM(json_extract(dup.props, '$.sizeBytes')), 0) AS wastedBytes,
                    json_group_array(dup.key) AS duplicatePaths
             FROM edges e
             JOIN nodes dup ON dup.id = e.src
             JOIN nodes canon ON canon.id = e.dst
             WHERE e.type = 'DUPLICATE_OF'
             GROUP BY canon.id
             ORDER BY wastedBytes DESC`,
          )
          .all() as Array<Record<string, unknown>>;
        rows = rows.map((r) => ({ ...r, duplicatePaths: JSON.parse(String(r.duplicatePaths)) }));
        break;
      case 'orphaned-files':
        // Files/dirs OWNED_BY an Application marked uninstalled/missing.
        rows = this.db
          .prepare(
            `SELECT f.key AS path,
                    json_extract(f.props, '$.sizeBytes') AS sizeBytes,
                    a.key AS appKey,
                    json_extract(a.props, '$.name') AS appName
             FROM edges e
             JOIN nodes f ON f.id = e.src AND f.type IN ('File','Directory','CacheLocation')
             JOIN nodes a ON a.id = e.dst AND a.type = 'Application'
             WHERE e.type = 'OWNED_BY'
               AND json_extract(a.props, '$.installed') = 0
             ORDER BY sizeBytes DESC`,
          )
          .all() as Array<Record<string, unknown>>;
        break;
      case 'top-space-owners':
        rows = this.db
          .prepare(
            `SELECT a.key AS appKey,
                    json_extract(a.props, '$.name') AS appName,
                    COALESCE(SUM(json_extract(o.props, '$.sizeBytes')), 0)
                      + COALESCE(json_extract(a.props, '$.sizeBytes'), 0) AS totalBytes
             FROM nodes a
             LEFT JOIN edges e ON e.dst = a.id AND e.type = 'OWNED_BY'
             LEFT JOIN nodes o ON o.id = e.src
             WHERE a.type = 'Application'
             GROUP BY a.id
             ORDER BY totalBytes DESC
             LIMIT ${Number.isInteger(params.limit) ? Number(params.limit) : 25}`,
          )
          .all() as Array<Record<string, unknown>>;
        break;
      default:
        throw new Error(`unknown graph query: ${queryId satisfies never}`);
    }
    return { queryId, rows, generatedAt: Date.now() };
  }
}

function receiptFromRow(row: ReceiptRow): Receipt {
  return {
    id: row.id,
    verdictId: row.verdict_id,
    action: row.action,
    path: row.path,
    trashRef: row.trash_ref,
    bytesFreed: row.bytes_freed,
    executedAt: row.executed_at,
    ok: row.ok === 1,
    error: row.error,
  };
}
