# 050 — Phase 5: #3108 — combo default reasoning effort arrives as none

## Reported behaviour

Combo `combo/0` with default reasoning level `max` routed to `deepseek-v4-pro` sends
`none`; selecting `deepseek-v4-pro` directly with `max` sends `max`. OpenCodex 2.37.0.

## Mechanism in the tree

`src/server/responses/core.ts:2277` builds the child body:

    const childBody = concreteComboRequestBody(
      body,
      pick.target,
      comboDefaultEffort(config, comboId),
      supportedLadderFor({ provider: targetRoute.provider, modelId: targetRoute.modelId }),
    );

`src/combos/request.ts:75` then refuses to inject:

    if (!targetReasoningEfforts?.includes(defaultEffort)) { /* debug log */ return clone; }

So the default is dropped whenever the concrete target's ladder does not literally contain
the configured rung — including when the ladder is `undefined`. The comment calls this
deliberate fail-closed behaviour, but the catalog path disagrees:
`src/codex/catalog/aggregation.ts:168` advertises the combo's default through
`effectiveComboDefault`, which downgrades a too-high request to the nearest supported rung
at or below it (`aggregation.ts:86-93`) instead of dropping it.

That asymmetry is the defect: the catalog promises `max` or the nearest rung below, the
runtime silently sends nothing, and the provider default — `none` — applies.

## MODIFY map

**`src/combos/request.ts`** — reuse the catalog's own resolution instead of exact membership:

    const resolved = targetReasoningEfforts === undefined
      ? undefined
      : effectiveComboDefault(defaultEffort, targetReasoningEfforts);
    if (!resolved) { /* same warn shape */ return clone; }

then inject `resolved` rather than `defaultEffort`.

- an unknown (`undefined`) ladder stays fail-closed — that half of the behaviour is correct.
- an explicitly empty ladder still yields `undefined` from `effectiveComboDefault`
  (`ranked.length === 0`), so a no-reasoning model is never given an effort.
- a caller-supplied `reasoning.effort` is still untouched; that check runs first.

## Import boundary — RESOLVED AT AUDIT, the direct import is forbidden

A-gate audit (independent explorer, grok-4.6) plus direct tracing settled this:
`src/codex/catalog/aggregation.ts` does NOT reach `src/lab/`, so `tests/core-lab-boundary.test.ts`
would stay green — but the import is still wrong for two harder reasons:

1. **It is a cycle.** `aggregation.ts:22-29` already imports `../../combos`. Adding
   `src/combos/request.ts` -> `aggregation.ts` closes the loop.
2. **It drags the catalog plane onto the request path.** `aggregation.ts:1-31` pulls
   `node:child_process`, `../../oauth`, `../model-cache`, and
   `../../adapters/cursor/live-models`. `src/server/responses/core.ts` imports `src/combos/`,
   so every routed request would carry live-discovery and OAuth weight it never uses.

**Therefore the fallback is the plan, not a contingency.** Lift the ranking helper into
`src/reasoning-effort.ts` — a genuine leaf whose only import is `./types`, and which already
owns `codexEffortRank` (`reasoning-effort.ts:79-81`), the exact primitive the helper needs.

**MOVE**: `effectiveComboDefault` from `src/codex/catalog/aggregation.ts:80-94` to
`src/reasoning-effort.ts`, renamed `resolveEffortAtOrBelow(configured, supported)` to say what
it does independent of combos. `aggregation.ts` imports it from there (it already imports
`codexEffortRank` out of the same module at line 11) and keeps a local
`effectiveComboDefault` alias only if the existing call site reads better that way.
`src/combos/request.ts` imports the same leaf function. No cycle, no catalog weight.

## TESTS

**`tests/combos.test.ts`** already covers `concreteComboRequestBody`. Add:

1. configured `max`, target ladder `["low","medium","high"]` -> injects `high`.
2. configured `max`, ladder includes `max` -> injects `max` (unchanged).
3. ladder `undefined` -> no injection (fail-closed, unchanged).
4. ladder `[]` -> no injection (unchanged).
5. caller-supplied `reasoning.effort` -> untouched (unchanged).

## Verification (C)

- `bun test tests/combos.test.ts` focused.
- CI judged at the end of the train.
