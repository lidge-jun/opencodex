# 030 — Phase 3: control baseline alignment (subgrid)

> AMENDED after A-gate audit (Archimedes, VERDICT: FAIL #2). The original
> `align-items: flex-start` plan fixed only the wide one-line 16px case. Once 010 lets the
> row wrap, the control row sits under copy, and the two cards' copy blocks are NOT the
> same height (ko web hint 30 chars vs vision hint 41 chars; fr/ru worse). Δ came back.

## The real contract

Δ selTop = 0 requires the two cards to share a ROW STRUCTURE, not just an alignment
keyword. The grid already stretches both cells; it just has no shared row lines.

Scope correction: Δ=0 is asserted **only while the grid is two-column**. In one-column the
cards are stacked in document order, so "Δ" is the distance between two cards — the
criterion is physically meaningless there and c4 is amended to say so.

## MODIFY gui/src/styles-dashboard-workspace.css

### 1. Give the grid explicit rows and let cards inherit them

```css
.dash-sidecar-grid {
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr));
  grid-template-rows: auto auto;   /* row 1 = copy, row 2 = controls */
}

.dash-sidecar-row-card {
  display: grid;
  grid-template-rows: subgrid;
  grid-row: span 2;
  row-gap: 12px;
  align-content: start;
}
```

The card stops being a flex row and becomes a 1-column subgrid of the outer grid. Both
cards' copy blocks share row 1 and both control groups share row 2, so the first select in
each card starts at exactly the same y — regardless of how many lines each hint wraps to.
That is Δ=0 by construction, not by measurement.

### 2. Side-by-side layout at wide cards

Subgrid rows give vertical alignment; horizontal side-by-side comes back with an inner
flex row only when the card is wide enough. Use the container query from 020 so this is
card-relative:

```css
@container sidecar-card (min-width: 30rem) {
  .dash-sidecar-row-card .dash-sidecar-copy { grid-row: 1; }
  .dash-sidecar-row-card .dash-delegation-controls { grid-row: 1 / span 2; align-self: start; }
}
```
Decide the exact placement from measurement after implementing step 1; the invariant to
preserve is that BOTH cards use the same rule, so they cannot diverge.

### 3. Trigger height floor (unchanged from original plan, audited PASS)

```css
.dash-sidecar-row-card .dash-delegation-controls .select-trigger {
  min-height: var(--control-md);   /* 34px, styles.css:116 */
}
```
Audited safe: `.dash-delegation-controls` and `.dash-vision-select-row` are both
`align-items: center`, so the 20px switch stays centred on the 34px row, and the global
`.lang-toggle` / `.codex-account-priority` overrides are untouched.

### 4. Remove the now-dead flex alignment overrides

`.dash-vision-sidecar-card { align-items: flex-start }` and the shared
`align-items: center` inheritance stop applying once the card is a grid. Delete rather
than leave contradictory declarations.

## Fallback if subgrid proves impractical

If subgrid forces markup changes that exceed this unit's scope, the fallback is an
explicit min-height on the copy block so both cards reserve the same copy band:
`.dash-sidecar-row-card .dash-sidecar-copy { min-height: calc(21px + 3px + 2 * 19.5px) }`.
That is a magic number and is strictly second choice — record the reason if it is used.

## Verification

- Δ selTop === 0 at every card width where the grid is two-column
- Both selH equal and >= 34
- Vision effort select and web-search stream switch still vertically centred
- Select menu still portals outside the card (subgrid does not add containment; the
  container-type from 020 does, and that was audited safe)

