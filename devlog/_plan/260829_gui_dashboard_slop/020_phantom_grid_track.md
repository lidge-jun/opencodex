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

## Change

Both grids hold a *known* number of cards, so express that instead of asking
`auto-fit` to guess:

```css
grid-template-columns: repeat(auto-fit, minmax(min(100%, 21rem), 1fr));
```

becomes an explicit two-up that collapses to one column by container width:

```css
grid-template-columns: 1fr;                 /* narrow: stack */
@container / min-width: two-up → 1fr 1fr    /* wide: matched pair */
```

Applies to `.dash-sidecar-grid` and `.dash-overview-tools`. The wrap width stays
`21rem` per card so the responsive behaviour is unchanged — verified by the same
sweep, which must keep reporting STACKED at 900/430 and PAIRED at 1024+.

## Acceptance

- No `0px` track in either grid's computed columns at any swept width.
- The PAIRED/STACKED pattern per width matches the baseline exactly (no
  behavioural change, only the phantom track removed).
