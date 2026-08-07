# SweepDeck — bugs found by the Robot Framework acceptance suites

Filed by QA. Product code is not modified by QA; each entry links the test that
demonstrates it. Blocked tests are tagged `known-bug` and the suites are run
with `--skiponfailure known-bug` so the run stays green while the bug is open.

---

## BUG-001 — sandbox junk scanner smart-selects "Probably safe" (0.7) items — **FIXED**

> **Resolution (2026-08-08, Reviewer):** verifier now caps `smartSelected` centrally when confidence < 0.90 (`verify.smart-select-band`, `packages/core/src/verifier/verifier.ts` + `SMART_SELECT_MIN_CONFIDENCE` in `rules.ts`), and both junk-scanner modes set `smartSelected` from the band instead of hardcoding it. Demonstrating test now passes; `known-bug` tag removed.

- **Severity:** medium (safety-policy violation, sandbox surface)
- **Where:** `packages/core/src/scanners/junk.ts` (`scanSandbox`, `smartSelected: true` hardcoded); the verifier (`packages/core/src/verifier/verifier.ts`) never corrects `smartSelected`.
- **Policy violated:** `docs/SAFETY-RULES.md` §3.3 — `smartSelected: true` ⇔ band is **Safe** (confidence ≥ 0.90). "Probably safe" (0.70–0.89) items must be *listed, unchecked* and never preselected.
- **Repro:**
  1. `mkdir /tmp/x && echo loose > /tmp/x/stray.tmp`
  2. `node packages/core/dist/cli.js scan --categories junk --root /tmp/x --db /tmp/x.db --json`
  3. `node packages/core/dist/cli.js plan --run <runId> --db /tmp/x.db --json`
- **Actual:** the `stray.tmp` verdict has `provenance.confidence: 0.7` (rule `sandbox.junk.tmp`, loose-file match) **and `smartSelected: true`**.
- **Expected:** `smartSelected: false` for any verdict below the 0.90 Safe band.
- **Demonstrating test:** `04_junk_scan.robot` :: *Loose Junk In Probably-Safe Band Is Not Smart Selected* (`[Tags] known-bug`).
- **Note:** the four planted fixture junk files are all dir-matched at 0.9, so the rest of the suites are unaffected.

---

## BUG-002 — `procs list` can hang forever when osascript blocks on TCC consent — **FIXED**

> **Resolution (2026-08-08, Reviewer):** new `execFileBounded` helper (`packages/core/src/util/exec.ts`) uses `killSignal: 'SIGKILL'` plus a Promise.race hard deadline so the call settles even if the child ignores SIGTERM or its stdio stays open; applied to osascript/reg (processes.ts), plutil/reg (apps.ts), lsof (verifier.ts) and taskkill (prockiller.ts). Verified: `procs list --json` now completes in ~4.6 s (rc 0) under a headless Python parent where osascript is TCC-blocked (was: indefinite hang).
>
> **Residual (QA-side, tag kept on the demonstrating test):** Robot Framework 7.4.2's `Run Process` with `timeout=` polls `process.poll()` for the whole timeout WITHOUT draining stdout/stderr PIPEs (`_process_is_stopped`); `procs list --json` emits >64KB on busy machines (131KB observed, ~700 procs), so the child blocks writing to the full pipe and is killed at the timeout — regardless of engine behavior. Suggested QA fix: pass `stdout=<file>` in `Run Core Cli` (Robot's documented remedy for large output), then remove the `known-bug` tag. Product code is not modifiable to avoid this: a full, unread pipe blocks any writer.

- **Severity:** high for CI (indefinite hang of a read-only command), low for interactive desktop use
- **Where:** `packages/core/src/scanners/processes.ts` — `getLoginItems()` runs
  `osascript -e 'tell application "System Events" to get the name of every login item'`
  with `{ timeout: 4000 }`.
- **Mechanism:** when the calling context has no Apple-Events automation grant
  (headless runner, CI agent, any non-Terminal parent), osascript blocks inside
  the TCC consent request. Node's `execFile` timeout fires and sends **SIGTERM
  once**, but a process blocked in the tccd request does not die on SIGTERM and
  node never escalates to SIGKILL — `execFile`'s callback only fires on child
  exit + stdio close, so `getLoginItems()` awaits forever and the CLI never
  exits (observed: full JSON already flushed to stdout, process alive 180 s
  later until externally killed).
- **Repro (intermittent — depends on the machine's TCC state):** run
  `node packages/core/dist/cli.js procs list --json` from a parent without the
  Automation/System Events permission (e.g. a CI agent or Robot Framework's
  Python process). Observed hangs of 30 s and 180 s until the harness killed it;
  the same command from an interactive shell finishes in ~5 s.
- **Expected:** the 4 s best-effort timeout must be effective — e.g. pass
  `killSignal: 'SIGKILL'` (or follow up SIGTERM with SIGKILL), and/or
  `child.unref()` semantics so a stuck osascript can never wedge
  `procs list` / the `processes` scan. SAFETY-RULES-adjacent: the scanner
  module's own doc says it "must NEVER crash a scan" — hanging one is worse.
- **Demonstrating test:** `01_cli_contract.robot` :: *Procs List Json Parses*
  (`[Tags] known-bug`, 60 s kill timeout). The test passes when TCC is quiet
  and skips (under `--skiponfailure known-bug`) when the hang bites.

---

## Observations (not filed as bugs)

### OBS-001 — canonical duplicate is omitted from the plan instead of listed with `smartSelected: false`

The test brief describes duplicate groups as "exactly one canonical
(smartSelected false) per group". The engine implements something strictly
stronger: only non-canonical members become verdicts at all; the canonical is
identified via `detail.canonicalPath` and is structurally absent from the plan,
so it can never be approved or deleted (this also matches SAFETY-RULES §3.3
"the last remaining copy of any group is structurally unapprovable").
`03_duplicates.robot` asserts this structural form: one distinct
`canonicalPath` per group, canonical never among the subjects, all member
verdicts `smartSelected: true`. Not a defect — noted so nobody "fixes" it into
the weaker form.
