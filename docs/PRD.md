# SweepDeck — Product Requirements Document (v1)

**Status:** Approved for v1 build
**Owner:** Product Manager, SweepDeck team
**Last updated:** 2026-08-07
**Companion documents:** [`SAFETY-RULES.md`](./SAFETY-RULES.md) (authoritative safety policy), `packages/core/src/contracts.ts` (frozen engine↔app contract)

> Where this PRD and `SAFETY-RULES.md` appear to conflict, **SAFETY-RULES.md wins**. Where either conflicts with `contracts.ts` type/IPC definitions, `contracts.ts` wins for shapes and this PRD wins for behavior.

---

## 1. Product summary

SweepDeck is a cross-platform (Windows + macOS) desktop disk cleaner and system optimizer built with Electron + TypeScript. Its differentiator is **graph engineering**:

- The machine is modeled as a **property graph** (Files, Directories, Volumes, Applications, Processes as nodes; `CONTAINS`, `OWNED_BY`, `DUPLICATE_OF`, `HELD_OPEN_BY`, `DEPENDS_ON`, `RUNS`, `INSTALLS_TO` as edges) persisted in SQLite.
- **Every fact carries provenance** — which scanner produced it, which rule fired, what evidence matched, at what confidence, and when. Provenance powers the confidence badges in the UI, the deletion receipts, and undo.
- Scans run as a **task graph** (diamond pattern): parallel scanners → independent safety verifier → merged clean plan → **human approval gate** → trash-first executor → receipts.

The result is a cleaner that can always answer *"why do you think this is safe to delete?"* — and that structurally cannot delete anything without an explicit, per-item human approval.

### Why users should care (value proposition)

| Typical cleaner | SweepDeck |
|---|---|
| "We found 12 GB of junk" — trust us | Every item shows the rule, the evidence, and a confidence badge |
| Bulk "Clean" button, opaque behavior | Per-item approval gate; nothing is destroyed without your explicit selection |
| Deleted means gone | Trash/quarantine-first execution; every action has a receipt and undo where possible |
| Uninstall = drag to trash | Graph traversal finds the app **and** its orphaned caches, preferences, and support files |
| System paths protected by a config flag | Protected paths are structurally unreachable by the executor (see SAFETY-RULES.md) |

### Non-goals for v1

- No antivirus / malware scanning.
- No registry "cleaning" or optimization on Windows.
- No background daemon / scheduled cleaning (v1 is fully interactive).
- No cloud sync, telemetry-driven recommendations, or account system.
- No Windows silent uninstall, no service removal (see §5 scope table).

---

## 2. Target users

1. **The prosumer** ("my SSD is full again") — developer, designer, video editor. Comfortable with the file system, wants to know *why* before deleting, values undo. Primary persona; drives the provenance/receipts design.
2. **The family tech helper** — cleans relatives' machines. Needs high-confidence smart selection so the defaults are safe to accept, plus a strong safety net when they're moving fast.
3. **The cautious upgrader** — non-expert who has been burned by aggressive cleaners. Will only ever accept "safe" (high-confidence) suggestions. Needs plain-language explanations and visible protections.
4. **QA / power users via CLI** — the headless `sweepdeck-core` CLI (JSONL event stream, sandbox `--root`) serves automation and our own Robot Framework suites; not a marketed persona but a supported surface.

---

## 3. Features

Each feature below lists user stories and **acceptance criteria (AC)**. All destructive flows additionally inherit the cross-cutting requirements of §4.

### 3.1 Smart Clean

Scans well-known junk locations — user/app caches, temp directories, log files, browser caches, and OS trash — and proposes deletions with per-item confidence badges. Corresponds to scan category `junk`, verdict category `junk`, action `trash`.

**User stories**

- As a user with a full disk, I want one scan that finds caches, temp files, logs, browser caches, and trash so I can reclaim space without hunting manually.
- As a cautious user, I want each proposed item to show *why* it was flagged and how confident SweepDeck is, so I can decide item by item.
- As a fast-moving user, I want a "smart selection" preselected for me containing only high-confidence items, so accepting the defaults is safe.

**Acceptance criteria**

- AC-SC-1: A `junk` scan emits streaming `WorkflowEvent`s (`task_started` / `task_progress` with `{done,total,bytes?}` / `task_finished`) and terminates with a `CleanPlan` (or a `ScanSummary` with `planId: null` when nothing is found).
- AC-SC-2: Scanned locations per OS at minimum:
  - macOS: `~/Library/Caches/*`, `~/Library/Logs/*`, `/private/var/folders` user temp (best-effort), per-browser cache dirs (Chrome, Edge, Firefox, Safari where readable), `~/.Trash`.
  - Windows: `%LOCALAPPDATA%\Temp`, `%TEMP%`, `%LOCALAPPDATA%\*\Cache` for known apps, per-browser cache dirs (Chrome, Edge, Firefox), Recycle Bin.
- AC-SC-3: Every verdict carries `Provenance` with a specific rule id (e.g. `mac.user-cache.older-than-7d`), evidence (matched glob, mtime, size), and a confidence in `[0,1]`.
- AC-SC-4: The UI renders a confidence badge per item using the bands defined in SAFETY-RULES.md §3.3 (Safe / Probably safe / Review / Blocked). `smartSelected: true` only for items in the "Safe" band per the verifier.
- AC-SC-5: Items younger than the category age threshold (SAFETY-RULES.md §3.1) or currently held open (`HELD_OPEN_BY` edge present) are downgraded and never smart-selected.
- AC-SC-6: Nothing is deleted at scan time. Deletion occurs only via `plan:approve` with explicit `verdictIds` (the human gate), executes trash-first, and produces one `Receipt` per item.
- AC-SC-7: Hard-denied paths (SAFETY-RULES.md §2) never appear as junk verdicts, even at confidence 0.
- AC-SC-8: After execution, the UI shows bytes actually freed (from receipts), not the pre-scan estimate.

### 3.2 App Uninstaller

Lists installed applications; uninstalling removes the app **and** its orphaned support files, discovered via graph traversal over `OWNED_BY` / `INSTALLS_TO` edges. Scan category `apps`; verdict categories `junk`/`orphan`; actions `uninstall` + `trash`.

**User stories**

- As a user removing an app, I want its caches, preferences, logs, and support files found and offered for removal too, so the app is really gone.
- As a Windows user, I want SweepDeck to launch the vendor's own uninstaller (so the app is removed the supported way), and then sweep up what the vendor left behind.
- As a user, I want to see exactly which files are attributed to the app and why, before anything is removed.

**Acceptance criteria**

- AC-AU-1: `apps:list` returns `AppInfo[]` for both platforms — from `/Applications` + `~/Applications` bundles (macOS) and the registry uninstall keys (Windows) — including `ownedPaths` from graph traversal.
- AC-AU-2: On macOS, uninstall = move the `.app` bundle to Trash plus the approved owned paths (e.g. `~/Library/Application Support/<app>`, `~/Library/Caches/<bundle-id>`, `~/Library/Preferences/<bundle-id>.plist`, launch agents). Each owned path is a separate verdict with its own provenance and approval checkbox.
- AC-AU-3: On Windows, uninstall = launch the registered vendor uninstaller **interactively** (no silent flags in v1; see §5), wait for it to exit, then re-scan and offer an **orphan sweep** of leftover owned paths as a new plan, again behind the gate.
- AC-AU-4: Attribution provenance is visible: each owned path shows how it was linked (path convention, bundle id match, install-log evidence) and its confidence. Low-confidence attributions are never smart-selected.
- AC-AU-5: A path owned by more than one installed application (shared frameworks, `DEPENDS_ON` targets) is excluded from the uninstall plan and shown as "shared — kept".
- AC-AU-6: The Orphaned Files insight (`graph:query` `orphaned-files`) lists files `OWNED_BY` applications that no longer exist, feeding the same gated flow.
- AC-AU-7: `apps:uninstall` returns a `runId`; the whole flow emits `WorkflowEvent`s including `gate_waiting` / `gate_resolved`. Nothing (including the vendor uninstaller launch) executes before gate approval of the uninstall verdict.
- AC-AU-8: System/OS-bundled applications (macOS `/System/Applications`, Windows system components) are not listed as uninstallable.

### 3.3 Large Files finder

Finds unusually large files; smart-selects by size threshold + age; supports manual selection; deletion behind the approval gate. Scan category `large`, verdict category `large`, action `trash`.

**User stories**

- As a user, I want to see the biggest files on my disk ranked by size so I can find the space hogs.
- As a user, I want smart selection to preselect only files that are both large and old (stale downloads, old disk images), not my active project files.
- As a user, I want to sort/filter by size, age, and location, and select items manually regardless of smart selection.

**Acceptance criteria**

- AC-LF-1: Default scan reports files ≥ 500 MB under the user's home volume (threshold user-adjustable, 100 MB–10 GB); results stream progressively so first results appear before the scan completes.
- AC-LF-2: Smart-select policy: `smartSelected: true` only when size ≥ threshold **and** last accessed/modified > 180 days ago **and** the file is in a "disposable-leaning" location (Downloads, temp-like dirs, `*.dmg`/`*.iso`/`*.zip` installers). Files under Documents/Desktop/Pictures are listed but never smart-selected (SAFETY-RULES.md §2.3).
- AC-LF-3: Each verdict's evidence includes size, mtime/atime, and the rule that fired; the UI shows a human-readable reason ("2.3 GB installer, untouched for 14 months").
- AC-LF-4: Manual selection of any listed item is allowed; the verifier may still downgrade or block (open files, protected paths) and the UI must explain the downgrade.
- AC-LF-5: Deletion only via the gate; trash-first; receipts with `trashRef` for undo.
- AC-LF-6: Files held open by a running process are marked and cannot be approved until the handle is released or the user resolves it via the Process view.

### 3.4 Duplicate finder

Entity-resolution dedupe: candidate blocking by (size, extension) → partial hash → full hash confirmation; duplicate groups pick a canonical copy; smart select proposes deleting the non-canonical copies. Scan category `duplicate`, verdict category `duplicate`, action `trash`.

**User stories**

- As a user, I want duplicates confirmed by content hash, not just name/size, so I never lose the only copy of a file.
- As a user, I want SweepDeck to pick the best copy to keep (canonical) and preselect the rest, with the ability to override which copy is kept.
- As a user, I want duplicates shown as groups so I understand what stays and what goes.

**Acceptance criteria**

- AC-DF-1: Pipeline is staged for performance: block on (size, extension) → partial hash (first N KiB) → **full hash** before any pair is asserted `DUPLICATE_OF`. No verdict is created for a pair that has not passed full-hash comparison.
- AC-DF-2: Zero-byte files and hard links / same-inode entries are excluded from duplicate groups.
- AC-DF-3: Canonical selection policy (deterministic, documented in evidence): prefer the copy in the most "intentional" location (Documents over Downloads over temp), then oldest original, then shortest path. Users can re-pick the canonical per group; smart selection recomputes.
- AC-DF-4: The whole group is never smart-selected — at least one copy (the canonical) is always kept unselected; the UI structurally prevents approving all members of a group in one action.
- AC-DF-5: Verdict `detail` carries `groupId` and canonical path (per the contract); `graph:query` `duplicate-groups` returns the group view.
- AC-DF-6: Evidence includes both hashes and the algorithm; deletion is gate-approved, trash-first, receipted.

### 3.5 Disk Status

Read-only dashboard: per-volume usage, top-level breakdown for a treemap, SMART health (best-effort), and TRIM advisory with consent-gated elevation. Scan category `disk`; only action type is `advise` — this feature deletes nothing.

**User stories**

- As a user, I want to see how full each volume is and what's taking the space (treemap of largest top-level directories) so I know where to aim the other tools.
- As a user, I want a best-effort SMART health readout so I get early warning of a failing drive.
- As an SSD user, I want to know whether TRIM is active, and if a manual TRIM would help, I want SweepDeck to run it only after I explicitly consent to elevation.

**Acceptance criteria**

- AC-DS-1: `disk:status` returns `DiskStatus` with all mounted volumes (mount, fs type, size/used/available/percent) and a `breakdown` of the largest top-level directories of the home volume, rendered as a treemap/bar breakdown in the UI.
- AC-DS-2: SMART is **best-effort**: if `smartctl`/OS facilities are unavailable or the drive doesn't report (common on NVMe via bridges, virtualized disks), `smart` is `null` or `{status: null}` and the UI shows "SMART: unavailable" — never an error state, never a fabricated "Healthy".
- AC-DS-3: TRIM is **advisory + consent**: `trimAdvice` reports whether TRIM is supported and whether auto-TRIM is likely already active, with a plain-language message and the exact `command` that would run. On modern macOS/Windows the expected advice is "automatic TRIM is active; no action needed."
- AC-DS-4: `disk:trim` requires `{consent: true}` and triggers the OS elevation prompt (admin/UAC); it is never invoked implicitly, never bundled into another action, and the command shown to the user is exactly the command executed.
- AC-DS-5: Disk Status issues no verdicts with destructive actions and writes nothing to disk (other than its own graph facts).
- AC-DS-6: `isSSD` may be `null` when detection is inconclusive; TRIM advice must degrade to "unknown — no action recommended" rather than guessing.

### 3.6 Process analyzer

Activity-monitor style view of running processes with heuristic "possibly unnecessary" flags (with reasons), per-process kill, and startup/login-item disable. Scan category `processes`; verdict category `process`; action `kill`.

**User stories**

- As a user whose machine feels slow, I want processes ranked by CPU/memory with a plain explanation of what each one likely is.
- As a user, I want SweepDeck to flag processes that may be unnecessary — with the specific reasons (high memory, login item, not an OS process, vendor updater) — rather than a bare "kill this".
- As a user, I want to stop a process or disable a login/startup item, each as an explicit, individually confirmed action.

**Acceptance criteria**

- AC-PA-1: `procs:list` returns `ProcInfo[]` with pid, name, command, CPU %, memory, user, start time; the view refreshes on demand and sorts by CPU or memory. Refresh must not block the UI.
- AC-PA-2: The `unnecessary` heuristic returns a score in `[0,1]` plus human-readable `reasons[]`; every flagged process shows at least one concrete reason. Processes with `isSystem: true` are never flagged and never killable from SweepDeck (structurally excluded, per SAFETY-RULES.md §2.4).
- AC-PA-3: `procs:kill` is per-process, requires an explicit confirmation naming the process (the human gate for this feature), attempts graceful termination first (SIGTERM / `WM_CLOSE`-equivalent) with force-kill only as an explicit second step, and returns `{ok, error?}` honestly (e.g. permission denied on other users' processes).
- AC-PA-4: Killing a process produces a `Receipt` (action `kill`, `trashRef: null`); the UI states clearly that kill is **not undoable** and that unsaved data in that app may be lost.
- AC-PA-5: Startup/login-item disable (macOS login items / launch agents in user domain; Windows `Run` keys + Startup folder) is reversible: SweepDeck records what was disabled and offers re-enable. Disabling is per-item and gate-confirmed. Disabling **services** is out of scope (§5).
- AC-PA-6: Heuristic false-positive posture: flags are worded as "possibly unnecessary"; the UI never auto-selects processes for killing (no smart-select for kill actions — `smartSelected` is always `false` for `process` verdicts).

---

## 4. Cross-cutting requirements

These apply to every feature and are restated normatively in SAFETY-RULES.md.

- **CC-1 — Approval Gate.** Every destructive action (`trash`, `uninstall`, `kill`, startup-disable) passes through the human gate: the engine pauses at `gate_waiting` and executes only the `verdictIds` explicitly passed to `plan:approve` (or the per-process confirm for kills). "Select all" selects visible, already-verified items — it never bypasses per-item verdict status. The CLI enforces the same rule: `exec` without `--approve-ids` exits with code 2 (REFUSED).
- **CC-2 — Receipts with provenance.** Every executed action produces a `Receipt` linked to its verdict (and via the verdict, to the full provenance chain: scanner, rule, evidence, confidence). Receipts record path, `trashRef`, bytes freed, timestamp, and honest `ok/error`. Receipts are listable in the UI (`receipts:list`) and persist across restarts.
- **CC-3 — Undo where possible.** File deletions are trash/quarantine-backed (`trashRef` set) and undoable via `receipts:undo` for the retention window defined in SAFETY-RULES.md §5. Actions that cannot be undone (process kill; a vendor uninstaller's own work) are labeled as such **before** approval.
- **CC-4 — Protected paths are structurally unenforceable to delete.** The hard-deny list (SAFETY-RULES.md §2) is enforced in the executor and verifier as code that cannot be configured off — not a settings flag, not a UI filter. A protected path reaching the executor is a REFUSED error (CLI exit 2), logged, and surfaced.
- **CC-5 — Provenance everywhere.** No verdict, insight row, or badge appears in the UI without a resolvable provenance record. "Why?" is answerable for every item with one click.
- **CC-6 — Verifier independence.** The safety verifier is a separate task-graph node from the scanners (the diamond): scanners propose, the verifier disposes. A scanner bug can inflate candidates but cannot inflate confidence past the verifier.

---

## 5. v1 scope table

| Capability | v1 status | Notes |
|---|---|---|
| Smart Clean (caches/temp/logs/browser caches/trash) | **Real** | Full pipeline: scan → verify → gate → trash-first exec → receipts → undo |
| Large Files finder | **Real** | Streaming results, smart + manual select |
| Duplicate finder | **Real** | Full-hash confirmation required; canonical-keep enforced |
| App list + macOS uninstall + owned-path sweep | **Real** | Bundle + owned paths to Trash |
| Windows uninstall | **Real (interactive)** | Launches vendor uninstaller, waits, then orphan sweep. **Silent uninstall: out of scope** |
| Orphaned-files insight | **Real** | `graph:query orphaned-files` |
| Disk usage breakdown / treemap | **Real** | Home volume top-level dirs |
| SMART health | **Best-effort** | Show what the OS/tooling reports; degrade to "unavailable" gracefully; no health claims without data |
| TRIM | **Advisory + consent** | Advice always; execution only behind explicit consent + OS elevation. Expected common case: "auto-TRIM active, nothing to do" |
| Process list + heuristics + kill | **Real** | Graceful-then-force kill; system processes excluded |
| Startup / login-item disable | **Real (user-domain)** | Reversible; user-domain items only |
| Windows **services** removal/disable | **Out of scope** | Too high blast radius for v1; revisit with a dedicated safety review |
| Windows **silent** uninstall (`/S`, msiexec quiet) | **Out of scope** | Vendor uninstaller runs interactively so the user sees vendor prompts |
| Scheduled/background cleaning | **Out of scope** | v1 is interactive only |
| Registry cleaning | **Out of scope** | Permanently out of product direction, not just v1 |
| Undo for process kill / vendor-uninstaller effects | **Not possible** | Labeled as irreversible in UI before approval |

---

## 6. Non-functional requirements

- **NFR-1 — Streaming scan responsiveness.** All scans emit `WorkflowEvent` progress (JSONL on CLI, `workflow:event` IPC in app). First progress event within 2 s of scan start; progress updates at least every 500 ms while a scanner is active; the plan view populates incrementally where feasible (large files, duplicates groups).
- **NFR-2 — UI responsiveness.** Scanning, hashing, and graph writes run in the engine (main-process workers / core package), never in the renderer. The renderer stays interactive (input latency < 100 ms) during a full-disk scan; scans are cancellable at any time via `scan:cancel` and cancellation takes effect within 2 s.
- **NFR-3 — Cross-platform parity.** All six features ship on both Windows and macOS. Platform-specific deltas are limited to: junk location lists, uninstall mechanics (§3.2), login-item mechanics, trash backend (macOS Trash / Windows Recycle Bin, with SweepDeck quarantine fallback per SAFETY-RULES.md §5), and SMART/TRIM tooling. Any feature behaving differently per platform says so in the UI.
- **NFR-4 — Security.**
  - Electron hardening: `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderer; the only bridge is the typed `window.sweepdeck` preload API from the contract.
  - **No raw paths executed from the renderer**: the renderer only ever sends ids (`runId`, `planId`, `verdictIds`, `receiptId`, app `key`, `pid`, canned `GraphQueryId`). Paths to act on are resolved main-side from the verdict store. The renderer cannot submit an arbitrary path or SQL for execution.
  - Elevation only for TRIM, only with `{consent: true}`, via the OS prompt; SweepDeck never stores credentials.
  - The SQLite graph DB and quarantine live under the per-user app-data directory with user-only permissions.
- **NFR-5 — Performance targets.** Junk scan of a typical machine (~1 M files) completes in ≤ 3 min; duplicate scan avoids full-hashing anything outside a size/ext block with ≥ 2 members; memory ceiling for the engine during scan ≤ 1 GB.
- **NFR-6 — Honesty of numbers.** "Reclaimable" is an estimate labeled as such; "freed" comes only from receipts. Failures are counted and shown (`ExecResult.failed`, `ScanSummary.errors`), never silently dropped.
- **NFR-7 — Testability.** Every destructive path is exercisable headlessly via `sweepdeck-core` against a sandbox `--root`; Robot Framework suites cover the gate-refusal (exit 2), protected-path refusal (exit 2), and undo round-trip.

---

## 7. Success metrics & definition of done (v1)

### Definition of done

v1 ships when all of the following hold:

1. All six features meet their acceptance criteria on both Windows and macOS (manual QA matrix + Robot suites green in CI on the win+mac matrix).
2. **Safety invariants proven by automated test:**
   - `exec` with no approvals refuses (exit 2 / IPC error) — no side effects.
   - A crafted plan containing a hard-denied path refuses at the executor with zero deletions performed.
   - Every executed action in a test run has a matching receipt; every trash-backed receipt undoes successfully and restores byte-identical content.
   - Duplicate groups can never be fully deleted in one approval.
3. Cross-cutting CC-1…CC-6 verified by code review against SAFETY-RULES.md.
4. Installers (`.exe`/`.msi`/`.dmg`/`.pkg`) build and sign in CI from a `v*` tag; app launches from a clean install on both OSes.
5. Zero known data-loss bugs of any severity; zero open critical/major bugs in destructive flows.

### Success metrics (first 90 days post-launch, from local, user-visible stats — no telemetry in v1; measured via beta cohort + support channel)

| Metric | Target | Why |
|---|---|---|
| Data-loss incident reports (user lost a file they didn't approve, or undo failed) | **0** | The one metric that kills the product |
| Beta users who complete a Smart Clean end-to-end (scan → approve → freed) | ≥ 70 % of users who start a scan | Gate friction must not stall the core loop |
| Median bytes freed in first Smart Clean session | ≥ 1 GB | Product must feel worth it |
| Smart-selection acceptance (approved-as-preselected ÷ smart-selected shown) | ≥ 80 % | Measures confidence-band calibration |
| Undo usage after Smart Clean | ≤ 2 % of executed items | High undo rate = smart-select is too aggressive |
| Scan-cancel rate | ≤ 10 % | Proxy for perceived scan speed |
| Uninstall flows that complete orphan sweep (Windows) | ≥ 60 % | Validates the two-phase Windows design |

---

## 8. Open risks (PM-tracked)

- **R-1 Confidence calibration.** If the verifier's bands are miscalibrated, either smart-select feels useless (too conservative) or undo/complaint rates spike (too aggressive). Mitigation: start conservative; the acceptance/undo metrics above are the tuning signal.
- **R-2 Windows uninstaller variance.** Vendor uninstallers may spawn detached processes, prompt for reboot, or leave the registry key present. The orphan sweep must re-verify (fresh scan) rather than trust the pre-uninstall graph. Reboot-required cases defer the sweep with a clear "finish after restart" state.
- **R-3 Ownership attribution false positives.** Graph attribution of support files to apps by path convention can over-claim (shared vendor dirs). Mitigation: AC-AU-5 shared-path exclusion + low-confidence never smart-selected; treat every attribution complaint as a rules bug.
- **R-4 SMART/TRIM expectations.** Users may expect authoritative drive health; best-effort must be worded to avoid implying a guarantee (legal + trust risk). AC-DS-2/DS-6 wording is normative.
- **R-5 Recycle Bin / Trash API variance.** Trash-first depends on OS trash behavior (e.g., files too large for Recycle Bin, network volumes with no trash). SAFETY-RULES.md §5 mandates the quarantine fallback; executor must never fall back to hard delete.
- **R-6 Process-kill collateral.** Killing an unrecognized-but-important user process (e.g., a backup agent) loses user goodwill even when "working as designed". Mitigation: no smart-select for kills, graceful-first termination, explicit irreversibility labeling.
