# SweepDeck

Cross-platform (Windows & macOS) disk cleaner and system optimizer, built with **graph engineering** methods:

- The machine is modeled as a **property graph** (Files, Directories, Volumes, Applications, Processes as nodes; `CONTAINS`, `OWNED_BY`, `DUPLICATE_OF`, `HELD_OPEN_BY`, … as edges) persisted in SQLite.
- Every "safe to delete" verdict carries **provenance** — which scanner, which rule, what evidence, what confidence — powering the deletion receipt and undo.
- Scans run as a **task graph** (diamond pattern): parallel scanners → independent safety verifier → merged clean plan → **human approval gate** → trash-first executor.

## Features

1. **Smart Clean** — caches, temp files, logs, browser caches, trash
2. **Uninstaller** — apps plus their orphaned support files (graph traversal)
3. **Large Files** — smart or manual selection, user-approved deletion
4. **Duplicates** — entity-resolution dedupe (size/ext blocking → partial → full hash), canonical-copy smart select
5. **Disk Status** — usage breakdown, SMART (best-effort), TRIM advice with consent-gated elevation
6. **Processes** — activity-monitor view with "unnecessary" heuristics, kill / startup-disable

## Repo layout

- `packages/core` — engine + headless CLI (`sweepdeck-core`), no Electron imports
- `packages/app` — Electron app (main / preload / React renderer)
- `tests/robot` — Robot Framework QA suites (run against the CLI in a sandbox)
- `design/` — tokens & wireframes; `docs/` — PRD, architecture, safety rules, signing
- `.github/workflows` — CI (win+mac matrix) and tag-triggered release building `.exe/.msi/.dmg/.pkg` with self-signed signing

## Development

```bash
npm ci
npm run icons        # generate build/icon.{png,icns,ico} from design/icon
npm run build:core
npm test             # vitest
pip install robotframework && robot --outputdir robot-results tests/robot
npm run dev          # Electron app with Vite HMR
npm run dist         # package installers locally
```

Releases: push a `v*` tag; GitHub Actions builds and signs (self-signed) all four installers. See `docs/SIGNING.md` to switch to real certificates.

## quick start
### 1. move app into application folder
### 2. eject the dmg/pkg virtual disk

```bash
sudo xattr -cr /Applications/SweepDeck.app

sudo codesign --force --deep --sign - /Applications/SweepDeck.app

sudo xattr -d com.apple.quarantine /Applications/SweepDeck.app
```

then reopen the app
