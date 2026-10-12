# 020 — wp2: /v1/models hardening (max_output_tokens; threshold stays in pricing.overrides)

Depends on: 010. Own PR against `dev`.

Loop-spec: spec-satisfaction; trigger = rows omit `capabilities.max_output_tokens` although the
bundle reads it (Anthropic wire `max_tokens` when no family outputCap; tooltip "Max output");
goal = advertise an authoritative output ceiling where opencodex has one; non-goals = inventing
limits, changing `supports_reasoning`; verifier = the focused list below + typecheck; stop =
green + exact-head CI.

## Decision recorded at P (conflict between research lanes)

Lane B proposed also emitting a top-level `long_context_threshold_tokens`. Lane D read the
parser (001 §"Extended-capability schema"): Cursor's row normaliser computes that field itself
from `cost.long_context.threshold_tokens` → `capabilities.cost.long_context.threshold_tokens` →
smallest `pricing.overrides[].min_prompt_tokens`, and the raw top-level key is never read
(bundle: `void 0!==i?{long_context_threshold_tokens:i}:{}` where `i` is derived from those
three). Emitting it would be dead data and a nested `cost.long_context` breaks the `mme`
numeric-record schema. **wp2 keeps `pricing.overrides` as the only threshold carrier and adds
no top-level key.** The test asserts its absence so nobody re-adds it.

## Design (Lane B, folded; threshold item removed)

## Findings

- `modelCapabilityFields` currently emits `pricing.overrides` for long tiers but omits Cursor’s validated top-level `long_context_threshold_tokens` ([models-capabilities.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/server/models-capabilities.ts:97)).
- The generated tuple’s third column is `maxTokens`; `rowToMetadata` exposes it as `ModelMetadata.maxTokens`. It is the model output-token budget, not an input limit ([model-metadata.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/generated/model-metadata.ts:38), [generator](/Users/jun/.codex/worktrees/4ed0/opencodex/scripts/generate-model-metadata.ts:90)).
- `CatalogModel` has `contextWindow`, `maxInputTokens`, and `inputModalities`, but no output-token field ([parsing.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/codex/catalog/parsing.ts:95)).
- Routed context/modalities arrive through provider configuration and live `/models` parsing; generated metadata also supplies them when jawcode rows are appended ([provider-fetch.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/codex/catalog/provider-fetch.ts:682), [provider-fetch.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/codex/catalog/provider-fetch.ts:1209), [provider-fetch.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/codex/catalog/provider-fetch.ts:2364)).
- `supports_reasoning` is already honest: it is `true` only when the advertised ladder is non-empty. Generated metadata’s boolean `reasoning` flag is not consulted, and should remain unused here ([models-capabilities.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/server/models-capabilities.ts:118)).

## Diff-level design

### 1. Extend the Cursor capability projection

[src/server/models-capabilities.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/server/models-capabilities.ts:57)

Change the contracts to:

```ts
export interface ModelCapabilityInput {
  reasoningEfforts?: readonly string[];
  contextWindow?: number;
  longContextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: readonly string[];
}

export interface ModelCapabilityFields {
  api_types: readonly string[];
  capabilities: {
    context_length?: number;
    max_output_tokens?: number;
    output_modalities: string[];
    input_modalities?: string[];
    supports_tool_use: true;
    supports_streaming: true;
    supports_reasoning: boolean;
    supports_vision?: boolean;
    reasoning_effort?: string[];
  };
  long_context_threshold_tokens?: number;
  pricing?: { overrides: Array<{ min_prompt_tokens: number }> };
}
```

The exact function signature remains:

```ts
export function modelCapabilityFields(
  input: ModelCapabilityInput,
): ModelCapabilityFields
```

Inside it, add:

```ts
const maxOutputTokens = positiveInt(input.maxOutputTokens);
```

Then emit:

```ts
capabilities: {
  ...(hasLongTier
    ? { context_length: longContextLength }
    : contextLength !== undefined ? { context_length: contextLength } : {}),
  ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
  output_modalities: ["text"],
  // existing fields unchanged
},
...(hasLongTier
  ? {
      long_context_threshold_tokens: contextLength,
      pricing: { overrides: [{ min_prompt_tokens: contextLength }] },
    }
  : {}),
```

Do not add `cost.long_context`: the requested contract is the validated top-level threshold while retaining the existing pricing override.

### 2. Expose native output limits from canonical metadata

[src/codex/catalog/metadata.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/codex/catalog/metadata.ts:266)

Add beside the native context helpers:

```ts
export function nativeOpenAiMaxOutputTokens(slug: string): number | undefined {
  const sourceSlug = nativeOpenAiCapabilitySourceSlug(slug);
  return positiveInt(getModelMetadata("openai", sourceSlug)?.maxTokens);
}
```

This also gives `gpt-daybreak-blue-latest` Sol’s inherited 128k output limit.

Export it through [src/codex/catalog.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/codex/catalog.ts:5):

```ts
nativeOpenAiMaxOutputTokens,
```

Do not edit `src/generated/model-metadata.ts` or its generator; the required column already exists.

### 3. Add output limits to `CatalogModel`

[src/codex/catalog/parsing.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/codex/catalog/parsing.ts:113)

```ts
contextWindow?: number;
maxInputTokens?: number;
/** Model-scoped output-token ceiling; omitted when no authoritative value is known. */
maxOutputTokens?: number;
```

### 4. Carry routed values through provider discovery

[src/codex/catalog/provider-fetch.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/codex/catalog/provider-fetch.ts:566)

Include model-scoped output metadata in the gather fingerprint:

```ts
maxOut: prov.modelMaxOutputTokens ?? null,
```

Add a resolver near the existing configured-limit helpers:

```ts
function generatedMaxOutputTokens(
  providerName: string,
  id: string,
): number | undefined {
  const metadataProvider = resolveMetadataProvider(providerName);
  if (!metadataProvider) return undefined;
  const metadata = getModelMetadata(metadataProvider, id)
    ?? (shouldCaseFoldMetadataModelId(providerName)
      ? getModelMetadataCaseInsensitive(metadataProvider, id)
      : undefined);
  return positiveSafeInteger(metadata?.maxTokens);
}

function routedMaxOutputTokens(
  providerName: string,
  provider: OcxProviderConfig,
  model: CatalogModel,
): number | undefined {
  const discovered = positiveSafeInteger(model.maxOutputTokens);
  const generated = generatedMaxOutputTokens(providerName, model.id);
  const configured = positiveSafeInteger(
    modelRecordValue(provider.modelMaxOutputTokens, model.id),
  );
  const authoritative = discovered ?? generated;
  if (configured === undefined) return authoritative;
  return authoritative === undefined
    ? configured
    : Math.min(authoritative, configured);
}
```

Intentionally exclude `defaultMaxOutputTokens`: it is a request default, not a model-specific ceiling.

In `applyProviderConfigHints`:

```ts
const maxOutputTokens = routedMaxOutputTokens(name, prov, model);
```

and in `hinted`:

```ts
...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
```

In `catalogHintsFromModelsApiItem`, parse only explicit output-limit fields:

```ts
const maxOutputTokens = positiveSafeInteger(
  capabilityRecord?.max_output_tokens,
  limits?.max_output_tokens,
  metadata?.max_output_tokens,
  item.max_output_tokens,
);
```

Return it alongside the existing limits:

```ts
...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
```

When `augmentRoutedModelsWithMetadata` constructs missing jawcode rows, add:

```ts
...(typeof meta.maxTokens === "number" && meta.maxTokens > 0
  ? { maxOutputTokens: meta.maxTokens }
  : {}),
```

For trusted OpenAI API rows, call `routedMaxOutputTokens` using the existing live row as the discovered input and emit the result. Add `maxOutputTokens` to `normalizedOpenAiApiSignature` so metadata collisions remain observable.

For custom-model replacement merging, conservatively take the minimum positive value from `base.maxOutputTokens` and `replaced?.maxOutputTokens`, exactly as `maxInputTokens` is currently merged.

### 5. Preserve output limits through combos

[src/codex/catalog/aggregation.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/codex/catalog/aggregation.ts:122)

A combo has a known output ceiling only when every member has one:

```ts
const knownMaxOutputTokens = members
  .map(member => member.maxOutputTokens)
  .filter((value): value is number => typeof value === "number" && value > 0);
const maxOutputTokens = knownMaxOutputTokens.length === members.length
  ? Math.min(...knownMaxOutputTokens)
  : undefined;
```

Add to the returned row:

```ts
...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
```

In `provider-fetch.ts`, add `maxOutputTokens` to `ComboCatalogMemberFallback`, native synthetic members, native-alias fallback metadata, and `withFallbackMetadata`. A fallback may fill an unknown output limit, but must never replace a smaller discovered one.

### 6. Wire the fields into `/v1/models`

[src/server/index.ts](/Users/jun/.codex/worktrees/4ed0/opencodex/src/server/index.ts:1357)

Add `nativeOpenAiMaxOutputTokens` to the dynamic catalog import.

Native call:

```ts
...modelCapabilityFields({
  reasoningEfforts: nativeReasoningEfforts(metadataId),
  ...nativeContextInput(metadataId),
  maxOutputTokens: nativeOpenAiMaxOutputTokens(metadataId),
  inputModalities: nativeInputModalities(metadataId),
}),
```

Routed call:

```ts
...modelCapabilityFields({
  reasoningEfforts: m.reasoningEfforts,
  contextWindow: m.contextWindow,
  maxOutputTokens: m.maxOutputTokens,
  inputModalities: m.inputModalities,
}),
```

No change to reasoning derivation: neither `cursorEffortFamily()` nor generated `metadata.reasoning` should affect `supports_reasoning`.

## Exact test changes

### `tests/cursor-local-models-schema.test.ts`

Update `capabilityConfig()`:

```ts
modelMaxOutputTokens: { k3: 64_000 },
```

In `a larger opt-in window becomes context_length...`, add:

```ts
expect(tiered.long_context_threshold_tokens).toBe(272000);
expect("long_context_threshold_tokens" in flat).toBe(false);
```

Add test:

```ts
test("max output tokens are sanitized independently of reasoning", () => {
  expect(modelCapabilityFields({ maxOutputTokens: 128000 }).capabilities.max_output_tokens)
    .toBe(128000);
  expect("max_output_tokens" in modelCapabilityFields({ maxOutputTokens: 0 }).capabilities)
    .toBe(false);
  expect(modelCapabilityFields({ maxOutputTokens: 1.9 }).capabilities.supports_reasoning)
    .toBe(false);
});
```

In `routed rows carry api_types...`:

```ts
expect(k3Caps.max_output_tokens).toBe(64_000);
expect(solCaps.max_output_tokens).toBe(128_000);
expect(sol!.long_context_threshold_tokens).toBe(272_000);
expect("max_output_tokens" in plainCaps).toBe(false);
```

### `tests/provider-model-discovery-contract.test.ts`

Extend `accepts only positive safe-integer token limits from live metadata`:

```ts
expect(catalogHintsFromModelsApiItem("example", {
  id: "valid-output",
  capabilities: { max_output_tokens: 8192 },
})).toEqual({ maxOutputTokens: 8192 });

expect(catalogHintsFromModelsApiItem("example", {
  id: "invalid-output",
  capabilities: { max_output_tokens: 0.5 },
})).toEqual({});
```

Also cover `Number.MAX_SAFE_INTEGER + 1`.

### `tests/codex-catalog.test.ts`

In `DeepSeek catalog sync appends V4 rows missing from /v1/models`, assert:

```ts
expect(models.find(model => model.id === "deepseek-v4-flash")?.maxOutputTokens)
  .toBe(384_000);
```

Add:

```ts
test("combo output ceiling is the smallest known member ceiling and stays unknown if any member is unknown", () => {
  const known = deriveComboCatalogModel("known-output", normalizedCombo(), [
    { provider: "a", id: "m1", contextWindow: 128_000, maxOutputTokens: 64_000 },
    { provider: "b", id: "m2", contextWindow: 128_000, maxOutputTokens: 32_000 },
  ]);
  expect(known?.maxOutputTokens).toBe(32_000);

  const partial = deriveComboCatalogModel("partial-output", normalizedCombo(), [
    { provider: "a", id: "m1", contextWindow: 128_000, maxOutputTokens: 64_000 },
    { provider: "b", id: "m2", contextWindow: 128_000 },
  ]);
  expect(partial).not.toHaveProperty("maxOutputTokens");
});
```

### `tests/grok-models-effort-list.test.ts`

Keep all current Grok assertions. In `models with an empty tier list advertise no effort fields`, add:

```ts
const capabilities = plain!.capabilities as Record<string, unknown>;
expect(capabilities.supports_reasoning).toBe(false);
expect("reasoning_effort" in capabilities).toBe(false);
```

This pins the independent Grok/Cursor representations to the same ladder truth.

### `tests/server-combo-failover-e2e.test.ts`

In `ordinary /v1/models restores a non-OpenAI selector...`, add:

```ts
modelMaxOutputTokens: { "deepseek-chat": 64_000 },
```

Extend the response-row type with:

```ts
capabilities?: { max_output_tokens?: number };
```

Assert both the combo alias and restored routed row advertise `64_000`. Existing `toMatchObject` row-literal assertions remain valid because they intentionally match subsets.

## Worker verification

```bash
bun test tests/cursor-local-models-schema.test.ts
bun test tests/provider-model-discovery-contract.test.ts
bun test tests/codex-catalog.test.ts
bun test tests/grok-models-effort-list.test.ts
bun test tests/server-combo-failover-e2e.test.ts
bun run typecheck
bun run test:changed
```

Do not run `bun run test` or bare `bun test`.

## RISKS

- `modelMaxOutputTokens` is currently used as an adapter fallback, not a runtime-enforced hard ceiling. Treating a model-scoped value as an advertised ceiling is conservative when it lowers the generated/live value, but `defaultMaxOutputTokens` must remain excluded.
- Generated metadata can become stale; live explicit capability data should therefore win, with configured values allowed only to narrow.
- Combo propagation must require every member to be known. Taking the minimum of only known members would overstate a route whose unknown target may support less.
- Cursor Private Inference behavior remains statically established, not end-to-end verified against this endpoint.

## OPEN QUESTIONS

- Non-blocking policy choice: should user-supplied `modelMaxOutputTokens` be considered authoritative enough to advertise? Recommendation: yes for the model-scoped map, no for the provider-wide default.
- Should a future phase emit `cost.long_context.threshold_tokens` as well? Recommendation: no in wp2; top-level threshold plus the retained pricing override satisfies the stated schema without inventing cost data.
- A controlled Cursor Private Inference E2E should still verify that the new fields actually render Context/output controls in build 3.18.25.



