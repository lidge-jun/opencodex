# 060 — wp6: evidence-backed closures

Five items are already terminal on `dev`. Each gets a comment citing the specific code or
commit that makes it so, then closes. No code changes in this phase.

## Issues

**#2442 — OpenCode Go rejects `search_content_types`.** The adapter already strips that field
for Muse Spark plain `web_search`
([openai-responses.ts:1587](../../../src/adapters/openai-responses.ts)), with positive and
isolation coverage in `tests/muse-spark-web-search-compat.test.ts:38`.

**#2423 — OpenRouter Ox Alpha HTTP 200 with an empty completion.** A terminal-less pre-output
EOF now raises a retryable empty-completion error
([empty-completion-guard.ts:309](../../../src/server/responses/empty-completion-guard.ts)),
pinned by `tests/empty-completion-guard.test.ts:326`.

**#2060 — OpenCode Go account-pool round-robin.** Closing with an explicit adjudication rather
than a claim of equivalence, because the two are not the same thing.

The request was continuous per-request round-robin. What ships is 429-driven failover:
`hasKeyPoolFailover` + `rotateProviderTransportOn429`
([key-failover.ts:82](../../../src/providers/key-failover.ts)) rotate to the next non-cooled
key on upstream 429 and replay the same request.

Owner decision: **429 failover is the correct default**, and continuous round-robin belongs to
the pool feature rather than to the provider path. Rotating every request would shred prompt
caching and spread thread affinity across keys for no benefit while every key is healthy. The
comment states this as a decision, not as "already implemented" — the reporter asked for
something real and deserves to know it was considered and declined.

## Pull requests

**#1769 — manual paste fallback for OAuth add-account.** Superseded by `74e8ce557`, which
landed the manual redirect/code paste fallback BEFORE this PR opened. Current `dev` waits for
and validates pasted input including attempt-state matching
([oauth/index.ts:1338](../../../src/oauth/index.ts)) and exposes the management endpoint
([oauth-account-routes.ts:206](../../../src/server/management/oauth-account-routes.ts)).

**#2215 — document V2 fork override rule.** Superseded by `7fdb2cb8e`, which documents that
full-history V2 forks inherit the parent model and that model/effort overrides need partial or
no history ([sub-agent-surface.md:68](../../../docs-site/src/content/docs/guides/sub-agent-surface.md)
and :222).

## Verification (C)

`gh issue view <n>` / `gh pr view <n>` reporting `CLOSED` for all five, each with its comment
posted. Contributor-facing courtesy: name the commit, not just the conclusion — a superseded
author should be able to see their work was checked rather than dismissed.

