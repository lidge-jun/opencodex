# Post-merge fixes after batches 6–7 and #5910

A second review of `dev` at `f32f9aabd7` by independent Sol reviewers (union, batch 6 runtime, batch 7 + #5910, new
PR triage) found three verified P2 layout defects from #5910 and one shared CI hang. The batch 6 finding about a failed
replacement surfacing as a generic `upstream_sse_error` matches the Responses post-header path
(`deferProtocolSafeResetRecovery` also preserves the original stream error), so it is a cross-lane design question,
not a batch 6 regression, and is out of scope here.

## Fixes (branch `codex/post-merge-fixes`)

1. Combos overflow in the desktop shell. `quota-summary-bar.css` sizes the Combos shell only when the bar is a direct
   child of `.main`; the desktop shell wraps it in `.main-top`, so the `100dvh` shell sits under a 40px strip and the page
   overflows by 40px. Add the same two rules (and the ≤760px `height: 100%` rule) keyed on `.main:has(> .main-top)` in
   `gui/src/components/app-titlebar.css`, which owns `.main-top`.
2. Narrow desktop window: `.main-top` is `position: sticky; top: 0` like `.mobile-topbar`, and paints over the menu while
   scrolling. At `max-width: 760px` make `.main-top` static, as the quota bar already was there.
3. High page zoom: `watchMacTitlebarMetrics` floors the points→CSS ratio at 1, so at 300% on a 360pt window the 80px
   inset pushes the 44px menu off a 120px viewport. For ratio < 1 set `--tl-inset` to `ceil(80 × ratio)` and
   `--chrome-clear` to that plus 44 (toggle 28 + padding 16, which are CSS pixels); keep `--titlebar-h` at 40 and keep the
   ratio ≥ 1 branch unchanged.

Tests: extend `gui/tests/app-titlebar.test.tsx` (zoom-in case: DPR 6 on a 2x window → inset 27px, clear 71px,
titlebar 40px; CSS assertions for the static strip and the `.main-top` Combos rules). GUI screenshot for the PR.

4. CI hang (`test 4/4` batch of `tests/cli/*` timing out at 120s on Linux in dev, #5924 and #5928): root cause is being
   investigated in a separate lane; its fix lands in this branch if it is ready and verified, otherwise separately.

## Check

`bun x tsc --noEmit`, `bun run lint:gui`, `bun run build:gui`, gui tests for the titlebar and quota bar, structure and
privacy checks, exact-head CI, then `--admin --match-head-commit`.

