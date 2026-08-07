# SweepDeck — Design Notes

Companion to `design/tokens.json` and `design/wireframes/*.html`. Wireframes are static,
self-contained HTML using the token values inline; they double as the visual spec for the
React renderer.

## Palette — "Frost on slate"

Derived from `build/icon.png`: a pale, icy blue-white ring on a dark slate-teal ground.

- **Backgrounds** are slate with a cold blue-teal cast, three elevation layers plus an inset:
  `base #0e141a` (page) → `raised #151c23` (cards) → `overlay #1c2731` (modals, toasts,
  approval bar) → `inset #0a0f14` (sidebar, status bar, code wells). Elevation is expressed by
  lightness + hairline border, not heavy shadows — shadows are reserved for true overlays.
- **Accent `#5fb0dd` (hover `#7ec4e8`)** is the icon's frost ring. It is used sparingly:
  primary buttons, active nav, selection tint, canonical badge, focus ring. Utility-app calm,
  not gamer RGB — large surfaces stay neutral, color carries meaning.
- **Semantics**: success `#33b374`, warning `#d9a514`, danger `#e05252`, info `#4d9fd6`.
  Danger fills appear ONLY on truly destructive confirm buttons (Uninstall, Kill); moving to
  Trash is accent-colored because it is reversible by design.
- **Confidence badges** map `Provenance.confidence` to high `#33b374` (≥ 0.85) / medium
  `#d9a514` (0.6–0.85) / low `#e07856` (< 0.6). Low is orange, not red — it means "look
  closer", not "error". Badges always pair dot + word + number, never color alone.
- **Chart categoricals** (8): `#3d8fe0 #d95926 #199e70 #c98500 #d55181 #008300 #9085e9
  #e66767` (dark) with a light-mode variant set in the `light` block. Both orders were run
  through the dataviz six-checks validator against our actual surfaces: dark passes all checks
  (worst adjacent CVD ΔE 8.4); light passes with a contrast WARN on slots 3/4/5, so light-mode
  charts must ship direct labels or a legend with values (the wireframe donuts/legends already
  do). Assign hues in fixed slot order, never cycled; series identity never changes color when
  filters change.
- **Light theme** is a full color-role override block in the tokens (`color.light`), not an
  algorithmic flip. Non-color tokens (type, space, radius, motion) are shared.

## Typography

System stack (`system-ui, -apple-system, 'Segoe UI'…`) — native feel per OS, zero font
shipping. Sizes 11/12/13/15/18/24 with 13 px as body default (dense utility density, like
Activity Monitor). Weights 400/500/600/700; 600 for headings and buttons. All numbers that
align vertically (sizes, CPU %, receipts) use `font-variant-numeric: tabular-nums`. Paths and
provenance ids use the mono stack at 11–12 px in muted ink — visually secondary but always
present, because provenance is the product's trust story.

## The approval-gate pattern (one pattern, everywhere)

Every destructive flow renders the SAME four-stage furniture, in the same order:

1. **Checklist** — items arrive `proposed`, with `smartSelected` pre-checked and everything
   else unchecked. Blocked items (e.g. HELD_OPEN_BY a live process) render disabled with the
   reason inline. Canonical duplicates can never be checked for removal.
2. **Summary bar** — sticky at the bottom of the scroll region: exact count + exact bytes +
   what was auto-skipped, and a single primary button labeled with the outcome
   ("Review & Clean 2.4 GB", "Review & Uninstall 1.88 GB"). No selection → button disabled.
3. **Confirm modal** — titled as a question, then a literal "exactly what will happen" list:
   what moves to Trash, what is skipped and why, what is kept, and that a receipt with Undo is
   written. Elevation (TRIM) adds an explicit consent checkbox that enables the button.
   Confirm is the ONLY call site of `planApprove` — the UI has no other path to the executor.
4. **Receipt toast** — success toast with bytes freed, receipt id, and Undo right in the
   toast; it then lives permanently in Dashboard → Recent receipts. Kills are the one
   non-undoable action and the modal says so before, not after.

Wireframe `02-smart-clean.html` is the canonical instance; 03/04/05/07 reuse it verbatim, and
06 uses the same modal for consent-gated elevation.

## Empty / loading / error states

- **Empty**: dashed-ring illustration + one sentence + the one primary action (see 00-shell).
  Never a bare blank panel. "No candidates found" after a scan is a success state: green
  check, "Nothing worth cleaning — scanned 48,211 files."
- **Loading**: scans are never spinners — the phase stream (scan → verify → merge) shows
  per-phase progress bars fed by `WorkflowEvent`, with the latest event as a mono ticker line.
  Lists use skeleton rows (bg.raised pulse at motion.slow); the status bar mirrors the current
  phase so progress survives navigation.
- **Error**: `task_failed` events render as a warning-bordered card per scanner node — other
  scanners' results remain usable; partial success is the norm. Per-item exec failures show in
  the receipt (`ok:false` + error) with a retry affordance. Errors name the node and keep the
  message copyable.

## Accessibility

- **Contrast**: text.primary on all three bg layers ≥ 12:1; text.secondary ≥ 6:1; text.muted
  reserved for supplementary text (≥ 4.5:1 on base). Accent-on-dark and on-accent text both
  clear 4.5:1. Badge text colors are lightened variants on tinted chips, not raw semantic hues.
- **Focus**: every interactive element has `:focus-visible` — 2 px `focusRing #7ec4e8` outline
  with 2 px offset (token `shadow.focus` shows the ring-on-bg composite). Focus is never
  removed, only styled.
- **Keyboard**: Cmd/Ctrl+1…7 switches views; full tab order top-to-bottom ending at the
  approval bar so the confirm button is the natural last stop; Space toggles checkboxes;
  modals trap focus, Esc cancels, and destructive confirms are never the default-focused
  button. Tooltips (process reasons) open on focus as well as hover.
- **Not color alone**: confidence = dot + word + number; SMART/status chips = dot + text;
  canonical = crown badge + "kept" label + disabled Remove; charts get direct labels/legends
  with values, and donut/treemap blocks carry `role="img"` + aria-labels with the numbers.
- **Motion**: durations 80–280 ms with standard easing only; `prefers-reduced-motion`
  collapses all non-essential transitions to 0 ms (token `motion.reducedMotion`).
