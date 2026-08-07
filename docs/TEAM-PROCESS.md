# Team process — role-based agent delivery

SweepDeck is delivered by a team of role agents coordinated by a **manager** (task-graph
principles applied to the team itself: one writer per file, human gate on irreversible steps,
verifier in a separate context).

| # | Role | Owns (write access) | Deliverables | Gate |
|---|------|--------------------|--------------|------|
| 0 | Manager | root configs, `packages/core/src/contracts.ts` (frozen), `.github/workflows/`, `docs/ARCHITECTURE.md`, `docs/SIGNING.md`, `scripts/make-icons.mjs` | scaffold, frozen contract, CI/release pipelines, icon pipeline | — |
| 1 | PM | `docs/PRD.md`, `docs/SAFETY-RULES.md` | requirements, acceptance criteria, safety policy | manager review |
| 2 | UI/UX designer | `design/` | `tokens.json`, 8 HTML wireframes, design notes | PM sign-off |
| 3 | Backend engineer | `packages/core/` (except contracts.ts) | graph store, workflow engine, scanners, verifier, executor, CLI, vitest units | reviewer pass |
| 4 | UI engineer | `packages/app/`, `build/entitlements.mac.plist` | Electron main/preload/renderer, 7 screens, electron-builder config | reviewer pass |
| 5 | QA/QC engineer | `tests/robot/`, `scripts/make-fixtures.mjs` | Robot Framework suites + fixture builder, green on both OSes | all suites pass |
| 6 | Reviewer | (read all, fixes via minimal patches) | security & correctness review report, applied fixes | release tag |

**Order:** PM ∥ designer ∥ backend start together (backend builds against the frozen contract,
not the PRD). UI engineer starts when design tokens exist. QA starts when the CLI builds. Reviewer
runs last over the full diff. The manager merges, runs CI, tags releases.

**Rules**

1. *One writer per file* — ownership table above is authoritative; cross-package changes go
   through the manager.
2. *The contract is frozen* — `packages/core/src/contracts.ts` changes require manager sign-off;
   backend and UI build against it independently (that is what allows them to run in parallel).
3. *Verifier in a separate context* — QA and the reviewer never modify the code they are grading
   beyond minimal reviewed fixes; test fixtures are QA-owned so the backend can't accidentally
   teach to the test.
4. *Human gate* — releases (tags) and anything destructive require explicit human/manager action.
