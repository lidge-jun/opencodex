# 004 — DONE record

## WP1 (code) — DONE
- `src/providers/registry.ts`: nvidia entry hardened (parallelToolCalls:false; noReasoningModels + modelReasoningEfforts:[] for 5 NIM kimi ids; preserveReasoningContentModels for the thinking family).
- `src/adapters/openai-chat.ts`: `formatOpenAIChatErrorBody` wired as adapter `formatErrorBody` (JSON-only, pydantic-array aware, redacted, 400-char cap).
- `tests/nvidia-nim-hardening.test.ts`: 14/14 pass. Adjacent suites green (70+66+67). tsc scoped-clean.
- A-gate: sol "Locke" PASS (0 blockers, 5 advisories folded).

## WP2 (record + reply + push) — DONE
- A-gate: sol "James" round-1 FAIL (2 wording blockers) → revision → round-2 residuals (2 softenings) folded → final text.
- Issue #126 reply posted: https://github.com/lidge-jun/opencodex/issues/126#issuecomment-4972552726
- Commit scope: registry.ts, openai-chat.ts, new test, this devlog folder (git add -f; devlog/ is gitignored but committed by convention). Parallel agents' dirty files untouched.
- Push: origin/dev (4 pre-existing cursor commits ride along — already on local dev before this unit).
- NO release/tag — release pending, as stated in the issue reply.

## Deferred (recorded, not regressions)
- huggingface / fireworks / firepass / openrouter kimi flags: deferred per Locke's disposition (generic routers / frozen entitlement); revisit on incident evidence.
- Durable fix for dynamic model families (prefix/pattern matching in registry lists, or trusting NIM capability metadata if it ever ships): future unit.
- The keyed 404 root cause (account enablement vs rollout) is NVIDIA-side; unverifiable without the reporter's account.
