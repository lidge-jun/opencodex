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

Import boundary: `effectiveComboDefault` lives in `src/codex/catalog/aggregation.ts`. Check
that importing it into `src/combos/request.ts` does not pull catalog-fetch or Lab weight onto
the request path — `tests/core-lab-boundary.test.ts` is the guard. If it does, lift the
ranking helper into a leaf module both sides import.

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

