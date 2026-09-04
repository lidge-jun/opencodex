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

## Change 2 — `src/server/responses/core.ts` (:3475-3480)

**Amended after audit round 1 (B3).** An earlier draft of this doc proposed a dedicated
`else if` arm that called `getValidAccessTokenSnapshot("anthropic")` itself. That is rejected:
it mints a second credential read for an account the shared arm has already resolved.

Anthropic reaches the shared OAuth else-arm whenever the pool is off, because the inner `if`
requires `isAnthropicAccountPoolEnabled`. That arm resolves the active account into
`resolved`, and `resolved.accountId` is precisely the account that will serve the request.
So the capture is one stamp beside the existing generic one:

```ts
 if (isGenericFailoverProvider(route.providerName, route.provider)) {
   genericFailoverAccountId = resolved.accountId;
 }
+// Anthropic is excluded from isGenericFailoverProvider (its pool owns affinity and a
+// fail-closed local-cli rule), so without this its identity is dropped and a later 429 has
+// nothing to cool. Reactive failover needs only the id -- no affinity bind, no promotion,
+// no quota-ranked pick. Those are proactive and stay behind the pool flag.
+if (route.providerName === "anthropic" && hasAnthropicFailoverQuorum()) {
+  anthropicPoolAccountId = resolved.accountId;
+}
```

One resolution, one stamp, no new credential read.

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
