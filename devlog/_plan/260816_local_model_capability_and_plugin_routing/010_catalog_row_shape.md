# 010 — Phase 1: read the catalog in the shape it is written

Diff-level implementation doc. Research: `001_capability_evidence_defect.md`.

## Goal

`cachedCatalogModels()` must project the on-disk catalog rows it actually
receives (`slug`, `context_window`, `input_modalities`) instead of a field
shape nothing writes. After this phase, a model whose only evidence source is
the catalog carries its real `contextWindow` and `image` evidence.

## Scope boundary

IN: `src/routing/capability.ts`, one new focused test file.
OUT: the evidence priority order (catalog stays the fourth fallback), the
"unknown is not zero" contract, the memoization strategy, the policy
evaluator, and every other module.

## File change map

| Path | Action | What |
|------|--------|------|
| `src/routing/capability.ts` | MODIFY | Parse `slug`/`context_window`/`input_modalities`; match rows by slug equivalence |
| `tests/routing-capability-catalog.test.ts` | NEW | Regression: catalog-only evidence survives assembly |

## MODIFY `src/routing/capability.ts`

### 1. Row type — carry the slug, not a split identity

Before:

```ts
type CatalogModelRow = {
  provider: string;
  id: string;
  contextWindow?: number;
  inputModalities?: string[];
  reasoningEfforts?: string[];
  capabilities?: string[];
};
```

After:

```ts
type CatalogModelRow = {
  /** Codex-facing routed slug exactly as written to the catalog file. */
  slug: string;
  contextWindow?: number;
  inputModalities?: string[];
  reasoningEfforts?: string[];
  capabilities?: string[];
};
```

Rationale: the catalog's identity field is the combined `slug`. Splitting it
back into `provider`/`id` here would have to re-implement the slug codec's
decode rules; comparing slugs with the codec's own equivalence helper cannot
drift from it.

### 2. Projection — read the written keys

Before (the filter that discards all 17 rows):

```ts
    const rows = models
      .filter((model): model is Record<string, unknown> & { id: string; provider: string } =>
        typeof model === "object" && model !== null && typeof model.id === "string" && typeof model.provider === "string")
      .map(model => ({
        provider: model.provider,
        id: model.id,
        ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
        ...(Array.isArray(model.inputModalities)
          ? { inputModalities: model.inputModalities.filter((value): value is string => typeof value === "string") }
          : {}),
```

After:

```ts
    const rows = models
      .filter((model): model is Record<string, unknown> & { slug: string } =>
        typeof model === "object" && model !== null && typeof model.slug === "string" && model.slug.length > 0)
      .map(model => ({
        slug: model.slug,
        ...(typeof model.context_window === "number" ? { contextWindow: model.context_window } : {}),
        ...(Array.isArray(model.input_modalities)
          ? { inputModalities: model.input_modalities.filter((value): value is string => typeof value === "string") }
          : {}),
```

`reasoningEfforts` and `capabilities` keep their existing guarded spreads.
They are read from `supported_reasoning_levels` only if a later phase proves
the shape; this phase does NOT invent a mapping for them, because the catalog
writes them as objects (`{ effort, description }`), not strings. Leaving them
absent preserves "unknown is not zero" — it does not regress today's
behavior, since today they are absent too.

### 3. Lookup — slug equivalence, not field equality

Before:

```ts
  const catalogRow = cachedCatalogModels().find(model => model.provider === providerName && model.id === modelId);
```

After:

```ts
  const candidateSlug = routedSlug(providerName, modelId);
  const catalogRow = cachedCatalogModels().find(model => slugsEquivalent(model.slug, candidateSlug));
```

New import:

```ts
import { routedSlug, slugsEquivalent } from "../providers/slug-codec";
```

`slugsEquivalent` handles the raw/encoded mix, so a native id containing "/"
(`zenmux/moonshotai/kimi-k3-free` → catalog slug
`zenmux/moonshotai-kimi-k3-free`) matches without a blind string replace.

### Import-boundary check

`src/providers/slug-codec.ts` imports nothing (pure string functions), so it
cannot pull `src/lab/` into `src/router.ts`. `tests/core-lab-boundary.test.ts`
is the gate that proves this and must stay green.

### Performance

Unchanged: the same one-time parse, the same path+mtime memo, one `routedSlug`
call per candidate (a string concat).

## NEW `tests/routing-capability-catalog.test.ts`

Writes a temporary catalog file in the real on-disk shape, points the catalog
path at it, and asserts assembly:

```ts
import { describe, expect, test } from "bun:test";

describe("candidateCapabilityEvidence catalog rows", () => {
  test("carries context window and image modality from a catalog-only model", () => {
    // config declares the provider but NO modelContextWindows / modelInputModalities,
    // so the catalog row is the only possible evidence source.
    const evidence = candidateCapabilityEvidence(config, "lidge", "qwen3.8-27b-nvfp4");
    expect(evidence.contextWindow).toBe(262144);
    expect(evidence.image).toBe(true);
  });

  test("matches a routed slug whose native id contains a slash", () => {
    // catalog slug "zenmux/moonshotai-kimi-k3-free" vs native id "moonshotai/kimi-k3-free"
    const evidence = candidateCapabilityEvidence(config, "zenmux", "moonshotai/kimi-k3-free");
    expect(evidence.contextWindow).toBe(200000);
  });

  test("leaves a dimension unknown when the catalog omits it", () => {
    // "unknown is not zero": a row without input_modalities must not assert image:false
    const evidence = candidateCapabilityEvidence(config, "lidge", "text-only-model");
    expect(evidence.image).toBeUndefined();
  });
});
```

The catalog path helper (`readCodexCatalogPath`) resolves from environment
state; the test overrides it through the same mechanism existing catalog
tests use — B confirms that mechanism against `tests/` before writing the
file, and amends this doc if it differs.

## Accept criteria

1. The new test FAILS on the current tree (evidence lacks `contextWindow` and
   `image`) and PASSES after the projection change. Recording both runs is the
   activation evidence required by C-ACTIVATION-GROUNDING-01 — the failing-first
   run is what proves the test observes the defect rather than passing vacuously.
2. `bun x tsc --noEmit` clean.
3. `tests/core-lab-boundary.test.ts` green (import boundary unbroken).
4. Full suite green via `ssh lidge` (shared routing surface).
5. The "unknown" case asserts `undefined`, never `false`.

## Verifier commands (PLAN-VERIFIER-REAL-01)

| Command | Reads this change? | Notes |
|---------|-------------------|-------|
| `bun test tests/routing-capability-catalog.test.ts` | YES — the file under test is the direct argument | New file; verified to exist after B |
| `bun x tsc --noEmit` | YES — `tsconfig.json` `include` covers `src/**` | Confirmed: repo-wide strict pass |
| `bun test tests/core-lab-boundary.test.ts` | YES — walks the import graph from `src/router.ts`, which reaches `src/routing/capability.ts` | Guards the new import |

## Bypass record (PLAN-BYPASS-NAMED-01)

This phase adds no enforcement layer; it repairs a data path. Tier: N/A.
Executing surface: none. Known bypass: N/A. Residual risk: a future catalog
schema change could desynchronize reader and writer again — the new test is
the early warning, not enforcement. Final enforcement layer: none.
