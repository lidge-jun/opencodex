# Usage custom date range — manual-query disclosure

Triggered by a maintainer browser comment on `/#usage`: the custom date range block should be a
dropdown (manual lookup) by default, with the fields below it, and the current layout is visually
wrong — control heights do not line up. Scope is the usage page filter area only.

## Design read (cxc-dev-uiux-design)

Reading this as: a dense local analytics page for a single operator who reads the presets almost
every time and reaches for an explicit interval rarely, in the quiet utilitarian language the rest
of the dashboard already speaks. Tokens come from `gui/src/styles.css`; nothing new is invented.

```
DESIGN_VARIANCE: 3
MOTION_INTENSITY: 1
Product density profile: D5
Reasoning: dashboard/admin surface for repeated operator work — the expressive default kit is
domain-gated off, so the work is restraint, alignment and disclosure rather than decoration.
```

Do's: one obvious path (presets), expert control demoted behind a labelled disclosure, every
control on one height, left-aligned so the block reads with the page it belongs to.
Don'ts: no second full-width flex-end row, no decorative motion, no hidden applied state.

## Problem

`Usage.tsx` renders the custom-range `<form>` unconditionally under the page subtitle and reuses
`.usage-filters`, which is `justify-content: flex-end`. Three consequences:

1. Two empty `datetime-local` fields are the second thing on the page even though the answer the
   page exists to give is already rendered from a preset (UX-LAZY-01: an expert fork at top level).
2. The row is pushed to the right edge with a wide empty gutter, and the help caption underneath
   starts at the left edge, so the two halves do not read as one control.
3. `align-items: center` centers a label+input stack (≈57px) against `btn-sm` buttons (≈26px), so
   Apply/Clear float in the middle of the fields instead of sitting on their baseline.

## Work phases

1. wp1: collapse the block behind a closed-by-default disclosure trigger, render the fields in a
   bottom-aligned grid panel on one control height, keep the applied interval visible while
   collapsed, and update `gui/tests/usage-custom-range.test.tsx`.
2. wp2: publish as a PR against `dev` with a GUI screenshot and merge on exact-head CI; depends
   on wp1.

## Contract

- Trigger reuses the existing `usage.range.custom` label, so no locale catalog gains a key.
- Collapsed state renders no date inputs; `aria-expanded`/`aria-controls` carry the state.
- An applied window keeps its `role="status"` interval line outside the panel, so collapsing never
  hides which interval the numbers cover (progressive disclosure names what stays hidden).
- Draft text, validation, request identity and cache behavior are untouched: this is presentation.

Verification: see `010_audit.md`. The maintainer forbade local suite runs mid-unit, so the
repository-wide `bun run test` is NOT RUN locally and remote exact-head CI is the only
full-suite evidence for this change.
