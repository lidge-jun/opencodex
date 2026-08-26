# 060 — Container-query conversion (criterion c3)

This closes the one acceptance criterion the first cycle deliberately left open.

## Why it was deferred, and why it is safe now

`container-type: inline-size` implies layout containment. During the first cycle the card
was briefly a `grid-template-rows: subgrid`, and a subgrid must read its parent's row
lines — containment forbids that, so the computed `grid-template-rows` came back `none`
and the subgrid silently never applied. That conflict is why the conversion did not ride
along with the fix.

The shipped layout is flex, not subgrid. Nothing in the card reads a parent row line, so
the containment has nothing left to break:

- both in-card overlays portal to `document.body` (`Select` defaults to `portal`,
  `VisionAdvancedPopover` uses `createPortal`), so containment cannot trap them
- the sticky table header lives on `.dashboard-workspace-main`, outside the card

The container goes on the CARD. Lifting it to the workspace shell WOULD trap the sticky
header — that hazard is real and is recorded at the rule.

## The wrong axis

`.dash-sidecar-grid` is `repeat(auto-fit, minmax(min(100%, 21rem), 1fr))`, so card width
is decoupled from viewport width: a 336px card exists inside a 992px window. Three rules
were stacking these cards from the viewport.

| was | now | note |
|---|---|---|
| `@media (max-width: 36rem)` | `@container sidecar-card (max-width: 36rem)` | applied to BOTH cards, not vision-only |
| `@media (max-width: 30rem)` | deleted | dead: `.dash-vision-number` renders only inside the portaled popover, which already sets `width: 100%` |
| `@media (max-width: 22rem)` | `@container sidecar-card (max-width: 22rem)` | |

Every converted selector is at least two classes deep. A bare `.dash-sidecar-copy` is
specificity 0,1,0 and loses to the 0,2,0 base rules — the query would read as correct in
review and do nothing.

## The decisive evidence

A viewport media query structurally cannot fire on a wide window. Holding the viewport at
**2000px** and forcing the card narrow:

| card width | copy flex-basis | control flex-basis |
|---|---|---|
| 38.8rem | 256px | 320px |
| 34.7rem | 100% | 100% |
| 30.0rem | 100% | 100% |
| 21.3rem | 100% | 100% |

The rules turn on and off with the CARD while the window never moves. That is the
behaviour the old `@media` rules could not express.

## One regression, caught and fixed

Converting the 36rem block vision-only reintroduced a 1.19px baseline offset: stacking one
card's control group while the other kept a different basis is the same asymmetry the
first cycle removed. The block now targets `.dash-sidecar-row-card`, and a test asserts
that a vision-only selector inside an `@container` may only carry vision-specific
concerns (its select row), never the shared copy/control basis.

## Verification

- 5 locales (ko/fr/ru/ja/en) x 7 viewports (1093-2500px): Δ selTop 0.04px (sub-pixel),
  title 21px, no overflow — unchanged from before the conversion
- three new guards in `gui/tests/sidecar-layout.test.ts`, each driven RED:
  turning a `@container` back into `@media` fails the wrong-axis guard; making the 36rem
  block vision-only fails the symmetry guard
- `bun run typecheck` / `lint:gui` / `build:gui` green; 43 focused GUI tests pass

Full repository suite not run, per the user's instruction; this is CSS in one stylesheet
plus test assertions.

