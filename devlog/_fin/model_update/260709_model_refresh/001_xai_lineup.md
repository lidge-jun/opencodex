# 001 — xAI lineup research (2026-07-09, gpt-5.5 explorer "Feynman" + main-session web cross-check)

## VERDICT: grok-4.5 EXISTS, api id `grok-4.5`
- Announced 2026-07-08, flagship "smartest model" for coding/agentic work.
  Sources (OFFICIAL): https://x.ai/news/grok-4-5 , https://docs.x.ai/developers/grok-4-5 ,
  https://docs.x.ai/developers/models/grok-4.5 , https://docs.x.ai/developers/pricing
- Not yet EU-console available (expected mid/late July 2026).

## Current text-model lineup (OFFICIAL docs.x.ai/developers/models/*)
| api id | context | modalities | reasoning |
|---|---:|---|---|
| grok-4.5 | 500k | text,image -> text | reasoning.effort low/medium/high, default high, cannot disable |
| grok-4.3 | 1M | text,image -> text | none/low/medium/high |
| grok-4.20-multi-agent-0309 | 1M | text,image -> text | effort controls AGENT COUNT, not depth |
| grok-4.20-0309-reasoning | 1M | text,image -> text | reasoning |
| grok-4.20-0309-non-reasoning | 1M | text,image -> text | non-reasoning by id |
| grok-build-0.1 | 256k | text,image -> text | "can think", not configurable |
- Max output caps: not officially published (secondary UNVERIFIED: 128k for grok-4.5 via OpenRouter).
- Imagine (image/video) + Voice models exist but are out of openai-chat adapter scope.

## Deprecated (retired 2026-05-15, redirects still resolve)
grok-4-1-fast-*, grok-4-fast-*, grok-4-0709, grok-code-fast-1 (-> grok-build-0.1), grok-3,
grok-imagine-image-pro. Source: https://docs.x.ai/developers/migration/may-15-retirement

## grok-composer-2.5-fast
NOT in official docs/pricing (secondary-only: community/OAuth tooling). It WORKS today via the
user's Grok OAuth account through ocx (present in the live desktop model list), so we KEEP it in
the registry as an account-verified entry and let live /v1/models discovery decide its fate
(Phase 2). Do not treat official-docs absence as removal evidence for OAuth-plan models.

## Dynamic discovery
GET /v1/models (authenticated) returns ids + aliases + pricing + context_length ("minimalized");
richer: /v1/language-models. Source: https://docs.x.ai/developers/rest-api-reference/inference/models
=> ocx generic fetchProviderModels(/models) can consume context_length via item.context_length.

## Registry decisions (Phase 1)
- ADD grok-4.5 (list head), ADD grok-4.20-multi-agent-0309.
- defaultModel: grok-4.3 -> grok-4.5 (xAI flagship; decision recorded here).
- modelReasoningEfforts: grok-4.5 -> ["low","medium","high"] (no none/off; default high upstream).
- noReasoningModels: += grok-4.20-0309-non-reasoning; KEEP grok-build-0.1 (no documented effort
  control on chat wire) and grok-composer-2.5-fast (unverified control surface).
- modelContextWindows: pin official values (4.5: 500k; 4.3/4.20*: 1M; build: 256k).
- noVisionModels: KEEP as-is (build/composer) despite docs claiming image input — flipping the
  vision sidecar off is a behavior risk with no live wire evidence; revisit in Phase 2 with live
  discovery. Recorded as conservative deviation from explorer recommendation.
