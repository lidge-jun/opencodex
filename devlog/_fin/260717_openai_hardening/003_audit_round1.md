# Audit Round 1 — Synthesis

Reviewer: GPT-5.6 Sol, high reasoning, priority service tier
Result: `VERDICT: GO-WITH-FIXES (blockers=9)`
Disposition: all nine High blockers accepted; no blocker was rebutted.

## Root-cause synthesis

The first roadmap had the correct three-tier product intent but still described
several decisions as implementation-time choices. It also split public provider
exposure (010) from auth isolation (020), which would create a temporarily false
Direct contract after the first cycle. Source tracing found an existing fourth
`chatgpt` provider and two internal sidecar owners omitted from the file map.

## Accepted amendments

1. Rewrite every decade document with fixed symbols, paths, caller lists, and tests.
2. Make 010 non-activating foundation work. Activate registry, routing, migration,
   management admission, and all HTTP/WS/compact auth atomically in 020.
3. Keep `chatgpt` only as an internal legacy OAuth credential alias. It is removed
   from configured providers, public OAuth lists, routing candidates, and cards.
4. Run the pure migration once from `startServer`; back up the original config, then
   use existing temp+rename atomic persistence. A failed save aborts startup and
   leaves the original file intact.
5. Admit only the exact registry-owned `openai-multi` forward shape in management;
   reject client-authored account modes, virtual maps, bases, and capabilities.
6. Centralize sidecar selection and update standalone search/images plus internal
   `src/web-search/index.ts` and `src/vision/index.ts` callers.
7. Lock compact behavior from the official OpenAPI/SDK schema: Pro virtual compact
   requests send the base model only. `reasoning` is absent from compact params.
8. Use existing identity fields deliberately: persisted `model` is the selected
   virtual id, `requestedModel` is the original namespaced id, and `resolvedModel`
   is the upstream base id. Summaries continue grouping by `model`.
9. Add deterministic English/Korean browser QA with named viewports, interactions,
   console inspection, and persisted screenshot paths.

## External evidence

- <https://developers.openai.com/api/docs/models/gpt-5.6-sol>
- <https://developers.openai.com/api/docs/models/gpt-5.6-terra>
- <https://developers.openai.com/api/docs/models/gpt-5.6-luna>
- <https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode>
- <https://developers.openai.com/api/reference/resources/responses/methods/compact>
- Official OpenAPI operation `POST /responses/compact`, schema
  `CompactResponseMethodPublicBody`; the current official TypeScript SDK
  `ResponseCompactParams` exposes model/input/instructions/previous_response_id/
  prompt-cache/service-tier fields and no `reasoning` field.

## Re-audit gate

The same reviewer must confirm that the rewritten 010–050 documents close all nine
items and contain no unresolved “appropriate module,” “if supported,” optional test,
or activation-proof decisions.
