# 030 — Types, docs and management surface

## `src/types/config.ts`

`anthropicAccountPool` doc comment currently says "Failover on 429 + sticky affinity". After
010 the flag no longer owns failover, so the comment must stop claiming it:

```
 * Opt-in Anthropic OAuth PROACTIVE routing (#294). Default OFF.
 * Sticky session affinity and quota-ranked new-session selection.
 * Reactive 429 failover is NOT gated here -- it activates on account presence like every
 * other multi-credential provider, and cannot be switched off.
```

`oauthAccountFailover` doc comment must stop advertising `false` as a way to keep strict
single-account behaviour on 429, and say what it does govern now.

## `src/types/provider.ts`

Same correction on the per-provider override: an explicit boolean no longer "beats presence"
for reactive rotation; it governs the proactive pre-dispatch preference.

## `docs-site/`

No page currently documents `anthropicAccountPool` or `oauthAccountFailover` (an `rg` over
`docs-site/src/content/docs/en/` for those identifiers returns nothing), so there is no stale
English page to correct and no translated locale that can contradict it. Scope here is
therefore the in-repo type comments plus this devlog unit, and a docs page is out of scope
rather than skipped: adding a first-ever provider-pooling page would be a separate unit with
its own translation obligation across ten locales.

## Management API / GUI

`genericPoolSettingsDto` reports `inert: true` and the GUI's Anthropic pool settings panel
describes the opt-in pool. Neither lies after this change — the pool flag still means what the
panel says it means for proactive routing. A copy pass explaining "429 failover always on" is
desirable but is GUI-surface work; per `AGENTS.md` a PR touching `gui` requires a screenshot
in the description. Keeping `gui/` out of this PR keeps the change reviewable as a routing
fix. Recorded here as a deliberate deferral, not an oversight.

## Verification plan

Per the user's standing instruction, **no repository-wide local suite**. Focused only:

```
bun run typecheck
bun test tests/anthropic-account-pool.test.ts
bun test tests/generic-oauth-failover.test.ts
bun test tests/key-failover.test.ts
bun test tests/always-on-429-failover.test.ts
bun test tests/account-pool-management-api.test.ts
bun test tests/oauth-upsert-preserves-api-key.test.ts
```

Repository-wide validation is delegated to GitHub Actions on the exact PR head SHA, which must
be observed green before the admin merge.
