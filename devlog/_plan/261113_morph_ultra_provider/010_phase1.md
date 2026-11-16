# 010 — Phase 1 (morph_ultra_provider)

## MODIFY / NEW / DELETE map

### MODIFY `src/providers/registry/model-seeds.ts`

Append after the StepFun seeds (end of file):

```ts
// Morph Ultra plan (https://www.morphllm.com/products/ultra, verified 2026-11-13). The plan
// removes the token meter on Kimi K3.1 and DeepSeek V4.1 Flash; every other Morph model bills
// per token, so only Ultra rows are seeded. `morph-dsv41flash-abliterated` is Ultra-covered
// only for accounts approved for privileged access (403 otherwise) and is therefore not seeded.
export const MORPH_ULTRA_MODELS = ["morph-kimik31", "morph-dsv41flash-1017"];
export const MORPH_ULTRA_CONTEXT_WINDOW = 1_048_576;
export const MORPH_ULTRA_MODEL_CONTEXT_WINDOWS: Record<string, number> = Object.fromEntries(
  MORPH_ULTRA_MODELS.map(id => [id, MORPH_ULTRA_CONTEXT_WINDOW]),
);
export const MORPH_ULTRA_MODEL_INPUT_MODALITIES: Record<string, string[]> = Object.fromEntries(
  MORPH_ULTRA_MODELS.map(id => [id, ["text", "image"]]),
);
// Kimi K3.1 documents none/low/medium/high/xhigh/max; DeepSeek V4.1 Flash documents
// none/low/high/xhigh/max and folds medium into high.
export const MORPH_ULTRA_REASONING_EFFORTS: Record<string, string[]> = {
  "morph-kimik31": ["none", "low", "medium", "high", "xhigh", "max"],
  "morph-dsv41flash-1017": ["none", "low", "high", "xhigh", "max"],
};
export const MORPH_ULTRA_REASONING_EFFORT_MAPS: Record<string, Record<string, string>> = {
  "morph-dsv41flash-1017": { minimal: "low", medium: "high" },
};
```

### MODIFY `src/providers/registry/entries-extended.ts`

1. Add the five new names to the `model-seeds` import block (place them after
   `STEPFUN_REASONING_EFFORTS`).
2. Insert a new entry between the `moonshot` entry and the `huggingface` entry:

```ts
  {
    // Morph Ultra plan (https://www.morphllm.com/products/ultra, verified 2026-11-13): one
    // subscription, no token meter, on Kimi K3.1 and DeepSeek V4.1 Flash. Only those Ultra rows
    // are seeded — every other Morph model bills per token, and the abliterated variant needs
    // privileged-access approval. Discovery stays off so the picker cannot re-add per-token rows.
    id: "morph", label: "Morph (Ultra plan)", baseUrl: "https://api.morphllm.com/v1",
    adapter: "openai-chat", authKind: "key",
    dashboardUrl: "https://www.morphllm.com/dashboard/api-keys",
    defaultModel: "morph-dsv41flash-1017",
    models: MORPH_ULTRA_MODELS,
    liveModels: false,
    modelContextWindows: MORPH_ULTRA_MODEL_CONTEXT_WINDOWS,
    modelInputModalities: MORPH_ULTRA_MODEL_INPUT_MODALITIES,
    modelReasoningEfforts: MORPH_ULTRA_REASONING_EFFORTS,
    modelReasoningEffortMap: MORPH_ULTRA_REASONING_EFFORT_MAPS,
    note: "...",
  },
```

### MODIFY `src/usage/expected-prices.ts`

Add a `MORPH_ULTRA_PRICING` source constant and two `verified-derived` overlay rows
(`morph/morph-kimik31` 2.50/14.00/0.29/0, `morph/morph-dsv41flash-1017` 0.12/0.80/0.008/0),
noting the Ultra subscription bills no per-token rate and these are list-price estimates.

### MODIFY `tests/providers/provider-registry-parity.test.ts`

Add `"morph"` after `"moonshot"` in `EXPECTED_KEY_PROVIDER_IDS`.

### NEW `tests/providers/morph-ultra-provider.test.ts`

Cases: registry row shape; exactly the two Ultra models; 1M window and text+image; reasoning
ladders and the DeepSeek medium->high map; discovery off; price overlays resolve; routing
`morph/morph-kimik31` keeps the destination.

### MODIFY `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`

Register `morph-ultra-provider.test.ts` -> `providers`.

### MODIFY docs and structure

- `docs-site/src/content/docs/guides/providers.md`: 103 -> 104, 84 -> 85; add a Morph row to
  the endpoint table and a short Ultra paragraph.
- The seven translated guides and eight quickstarts: same count bump.
- `structure/ops/docs-and-release.md`: "103 total: 84 key-based" -> "104 total: 85 key-based".
- `structure/providers-and-adapters.md`: note the Morph preset's Ultra-only roster.

## TESTS

`tests/providers/morph-ultra-provider.test.ts` (new), plus the existing parity and docs-count
suites.

## Verification (C)

- `bun run typecheck` -> exit 0
- `bun test tests/providers/morph-ultra-provider.test.ts tests/providers/provider-registry-parity.test.ts tests/ci-workflows/docs-provider-preset-counts.test.ts tests/test-layout.test.ts` -> exit 0
- `bun run structure:check` -> exit 0
