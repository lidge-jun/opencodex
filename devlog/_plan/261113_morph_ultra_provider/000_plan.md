# 000 — morph_ultra_provider: Plan

## Objective

Register a new key provider preset `morph` for the Morph Ultra plan on the OpenAI Chat
Completions wire, exposing only Ultra-plan models, with `morph-kimik31` (Kimi K3.1) and
`morph-dsv41flash-1017` (DeepSeek V4.1 Flash, Oct 17 snapshot) as the enabled roster.

Evidence base (researched 2026-11-13, read-only, primary sources):
- https://www.morphllm.com/products/ultra and https://docs.morphllm.com/ultra-plan — Ultra is
  $200/month, no token meter, and covers Kimi K3.1 (`morph-kimik31`), DeepSeek V4.1 Flash
  (`morph-dsv41flash`), its Oct 17 snapshot (`morph-dsv41flash-1017`), and
  `morph-dsv41flash-abliterated` only for accounts approved for privileged access.
- https://docs.morphllm.com/sdk/components/fast-models — OpenAI-compatible base
  `https://api.morphllm.com/v1`, 1,048,576-token context, text+image input, tools,
  `response_format`, streaming, reasoning.
- https://docs.morphllm.com/auth — `Authorization: Bearer <key>`.
- https://docs.morphllm.com/api-reference/endpoint/models — `GET /v1/models` returns the
  OpenAI list shape with ids only.
- Reasoning ladders: `morph-kimik31` accepts none/low/medium/high/xhigh/max;
  `morph-dsv41flash` and `-1017` accept none/low/high/xhigh/max (medium maps to high,
  minimal maps to low).

## Loop-spec

- Loop archetype: verifier-defined (typecheck + focused tests + structure/docs gates).
- Write scope: `src/providers/registry/model-seeds.ts`,
  `src/providers/registry/entries-extended.ts`, `src/usage/expected-prices.ts`,
  `tests/providers/provider-registry-parity.test.ts`, new
  `tests/providers/morph-ultra-provider.test.ts`, `scripts/test-layout/layout.json`,
  `tests/fixtures/test-layout-expected.json`, `structure/providers-and-adapters.md`,
  `structure/ops/docs-and-release.md`, `docs-site/src/content/docs/**/guides/providers.md`,
  `docs-site/src/content/docs/**/getting-started/quickstart.md`.
- Out of scope: the free-directory row (its base URL already matches), OAuth, Responses wire,
  GUI changes, any push/PR.
- Budget: one work phase.

## Work-phase map

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp1 | 010_phase1.md | Registry entry + seeds + prices + tests + docs counts | — |

## Accept criteria

- `morph` resolves through `getProviderRegistryEntry` with base URL
  `https://api.morphllm.com/v1`, adapter `openai-chat`, authKind `key`, and exactly the two
  enabled Ultra models.
- `bun run typecheck` exits 0.
- Focused tests (parity, docs counts, new morph test, test-layout) pass.
- `bun run structure:check` passes.
