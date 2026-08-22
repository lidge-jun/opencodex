# 070 — Issue #907: stale jawcode prices for gpt-5.6-terra/luna

Independent lane. Research: explorer batch F. Authority note: the generated
artifact must not be hand-edited (`src/generated/jawcode-model-metadata.ts:2`);
the source of truth is the EXTERNAL jawcode checkout — writing it needs the
user's repo, so this phase has a two-repo write boundary (see below).

## Verified current state

- `src/generated/jawcode-model-metadata.ts:47`: Luna `1/6/0.1/1.25`, Terra
  `2.5/15/0.25/3.125` (pre-cut).
- Generator: `scripts/generate-jawcode-metadata.ts:22` —
  `JAWCODE_MODELS_JSON` or `../jawcode/packages/ai/src/models.json`; copies
  cost fields untransformed (`:82`).
- Local jawcode source `/Users/jun/Developer/new/700_projects/jawcode/packages/ai/src/models.json`
  is stale in four bundles: `github-copilot` (:10667,:10723), `openai`
  (:59069,:59121), `openai-codex` (:59822,:59876), `opencode-zen`
  (:61734,:61784).
- Current official short-context tuples (input/output/cacheRead/cacheWrite):
  Terra `2/12/0.20/2.50`, Luna `0.20/1.20/0.02/0.25`.
- `src/usage/expected-prices.ts:32` already has the correct base tuples, but
  nonzero jawcode rows take precedence (`src/usage/cost.ts:207`).
- Fast multipliers coupled to stale bases: Terra `1.6`, Luna `0.4`
  (`expected-prices.ts:163`); official Fast = 2× standard for both.

## Diff-level plan

EXTERNAL FIRST (jawcode repo, scoped clean branch — its checkout is dirty):
`packages/ai/src/models.json` — correct Terra + Luna in all four bundles; Sol
unchanged.

MODIFY `src/generated/jawcode-model-metadata.ts` — REGENERATE only:
`JAWCODE_MODELS_JSON=/Users/jun/Developer/new/700_projects/jawcode/packages/ai/src/models.json bun run generate:jawcode-metadata`;
inspect the generated diff — only intended price changes allowed.

MODIFY `src/usage/expected-prices.ts` — Terra and Luna
`PRIORITY_MULTIPLIERS` → `2`; Sol stays `2`.

MODIFY `tests/usage-cost.test.ts` — table-driven
`resolveMatchedPrice("openai", model)` pinning Sol/Terra/Luna four-tuples;
Luna Fast: standard `$0.064`, Fast `$0.128`; Terra: `$0.64` / `$1.28`.

No change: `scripts/generate-jawcode-metadata.ts`,
`tests/jawcode-metadata-sync.test.ts` (already byte-compares regeneration).

## Tests / activation

Identical short-context usage against OpenAI Luna/Terra → Logs/API estimates
use the post-cut tuple; `service_tier=priority` → published Fast totals.
Matrix: exact four-tuples; cache-read + cache-write inputs; long-context
boundaries stay green; regeneration sync with explicit `JAWCODE_MODELS_JSON`.

## Risks

- Dirty jawcode checkout: use a scoped clean branch/worktree there; never
  sweep unrelated changes.
- Fixing bases without multipliers silently undercharges Fast.
- Generated-only patch would be reverted by the next regeneration and
  contradicts the sync guard — regeneration is mandatory.

## Accept criteria

- Price snapshot tests green; generated diff contains only intended changes;
  gates as 030.
