# 005 — A-gate round 2: verdict and synthesis

Same reviewer, re-audit of the amended plan. Verdict **FAIL**, blockers 1 and 2 blocking.
Round 1's nine findings were all confirmed adequately fixed except where noted below; these
two are NEW defects introduced by the round-1 amendments themselves, which is exactly what a
second round is for.

## Blocker 1 (High) — the suffix-tier fix does not cover clamped efforts

**Accepted. Verified in code.**

`ANTIGRAVITY_SUFFIX_TIER_MODELS` equalizes the two paths for `unset`/`low`/`medium`/`high` and
leaves `max`/`xhigh`/`ultra` diverging:

| Path | `effort = "max"` | Why |
|---|---|---|
| discovered | `gemini-3.8-flash-high` | `resolveAntigravityThinkingLevel` clamps to `high` first (L400-408) |
| static rule 2/3 | `gemini-3.8-flash-medium` | `"max" in effortMap` is false, so it falls to `ANTIGRAVITY_DEFAULT_EFFORT` (L644-645) |

A user asking for `max` gets `high` or `medium` depending on whether discovery has run. The
reviewer also correctly notes this is reachable in production, not just theoretically:
`src/web-search/gemini-executor.ts:51` passes the raw effort straight through without going
via `mapReasoningEffort`.

Worse for the plan's own credibility: `010` test items 6 and 11 as written would FAIL against
the code `010` proposed. The plan contradicted itself.

**Fix (amends `010` section 8a):** clamp before the map lookup for suffix-tier models, so both
paths perform the same normalization in the same order:

```ts
const effortMap = ANTIGRAVITY_EFFORT_WIRE_MAP[modelId];
if (effortMap) {
  const suffixTiered = ANTIGRAVITY_SUFFIX_TIER_MODELS.has(modelId);
  // Normalize FIRST for suffix-tiered models: the discovery path clamps max/xhigh/ultra to
  // `high` before its lookup, so a static path that skips the clamp answers `medium` for the
  // same request. Same input, two tiers, decided by whether discovery happened to run.
  const requested = suffixTiered && effort
    ? resolveAntigravityThinkingLevel(effort) ?? effort
    : effort;
  if (requested && requested in effortMap) {
    const wireModelId = effortMap[requested]!;
    return suffixTiered ? { wireModelId } : { wireModelId, thinkingLevel: requested };
  }
  const defaultEffort = ANTIGRAVITY_DEFAULT_EFFORT[modelId]!;
  return { wireModelId: effortMap[defaultEffort]! };
}
```

The `suffixTiered &&` guard keeps `gemini-3.1-pro` byte-identical to today: it has no `medium`
rung, and clamping there would change which wire id a `medium` request reaches — a behavior
change outside this unit.

Test item 11 is extended to `max`, `xhigh`, `ultra`, and the stale lines at `010:13-14` and
`010:252-253` that still promise a `thinkingLevel` are corrected.

## Blocker 2 (High) — partial-ladder suffix rows bypass the paragraph guard

**Accepted. This is a genuinely subtle interaction and the reviewer found it by composing two
separate parts of the plan.**

The guard set holds picker ids (`gemini-3.8-flash`) and compares against `parsed.modelId`,
which is correct for the collapsed row. But `010` section 3 deliberately keeps raw suffix ids
visible when CCA returns a PARTIAL ladder — that is the documented degradation path. In that
state a user selects `gemini-3.8-flash-high` directly, so `parsed.modelId` IS the suffix id, it
misses the base-only set, and the paragraph survives.

The 429 probes in `003` were run against exactly those suffix wire ids, so this is not a
hypothetical gap: the ids proven to reject the paragraph are precisely the ones that would slip
past the guard.

**Fix (amends `010` section 8b):** canonicalize before the membership test rather than
enumerating every spelling:

```ts
/**
 * Whether CCA rejects the Claude-Agent identity paragraph for this selector.
 *
 * Canonicalize first: when discovery returns a partial ladder the picker publishes RAW suffix
 * ids (see parseAntigravityAvailableModels), so `parsed.modelId` can be `gemini-3.8-flash-high`
 * rather than the collapsed base. Those are the exact ids the 429 probe used, so a base-only
 * membership test would miss the degraded path — the one users hit when CCA is flaky, i.e. the
 * worst possible time to also lose the guard.
 */
function rejectsClaudeSdkParagraph(modelId: string): boolean {
  return ANTIGRAVITY_CLAUDE_SDK_PARAGRAPH_REJECTORS.has(canonicalAntigravityUsageModel(modelId));
}
```

`canonicalAntigravityUsageModel` already collapses `gemini-3.8-flash-high` onto
`gemini-3.8-flash` via the `ANTIGRAVITY_EFFORT_WIRE_MAP` derivation, and leaves unknown ids as
identity, so it adds no new mapping surface. It must be exported from
`src/providers/antigravity-models.ts` (it already is) and imported by `src/adapters/google.ts`.

Required test: a partial-discovery payload publishing `gemini-3.8-flash-high` as its own row,
then a serialized request asserting the paragraph is absent.

## Blocker 3 (Medium) — direct Google 3.8 activation untested

Accepted. `030` gains a direct AI Studio test: bare `gemini-3.8-flash` reaches the wire with no
synthetic `-tiered` rename, and the configured-ladder branch at `google.ts:782-790` emits
`thinkingConfig`. Adding the model to `modelReasoningEfforts` is what newly activates that
branch for 3.8, so it needs its own activation scenario.

## Blocker 4 (Medium) — the rename plan contradicted itself

Accepted, and embarrassing: `010` line 47 said the constant keeps its name while section 8c
renamed it. Section 8c now enumerates all three call sites — `antigravity-models.ts:201`,
`:233`, `:618` — and the contradictory sentence is removed. A declaration-only rename would not
even typecheck.

## Blocker 5 (Low) — `tests/google-output-clamp.test.ts`

**Accepted as a documentation gap, resolved as no-change with evidence.**

`maxOutputTokensForGoogleModel` (`src/adapters/google.ts:83-89`) is family-based: any id
starting `gemini` and not matching the `pro` pattern returns 65536. `gemini-3.8-flash` therefore
already receives the correct documented ceiling with no table entry, which `001` confirms is
65,536. Recorded in `004` rather than changed.

## Round outcome

Both High blockers folded as concrete code amendments; three lesser findings folded or resolved
with evidence. Round 3 re-audits with the same reviewer.
