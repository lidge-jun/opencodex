# 010 — Anthropic: reactive 429 rotation independent of the pool flag

## Goal

`rotateAnthropicAccountOn429` must work when `anthropicAccountPool.enabled` is absent or
`false`, provided two or more usable Anthropic OAuth accounts are stored. Affinity, strategy
and `autoSwitchThreshold` stay behind the flag.

## Change 1 — `src/oauth/anthropic-routing.ts`

Add a presence predicate beside the existing flag predicate:

```ts
/**
 * Reactive 429 failover quorum: two or more accounts that could serve traffic if asked.
 * Cooldowns are deliberately ignored -- this answers "did the operator log in twice",
 * not "who is free right now", and a cooled account must not switch the feature off
 * exactly when it is needed.
 */
export function hasAnthropicFailoverQuorum(now = Date.now()): boolean {
  const set = getAccountSet(PROVIDER);
  if (!set) return false;
  return set.accounts.filter(a => a.needsReauth !== true && isPoolCredentialUsable(a.id, now)).length >= 2;
}
```

Replace the hard gate in `rotateAnthropicAccountOn429`:

```ts
-  if (!isAnthropicAccountPoolEnabled(config)) return null;
+  // Reactive 429 failover is a safety net, not a routing policy: it only ever runs after
+  // upstream refused, and only when the operator deliberately stored a second account.
+  // The pool flag still gates PROACTIVE routing (affinity, strategy, autoSwitchThreshold).
+  if (!isAnthropicAccountPoolEnabled(config) && !hasAnthropicFailoverQuorum(now)) return null;
```

With the flag off, `pickAlternateAnthropicAccount` falls to the `quota` branch
(`anthropicPoolStrategy` normalizes an absent strategy to `quota`), which calls
`pickLowestUsage`. That reads whatever usage evidence exists and otherwise returns the first
eligible non-excluded account — a deterministic, evidence-optional pick. No new code path.

`clearAnthropicSessionAffinityForAccount` still runs. Harmless with the flag off: the
affinity map is empty because nothing binds into it.

## Change 2 — `src/server/responses/core.ts` (:3395-3420)

The account identity must be captured even when the pool is off, or the rotation loops have
nothing to cool. Restructure the branch:

```ts
if (route.providerName === "anthropic" && isAnthropicAccountPoolEnabled(config)) {
  ... existing proactive selection, unchanged ...
} else if (route.providerName === "anthropic" && route.provider.authMode === "oauth"
           && hasAnthropicFailoverQuorum()) {
  // Pool off: keep the ordinary active-account resolution, but REMEMBER which account
  // served the request so a later 429 cools that one. No affinity bind, no promotion,
  // no quota-ranked pick -- those are proactive and remain opt-in.
  const snapshot = await getValidAccessTokenSnapshot("anthropic");
  anthropicPoolAccountId = snapshot.accountId;
  route.provider = { ...route.provider, apiKey: snapshot.accessToken };
  logCtx.provider = formatAnthropicProviderForLog("anthropic", snapshot.accountId, config);
}
```

Note the ordering constraint: the `else` arm of the outer `if (route.provider.authMode === "oauth")`
block currently handles every non-Anthropic-pool OAuth provider through the generic path.
Anthropic is excluded from `isGenericFailoverProvider`, so it reaches that arm and resolves
the active account normally. The minimal edit is therefore to capture `anthropicPoolAccountId`
from `resolved.accountId` in that shared arm when the provider is `anthropic` and the quorum
holds, rather than duplicating a resolution. Prefer that: one resolution, one stamp.

## Change 3 — the two rotation loops (:6173, :6584)

Both read:

```ts
&& isAnthropicAccountPoolEnabled(config)
```

Drop that clause. `rotateAnthropicAccountOn429` now owns the activation decision, and
`anthropicPoolAccountId` is only non-null when there was something to rotate. Keeping the
clause here would re-impose the gate the module just stopped applying.

`promoteAnthropicActiveAccount(nextAccountId)` inside the loop: with the pool off this
persists the store's active account after a successful failover. That is correct and desirable
— the old account is rate-limited, so the next request should start on the one that worked.
It is also exactly what the API-key rotator does (`provider.apiKey = candidate.key` then
`saveConfigPreservingClaudeCode`). Keep it.

## Tests (`tests/anthropic-account-pool.test.ts` + new file)

1. Pool flag absent, two usable accounts, 429 on A -> `rotateAnthropicAccountOn429` returns B
   and A is cooled.
2. Pool flag `false`, same -> same result (an explicit false is not a reactive kill switch).
3. Pool flag absent, ONE account -> returns `null` (strict no-op, nowhere to go).
4. Pool flag absent -> `resolveAnthropicAccountForSession` still returns
   `{ reason: "pool-disabled" }` with the store active account, and binds no affinity.
5. Pool flag absent, second account is a `local-cli` credential with expired access ->
   no quorum, returns `null` (fail-closed rule preserved).
