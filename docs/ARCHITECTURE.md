# SweepDeck Architecture

SweepDeck applies **graph engineering** in two complementary layers, following the patterns in the
graph-engineering reference material (knowledge-graph half + task-graph half).

## 1. Knowledge graph — what the engine knows

The machine is modeled as a **property graph** persisted in SQLite (`better-sqlite3`, WAL mode).

**Ontology (schema before extraction):**

| Node types | Edge types |
|---|---|
| `File`, `Directory`, `Volume`, `Application`, `Process`, `CacheLocation`, `User` | `CONTAINS`, `OWNED_BY`, `HELD_OPEN_BY`, `DUPLICATE_OF`, `DEPENDS_ON`, `RUNS`, `INSTALLS_TO` |

**Provenance on every fact.** Every node, edge, and verdict carries
`{scanner, rule, evidence, confidence, extractedAt}`. This powers:

- the **deletion receipt** (audit log) — the user can always see *why* something was proposed;
- confidence badges in the UI;
- undo (receipts store a `trashRef` into the quarantine directory).

**Feature ↔ graph mapping:**

- *Duplicates = entity resolution (fusion):* blocking by `(size, ext)` → partial hash (first+last 64 KB)
  → full hash → `DUPLICATE_OF` edges to a canonical node chosen by merge policy
  (user-organized dirs > oldest mtime > shortest path). Smart-select = all non-canonical members.
- *Uninstall = graph traversal:* from an `Application` node, walk `OWNED_BY` / `INSTALLS_TO`
  edges to find the app bundle plus orphaned support files.
- *Insights = canned graph queries:* e.g. "Chrome owns 4.2 GB of cache across 3 locations"
  is an aggregation over `OWNED_BY` edges (`graph:query` IPC, renderer never sends SQL).

## 2. Task graph — how the engine works

Scans run on a small in-process workflow engine (deer-workflow style, zero deps):

- `parallel(tasks)` — failure of one branch resolves it to `null`; **siblings continue**
  (a permission-denied directory never cancels a scan).
- `pipeline(items, ...stages)` — per-item stages without global barriers.
- Named **phases** + a **JSONL event stream** (`WorkflowEvent`) that drives both the
  headless CLI (`--json`) and the Electron renderer (same events over IPC).

**The diamond with a human gate:**

```
phase scan    parallel: junk | large | duplicates | apps | processes | disk
phase verify  independent verifier (a scanner never grades its own homework)
phase merge   CleanPlan persisted (verdicts + provenance)
gate          HUMAN APPROVAL — per-item, explicit (UI checklist / CLI --approve-ids)
phase exec    trash-first executor → receipts (+ undo)
```

**Structural safety (not a flag):** the `Deleter` is constructed with allow-listed roots; it
`realpath`s every target and throws `ProtectedPathError` for anything outside the allowlist or on
the hard-deny list (`/System`, `C:\Windows`, …). See `docs/SAFETY-RULES.md`. The CLI exits with
code `2` ("refused") when approval is missing or a protected path is touched.

## 3. Process boundaries

```
packages/core   engine + CLI (pure Node, ESM, no Electron imports)  ← Robot Framework tests here
packages/app    Electron: main (hosts engine, validates IPC) / preload (contextBridge) / renderer (React)
```

Renderer security: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP
`default-src 'self'`; renderer approves **verdict IDs**, never raw paths — path resolution happens
engine-side against the persisted plan.

## 4. Delivery

Built by a role-based agent team (PM → designer ∥ backend → UI engineer → QA (Robot Framework) →
reviewer) coordinated by a manager; see `docs/TEAM-PROCESS.md`. CI and release packaging/signing
run in GitHub Actions; see `docs/SIGNING.md`.
