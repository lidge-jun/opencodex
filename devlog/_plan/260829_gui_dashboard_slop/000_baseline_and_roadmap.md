# 000 — Dashboard sidecar pair alignment and GUI polish

Reported: the dashboard at `#dashboard` "슬롭이 났다" — components misaligned
horizontally and vertically, and wrong under dynamic viewports.

This unit fixes what is *measured*, not what is asserted. Every defect below has
a numeric baseline captured with a CDP geometry harness that overrides the
viewport (`Emulation.setDeviceMetricsOverride`, dpr 2) and reads live
`getBoundingClientRect` values, so a claim can be re-checked rather than
re-argued.

## Harness and why it is trustworthy

Two harness bugs were found and fixed *before* any defect was accepted, because
each one silently manufactured agreement:

1. **Viewport lag.** The first sweep measured a cell before the emulated
   viewport had actually resized, so rows reported the *previous* width
   (`ru/w1100` measured `vw=1440`). Fixed with a settle loop that requires
   `innerWidth === target` before measuring, and the verdict tool now fails on
   any unsettled cell.
2. **Locale never applied.** `Page.navigate` to a URL differing only in its
   hash does not reload the document, so all four locales measured byte-identical
   geometry — an invalid multi-locale claim that *looked* like passing evidence.
   Fixed with an explicit `Page.reload` plus a settle condition on
   `document.documentElement.lang`. The probe now records the rendered hint
   length per card, and the verdict tool **fails** when every locale reports the
   same signature. Post-fix signatures: `en=66,81 ko=30,41 ru=82,114 fr=88,111`.

The second bug is the important one: without it, this unit would have "verified"
the locale dimension while never rendering a non-English string.

## Defect 1 — the sidecar pair loses its shared control row (TOP PRIORITY)

`.dash-sidecar-row-card` (web search) and `.dash-vision-sidecar-card` are
documented in the stylesheet as a *matched pair* whose first `Select` must land
on one line. Measured `ctrlYDelta` (vertical offset between the two control
rows):

| locale | 1440 | 1100 | 1024 |
|--------|------|------|------|
| en     | 0.1  | 0.1  | **27.4** |
| ko     | 0.4  | 0.4  | **27.8** |
| ru     | 0.1  | **7.1** | **22.6** |
| fr     | 0.1  | **2.3** | **22.6** |

### Root cause

Both cards are `flex-wrap: wrap` with `align-items: center`, and the grid
stretches them to equal height. Below ~`36rem` of *card* width the container
query gives copy and controls `flex-basis: 100%`, so each card becomes two
wrapped flex lines. The two cards then have **equal outer height but different
content height** — vision's control column is taller (select row + advanced
disclosure). Flexbox distributes the leftover space of each card independently
and `align-items: center` centres each line within its own leftover, so the
shorter card's control row sinks by half the difference. Nothing ties one card's
second line to the other's.

The shipped mitigation is a hard-coded reserved band:

```css
.dash-sidecar-row-card .dash-sidecar-copy { min-height: 3.9375rem; }
```

`3.9375rem` = 63px = "21px title + 3px hint margin + two 19.5px hint lines".
That number only holds while *both* hints wrap to at most two lines. It is the
third attempt at this alignment recorded in the file — after wrapping only one
card, then `align-items: flex-start` on one card — each adding a magic number
instead of removing the cause. The ru/fr breakage at 1100px is the band failing
exactly as predicted: longer hints take a third line, overflow the band, and the
pair desynchronises at a width where English still looks fine.

### Fix direction

Align the rows *structurally* so no number has to be maintained: the pair shares
one row grid, and each card's copy row and control row are placed into shared
tracks. Then alignment holds for any hint length in any locale, and the band can
be deleted rather than re-tuned. The existing comment correctly warns that
`container-type` layout containment blocks `subgrid` from reading parent
tracks, so the container query must not sit on a subgrid participant.

## Defect 2 — phantom zero-width grid track

At vw ≥ 1440, `.dash-sidecar-grid` and `.dash-overview-tools` compute
`grid-template-columns: 555px 555px 0px`. `repeat(auto-fit, minmax(min(100%, 21rem), 1fr))`
emits a third, zero-width track. Trailing gap measures 0 today, so nothing
visibly shifts — but the track is real, and it becomes a phantom gap the moment a
third card is added to either grid.

## Defect 3 — static viewport units in scroll surfaces

`gui/src/styles.css:2003` caps `.logs-table-wrap` with
`max-height: calc(100vh - 260px)`. Static `vh` resolves against the *large*
viewport, ignoring mobile browser chrome, while the rest of the shell already
uses `100dvh` (styles.css:244, 247, 411, 412, 2198). The log table is therefore
sized for a viewport the user cannot see. `styles.css:755` and `1222` cap toast
width with `calc(100vw - Npx)`, which ignores classic scrollbar width.

The probe measures this behaviourally — comparing each scroll container's
computed cap against `visualViewport.height` — rather than grepping for the
unit, so the assertion survives a refactor.

## Work phases

| phase | doc | deliverable |
|-------|-----|-------------|
| wp0 | this unit | measured baseline + roadmap |
| wp1 | `010` | sidecar pair structural alignment (top priority) |
| wp2 | `020` | phantom auto-fit track |
| wp3 | `030` | dynamic viewport units |

Acceptance for every implementation phase: `ctrlYDelta ≤ 1px` and
`heightDelta ≤ 1px` while paired, no horizontal overflow, no zero-width track,
no scroll cap exceeding the visual viewport, across
`1440/1100/1024/900/430` × `en/ko/ru/fr`, with locale signatures proven
distinct.

## Constraints

- The local suite is not run here (user instruction). Gates run remotely via
  `ssh lidge` + `ocx-run`; pushes use `--no-verify` only after those gates.
- Delivery is a stacked PR chain onto `dev`, each PR carrying screenshots
  (`enforce-target` requires a screenshot for GUI PRs).
