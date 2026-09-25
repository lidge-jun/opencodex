# 020 — Audit (plan 010)

Reviewer: read-only subagent (the `devin/swe-2` attempt failed with Devin `resource_exhausted`, retry ~1740s;
rerun on the inherited model). Verdict: NEAR-PASS. All points folded; nothing rebutted.

| Finding | Resolution |
| --- | --- |
| Own-pinned-row branch (e.g. `gpt-daybreak-red-latest`) is not self-described, so `isGpt56NativeSlug`/`nativeLadderIncludesUltra` would synthesize `ultra` and strip Lite/WebSocket flags | Dropped. Every configured slug borrows `gpt-6-sol`; its source is self-described, so both predicates follow Sol. Context is always the GPT-6 default. |
| Combo `nativeAlias` validation (combos/types.ts:228) runs during schema parse, before registration | Documented limitation: a `nativeAlias` onto a configured slug is refused. Out of scope. |
| Process-global registry leaks across test files | `resetConfiguredNativeOpenAiModelsForTests()`; the new test calls it in `afterEach`. |
| Mutate the shared array, Set and three maps in place; never delete built-ins | Registration diff-applies in place; built-in ids are ineligible, so they are never added or removed. |
| Import cycle / GUI bundle | `native-models.ts` stays import-free. The config filter (`configuredNativeOpenAiModelIds`) lives in server-only `src/config/derived-registries.ts`, importing `openai-tiers-destination`. |
| Missed refresh sites: config/live-reconcile.ts, server/management/provider-routes.ts (2) | Added to the replacement list. |
| `ENTITLEMENT_PREFERRED_NATIVE_OPENAI_MODELS` / `NATIVE_MAIN_DRAIN_SENTINEL_MODELS` exclude configured slugs | Deliberate: both sets are reasoned per model. Configured slugs behave like `gpt-5.5` there. Documented in structure/catalog.md. |
| Every pool selector gets the slug (metadata.ts:831) | Consistent with "never gated"; asserted in the test. |
| Alias branch needs a presentation | Presentation generated from the slug. |
| Module-state vs argument rule (metadata.ts:238) | Registration happens inside `loadConfig`, so every process that loads config (including `ocx ensure`) sees it. Documented. |
| `refreshConfiguredNativeOpenAiModels` redundant | Folded into `refreshConfigDerivedRegistries`. |
