/**
 * SQLite DDL for the SweepDeck knowledge graph.
 * Opened in WAL mode; migration is idempotent (CREATE IF NOT EXISTS) and
 * versioned via PRAGMA user_version for future additive migrations.
 */
import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN
    ('File','Directory','Volume','Application','Process','CacheLocation','User')),
  key TEXT NOT NULL,
  props TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  UNIQUE (type, key)
);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY,
  src INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  dst INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN
    ('CONTAINS','OWNED_BY','HELD_OPEN_BY','DUPLICATE_OF','DEPENDS_ON','RUNS','INSTALLS_TO')),
  props TEXT NOT NULL DEFAULT '{}',
  UNIQUE (src, dst, type)
);

CREATE TABLE IF NOT EXISTS provenance (
  id INTEGER PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('node','edge','verdict')),
  subject_id INTEGER NOT NULL,
  scanner TEXT NOT NULL,
  rule TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL,
  extracted_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS verdicts (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id INTEGER REFERENCES nodes(id),
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  subject_key TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  label TEXT NOT NULL,
  size_bytes INTEGER,
  smart_selected INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS plans (
  plan_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  total_reclaimable INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY,
  verdict_id INTEGER REFERENCES verdicts(id),
  action TEXT NOT NULL,
  path TEXT,
  trash_ref TEXT,
  bytes_freed INTEGER,
  executed_at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_edges_src_type ON edges(src, type);
CREATE INDEX IF NOT EXISTS idx_edges_dst_type ON edges(dst, type);
CREATE INDEX IF NOT EXISTS idx_prov_subject ON provenance(subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS idx_verdicts_run ON verdicts(run_id);
`;

/** Apply pragmas + DDL. Safe to call on every open. */
export function migrate(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(DDL);
  const v = db.pragma('user_version', { simple: true }) as number;
  if (v < SCHEMA_VERSION) {
    // v0 → v1: initial schema (created above). Future migrations chain here.
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}
