# 011 — Audit correction: subgrid was the wrong fix

The `010` plan was written before the regime sweep existed. The sweep contradicts
its central assumption, so `010` is superseded by this document. Recorded rather
than silently edited, because the wrong assumption is the interesting part.

## What `010` assumed

That the cards render as a horizontal row at desktop width (copy LEFT, controls
RIGHT) and only stack when narrow — so a two-row subgrid was needed to align the
"second line" of each card.

## What the measurement shows

Per-card internal layout, at full reload per width, sidebar state recorded:

| vw | mainInner | cardW | columns | inside the card | ctrlYDelta |
|------|-----------|-------|---------|-----------------|------------|
| 1600 | 1128 | 556 | 2 | STACKED | 0 |
| 1440 | 1126 | 555 | 2 | STACKED | 0 |
| 1280 | 966 | 475 | 2 | STACKED | 0 |
| 1100 | 786 | 385 | 2 | STACKED | -2.3 |
| 1024 | 782 | 347 | 2 | STACKED | **22.5** |
| 1010 | 768 | 340 | 2 | STACKED | **22.5** |
| 1000 | 758 | 686 | 1 | ROW | n/a (single column) |
| 992 | 750 | 678 | 1 | ROW | n/a |
| 980 | 738 | 666 | 1 | STACKED | n/a |
| 768 | 526 | 454 | 1 | STACKED | n/a |
| **760** | **750** | **349** | **2** | STACKED | **22.5** |
| 740 | 730 | 339 | 2 | STACKED | **22.5** |
| 720 | 710 | 674 | 1 | ROW | n/a |

Two facts kill `010`:

1. **The cards are ALREADY stacked internally at every two-column width.** The
   `36rem` container query fires whenever the pair is side by side, because a
   two-up card is at most ~556px = 34.75rem < 36rem. Copy and controls are already
   on separate lines; there is no row to preserve and nothing for a two-row
   subgrid to add. The horizontal row only appears when the grid collapses to ONE
   column (cardW ≈ 674-686px > 36rem), and in that state the cards are stacked
   vertically as a pair, so cross-card alignment is meaningless.
2. **A JSX wrapper would have been added for nothing**, and moving
   `container-type` off the card would have silently killed the existing
   `@container sidecar-card` rules — the exact "reads correct in review but does
   nothing" failure the stylesheet already warns about.

## The real cause of the 22.5px offset

Both cards are stretched to equal height by the grid, and each is
`flex-wrap: wrap` + `align-items: center`. Two wrapped lines, equal outer
height, **different content height** (vision's control column is taller: select
row + 12px gap + the advanced disclosure). Flexbox gives each card its own
leftover space, and `align-items: center` centres each line inside its own
leftover. The card with less content has more leftover, so its control row sinks
by roughly half the difference. Nothing couples the two cards.

The 63px copy band mitigates this only while both hints wrap to the same number of
lines. At `ru`/`fr`, the vision hint takes a third line at 1100px, which is why
ru/fr break at a width where en/ko still measure clean.

## The fix

Pack the wrapped lines from the top of each card instead of centring them in
leftover space:

```css
.dash-sidecar-row-card { align-content: start; }
```

`align-content` is the correct property for a **multi-line** flex container — it
distributes the *lines*, which is exactly what is misdistributed here.
`align-items` (already `center` from `.dash-delegation-summary`) aligns items
*within* a line and must stay, so the single-line desktop row keeps its vertical
centring.

The stylesheet notes that `align-content` "has no effect on one line" — true, and
it is why `align-content` alone was rejected for the *control group*. But the
target here is the CARD, which genuinely has two lines in exactly the regime that
misaligns. In the one-column regime the card is a single line, where
`align-content: start` is inert and the row is unaffected. That is the property
doing precisely one job in precisely one regime.

With lines packed from the top, both control rows sit at
`padding-top + copyRowHeight`. Equal copy row height across the pair is then the
only remaining requirement, and it is what the `min-height` band already
provides — but now the band only needs to cover the *tallest actual* copy, and
alignment no longer depends on the two hints matching. The band is therefore
replaced by a locale-proof mechanism: the copy row's height is equalised by the
same `align-content` packing plus a shared floor expressed in line units
(`3lh`), not a pixel count derived from one locale's wrap count.

## Consequences for the existing test

`gui/tests/sidecar-layout.test.ts` currently asserts the magic band *as the
contract*:

- "both cards reserve the same copy band" requires `min-height >= 3.9rem` on the
  copy block;
- "both control groups reserve the same band and pack from its top" requires
  `min-height` and `align-items: flex-start` on the control group.

Those assertions encode the mitigation, not the requirement, so they must be
rewritten to assert the *cause* being removed (lines pack from the start; no
pixel-derived band is load-bearing). This is the file's stated purpose — "make the
specific CSS shape that caused the bug impossible to reintroduce" — applied to the
actual cause.

## Additional defect found by the sweep (new)

**The 760px two-column regression.** At `max-width: 760px` the sidebar leaves the
flow (`position: fixed`, off-canvas at `x=-280`), so `.main-inner` JUMPS from
526px to 750px. The sidecar grid re-splits into two columns at 349px each and the
22.5px misalignment returns — on tablet widths, below the width where it was last
believed fixed. Any fix must be verified at 760/740, not only at desktop widths.
