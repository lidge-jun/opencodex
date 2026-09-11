# 020 — Phantom zero-width auto-fit track (wp2)

> **WITHDRAWN — nothing in this document ships.** The investigation concluded the
> reported defect is not a defect: a collapsed zero-width `auto-fit` track is
> normal behaviour, and no code change was made for it. Kept as the record of why
> the track is expected, so the next person who measures it does not re-open it.

## Defect

At vw ≥ 1440 both dashboard grids compute a third, zero-width column:

```css
grid-template-columns: 555px 555px 0px
```

from `repeat(auto-fit, minmax(min(100%, 21rem), 1fr))`.

`auto-fit` collapses empty tracks but still *generates* one here because
`min(100%, 21rem)` lets the hypothetical third track floor at 0 once the
container is wide enough to nominally fit it. With only two children the track
collapses to 0 and the trailing gap measures 0, so nothing shifts today. It
becomes a real phantom gap the moment a third card is added.

## Why this was withdrawn — measured

The claim above ("the trailing gap measures 0, so nothing shifts today") was the
reason to withdraw, but it went unmeasured on the axis the request named first —
the horizontal one. It has now been measured, by auditing the rendered edges of
each grid's direct children rather than reading the computed track list.

`.dash-sidecar-grid` and `.dash-overview-tools`, two-up regime:

| vw | card widths | top spread | bottom spread | gutters |
|----|-------------|-----------|---------------|---------|
| 1600 | 556 / 556 | 0.0px | 0.0px | one 16px |
| 1440 | 555 / 555 | 0.0px | 0.0px | one 16px |
| 1280 | 475 / 475 | 0.0px | 0.0px | one 16px |
| 1100 | 385 / 385 | 0.0px | 0.0px | one 16px |
| 1024 | 347 / 347 | 0.0px | 0.0px | one 16px |

Identical widths, shared top and bottom edges, and exactly one gutter — no
trailing gap after the second card at any width. The collapsed third track
consumes no space and displaces nothing, in either grid, on both axes. So there
is no horizontal misalignment to fix here, and the generated-but-collapsed track
is not a defect.

## The rewrite that was considered and rejected

Recorded so it is not mistaken for a pending plan: **none of this shipped, and
applying it is not recommended.**

The option was to stop asking `auto-fit` to guess and state the known card count
— `grid-template-columns: 1fr` with a container query promoting to `1fr 1fr` —
for both grids. It was rejected on cost against benefit: it fixes nothing
measurable today (see the table above), and it trades `auto-fit`'s automatic
behaviour for a hard-coded count, so a third card would then need a stylesheet
change instead of just appearing. The phantom track only becomes real if a third
card is added, and at that point `auto-fit` is what handles it correctly.

If a future change does add a third card to either grid, re-measure the trailing
gap first; the audit above is the procedure.
