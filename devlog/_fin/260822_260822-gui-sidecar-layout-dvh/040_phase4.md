# 040 — Phase 4: regression tests, gates, PR

> AMENDED after A-gate audit (VERDICT: FAIL #3). The original assertions were loose enough
> that the LIVE BUG would pass them.

## NEW gui/tests/sidecar-layout.test.ts

House style: `gui/tests/apikeys-layout.test.ts` — read the CSS with `Bun.file`, slice the
rule block from its selector to the closing brace, assert on that block only. happy-dom
does no layout (`gui/tests/codex-auto-switch-controller.test.tsx:533`), so pixel assertions
would be theatre.

Each assertion must fail if the exact production bug returns:

1. **Copy floor.** Slice `.dash-sidecar-row-card .dash-sidecar-copy`. Assert it contains
   `min-width: min(100%, 14rem)` (NOT merely "a min-width" — `.dash-sidecar-copy` already
   declares `min-width: 0` and would pass a loose check), and assert the block does NOT
   contain `overflow-wrap: anywhere`, and does NOT contain `flex: 1 1 0`.
2. **Row wrap.** Slice `.dash-sidecar-row-card`. Assert the card block does NOT contain
   `flex-wrap: nowrap`. Also slice `.dash-vision-sidecar-card .dash-delegation-controls`
   and assert the leftover `flex-wrap: nowrap` (line 167) is gone.
3. **Container declared on the card.** Slice `.dash-sidecar-row-card`; assert
   `container-type: inline-size` and `container-name: sidecar-card`.
4. **Wrong-axis guard.** Assert the file contains no `@media` block whose body mentions
   `.dash-sidecar-row-card` or `.dash-vision-sidecar-card`. Parse blocks, do not regex the
   whole file.
5. **Container rules win the cascade.** Assert every selector inside
   `@container sidecar-card` that sets `flex-basis`/`grid-row` on `.dash-sidecar-copy` or
   `.dash-delegation-controls` is at least two classes deep (e.g.
   `.dash-sidecar-row-card .dash-sidecar-copy`). A bare `.dash-sidecar-copy` is 0,1,0 and
   silently loses to the 0,2,0 base rules — the audit's blocker #1.
6. **Shared row structure.** Slice `.dash-sidecar-row-card`; assert
   `grid-template-rows: subgrid` (or, if the fallback was used, the documented
   `min-height` on copy). Assert the trigger rule declares `min-height: var(--control-md)`.
7. **Grid floor.** Parse the `.dash-sidecar-grid` block, extract the `minmax(min(100%, Nrem)`
   value, and assert `N >= 24` numerically. A `toContain("24rem")` would pass on a comment.

## Reuse the existing DOM harness

Do NOT add a second render harness. `gui/tests/vision-sidecar-dashboard.test.tsx:74`
already mounts `DashboardSidecarPanels`. If a DOM structure assertion is needed (both cards
expose one `.dash-sidecar-copy` + one `.dash-delegation-controls`, same order), add it there.

## Gates — FOCUSED ONLY

Per the user's instruction, the full repository suite is NOT run.

```
bun run typecheck
cd gui && bun test tests/sidecar-layout.test.ts tests/vision-sidecar-dashboard.test.tsx
bun run lint:gui
bun run build:gui
```

Rationale that this is proportionate: the change set is CSS in one stylesheet plus one new
GUI test. It touches no `src/` runtime, no routing, no config, no server behaviour — the
AGENTS.md conditions that require a full suite are all absent. `build:gui` is the real
compile gate for a CSS change.

## Browser evidence

Re-run the width sweep (card widths 280-1400, ko + fr) and capture:
- after-state screenshot at the width that used to collapse (card ~398px)
- Δ selTop table showing 0 across the two-column band
- fr locale check: the audit flags `Service auxiliaire de recherche Web` as the worst title
  wrap and `Diffuser les réponses en direct` (~210px) as the worst control label

## Push and PR

- Commit, then `git push --no-verify` (user instruction).
- If push from this host fails, retry from `ssh lidge`.
- PR targets `dev`, full template, and — because the description mentions `gui` —
  `enforce-target` REQUIRES a screenshot in the body.

