# 010 — Configured native GPT models (plan)

## Problem

Claude models on the Anthropic provider load from config: listing `claude-opus-5-5` under
`providers.anthropic.models` (plus optional `modelContextWindows`) is enough, and live discovery
fills in the rest. Native GPT models on the ChatGPT/Codex login do not. Every native slug is
hard-coded in `src/codex/catalog/native-models.ts` (`NATIVE_OPENAI_MODELS`), and the four GPT-6
rows each repeat the literal 272,000 / 872,000 context pair in `NATIVE_OPENAI_CONTEXT_OVERRIDES`.
Adding GPT-6 Sol and Luna took #5580 (763 lines). `providers.openai.models` is ignored for the
forward provider (`provider-models.ts` returns `[]` for `authMode: "forward"`).

Routing already works: `router.ts` sends any bare `gpt-*` id down the `native-family` route. What
is missing is the catalog: the id is dropped by `isUnsupportedOpenAiNativeSlug` and gets no
capabilities or context.

## Contract

A bare id listed under `providers.openai.models` becomes a *configured native* when:

- `providers.openai` exists, is not disabled, and is the canonical Codex forward provider
  (adapter `openai-responses`, authMode `forward` or omitted, canonical Codex base URL);
- the id matches `^gpt-[a-z0-9][a-z0-9.-]*$` (no `/`);
- it is not built in, not retired (`RETIRED_NATIVE_OPENAI_MODELS`), and not `gpt-reserve`.

A configured native:

- joins `NATIVE_OPENAI_MODELS` / `SUPPORTED_NATIVE_OPENAI_SLUGS`, so the canonical catalog backfill,
  `/v1/models`, dashboard native rows and desktop projections list it. It is never account-gated.
- inherits capability metadata from its own pinned upstream row when one exists, otherwise from
  the pinned `gpt-6-sol` row (reasoning ladder, modalities, instructions, speed tiers). The display
  name comes from the slug (`gpt-6-nova` -> `GPT-6-Nova`); instructions are retargeted with
  `identifyRoutedModel`.
- uses the GPT-6 family context default: 272,000 window, 872,000 opt-in ceiling, 872,000 max input
  (clamped to the resolved window). `providers.openai.modelContextWindows[id]`, `contextWindow`
  and `providerContextCaps.openai` apply unchanged through `narrowToLimits`.
- Removing the id from config unregisters it; the persisted catalog row then counts as unsupported
  and is dropped on the next canonical write, like any other unsupported native.

## Diff-level changes

1. `src/codex/catalog/native-models.ts`: mutable `NATIVE_OPENAI_MODELS` seeded from a frozen built-in
   list; `NATIVE_GPT6_CONTEXT`; `CONFIGURED_NATIVE_OPENAI_TEMPLATE_MODEL = "gpt-6-sol"`;
   `configuredNativeOpenAiModelIds(config)` (pure filter), `setConfiguredNativeOpenAiModels(ids)`
   (diff-applies, notifies), `configuredNativeOpenAiModels()`, `isConfiguredNativeOpenAiModel()`,
   `subscribeConfiguredNativeOpenAiModels()` (fires immediately), `refreshConfiguredNativeOpenAiModels(config)`.
   `nativeOpenAiCapabilitySourceSlug` maps a configured slug to itself when pinned, else to the
   template; alias check and presentation cover template-borrowing configured slugs.
2. `src/codex/catalog/metadata.ts`: GPT-6 overrides spread `NATIVE_GPT6_CONTEXT`;
   `upstreamNativeEntryForSlug` admits configured slugs; a subscription after
   `UPSTREAM_NATIVE_ENTRIES` keeps `PINNED_NATIVE_CAPABILITY_ENTRIES`, `UPSTREAM_NATIVE_ENTRIES` and
   `NATIVE_OPENAI_CONTEXT_OVERRIDES` in step; `nativeOpenAiSlugs` / `listCatalogNativeSlugs` include
   configured ids.
3. `src/codex/catalog/build-entries.ts`: `CANONICAL_NATIVE_CATALOG_CONTENT_POLICY.nativeBackfillSlugs`
   becomes a getter over the current list.
4. `src/vision/reasoning.ts`: consult `SUPPORTED_NATIVE_OPENAI_SLUGS` at call time.
5. New `src/config/derived-registries.ts`: `refreshConfigDerivedRegistries(config)` runs
   `refreshUserCostOverlays` then `refreshConfiguredNativeOpenAiModels`, replacing the
   `refreshUserCostOverlays` calls in `config.ts` (line count unchanged), `config/load-degrade.ts`,
   `config/persist-unlocked.ts` and `usage/user-cost-overlay-reconciler.ts`, so load, save and
   external-edit reconcile all register.
6. Tests: new `tests/codex-integration/configured-native-models.test.ts` (registered in layout.json
   and test-layout-expected.json).
7. Docs: `structure/catalog.md` and docs-site `reference/configuration/providers.md`.

## Out of scope

Routing, account gating, bare listing of unknown roster observations, prices, GUI, API-key rows.

## Verification

`bun run typecheck`; the new test file plus `gpt6-native-rows.test.ts`, `native-model-toggle.test.ts`,
layout and file-size guards; `bun run test:changed`; `bun run structure:check`; `git diff --check`;
then exact-head hosted CI on the PR.

## HOTL bounds

Write scope: files above plus this devlog unit. Tools: local git/bun, gh for one PR to dev.
Merge only after exact-head required CI succeeds.
