# SweepDeck — Safety Rules (Authoritative Policy)

**Status:** Normative for all engine and app code. This document is the single source of truth for what SweepDeck may and may not do to a user's machine.
**Owner:** Product Manager, SweepDeck team
**Last updated:** 2026-08-07

> Rules in this document are **structural requirements**: they must be enforced in engine code paths that cannot be disabled by configuration, feature flag, environment variable, or UI state. If a rule here conflicts with the PRD, this document wins. Changes require manager sign-off (same policy as `packages/core/src/contracts.ts`).
>
> Enforcement points, in order: **scanner filters** (don't even propose) → **verifier** (downgrade/block) → **executor hard-deny** (final backstop; refuses with CLI exit 2 / IPC error even if earlier layers were bypassed or buggy). A protected path reaching the executor is treated as an engine bug: refuse, log, surface to the user, delete nothing in that batch item.

---

## 1. The Human-Gate Rule

**No delete, uninstall, kill, or startup-disable ever executes without explicit per-item human approval.**

1. The engine's task graph pauses at the gate (`gate_waiting`) after producing a `CleanPlan`. Execution happens only for the specific `verdictIds` passed to `plan:approve` (app) or `--approve-ids` (CLI). Absence of approvals is a **refusal** (CLI exit code 2, `CLI_EXIT.REFUSED`), never an implicit "approve all".
2. Approval is **per item**. Bulk selection affordances ("select all safe items") may set checkboxes, but each executed verdict must be individually present in the approved id list, individually verified, and individually receipted.
3. Process kills and startup-item disables use a per-action confirmation that names the exact process/item. There is no "kill all flagged" action anywhere in the product.
4. There is no auto-clean, scheduled clean, or "clean on low disk space" trigger in v1. Nothing destructive runs without a user in the loop at that moment.
5. Approving a plan approves **that plan** (`planId`-scoped). Stale plans (superseded by a newer scan of the same category, or older than 24 h) must be refused at execution and the user asked to re-scan — the disk may have changed.
6. Dry-run (`--dry-run`) must be side-effect-free: no filesystem writes outside the DB, no trash operations, no process signals.

---

## 2. Hard-Deny Lists (structural, per OS)

Paths below can **never** be the subject of a `trash`/`uninstall` deletion. Deny checks run on the **canonicalized real path** (symlinks resolved, `..` normalized, macOS firmlinks resolved, Windows short-names/junctions expanded) — never on the raw string. Symlinks are handled by trashing the link itself only, never following it to the target.

### 2.1 macOS — always denied

- `/System` and everything beneath it
- `/Library` **system-level** (i.e. `/Library/...`) — the per-user `~/Library` is scannable under category rules; `/Library` is not
- `/usr` (including `/usr/local` in v1 — revisit only with a dedicated review)
- `/bin`, `/sbin`
- `/private/var/db` and everything beneath it
- `/private/etc`, `/etc`, `/var/db` (alias forms of the above after canonicalization)
- `/Applications` bundles are deletable **only** as the explicit target of an uninstall verdict — never as junk/large/duplicate
- The SweepDeck quarantine directory and its own app-data/DB (self-protection)

### 2.2 Windows — always denied

- `C:\Windows` and everything beneath it (including `C:\Windows\Temp` in v1 — user temp is enough)
- `C:\Program Files` and `C:\Program Files (x86)` — **except** a path that is the explicit, verified target of an approved uninstall verdict's orphan sweep for that specific app's install directory
- `C:\ProgramData\Microsoft` and Windows system profile directories (`C:\Users\Default`, `C:\Users\Public\Desktop` system items, `%SystemRoot%`)
- Any drive root and OEM/recovery partitions
- The SweepDeck quarantine directory and its own app-data/DB (self-protection)

### 2.3 Both platforms — structural rules

- **Depth rule:** any path **shallower than depth 2** from a volume root is denied for deletion (e.g. `/Users`, `C:\Users`, `/Applications` as a directory, `D:\`). Depth counts path components below the volume mount point; the rule applies to the deletion subject itself, not to files contained deeper inside.
- **User-content rule:** the user's `Documents`, `Desktop`, and `Pictures` directories (and their contents) are **denied for the `junk` category** entirely — no cache/temp/log rule may match inside them. They remain visible to Large Files and Duplicates, where items may be *listed and manually selected* but are never smart-selected (see §3.4).
- **Currently-running rule:** an application's bundle/install dir cannot be uninstalled while the app has running processes (`RUNS` edge live); the user must quit (or be offered the Process view) first.
- **Volume rule:** no deletions on read-only volumes, and no deletions outside the volumes the scan covered.

### 2.4 Process hard-deny

- `isSystem: true` processes (kernel/OS-owned: PID ≤ reserved range, OS user accounts like `root`/`SYSTEM`/`_windowserver` service accounts, protected-process flags on Windows, platform binaries under `/System` / `C:\Windows`) are structurally excluded from kill: not killable via IPC/CLI regardless of UI state, and never heuristic-flagged.
- Processes belonging to other interactive users are killable only if the OS grants permission; SweepDeck never suggests elevation to kill.
- SweepDeck never kills itself or its own helper processes via the process feature.

---

## 3. Verifier Rules

The verifier is an independent task-graph node. It re-derives safety from evidence; it never trusts a scanner's confidence at face value. Output per verdict: a final confidence in `[0,1]`, a band (§3.3), and `smartSelected`.

### 3.1 Age thresholds (junk category)

A junk candidate younger than its threshold is **downgraded one band** (and can never be Safe):

| Junk type | Minimum age (mtime) for full confidence |
|---|---|
| App/user caches (`~/Library/Caches`, `%LOCALAPPDATA%\*\Cache`) | 7 days |
| Browser caches | 3 days |
| Temp directories (`%TEMP%`, `/var/folders` user temp) | 3 days |
| Logs | 14 days |
| OS Trash / Recycle Bin contents | 0 days (already user-discarded) — but emptying trash is labeled **not undoable** at approval time |

Age is measured from the newest of mtime/ctime. Items modified mid-scan (mtime after scan start) are re-checked at execution time and skipped with a receipted error if still fresh.

### 3.2 Open-file / handle downgrade

- Any file with a live `HELD_OPEN_BY` edge (open handle detected via lsof/OS handle enumeration, best-effort) is downgraded to **Review** at best, `smartSelected: false`, and the executor re-checks at execution time: if still open, that item fails safe (receipt `ok: false`, "file in use") rather than force-deleting.
- Handle detection is best-effort: absence of a detected handle is not proof of safety, so this rule only ever **downgrades** — it never boosts confidence.
- Databases-in-use patterns (`.sqlite-wal`, `.sqlite-shm`, lock files adjacent to a live sibling) inherit the open-file downgrade even without a detected handle.

### 3.3 Confidence bands and UI presentation

| Band | Confidence | Smart-selectable | UI treatment |
|---|---|---|---|
| **Safe** | ≥ 0.90 | Yes (preselected) | Green badge; one-line reason; approvable in bulk selection |
| **Probably safe** | 0.70 – 0.89 | No (listed, unchecked) | Yellow badge; reason + evidence shown inline; user must tick |
| **Review** | 0.40 – 0.69 | No | Grey badge "Needs review"; expanded evidence panel opens before the checkbox can be ticked |
| **Blocked** | < 0.40 or any hard rule hit | No | Red badge; checkbox disabled; shows *why* it's blocked (rule id). Present for transparency only |

Rules for the bands:

- `smartSelected: true` ⇔ band is **Safe** (and no downgrade rule fired). This is the only path to preselection anywhere in the product, and it never applies to `process` verdicts (kill is never preselected).
- Bands only move **down** through the verifier and executor pipeline, never up. No UI action can raise a band.
- Every badge must resolve to its provenance (scanner, rule id, evidence, timestamp) in one click. A verdict without resolvable provenance is treated as Blocked.
- Duplicate groups: the canonical copy is always rendered as "kept" and is not approvable while other group members are selected; the last remaining copy of any group is structurally unapprovable.

### 3.4 Category-specific verifier rules

- **Large files:** items under Documents/Desktop/Pictures cap at **Probably safe** (manual tick required). Items with atime/mtime within 180 days cap at Review for smart-select purposes.
- **Duplicates:** only full-hash-confirmed pairs get a verdict; partial-hash matches are working state, never user-visible verdicts.
- **Uninstall owned-paths:** attribution by strong evidence (bundle-id match, INSTALLS_TO record) may reach Safe; attribution by path convention alone caps at Probably safe; shared paths (owned by >1 installed app) are Blocked.
- **Junk:** a rule may only match inside its declared roots; a glob that resolves outside its root (symlink escape) is discarded and logged.

---

## 4. Receipts

Every executed action — success or failure — produces exactly one `Receipt` linked to its verdict, recording action, path, `trashRef` (when trash-backed), bytes freed, timestamp, and `ok/error`. Receipts are append-only, persist in the SQLite DB across restarts, and are user-visible (`receipts:list`). The provenance chain (receipt → verdict → provenance) must remain resolvable for as long as the receipt exists.

---

## 5. Quarantine / Undo Policy

1. **Trash-first, always.** File deletions move items to the OS trash (macOS Trash / Windows Recycle Bin) and record `trashRef`. **Hard delete (unlink) is never a fallback.** If the OS trash cannot take the item (network volume, size limits, API failure), the executor moves it into the **SweepDeck quarantine** — a per-user, user-only-permissions directory that preserves the original absolute path and metadata in the DB — and the receipt's `trashRef` points there. If neither trash nor quarantine succeeds, the item **fails safe**: nothing is deleted, receipt `ok: false`.
2. **Undo** (`receipts:undo` / `undo --receipt`) restores the item from `trashRef` to its original path. If the original path is occupied, restore to a `Recovered by SweepDeck` folder alongside it and say so; never overwrite. Undo of an undone or missing item returns an honest error. Restored content must be byte-identical.
3. **Retention:** quarantine items are kept **30 days**, then purged (purging quarantine is the one deletion that doesn't create new user-facing verdicts — it is receipted internally). Items in the OS trash follow the OS's own retention; SweepDeck never empties the OS trash except as the explicit, approved Trash-emptying action of Smart Clean.
4. **Irreversible actions are labeled before approval:** emptying Trash/Recycle Bin, process kill, and whatever a vendor uninstaller does on Windows. The approval UI must show a distinct "cannot be undone" marker on these items; their receipts have `trashRef: null`.
5. **Startup-item disables are parked, not deleted:** the original entry (launch-agent plist / Run-key value / shortcut) is preserved in quarantine so re-enable is a restore, receipted like any other undo.
6. **Self-consistency:** the quarantine directory and the SweepDeck DB are on the hard-deny list (§2) — no SweepDeck feature can select them for cleaning.

---

## 6. Test obligations (must stay green in CI)

- `exec` without `--approve-ids` → exit 2, zero side effects.
- Plan containing a hard-denied path (each OS list sampled + depth rule + Documents/Desktop/Pictures junk rule) → executor refuses that item, exit 2 semantics, zero deletions for that item.
- Open-file fixture → verdict downgraded, execution fails safe with receipted error.
- Trash-unavailable fixture → quarantine used; undo restores byte-identical content to the original path.
- Duplicate-group fixture → approving all members of a group is impossible via API.
- Stale plan (older than 24 h / superseded) → execution refused.
