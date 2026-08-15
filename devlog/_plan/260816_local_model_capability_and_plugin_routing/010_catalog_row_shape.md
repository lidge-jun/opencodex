# 010 — Phase 1: give the catalog explicit capability provenance

Diff-level implementation doc. Research: `001_capability_evidence_defect.md`.
**Revised after audit round 1** — see `003_audit_synthesis_round1.md`. The first
draft proposed reading the catalog's `context_window`/`input_modalities`
directly. That was rejected: those fields are synthesized for Codex's strict
parser, so reading them turns unknown into a false negative (B2), and matching
a row disarms the tool-capability fallback (B1).

## Goal

A model whose only evidence source is the catalog must carry its REAL
contextWindow and image evidence — and only when that evidence is real. A
synthesized compatibility default must stay unknown, and no dimension that is
correct today may regress.

## Why not read context_window / input_modalities

`ensureStrictCatalogFields()` fills those fields so Codex's parser accepts the
file, whether or not any provider asserted them:

    // src/codex/catalog/parsing.ts:315
    if (!Array.isArray(entry.input_modalities) && !options.preserveExactInputModalities) {
      entry.input_modalities = ["text"];
    }
    // src/codex/catalog/parsing.ts:328
    const contextWindow = typeof entry.context_window === "number" && entry.context_window > 0 ? entry.context_window : 128000;

Every row therefore has both fields, and their presence says nothing about what
is known. Routing must distinguish "the provider said text-only" from "nobody
said anything", so it needs a separate channel.

## Scope boundary

IN: the provenance stamp in `src/codex/catalog/effort.ts`, the reader in
`src/routing/capability.ts`, one new focused test.
OUT: the evidence priority order, the memoization strategy, the policy
evaluator, reasoning-effort ingestion, and every other module.

## File change map

| Path | Action | What |
|------|--------|------|
| `src/codex/catalog/effort.ts` | MODIFY | Stamp `opencodex_capability_provenance` when real values are applied |
| `src/routing/capability.ts` | MODIFY | Read the provenance block; make the adapter tool fallback unconditional |
| `tests/routing-capability-catalog.test.ts` | NEW | Real evidence survives; synthesized defaults stay unknown; tools never regresses |

## MODIFY 1 — src/codex/catalog/effort.ts

`applyCatalogModelMetadata()` is the only place that knows a value came from a
real `CatalogModel`: it writes exclusively inside guarded blocks that test the
model's own fields. Stamp provenance there.

Existing shape (unchanged):

    if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
      entry.context_window = model.contextWindow;
      entry.max_context_window = model.contextWindow;
      ...
    }
    if (Array.isArray(model.inputModalities) && model.inputModalities.length > 0) {
      entry.input_modalities = model.inputModalities;
    }

Added at the end of the function:

    // Routing evidence provenance. ensureStrictCatalogFields() later fills
    // context_window/input_modalities with compatibility defaults for Codex's
    // strict parser, so their presence cannot distinguish a real provider
    // assertion from a synthesized placeholder. These keys record only what a
    // CatalogModel actually asserted; src/routing/capability.ts reads them and
    // nothing else, which is what keeps "unknown is not zero" true.
    const provenance: Record<string, unknown> = { provider: model.provider, model_id: model.id };
    if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
      provenance.context_window = model.contextWindow;
    }
    if (Array.isArray(model.inputModalities) && model.inputModalities.length > 0) {
      provenance.input_modalities = model.inputModalities;
    }
    if (Array.isArray(model.capabilities) && model.capabilities.length > 0) {
      provenance.capabilities = model.capabilities;
    }
    entry.opencodex_capability_provenance = provenance;

`provider`/`model_id` are always stamped: they are the exact-identity match
that closes the slug-collision hole (B4).

B must confirm the key survives `ensureStrictCatalogFields` and
`normalizeServiceTiers` (neither strips unknown keys today —
`opencodex_catalog_kind` already depends on this, src/codex/catalog/sync.ts:371)
and that Codex's strict parse accepts an extra object-valued key. If it does
not, the fallback is a flat JSON string under the same prefix; B records which
was used.

## MODIFY 2 — src/routing/capability.ts

### 2a. Row type

Before:

    type CatalogModelRow = {
      provider: string;
      id: string;
      contextWindow?: number;
      inputModalities?: string[];
      reasoningEfforts?: string[];
      capabilities?: string[];
    };

After:

    type CatalogModelRow = {
      /** Exact provider/native-id identity, from the provenance block. */
      provider: string;
      id: string;
      /** Only values a CatalogModel asserted; never a strict-parser default. */
      contextWindow?: number;
      inputModalities?: string[];
      capabilities?: string[];
    };

`reasoningEfforts` is dropped: the catalog writes `supported_reasoning_levels`
as `{effort, description}` objects and this unit adds no mapping. Its absence
is today's behavior, so nothing regresses.

### 2b. Projection — read the provenance block

Before (the filter that discards all 17 rows):

    const rows = models
      .filter((model): model is Record<string, unknown> & { id: string; provider: string } =>
        typeof model === "object" && model !== null && typeof model.id === "string" && typeof model.provider === "string")
      .map(model => ({
        provider: model.provider,
        id: model.id,
        ...

After:

    const rows = models.flatMap(model => {
      if (typeof model !== "object" || model === null) return [];
      const provenance = (model as Record<string, unknown>).opencodex_capability_provenance;
      if (typeof provenance !== "object" || provenance === null) return [];
      const p = provenance as Record<string, unknown>;
      if (typeof p.provider !== "string" || typeof p.model_id !== "string") return [];
      return [{
        provider: p.provider,
        id: p.model_id,
        ...(typeof p.context_window === "number" && p.context_window > 0
          ? { contextWindow: p.context_window }
          : {}),
        ...(Array.isArray(p.input_modalities)
          ? { inputModalities: p.input_modalities.filter((value): value is string => typeof value === "string") }
          : {}),
        ...(Array.isArray(p.capabilities)
          ? { capabilities: p.capabilities.filter((value): value is string => typeof value === "string") }
          : {}),
      }];
    });

A row without provenance contributes nothing — exactly today's behavior for
every row — so this can only add evidence, never remove it.

### 2c. Lookup — unchanged

    const catalogRow = cachedCatalogModels().find(model => model.provider === providerName && model.id === modelId);

The provenance block stores the exact native provider/model_id, so the existing
equality lookup is already correct. No slug decoding, no new import, and the B4
collision risk disappears rather than being mitigated.

### 2d. Keep the adapter tool fallback unconditional (B1)

Before:

    const tools = capabilities.includes("tools")
      || isNative
      || (catalogRow === undefined && provider !== undefined && TOOL_CAPABLE_ADAPTERS.has(provider.adapter))
      || provider?.parallelToolCalls === true
      || undefined;

After:

    const tools = capabilities.includes("tools")
      || isNative
      // The adapter protocol is positive evidence on its own. This was gated on
      // `catalogRow === undefined`, which was safe only while the catalog lookup
      // never matched: once it matches, a row that simply does not enumerate
      // "tools" would silently revoke tool support for every openai-chat and
      // anthropic candidate.
      || (provider !== undefined && TOOL_CAPABLE_ADAPTERS.has(provider.adapter))
      || provider?.parallelToolCalls === true
      || undefined;

A strict widening of a positive signal. `capabilities` stays positive-only, so
nothing can turn `tools` false.

### Import-boundary check

No new import is added, so the import graph is unchanged.
`tests/core-lab-boundary.test.ts` (13 pass pre-change) must still be re-run.

## NEW tests/routing-capability-catalog.test.ts

Writes a temporary catalog file and points the catalog path at it. B confirms
the path-override mechanism used by existing catalog tests before writing, and
amends this doc if it differs.

    test("carries asserted context window and image modality from a catalog-only model", () => {
      // Provider config declares NO modelContextWindows / modelInputModalities,
      // so the provenance block is the only possible evidence source.
      const evidence = candidateCapabilityEvidence(config, "lidge", "qwen3.8-27b-nvfp4");
      expect(evidence.contextWindow).toBe(262144);
      expect(evidence.image).toBe(true);
    });

    test("a synthesized strict-parser default stays unknown (B2)", () => {
      // Row written with context_window 128000 and input_modalities ["text"]
      // by ensureStrictCatalogFields, but no provenance for either field.
      const evidence = candidateCapabilityEvidence(config, "demo", "unknown-model");
      expect(evidence.contextWindow).toBeUndefined();
      expect(evidence.image).toBeUndefined();   // never false
    });

    test("matching a catalog row does not revoke adapter tool support (B1)", () => {
      const evidence = candidateCapabilityEvidence(config, "lidge", "qwen3.8-27b-nvfp4");
      expect(evidence.tools).toBe(true);
    });

    test("exact identity is not confused by slug collision (B4)", () => {
      // Native ids "a/b" and "a-b" both encode to the slug "p/a-b".
      expect(candidateCapabilityEvidence(config, "p", "a/b").contextWindow).toBe(111000);
      expect(candidateCapabilityEvidence(config, "p", "a-b").contextWindow).toBe(222000);
    });

## Accept criteria

1. Test 1 FAILS on the current tree and PASSES after the change; both runs
   recorded (C-ACTIVATION-GROUNDING-01).
2. Test 2 asserts undefined, never false — the B2 contract.
3. Test 3 passes before AND after: it proves the fix does not introduce the
   regression the audit predicted.
4. `bun x tsc --noEmit` clean.
5. `tests/core-lab-boundary.test.ts` green.
6. Remote exact-head suite green on lidge (command in the section below).

## Verifier commands (PLAN-VERIFIER-REAL-01)

| Command | Reads this change? | Notes |
|---------|-------------------|-------|
| `bun run test tests/routing-capability-catalog.test.ts` | YES — the file under test is the direct argument | Bare `bun test` bypasses the wrapper and fails test-home-guard (B6) |
| `bun x tsc --noEmit` | YES — tsconfig include covers `src/**` | Verified exit 0 pre-change |
| `bun run test tests/core-lab-boundary.test.ts` | YES — walks the import graph from `src/router.ts` into `src/routing/capability.ts` | Verified 13 pass pre-change |
| Remote exact-head suite (command below) | YES — shared routing surface | Required: shared surface |

## Field chain (PLAN-FIELD-CHAIN-01)

| Stage | Path | State after this phase |
|-------|------|------------------------|
| creation | `src/cli/models.ts` (`ocx models add`) / provider discovery | unchanged |
| serialization | `applyCatalogModelMetadata`, src/codex/catalog/effort.ts:113 | NEW provenance key |
| deserialization | `cachedCatalogModels`, src/routing/capability.ts:45 | reads provenance only |
| consumers | `candidateCapabilityEvidence` -> `src/routing/evaluator.ts` | receives real evidence; unknown stays unknown |

No other consumer reads `CatalogModelRow`: it is a module-local type
(src/routing/capability.ts:28) with no export.

## Bypass record (PLAN-BYPASS-NAMED-01)

No enforcement added; this repairs a data path. Tier: N/A. Executing surface:
none. Known bypass: a CatalogModel carrying no context/modality still yields
unknown evidence — by design. Residual risk: provenance is written by exactly
one function, so a future writer bypassing `applyCatalogModelMetadata` would
produce rows routing cannot read. The new tests are the early warning, not
enforcement. Final enforcement layer: none.

## Remote exact-head suite (B6/round-2 B2)

Pushing a branch updates a remote ref, not a remote checkout. Audit round 2
confirmed all three lidge checkouts sat on unrelated commits. The verifier must
therefore fetch and assert the SHA before running:

    LOCAL_SHA=$(git rev-parse HEAD)
    ssh lidge "cd ~/ocx-ci/opencodex \\
      && git fetch --quiet csa906 <branch> \\
      && git checkout --quiet --detach FETCH_HEAD \\
      && test \"\$(git rev-parse HEAD)\" = \"$LOCAL_SHA\" \\
      && bun install --frozen-lockfile \\
      && bun run test"

The `test` comparison is the gate: a mismatched checkout fails the command
instead of silently reporting a green suite for different code. `~/ocx-ci/opencodex`
is the chosen checkout (verified present, `origin` = lidge-jun/opencodex, on `dev`);
the push remote `csa906` must be added there if absent.
