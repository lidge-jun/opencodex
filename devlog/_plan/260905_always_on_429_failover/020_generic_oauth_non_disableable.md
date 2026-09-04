# 020 — Generic OAuth: reactive rotation stops being switchable off

## Goal

`oauthAccountFailover.enabled: false` — global or per provider — must no longer suppress
reactive 429 rotation. Presence (2+ eligible accounts) becomes the sole activation rule, which
makes generic OAuth behave exactly like the API-key pool.

## Change — `src/oauth/generic-account-failover.ts`

`isGenericOAuthFailoverEnabled` currently reads:

```ts
const perProvider = provider.oauthAccountFailover?.enabled;
if (typeof perProvider === "boolean") return perProvider;
const global = config.oauthAccountFailover?.enabled;
if (typeof global === "boolean") return global;
return hasFailoverAccountQuorum(providerName, now);
```

Becomes:

```ts
/**
 * Whether reactive 429 rotation is active for this provider.
 *
 * Presence is the ONLY rule: two or more eligible stored accounts. The former
 * `oauthAccountFailover.enabled` booleans no longer suppress it -- a stranded 429 with an
 * idle second account logged in is a defect, not a configuration choice, and the operator
 * who does not want rotation expresses that by not storing a second account.
 *
 * The knob survives for PROACTIVE preference (`preferredInitialAccount`), which does change
 * which account serves a healthy request and therefore remains refusable.
 */
export function isGenericOAuthFailoverEnabled(config, providerName, now = Date.now()): boolean {
  const provider = config.providers?.[providerName];
  if (!provider || !isGenericFailoverProvider(providerName, provider)) return false;
  return hasFailoverAccountQuorum(providerName, now);
}
```

## The knob is not deleted — it is re-scoped

Deleting `oauthAccountFailover` would be a config-compat break: existing files carry it,
`src/config.ts` validates it, `src/oauth/index.ts:1367` preserves it across preset overwrite,
`provider-routes.ts:952` preserves it across management writes, and
`pool-settings-capability.ts` serves it in a DTO. Removing the field would make those paths
drop operator data and would fail `tests/oauth-upsert-preserves-api-key.test.ts`.

So the field stays and keeps its `strategy` / `autoSwitchThreshold` meaning. Only
`enabled` changes meaning: it now governs the proactive preference, not the reactive net.

`preferredInitialAccount` currently opens with `if (!isGenericOAuthFailoverEnabled(...)) return null;`.
That call must be replaced with a proactive-specific predicate, or the re-scoped `enabled: false`
would stop refusing the thing it is supposed to refuse:

```ts
/** Proactive pre-dispatch preference: refusable, because it moves a HEALTHY request. */
function isProactivePreferenceEnabled(config, providerName, now): boolean {
  const provider = config.providers?.[providerName];
  if (!provider || !isGenericFailoverProvider(providerName, provider)) return false;
  const perProvider = provider.oauthAccountFailover?.enabled;
  if (typeof perProvider === "boolean" && !perProvider) return false;
  const global = config.oauthAccountFailover?.enabled;
  if (typeof global === "boolean" && !global) return false;
  return hasFailoverAccountQuorum(providerName, now);
}
```

Only `false` is honoured here; `true` adds nothing over presence. That keeps the predicate
monotone with the old behaviour for every operator who never wrote the key.

## Call sites in `src/server/responses/core.ts`

`:5222`, `:5528`, `:6216` all guard rotation with `isGenericOAuthFailoverEnabled`. They need
no edit — the predicate they call simply became presence-only. `:3422` guards
`preferredInitialAccount`, which now self-gates on the proactive predicate.

## Tests (`tests/generic-oauth-failover.test.ts`)

1. `oauthAccountFailover.enabled: false` globally, two accounts, 429 -> still rotates.
2. Per-provider `enabled: false`, two accounts, 429 -> still rotates.
3. One account -> `null` regardless of any flag.
4. `enabled: false` -> `preferredInitialAccount` returns `null` even with headroom evidence
   (the proactive refusal is preserved).
5. Existing presence-default-on tests continue to pass unchanged.
