# Cycle 180 — Pro Reasoning Merge Contract

## Objective

Document and verify the exact reasoning merge semantics when `applyOpenAiVirtualModel`
rewrites a Pro request. `mode: "pro"` is injected, conflicting modes are replaced,
but effort, summary, generate_summary, and all other parser-allowed reasoning fields
are preserved.

## Scope

- `applyOpenAiVirtualModel`: raw reasoning object is spread then `mode` overwritten
- Omitted or null reasoning becomes `{ mode: "pro" }`
- Non-object reasoning (string, array) is rejected by the parser before apply (400)
- Second application on already-rewritten body is idempotent
- Compact path strips reasoning entirely (ResponseCompactParams has no reasoning field)

## Activation tests

- `tests/openai-api-virtual-models.test.ts` "omitted/null reasoning becomes mode pro"
- `tests/openai-api-virtual-models.test.ts` "conflicting mode is replaced while supported reasoning fields survive"
- `tests/openai-api-virtual-models.test.ts` "rewrites Pro request" (effort preserved)
- Transport test: invalid reasoning returns 400 without upstream fetch

## Evidence

- Consolidated implementation and activation evidence is indexed in
  [`190_consolidated_finish_plan.md`](./190_consolidated_finish_plan.md), with the final
  Cycle-B integration and gate receipts in [`050_integration_verification.md`](./050_integration_verification.md).

## Status

`done — verified by consolidated Cycle A/B sweep, see 190 + 050 evidence`
