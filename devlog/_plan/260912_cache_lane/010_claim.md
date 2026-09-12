# Claim deferral

Prerequisite: roadmap; origin/dev baseline. Independent PR. Carry source #4118 at fc8c03833e9ffd0f2bfd30f5ef7de19425c87645, preserving author trailers.

- MODIFY `docs-site/src/content/docs/fr/reference/proxy-formats.md`
- MODIFY `docs-site/src/content/docs/ja/reference/proxy-formats.md`
- MODIFY `docs-site/src/content/docs/ko/reference/proxy-formats.md`
- MODIFY `docs-site/src/content/docs/reference/proxy-formats.md`
- MODIFY `docs-site/src/content/docs/ru/reference/proxy-formats.md`
- MODIFY `docs-site/src/content/docs/tr/reference/proxy-formats.md`
- MODIFY `docs-site/src/content/docs/zh-cn/reference/proxy-formats.md`
- MODIFY `docs-site/src/content/docs/zh-tw/reference/proxy-formats.md`
- MODIFY `src/server/chat-completions.ts`
- MODIFY `src/server/responses/core.ts`
- MODIFY `src/vision/plan.ts`
- MODIFY `src/web-search/index.ts`
- MODIFY `structure/providers/openai-tiers.md`
- MODIFY `tests/codex-integration/bearer-admission-routed-provider.test.ts`
- MODIFY `tests/vision/vision-cache.test.ts`
- MODIFY `tests/web-search/web-search.test.ts`

Before: caller-auth noncanonical Chat eagerly claims stored main; helper admission does not share all terminal/routed/search exclusions. After: only non-caller-auth keeps early enrichment; carry `allowStoredOpenAiSidecarAuth` privately, then claim before reading main only when a canonical Direct helper candidate is actually needed. Snapshot stays separate from primary/retry credentials. Share routed-vision eligibility and tool-choice exclusions. Preserve loopback hostname/listener fields.

Activation: held keyless Cursor request without helper leaves main request count zero and profile switch succeeds; Direct helper carries main only to helper wire; Pool/exact account and excluded tool choices retain behavior. Auth review required.

Exact executable delta is the public diff at https://github.com/lidge-jun/opencodex/pull/4118.diff captured locally in .tmp/cache-handoff/pr-4118.diff; git apply --check exited 0 on baseline. Read and adapt source context before application. No source deletion. Add concise current-contract references to all mapped source ownership docs, with canonical details in structure/data-planes/inbound-compat.md and structure/providers/openai-tiers.md (claim) or structure/transports/responses.md (affinity).

C: git diff --check plus independent review; local tests NOT RUN. Runtime acceptance deferred to final hosted tip CI. D records implementation and pending remote evidence, not test success.
