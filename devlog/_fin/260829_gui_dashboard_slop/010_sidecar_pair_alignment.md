# 010 — Sidecar pair: structural row alignment (wp1, TOP PRIORITY)

Removes the magic reserved band and makes the two sidecar cards share real row
tracks, so their control rows align for any hint length in any locale.

## Current shape

```text
.dash-sidecar-grid                     grid, auto-fit 2 tracks, align-items: stretch
  └─ .panel.dash-delegation-summary.dash-sidecar-row-card
       ├─ .dash-sidecar-copy            (title + hint)
       └─ .dash-delegation-controls     (selects / switch / disclosure)
```

Each card is its own flex container (`flex-wrap: wrap`, `align-items: center`)
and, below `36rem` of card width, both children take `flex-basis: 100%` — two
wrapped lines whose position depends only on that card's own leftover space.

## Change

Make each card a two-row grid and let both cards inherit the *same* two rows from
the pair grid:

1. `.dash-sidecar-grid` gains `grid-template-rows: auto auto` so there are named
   parent rows to inherit.
2. `.dash-sidecar-row-card` becomes `display: grid` with
   `grid-template-rows: subgrid` spanning both rows, so copy lands in row 1 and
   controls in row 2 **in both cards**. Row 1 is sized by the taller of the two
   copy blocks, automatically — which is exactly what the 63px band was
   hand-computing.
3. Delete `.dash-sidecar-row-card .dash-sidecar-copy { min-height: 3.9375rem }`
   and the `min-height: 3.6875rem` band on `.dash-delegation-controls`. They are
   the numbers being replaced.
4. Move `container-type: inline-size` **off** the subgrid participant. Layout
   containment blocks a subgrid from reading parent tracks (the stylesheet already
   warns about this). The container is re-established on a wrapper so the existing
   `@container sidecar-card` rules keep working unchanged.

## Wrapper

Subgrid requires the card to be a grid *item* of the pair grid, but the card also
has to be the container query root's child. Structure becomes:

```text
.dash-sidecar-grid            (grid, 2 rows)
  └─ .dash-sidecar-cell       (container-type: inline-size, display: grid, rows: subgrid, span 2)
       └─ .dash-sidecar-row-card  (display: grid, rows: subgrid, span 2)
```

The cell carries the container query; the card carries the visible panel styling.
Both pass the rows through, so row 1 and row 2 are shared across the pair.

Requires one JSX change in `dashboard-overview-sections.tsx`: wrap each of the
two existing card `div`s in `<div className="dash-sidecar-cell">`.

## Stacked state

When the container query stacks a card (card narrower than `22rem`), the two
cards are in *different* grid columns of a single-column grid — i.e. different
rows of the pair — so cross-card alignment is meaningless and must not be
asserted. The verdict tool already treats `sameRow: false` as `STACKED` and
skips the delta check.

## Fallback

`grid-template-rows: subgrid` is supported in Chrome 117+, Safari 16+, Firefox
71+. Guard with `@supports (grid-template-rows: subgrid)`; without support the
cards keep the current flex row behaviour, which is the shipped status quo rather
than a regression. The deleted bands are restored inside the negative branch so
unsupported browsers keep today's approximation.

## Acceptance

- `ctrlYDelta ≤ 1px` and `heightDelta ≤ 1px` at every PAIRED cell across
  `1440/1100/1024` × `en/ko/ru/fr` (baseline: up to 27.8px).
- No `min-height` band remains on `.dash-sidecar-copy`.
- Locale hint signatures distinct, no unsettled cells.
- A focused GUI test asserts the subgrid contract so a future edit that reverts
  to the band fails.
