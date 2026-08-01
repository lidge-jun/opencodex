# 000 — Fix gpt-5.3-codex-spark upstream `all_turns` rejection

## Objective

Spark (`gpt-5.3-codex-spark`) errors with `'all_turns' is not supported` because
it inherits `use_responses_lite: true` from its 5.6 template in `catalog.ts deriveEntry()`.
codex-rs reads that flag and injects `reasoning.context: "all_turns"` into the wire
request — spark's backend only supports `"auto"` and `"current_turn"`.

## Root cause chain

1. Spark is NOT in `upstream-models.json` → `upstreamNativeEntry()` returns null
2. `deriveEntry()` falls to template clone (template = gpt-5.6-sol with `use_responses_lite: true`)
3. For non-routed native (`else` branch ~line 852), no lite-flag strip happens
   (unlike routed models which get `normalizeRoutedCatalogEntry()` → deletes `use_responses_lite`)
4. codex-rs sees `use_responses_lite: true` → sends `reasoning.context: "all_turns"`
5. Spark backend rejects → HTTP 400

## Fix plan (single work-phase)

### Fix 1 — Root cause in catalog.ts (MODIFY)

**File:** `src/codex/catalog.ts`
**Location:** `deriveEntry()`, non-routed native branch (~line 852)

After `applyNativeOpenAiContextOverride(e)` and the 5.6/non-5.6 reasoning-level
divergence, add a guard for non-5.6 natives that strips lite-only flags.

### Fix 2 — Defense in passthrough adapter (MODIFY)

**File:** `src/adapters/openai-responses.ts`

Add a strip function that drops `reasoning.context` when `"all_turns"` for spark.
Wire into `buildRequest` chain.

## Accept criteria

- `bun run tsc` passes
- Existing tests pass
- `ocx sync` regenerates catalogs with spark having `use_responses_lite` absent/false
- A dispatched spark subagent does NOT get a 400 for `all_turns`

## Scope

**IN:** `src/codex/catalog.ts`, `src/adapters/openai-responses.ts`, catalog sync
**OUT:** codex-rs changes, codexclaw skill changes
