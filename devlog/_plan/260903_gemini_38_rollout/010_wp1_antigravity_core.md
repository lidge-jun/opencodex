# 010 — wp1: Antigravity core surface

One file does almost all of the work: `src/providers/antigravity-models.ts`. Plus one line in
`src/providers/registry.ts`. Everything here is diff-level and copy-paste executable.

## Design decision restated (do not skip)

3.8 uses the **suffix-wire** shape (`ANTIGRAVITY_EFFORT_WIRE_MAP`), like 3.6 did, NOT the
single-wire `thinkingLevel` shape 3.7 uses (`ANTIGRAVITY_THINKING_LEVEL_MODELS`). Evidence:
`002` — CCA serves `gemini-3.8-flash-{low,medium,high}` and no `-tiered` row.

Trace through `resolveAntigravityEffortWireModel` to see why the map is mandatory rather than
cosmetic. With an `ANTIGRAVITY_EFFORT_WIRE_MAP` entry, rule 2/3 returns
`{ wireModelId: "gemini-3.8-flash-high" }` — the suffix alone, no `thinkingLevel`; see section
8a and `005` for why the level must NOT accompany it. Without the map, `gemini-3.8-flash`
is not a suffix id (rule 1 skips), has no thinking-level entry (rule 1b skips), has no effort map
(rule 2/3 skips), is not `claude-` (rule 4 skips), and falls to **rule 5**, which returns the bare
id with no tier at all — a picker row whose effort selector does nothing.

## MODIFY `src/providers/antigravity-models.ts`

### 1. Current-generation constants (near L16)

Before:

```ts
/** Current Antigravity Flash generation. */
const GEMINI_FLASH_CURRENT = "gemini-3.7-flash";
```

After:

```ts
/** Current Antigravity Flash generation. */
const GEMINI_FLASH_CURRENT = "gemini-3.8-flash";

/**
 * Previous Flash generation, still served by CCA.
 *
 * 3.6 was pulled the moment 3.7 shipped, which is why RETIRED_FLASH_TIERS exists. 3.8 did not
 * do that: Google documents 3.7 Flash as "remains fully supported", and a 2026-09-03
 * :fetchAvailableModels call returns 3.8, 3.7 AND 3.6 wire ids together. So 3.7 stays a
 * first-class picker row instead of joining the retired map.
 */
const GEMINI_FLASH_PREVIOUS = "gemini-3.7-flash";
```

`GEMINI_FLASH_WIRE_ID` keeps its VALUE (`gemini-3.7-flash-tiered`) — it is the retired-tier
redirect target, which is still 3.7 — but is RENAMED per section 8c.

### 2. Wire model list (L52) — DROPPED after audit

`ANTIGRAVITY_WIRE_MODELS` has no consumer outside its own declaration; discovery does not read
it (audit blocker 9). Editing it would change dead data and imply a behavioral effect that does
not exist. Left alone; whether the dead mirror should be deleted is a separate cleanup with its
own blast radius, recorded as a follow-up in `050`.

### 3. Picker collapse map (`ANTIGRAVITY_PICKER_MODEL_BY_WIRE_ID`, L63)

```ts
const ANTIGRAVITY_PICKER_MODEL_BY_WIRE_ID: Record<string, string> = {
  "gemini-3.8-flash-low": "gemini-3.8-flash",
  "gemini-3.8-flash-medium": "gemini-3.8-flash",
  "gemini-3.8-flash-high": "gemini-3.8-flash",
  "gemini-3.1-pro-low": "gemini-3.1-pro",
  "gemini-pro-agent": "gemini-3.1-pro",
};
```

This is what makes `ANTIGRAVITY_WIRE_IDS_BY_PICKER_MODEL` require all three rungs before the
collapsed row appears, so a partial CCA payload degrades to visible wire ids rather than a
ladder with missing rungs. The generic `-(low|medium|high)$` branch in
`pickerModelIdForDiscoveredWireId` would also collapse these, but only once
`gemini-3.8-flash` is in `ANTIGRAVITY_MODELS`; the explicit map is the belt to that suspenders
and mirrors how 3.1 Pro is handled.

### 4. Effort ladder (`ANTIGRAVITY_MODEL_EFFORTS`, L145)

```ts
export const ANTIGRAVITY_MODEL_EFFORTS: Record<string, string[]> = {
  "gemini-3.8-flash": ["low", "medium", "high"],
  "gemini-3.7-flash": ["low", "medium", "high"],
  ...
};
```

No `minimal`: Google documents it as an error for this generation (`001`), and CCA exposes only
the three tiers (`002`).

### 5. Effort-to-wire map (`ANTIGRAVITY_EFFORT_WIRE_MAP`, L153)

```ts
const ANTIGRAVITY_EFFORT_WIRE_MAP: Record<string, Record<string, string>> = {
  "gemini-3.8-flash": {
    low: "gemini-3.8-flash-low",
    medium: "gemini-3.8-flash-medium",
    high: "gemini-3.8-flash-high",
  },
  "gemini-3.1-pro": { low: "gemini-3.1-pro-low", high: "gemini-pro-agent" },
};
```

### 6. Default effort (`ANTIGRAVITY_DEFAULT_EFFORT`, L180)

```ts
const ANTIGRAVITY_DEFAULT_EFFORT: Record<string, string> = {
  "gemini-3.8-flash": "medium",
  "gemini-3.1-pro": "high",
};
```

`medium` matches Google's documented `thinking_level` default (`001`) and the tier CCA marks
`recommended` with a finite 4000 thinking budget (`002`). Rule 2/3 requires this key: with an
effort map present and no default, `effortMap[defaultEffort]!` dereferences `undefined`.

This constant has a SECOND consumer the first draft missed (audit blocker 5):
`discoveredAntigravityEffortWireModelId` (L405-410) reads it to pick the default rung from a
DISCOVERED ladder. So the value governs both the static and the live path, and an omission
would make live discovery fall back to `Object.values(effortMap)[0]` — an arbitrary rung
determined by CCA's key order.

### 7. Picker list (`ANTIGRAVITY_MODELS`, L243)

```ts
export const ANTIGRAVITY_MODELS = [
  GEMINI_FLASH_CURRENT,   // gemini-3.8-flash
  GEMINI_FLASH_PREVIOUS,  // gemini-3.7-flash — still served, see 002
  "gemini-3.1-pro",
  "gemini-3.1-flash-image",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
];
```

### 8. Context windows

`ANTIGRAVITY_WIRE_MODEL_CONTEXT_WINDOWS` (L257) gains the three wire ids at `1_048_576`;
`ANTIGRAVITY_MODEL_CONTEXT_WINDOWS` (L267) gains the collapsed `"gemini-3.8-flash": 1_048_576`.
Both are needed: the map has no fallback, and the collapsed id is not derivable from an alias
because 3.8 has no alias entry.

### 8a. Suffix-tier carrier set (NEW — audit blocker 1)

Static rule 2/3 returns `{ wireModelId, thinkingLevel }` while the discovery path returns
`{ wireModelId }` only. Same model, two different request bodies depending on whether discovery
has run. A probe (`003`) shows CCA accepts `gemini-3.8-flash-low` paired with
`thinkingLevel: HIGH` and returns 200 — a contradiction it will not reject, so the effective
tier becomes unknowable. The suffix must be the sole carrier:

```ts
/**
 * Base models whose every effort maps to a wire id that ALREADY encodes the tier.
 *
 * Sending thinkingLevel alongside such a suffix states the effort twice, and CCA accepts a
 * contradictory pair rather than failing, so a mismatch would silently run at an unknown tier.
 * Membership also makes static resolution byte-identical to the discovery path, which never
 * emits thinkingLevel.
 *
 * gemini-3.1-pro is deliberately absent: its `high` rung is `gemini-pro-agent`, which carries
 * no tier suffix, so there the level is the only thing naming the effort.
 */
const ANTIGRAVITY_SUFFIX_TIER_MODELS = new Set(["gemini-3.8-flash"]);
```

Rule 2/3 becomes (round-2 form — the round-1 draft left `max`/`xhigh`/`ultra` diverging,
see `005` blocker 1):

```ts
const effortMap = ANTIGRAVITY_EFFORT_WIRE_MAP[modelId];
if (effortMap) {
  const suffixTiered = ANTIGRAVITY_SUFFIX_TIER_MODELS.has(modelId);
  // Normalize FIRST for suffix-tiered models: the discovery path clamps max/xhigh/ultra to
  // `high` before its lookup (L400-408), so a static path that skips the clamp answers
  // `medium` for the same request. Same input, two tiers, decided by whether discovery ran.
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

The `suffixTiered &&` guard keeps `gemini-3.1-pro` byte-identical: it has no `medium` rung, so
clamping there would change which wire id a request reaches — outside this unit's scope (`050`).

### 8b. Claude SDK paragraph guard (NEW — audit blocker 2)

`src/adapters/google.ts:750` strips the rejected Claude-Agent identity paragraph only for
`gemini-3.7-flash`. Probes in `003` prove 3.8 rejects the same paragraph with a 429 that reads
as quota exhaustion, and succeeds the moment it is stripped. Making 3.8 the default without
this change would 429 every Claude-Agent-shaped request.

```ts
// Membership is probe-established per generation, never assumed: 3.7 and 3.8 both answer 429
// RESOURCE_EXHAUSTED when this paragraph survives into systemInstruction, and 200 without it.
const ANTIGRAVITY_CLAUDE_SDK_PARAGRAPH_REJECTORS = new Set([
  "gemini-3.7-flash",
  "gemini-3.8-flash",
]);

/**
 * Canonicalize before the membership test: when discovery returns a PARTIAL ladder the picker
 * publishes raw suffix ids, so `parsed.modelId` can be `gemini-3.8-flash-high` rather than the
 * collapsed base. Those are the exact ids the 429 probe used, so a base-only test would miss
 * the degraded path — the moment CCA is flaky is the worst time to also lose the guard.
 * `canonicalAntigravityUsageModel` already collapses suffix ids via ANTIGRAVITY_EFFORT_WIRE_MAP
 * and returns unknown ids unchanged, so this adds no new mapping surface.
 */
function rejectsClaudeSdkParagraph(modelId: string): boolean {
  return ANTIGRAVITY_CLAUDE_SDK_PARAGRAPH_REJECTORS.has(canonicalAntigravityUsageModel(modelId));
}

const stripRejectedClaudeSdkParagraph = provider.googleMode === "cloud-code-assist"
  && rejectsClaudeSdkParagraph(parsed.modelId);
```

`canonicalAntigravityUsageModel` is already exported from `src/providers/antigravity-models.ts`;
`src/adapters/google.ts` gains the import.

### 8c. Constant rename (audit blocker 8)

`GEMINI_FLASH_WIRE_ID` becomes `GEMINI_RETIRED_FLASH_TARGET_WIRE_ID`. After 3.8 becomes
current, a constant named "the Flash wire id" holding `gemini-3.7-flash-tiered` reads as a bug.
Its rule-0 comment is corrected too: retired ids route to **3.7**, not to "the current
generation".

**All four sites move together or typecheck fails** (audit round 2, blocker 4): the declaration
at `src/providers/antigravity-models.ts:23`, plus references at `:201`
(`ANTIGRAVITY_PICKER_TO_WIRE`), `:233` (the retired-alias `Object.fromEntries`), and `:618`
(rule 0's return).

### 9. Input modalities (`ANTIGRAVITY_MODEL_INPUT_MODALITIES`, L281)

```ts
  "gemini-3.8-flash": ["text", "image"],
```

Google lists video, audio and PDF (`001`) and CCA reports `supportsVideo: true` (`002`), but
this proxy transports only `OcxTextContent` and `OcxImageContent`, and the Codex catalog
normalizes `input_modalities` against a closed enum where one out-of-enum value rejects the
ENTIRE catalog. The vendor capability is recorded in `001` as a fact about Google, not a claim
about this proxy. Same reasoning, same values as every other Gemini row.

## What is deliberately NOT touched

| Symbol | Why untouched |
|---|---|
| `RETIRED_FLASH_TIERS` | 3.7 is not retired (`001`, `002`). Adding it would strand a live model. |
| `ANTIGRAVITY_THINKING_LEVEL_MODELS` | 3.7 keeps its single-wire tiering; 3.8 must not join it. |
| `ANTIGRAVITY_PICKER_TO_WIRE` | Only for the `-tiered` rename; 3.8 has no `-tiered` id. |
| `ANTIGRAVITY_COMPATIBILITY_MODEL_ALIASES` | No saved config can name a 3.8 id yet. |
| `ANTIGRAVITY_USAGE_BASE_BY_ID` | Derives 3.8 automatically from `ANTIGRAVITY_EFFORT_WIRE_MAP`. |

## Complete consumer chain (PLAN-FIELD-CHAIN-01, completed after audit)

| Symbol | Consumers |
|---|---|
| `ANTIGRAVITY_EFFORT_WIRE_MAP` | static rule 2/3 (L639-645); discovery-map completion `completeDiscoveredEffortWireModelIds` (L164-166); discovery suppression via `hasOwnEffortLadder` (L597-601); `ANTIGRAVITY_USAGE_BASE_BY_ID` derivation |
| `ANTIGRAVITY_DEFAULT_EFFORT` | static rule 2/3 (L644); discovered-ladder default selection (L405-410) |
| `ANTIGRAVITY_MODEL_EFFORTS` | registry `modelReasoningEfforts` (`registry.ts:1753`) |
| `ANTIGRAVITY_WIRE_MODEL_CONTEXT_WINDOWS` | exported-map spread and alias derivation (L272-277) |
| `ANTIGRAVITY_MODEL_CONTEXT_WINDOWS` | registry `modelContextWindows` |
| `ANTIGRAVITY_PICKER_MODEL_BY_WIRE_ID` | reverse derivation `ANTIGRAVITY_WIRE_IDS_BY_PICKER_MODEL` (L67-95); `pickerModelIdForDiscoveredWireId` |

That last row is worth verifying rather than assuming: the IIFE walks
`ANTIGRAVITY_EFFORT_WIRE_MAP` and maps every wire value back to its base, so
`gemini-3.8-flash-high` collapses onto `gemini-3.8-flash` for usage aggregation with no new code.

## MODIFY `src/providers/registry.ts` (L1753)

`defaultModel: "gemini-3.7-flash"` becomes `defaultModel: "gemini-3.8-flash"`. The `models`,
`modelContextWindows`, `modelInputModalities` and `modelReasoningEfforts` fields already
reference the exported maps, so they follow automatically.

## Tests — MODIFY `tests/google-antigravity-wire.test.ts`

Add a `Gemini 3.8 Flash` describe block asserting:

1. `ANTIGRAVITY_MODELS` contains `gemini-3.8-flash` **and** still contains `gemini-3.7-flash`.
2. Registry `google-antigravity` `defaultModel === "gemini-3.8-flash"`.
3. `ANTIGRAVITY_MODEL_EFFORTS["gemini-3.8-flash"]` equals `["low","medium","high"]`.
4. Each effort resolves to its own wire id, table-driven over the three tiers, each returning
   NO `thinkingLevel` (the suffix is the sole tier carrier — section 8a).
5. No effort resolves to `gemini-3.8-flash-medium` by default — i.e. an unset effort returns the
   `medium` wire id (activation scenario for the `ANTIGRAVITY_DEFAULT_EFFORT` branch).
6. `xhigh`/`max`/`ultra` clamp to the `gemini-3.8-flash-high` wire id on BOTH the static and
   the discovered path (round-2 blocker 1: the round-1 draft returned the `medium` wire id
   statically and the `high` one after discovery).
7. A discovery payload containing all three 3.8 wire ids collapses to exactly one
   `gemini-3.8-flash` row carrying the full `effortWireModelIds` triple.
8. A payload containing only two of the three rungs does NOT collapse (partial-ladder guard).
9. Regression: `resolveAntigravityEffortWireModel("gemini-3.6-flash-high")` still returns
   `gemini-3.7-flash-tiered` with `thinkingLevel: "high"`.
10. `canonicalAntigravityUsageModel("gemini-3.8-flash-high") === "gemini-3.8-flash"`, and
    `canonicalAntigravityUsageModel("gemini-3.6-flash-high") === "gemini-3.6-flash-high"`.
11. **Path-equality (audit blocker 1):** for each of unset, `low`, `medium`, `high`, `max`,
    `xhigh`, `ultra`, resolving WITH a registered discovery ladder returns an object deep-equal
    to resolving WITHOUT one. Asserting the two paths separately is what allowed them to
    diverge; the clamped efforts are the cases the round-1 fix missed.
12. **Paragraph guard (audit blocker 2):** the serialized CCA `systemInstruction` omits the
    Claude SDK identity paragraph for both `gemini-3.7-flash` and `gemini-3.8-flash`, and a
    non-CCA Google request still contains it. Add beside `tests/google-adapter.test.ts:250`.
13. **Partial-ladder guard (round-2 blocker 2):** a discovery payload publishing only
    `gemini-3.8-flash-high` as its own row, then a serialized request selecting that suffix id,
    still omits the paragraph. This is the case a base-only membership test would miss.

## Stale exact assertions this phase must update (audit blocker 3)

- `tests/provider-registry-parity.test.ts:771` — `toHaveLength(6)` becomes 7, plus 3.8 ladder
  and context-window assertions mirroring the 3.7 ones.

Item 8 is the activation scenario for the `requiredWireIds.every(...)` guard; item 5 for the
default-effort branch; item 6 for `resolveAntigravityThinkingLevel`'s clamp.

## Focused verification for this phase

```bash
bun test tests/google-antigravity-wire.test.ts tests/gemini-37-flash-migration.test.ts \
  tests/google-adapter.test.ts tests/provider-registry-parity.test.ts
bun run typecheck
```
