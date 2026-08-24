# 000 — 260822-gui-sidecar-layout-dvh: Plan

## Objective

Remove the layout collapse in the dashboard sidecar cards at the root-cause level, and
make the two sidecar dropdown (Select) triggers share one baseline at every container
width. Ship it as a PR against `dev`.

Observed failure (user screenshot, 2026-08-22, ko locale):

- The "웹 검색 사이드카" card's title and hint collapse into a ONE-GLYPH-WIDE vertical
  stripe and the card grows past 600px tall.
- The two cards' first `.select-trigger` never share a vertical baseline.

## Evidence base (measured, not inferred)

Live browser sweep against this worktree's Vite build (`http://127.0.0.1:5199/#dashboard`,
ko locale, `getBoundingClientRect`):

| viewport | grid | web card | web titleW | web titleH | vision card | ΔselTop |
|---|---|---|---|---|---|---|
| 2000 | 1128 | 556x157 | 176 | 21 | 556x157 | **16** |
| 1500 | 1128 | 556x157 | 176 | 21 | 556x157 | **16** |
| 1280 | 966 | 475x157 | 95 | 21 | 475x157 | **16** |
| 1125 | 811 | **398x618** | **17** | **147** | 398x618 | **136** |
| 1025 | 711 | **348x637** | **0** | **147** | 348x637 | **112** |
| 875 | 561 | 561x101 | 181 | 21 | 561x157 | 161 |
| 475 | 429 | 429x201 | 49 | 42 | 429x197 | 211 |
| 425 | 379 | **379x637** | **0** | **147** | 379x217 | **449** |

Two independent defects are visible in the same table:

1. **Glyph collapse** — at card width 398px and below, `titleW` drops to 17px/0px and
   `titleH` rises to 147px. The card height goes 157 → 618px.
2. **Baseline drift** — `ΔselTop` is never 0. It is 16px even at 2000px viewport where
   nothing is crowded, and it grows to 449px when the cards diverge.

Before-state screenshot: `.tmp/ui-evidence/before-1125.jpg` (scratch, not committed).

## Root cause (explorer lane A, confirmed against source)

```
.dash-delegation-summary  →  display:flex; align-items:center; gap:16px   (styles.css:2307)
.dash-sidecar-row-card .dash-sidecar-copy      → flex: 1 1 0; overflow-wrap: anywhere
.dash-sidecar-row-card .dash-delegation-controls → flex: 0 0 auto; flex-wrap: nowrap
```

The row cannot wrap and the controls cannot shrink, so copy is the only item that yields.
Its basis is 0 and its `min-width` is 0, so its used width is
`max(0, content − 16 − controls)`. Once that goes negative, copy renders at 0px and
`overflow-wrap: anywhere` authorises a break after every CJK glyph.

Measured control max-content for the ko web-search row:

`168px (10.5rem select) + 8 + 107.6 ("응답 실시간 스트리밍") + 8 + 34 (switch) = 325.6px`

Copy reaches 0 at card border-box `325.6 + 16 + 36 (panel padding) + 2 (border) = 380px`.
The grid still emits 21rem = 336px tracks, i.e. **the two-column floor is 44px narrower
than the row it must hold.** French is worse (~433px).

The vision card does not collapse because it already special-cases the same trap
(`flex-wrap: wrap`, `flex: 1 1 16rem`, `min-width: min(100%, 14rem)`) — the fix is to
generalise that contract, not to invent one.

### Baseline drift cause (explorer lane C, computed)

Both triggers are the same box: `6px+6px padding + 13px×1.35 + 2px border = 31.55px`.
The drift is parent alignment, not size:

- web-search card inherits `align-items: center` from `.dash-delegation-summary`
- vision card overrides to `align-items: flex-start` and stacks a 12px gap + 19.5px
  advanced row under its select row

Vision's control column is `31.55 + 12 + 19.5 = 63.05px`. Grid stretch equalises card
height, so the centered web-search select lands at `(63.05 − 31.55)/2 = 15.75px` lower.
That is the 16px measured at every wide viewport.

### Wrong-axis media queries (explorer lane B, confirmed)

`.dash-sidecar-grid` is `repeat(auto-fit, minmax(min(100%, 21rem), 1fr))`, so card width is
decoupled from viewport width. Three rules still stack from the viewport:

| rule | file:line | verdict |
|---|---|---|
| `@media (max-width: 36rem)` vision stack | styles-dashboard-workspace.css:275 | wrong axis — never fires while two columns exist |
| `@media (max-width: 30rem)` vision number | styles-dashboard-workspace.css:296 | dead — `.dash-vision-number` is portal-only now, popover already sets width:100% |
| `@media (max-width: 22rem)` row stack | styles-dashboard-workspace.css:305 | wrong axis — 352px viewport, but cards hit 336px inside a 992px viewport |

The GUI already uses container queries in seven other stylesheets
(`provider-workspace`, `apikeys-workspace`, `models-workspace`, `subagents-workspace`,
`usage-workspace`, `.main-inner`). Dashboard workspace is the only holdout. Vite 8 ships
lightningcss 1.33.0; `bun run lint:gui` is oxlint on TS only and never parses CSS.

Containment hazard check: both in-card overlays (`Select` menu, `VisionAdvancedPopover`)
are `createPortal(..., document.body)` with fixed positioning, so card-level
`container-type: inline-size` cannot trap them. The sticky `thead` lives on
`.dashboard-workspace-main`, outside the card — which is exactly why the container goes on
the CARD and never on the shell.

## Loop-spec

- Loop archetype: verifier-defined (measured `getBoundingClientRect` contract + tests)
- Write scope: `gui/src/styles-dashboard-workspace.css`, `gui/src/styles.css`,
  `gui/src/pages/dashboard-overview-sections.tsx`, `gui/tests/`, this devlog unit
- Out of scope: `src/` runtime, server API, i18n copy rewrites, `go/`, `docs-site/`
- Budget: one PR, four implementation cycles

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp1 | 000 | this roadmap (docs-only) | — |
| wp2 | 010 | flex negotiation contract + grid floor | wp1 |
| wp3 | 020 | container-query conversion | wp2 |
| wp4 | 030 | control baseline alignment + trigger height token | wp2 |
| wp5 | 040 | regression tests, full gates, PR | wp2-wp4 |

## Accept criteria

- c2: no glyph collapse at any card width 280-1400px (measured `titleH <= 2 lines`)
- c3: narrow stacking fires from card width, not viewport width
- c4: both cards' first select share `selTop` (Δ = 0) and height
- c5: ko/ja/ru hints never overlap controls
- c6: regression tests added; typecheck / test / lint:gui / build:gui green
- c7: PR against `dev` with the full template and a screenshot


## A-gate audit outcome (2026-08-22)

Independent xai/grok-4.6 auditor: **VERDICT: FAIL**, 3 blockers, all accepted and folded
into the docs before B:

1. 020's \`@container\` selectors were 0,1,0 and would have lost the cascade to the 0,2,0
   base \`flex\` shorthands — the stacking rule would have been a silent no-op. 020/040
   now require two-class selectors and a test that enforces it.
2. 030's \`align-items: flex-start\` only fixed the wide one-line case. After 010 lets the
   row wrap, the control row inherits copy height, and the two hints differ in length
   (ko 30 vs 41 chars). 030 is rewritten around grid subgrid so the shared row line is
   structural.
3. 040's assertions were loose enough that the live bug (\`min-width: 0\`) would pass.
   Every assertion is now pinned to the exact value.

Accepted non-blocking notes: c4 is scoped to the two-column band (Δ is meaningless when
cards stack); 24rem is kept as the grid floor because 010's wrap removes the nowrap budget
the larger value was protecting; \`.dash-overview-tools\` 21rem squeeze is out of scope.
