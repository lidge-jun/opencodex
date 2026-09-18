# Final Go affinity

Prerequisite: roadmap; origin/dev baseline. Independent PR. Carry source #4050 at e5c2411f7b35c6265aacce19f66f13eace544579, preserving author trailers.

- MODIFY `docs-site/src/content/docs/guides/providers.md`
- MODIFY `src/server/claude-messages.ts`
- MODIFY `src/server/responses/core.ts`
- MODIFY `tests/providers/opencode-go-session-header.test.ts`

Before: preliminary Claude route injects Go identity into replay headers. After: derive validated lane with explicit session > Go header > valid Claude metadata > original request allocation, carry `claudeGoAffinity` in HandleResponsesOptions through combo recursion and consume only at final Go normalization. Never synthesize shared system hash identity or leak Go-only headers to non-Go.

Activation: existing two-wire/random/failover matrix gains metadata, explicit-header precedence, malformed/shared identity and independent sessionless controls; operator override wins. No public option or serialization: private in-memory options, recursion spreads options, final transport consumes.

Exact executable delta is the public diff at https://github.com/lidge-jun/opencodex/pull/4050.diff captured locally in .tmp/cache-handoff/pr-4050.diff; git apply --check exited 0 on baseline. Read and adapt source context before application. No source deletion. Add concise current-contract references to all mapped source ownership docs, with canonical details in structure/data-planes/inbound-compat.md and structure/providers/openai-tiers.md (claim) or structure/transports/responses.md (affinity).

C: git diff --check plus independent review; local tests NOT RUN. Runtime acceptance deferred to final hosted tip CI. D records implementation and pending remote evidence, not test success.
