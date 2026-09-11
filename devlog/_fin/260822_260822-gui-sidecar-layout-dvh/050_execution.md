# 050 — Execution record: what shipped, and where it diverged from the plan

The phase docs (010-040) were written before any code existed. The landed change is much
smaller than they specified, and it uses a different mechanism. This records both.

## What shipped

One file: `gui/src/styles-dashboard-workspace.css` (+44/-7), plus a new
`gui/tests/sidecar-layout.test.ts`. No JSX change, no new markup, no container queries,
no grid rewrite.

Four rules:

1. `.dash-sidecar-row-card .dash-sidecar-copy` gains `min-width: min(100%, 14rem)` and
   drops `overflow-wrap: anywhere` for `break-word`.
2. `.dash-sidecar-row-card .dash-delegation-controls` gains `min-height: 3.6875rem` and
   `align-items: flex-start`.
3. `.dash-sidecar-row-card` gains `flex-wrap: wrap` — previously only the vision card had it.
4. `.dash-sidecar-row-card .dash-sidecar-copy` gains `min-height: 3.9375rem`.
   `.dash-vision-sidecar-card`'s `align-items: flex-start` is removed.

## Why the collapse happened

`.dash-delegation-summary` is a nowrap flex row. Copy was `flex: 1 1 0` with
`min-width: 0`; controls were `flex: 0 0 auto; flex-wrap: nowrap`. Copy was therefore the
only item that could yield, and its floor was zero. Once the ko control row
(168px select + 8 + ~108px label + 8 + 34px switch = 326px) outgrew the track, copy's used
width went to 0 and `overflow-wrap: anywhere` authorised a break after every CJK glyph.

Measured: title 17px wide / 147px tall, card 157px → 618px, at a 1125px viewport.

The 14rem floor makes that state unreachable. `min()` caps the floor at the card so a
floor can never overflow the box it is a floor for.

## Why the baseline drift happened

Both triggers are the same 31.55px box. The drift was never size, it was placement:

- the vision card overrode the shared `align-items: center` with `flex-start`
- the vision card wrapped while the web-search card did not, so their control groups
  resolved onto different flex lines
- the two control groups are genuinely different heights (34px select row vs a 59px
  column carrying the "advanced" disclosure), and each centred inside an equal-height card
- the two copy blocks are different heights in every locale, so a wrapped control line
  followed its own card's copy

Symmetry is the fix. Both cards wrap, neither overrides the shared alignment, both copy
blocks reserve the same band, and both control groups reserve the same band and pack from
its top. Measured Δ selTop: 0.0px.

## Divergences from the plan

**Subgrid (030) was tried and abandoned.** `container-type: inline-size` implies layout
containment, and a subgrid must read its parent's row lines — the two silently conflict.
With both declared, `getComputedStyle(card).gridTemplateRows` returns `none`: the subgrid
never applies, with no warning. Splitting them across a wrapper element made the grid's own
rows expand to 880px and the cards to 1776px tall. The shipped fix stays in flex.

**Container queries (020) were not needed.** They were specified to replace three
wrong-axis `@media` rules. Once the copy floor exists those rules are no longer load-bearing
for the collapse, and adding `container-type` is what broke subgrid. Converting them is
still correct and remains open; it is not required by this fix.

**The 24rem grid floor (010) was not needed** once copy cannot be crushed.

**The `--control-md` trigger height token (030) was not needed.** Both triggers were
already 31.55px; the difference was position, not size.

## Measured final state

At viewports 1093-2500px, ko / fr / ru / ja / en:

- title height 21px (was 147px at the collapse)
- Δ selTop 0.0px at every two-column width
- nothing overflows a card's padding box

## Gates

`bun run typecheck`, `bun run lint:gui`, `bun run build:gui`, and the focused GUI tests
(40 tests across 5 files) — green. The regression suite was driven RED by reintroducing
`overflow-wrap: anywhere` before being restored, so it is not vacuous.

The full repository suite was not run, at the user's instruction. The change is CSS in one
stylesheet plus one GUI test; it touches no `src/` runtime, routing, config, or server code.

## Known remaining work

- Below ~280px of card width the control floors still exceed the card. Real viewports do
  not reach that (the app's own minimum keeps cards above ~340px), so it is not fixed here.
- The wrong-axis `@media` rules at lines 275/296/305 remain. Converting them to container
  queries is a separate change, and the containment interaction above is the reason it did
  not ride along with this one.

