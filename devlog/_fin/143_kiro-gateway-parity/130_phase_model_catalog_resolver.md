# Phase 130 (P1) - Kiro model catalog and resolver parity

## Trigger

The external review still flags Kiro model drift and weak model-id handling.
The official Kiro model catalog currently includes models missing from
`src/providers/registry.ts`, and `mapModelId()` only strips a `kiro-` prefix.

Official source checked on 2026-06-29:

- `https://kiro.dev/docs/models`
- The page says it was updated 2026-06-19.
- Missing from the current opencodex Kiro list: Claude Opus 4.5, Claude
  Sonnet 4.0, and MiniMax M2.1.
- Some Claude rows expose `Max` effort, but Codex catalog entries must remain
  Codex-safe (`low`/`medium`/`high`/`xhigh`) because Codex rejects raw `max`.

## Current state

- `src/providers/registry.ts` owns Kiro model arrays inline.
- `src/adapters/kiro-wire.ts` owns the runtime `mapModelId()` helper.
- The registry and adapter do not share a model-normalization source of truth.
- Existing tests only cover the older Kiro model list/context table.

## Diff plan

### ADD `src/providers/kiro-models.ts`

Create the canonical Kiro model metadata module:

- `KIRO_MODELS`
  - `kiro-auto`
  - `claude-opus-4.8`
  - `claude-opus-4.7`
  - `claude-opus-4.6`
  - `claude-opus-4.5`
  - `claude-sonnet-4.6`
  - `claude-sonnet-4.5`
  - `claude-sonnet-4.0`
  - `claude-haiku-4.5`
  - `deepseek-3.2`
  - `minimax-m2.5`
  - `minimax-m2.1`
  - `glm-5`
  - `qwen3-coder-next`
- `KIRO_MODEL_CONTEXT_WINDOWS`
  - Existing 1M/200k/128k/256k values remain.
  - Add 200k entries for Claude Opus 4.5, Claude Sonnet 4.0, and MiniMax M2.1.
  - Keep `kiro-auto` omitted because Kiro Auto has no fixed context window.
- `KIRO_MODEL_REASONING_EFFORTS`
  - Codex-safe efforts for every static Kiro model:
    `["low", "medium", "high", "xhigh"]`.
  - Do not expose raw `max` in catalog metadata.
- `normalizeKiroModelId(id)`
  - Trim/lowercase.
  - Strip provider-ish prefixes: `kiro/` and `kiro-`.
  - Map `kiro-auto` and `auto` to `auto`.
  - Strip trailing date suffixes like `-20250929`.
  - Strip trailing effort suffixes: `-low`, `-medium`, `-high`, `-xhigh`,
    `-max`.
  - Convert dashed numeric versions to dotted versions:
    `4-5` -> `4.5`, `m2-1` -> `m2.1`.
  - Reorder Claude family aliases:
    `claude-4.5-sonnet` -> `claude-sonnet-4.5`.
  - Return the normalized id for known and version-normalized ids; leave
    unknown non-matching strings unchanged.

### MODIFY `src/providers/registry.ts`

- Remove inline Kiro model arrays/context maps.
- Import `KIRO_MODELS`, `KIRO_MODEL_CONTEXT_WINDOWS`, and
  `KIRO_MODEL_REASONING_EFFORTS`.
- Keep Kiro `defaultModel: "kiro-auto"`.
- Keep catalog-visible reasoning tiers Codex-safe; no raw `max`.
- Keep Kiro image/native vision behavior out of this phase. Native image
  payloads are already implemented in Phase 10; this phase only resolves model
  catalog drift and model id normalization.

### MODIFY `src/adapters/kiro-wire.ts`

- Import `normalizeKiroModelId` from `src/providers/kiro-models.ts`.
- Change `mapModelId(id)` to use the shared normalizer:
  - `kiro-auto` / `auto` -> `auto`
  - otherwise return `normalizeKiroModelId(id)`.

### MODIFY `tests/kiro-adapter.test.ts`

Add/update regression coverage:

- Registry contains the official missing models:
  - `claude-opus-4.5`
  - `claude-sonnet-4.0`
  - `minimax-m2.1`
- Context windows contain the new documented entries.
- Auto remains omitted from `modelContextWindows`.
- Reasoning efforts stay Codex-safe for Kiro models and never include raw
  `max`.
- `buildRequest()` maps versioned/aliased ids into Kiro payload `modelId`:
  - `kiro-auto` -> `auto`
  - `claude-sonnet-4-5-20250929` -> `claude-sonnet-4.5`
  - `claude-4.5-sonnet-high` -> `claude-sonnet-4.5`
  - `minimax-m2-1` -> `minimax-m2.1`

### MODIFY `tests/token-estimate.test.ts`

- Add at least one newly added Kiro model to the Kiro token-estimate ratio
  table so model-list drift does not silently miss the sidecar.

## Verification

- `bun x tsc --noEmit`
- `bun test tests/kiro-adapter.test.ts tests/token-estimate.test.ts tests/provider-registry-parity.test.ts tests/router.test.ts`
- `wc -l src/providers/kiro-models.ts src/providers/registry.ts src/adapters/kiro-wire.ts tests/kiro-adapter.test.ts tests/token-estimate.test.ts`

## Commit

`fix(kiro): reconcile model catalog and aliases`

## Explicit non-goals

- No live/account-aware Kiro model discovery cache. The user explicitly
  deprioritized multi-account/failover complexity; static official-model
  reconciliation plus deterministic aliases is the scoped fix.
- No raw `max` catalog value because Codex catalog sanitization rejects it.
- No runtime API call to Kiro for model availability; account/tier/region
  availability can still vary and remains a documented limitation.
- No new image-modality matrix. Phase 10 already sends images natively; public
  Kiro docs do not provide a complete per-model modality table for this phase.

## Completion evidence

- Implemented in `0b8d95c`:
  - Added `src/providers/kiro-models.ts` as the shared Kiro model metadata and
    normalization owner.
  - Updated `src/providers/registry.ts` to consume the shared Kiro model list,
    context windows, and Codex-safe reasoning efforts.
  - Updated `src/adapters/kiro-wire.ts` so runtime wire model ids use the same
    normalizer as the catalog.
  - Added regression coverage in `tests/kiro-adapter.test.ts` and
    `tests/token-estimate.test.ts`.
- Re-verified on 2026-06-29:
  - `bun x tsc --noEmit` passed.
  - `bun test tests/kiro-adapter.test.ts tests/token-estimate.test.ts tests/provider-registry-parity.test.ts tests/router.test.ts tests/openai-chat-model-suffix.test.ts`
    passed: 50 tests.
  - The files that failed during a broad parallel `bun test tests/*.test.ts`
    run all passed in isolation:
    `tests/codex-routing.test.ts`, `tests/codex-account-store.test.ts`,
    `tests/codex-auth-api.test.ts`, `tests/server-auth.test.ts`, and
    `tests/api-usage.test.ts`.
- Check verdict: Phase 130 changes are clean. The broad parallel-suite failure
  is tracked as test isolation/shared-state behavior, not as a Kiro model
  resolver regression.
