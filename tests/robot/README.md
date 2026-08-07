# SweepDeck core CLI — Robot Framework acceptance suites

Black-box acceptance tests for `packages/core/dist/cli.js` (the frozen CLI
surface documented at the bottom of `packages/core/src/contracts.ts`), driven
against the deterministic sandbox fixture built by `scripts/make-fixtures.mjs`.

## Layout

```
tests/robot/
  01_cli_contract.robot   JSONL event stream, summary line, disk status, procs list
  02_safety.robot         protected-root refusal, Documents exclusion, quarantine containment
  03_duplicates.robot     dup grouping, full-hash false-positive guard, canonical policy
  04_junk_scan.robot      planted junk provenance + SAFETY-RULES confidence bands
  05_exec_gate.robot      human gate (exit 2), dry-run, quarantine, receipt, undo
  06_uninstall.robot      sandbox app uninstall via the OWNED_BY graph traversal
  resources/
    common.resource       shared keywords (Build Fixture Sandbox, Run Core Cli, ...)
    helpers.py            stdlib-only keyword library (JSONL parsing, checksums, plan queries)
  BUGS.md                 product bugs found by these suites (known-bug tagged tests)
```

Every suite creates its own throwaway fixture sandbox (`tempfile.mkdtemp`) and
its own graph DB in a *separate* temp dir (so tree checksums never see DB/WAL
writes), and deletes the sandbox in its teardown. Nothing outside temp dirs is
ever touched — the only destructive commands run with `--root <sandbox>`.

## Prerequisites

- Node.js on `PATH` (the CLI must be built: `packages/core/dist/cli.js`)
- Python 3 + Robot Framework: `pip3 install --user robotframework`
- No other pip packages — suites use only Robot standard libraries plus the
  bundled `resources/helpers.py`.

## Run locally

```sh
robot --outputdir robot-results --skiponfailure known-bug tests/robot
```

(Keep `--outputdir` out of the repo or gitignored.)

## CI invocation

```sh
robot --outputdir robot-results \
      --skiponfailure known-bug \
      --variable CLI_PATH:<abs path to packages/core/dist/cli.js> \
      tests/robot
```

`--skiponfailure known-bug` demotes tests that demonstrate open product bugs
(see `BUGS.md`) to SKIP instead of FAIL, keeping the gate green while the bug
is tracked. Remove a test's `known-bug` tag once the bug is fixed. Currently
tagged: *Loose Junk In Probably-Safe Band Is Not Smart Selected* (BUG-001,
deterministic fail) and *Procs List Json Parses* (BUG-002, intermittent hang
in TCC-restricted environments — passes when the environment permits).

## Portability notes (Windows CI)

- All paths are built with `${/}`, `Join Path`, or `os.path` in `helpers.py`;
  temp dirs come from `tempfile.mkdtemp` — `/tmp` is never assumed.
- The CLI is launched through the Process library as `node <CLI_PATH> ...`,
  resolving `node`/`node.exe` from `PATH`.
- The protected-root refusal test switches on `sys.platform`:
  `/System` on darwin, `C:\Windows` on win32
  (`helpers.protected_scan_root`).
- Path assertions (`Is Within`, `path_has_segment`) are realpath-based and
  separator-agnostic, so `\` vs `/` and symlinked temp dirs (macOS
  `/var` → `/private/var`) are handled.

## Notes / decisions

- `disk status --json` is exercised with `--root <sandbox>`: volumes, SMART
  and TRIM advice are still the real-mode code path; `--root` only confines
  the top-level *breakdown* walk, which otherwise walks the whole home
  directory (minutes on a real machine).
- `05_exec_gate.robot` is an ordered flow suite (refuse → dry-run → exec →
  undo over one sandbox); its tests intentionally share suite state.
- The executor's "doctored protected path" backstop cannot be reached through
  the CLI (exec only accepts `--approve-ids` against engine-produced
  verdicts), so `02_safety.robot` asserts the scanner/verifier layers
  structurally instead — see the suite documentation.
