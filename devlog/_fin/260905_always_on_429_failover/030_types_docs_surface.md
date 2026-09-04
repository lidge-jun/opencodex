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

**Corrected after audit round 1 (B4).** An earlier draft claimed the GUI copy stays truthful.
It does not. `gui/src/i18n/en.ts:1818`:

```
"anthropicPool.disabledDesc": "Uses only the active Claude account. Enable only if you accept experimental routing."
```

After 010 that is **stale**: disabled still means no affinity and no proactive pick, but a 429
now does move to another account. The string overstates what the off position buys.

`gui/` nevertheless stays out of this PR. Per `AGENTS.md` a PR whose title or description
mentions `gui` must carry a screenshot of the UI change, and this is a routing fix whose
reviewability suffers from a ten-locale copy pass bolted on. The honest record is therefore:
**known-stale copy, follow-up owed**, across `en` and the nine translated locales that mirror
it. Not "the panel does not lie".

`genericPoolSettingsDto` reporting `inert: true` is unaffected — it describes the `strategy`
and `autoSwitchThreshold` fields the selector still does not consume.

## Verification plan

Per the user's standing instruction, **no repository-wide local suite**. Focused only:

```
bun run typecheck
bun test tests/anthropic-account-pool.test.ts
bun test tests/generic-oauth-failover.test.ts
bun test tests/adapter-event-oauth-failover.test.ts
bun test tests/key-failover.test.ts
bun test tests/always-on-429-failover.test.ts
bun test tests/account-pool-management-api.test.ts
bun test tests/oauth-upsert-preserves-api-key.test.ts
```

`tests/adapter-event-oauth-failover.test.ts` was added to this list after audit round 1 (B2):
it drives a real Cursor 429 through `handleResponses` and asserts the opt-out behaviour this
unit reverses, so omitting it would have moved the failure to CI.

Repository-wide validation is delegated to GitHub Actions on the exact PR head SHA, which must
be observed green before the admin merge.
