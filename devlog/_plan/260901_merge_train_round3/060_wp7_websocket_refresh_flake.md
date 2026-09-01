# 060 — wp7: the websocket refresh flake, and why #3128 did not fix it

`tests/server-auth.test.ts` —
`server local API auth > websocket passthrough refreshes pool auth for each response.create turn`

This assertion has now cost four reruns across three trains. It failed on #3133, on #3137,
and again on #3137's rerun of an identical head. It is the reason #3137 is not merged.

## What #3128 did

Three lines. It added `codexAccountNamespaces: { "ws-refresh": "pool-a" }` and routed both
turns through `ws-refresh/gpt-test` instead of `gpt-test`. That pins **which account**
serves the turn.

It is an ancestor of every head that has since failed:

```
$ git merge-base --is-ancestor 33d32b6a3 HEAD && echo "3128 IS in carry base"
3128 IS in carry base
```

So account selection was never the mechanism. The train has been citing this as a fixed
flake, and that citation is worse than no citation — it trains the next reviewer to dismiss
a red that might be real.

## What actually happens

The failure diff is always the **first** element and never the second:

```
expect(seenAuth).toEqual(["Bearer old-access-token", "Bearer new-access-token"])
- Expected  - 1
+ Received  + 1
```

That is an early first refresh, not a missing second one.

Four facts, each checkable:

1. `const now = 1_800_000_000_000` (`:2222`) is **2027-01-15T08:00:00Z**. Today is
   2026-09-01. The fixture's clock is roughly four months in the future.
2. The credential is stored with `expiresAt: now + 120_000` (`:2239`) — an absolute
   timestamp in that future.
3. The refresh predicate is `cred.expiresAt > Date.now() + REFRESH_SKEW_MS`
   (`src/codex/account-store.ts:717`, `REFRESH_SKEW_MS = 60_000` at `:22`).
4. `startServer(0)` runs at `:2245`; `Date.now = () => now` is not installed until
   `:2251`.

Between 4's two lines, anything that reads the clock reads the **real** one. And under the
real clock the stored credential is not near expiry — it is four months in the future, so
the predicate passes.

Which inverts the earlier diagnosis. The margin is not 60 seconds; it is months. So the
trigger cannot be "the read landed on the wrong side of the skew boundary" — something must
be forcing a refresh that ignores freshness, or reading the credential before the fixture's
clock is in place under conditions where freshness does not apply.

## The window is not empty, and that is the part that matters

`startServer` is synchronous (`src/server/index.ts:555`) — but it launches work that is
not. At `:2054-2064`:

```ts
import("../codex/plan-from-token")
  .then(({ reconcileCodexPlansFromTokens }) => { ... return import("../codex/auth-api"); })
  .then(({ primeCodexPoolQuotas }) => primeCodexPoolQuotas(config, "startup"))
  .catch(() => {});
```

That chain is gated on `providerCodexAccountMode("openai", openAiProvider) === "pool"`
(`:2052`), and this fixture configures exactly that: `poolProviders()` with
`activeCodexAccountId: "pool-a"`. So the test **does** arm it.

Two dynamic `import()`s resolve as microtasks after `startServer` returns. Whether
`primeCodexPoolQuotas` reaches the credential before or after `:2251` installs the fake
clock depends on module-cache warmth and machine load — which is exactly the shape of a
failure that is rare locally, common on a loaded CI runner, and indifferent to which account
the turn names.

## The mechanism, now with firing evidence

`LOOP-MECHANISM-PROOF-01` says a plausible chain is not activation proof. So here is the
chain firing, from the runtime's own counter:

```
$ OPENCODEX_DEBUG_QUOTA=1 bun test tests/server-auth.test.ts -t "websocket passthrough refreshes pool auth"
[codex-quota] prime done (reason=startup, pool=1, refreshed=1)
(pass) ... [1325.02ms]
```

`pool=1, refreshed=1`: the startup prime runs during this test and treats `pool-a` as
**stale**, so it calls `fetchPoolAccountQuota("pool-a", ...)` — which reaches the credential.

Why it is judged stale is the whole race, and it runs **opposite** to the direction the
earlier diagnosis assumed:

```
src/codex/auth-api.ts:1334-1337
  const stale = pool.filter(a => {
    const q = getAccountQuota(a.id);
    return !q || Date.now() - q.updatedAt >= POOL_CACHE_TTL;   // 5 * 60_000
  });

src/codex/quota.ts:457
  updatedAt: Date.now(),
```

The fixture calls `updateAccountQuota("pool-a", 10, 5)` at `:2242`, **before**
`Date.now` is faked — so `updatedAt` is stamped with the **real** clock, 2026-09-01.

Now the two orderings diverge:

| when the prime's `Date.now()` runs | value | `Date.now() - updatedAt` | verdict |
| --- | --- | --- | --- |
| before `:2251` installs the fake clock | real, 2026-09-01 | ~0 ms | fresh — no fetch |
| after `:2251` | fake, 2027-01-15 | ~136 days | **stale — fetch fires** |

So the failure needs the prime to land on the **late** side, not the early one. The stored
credential is not near expiry under either clock; what varies is whether a quota fetch is
triggered at all, and that fetch is what rotates the token before the first turn is served.

The earlier reading — "60 s of margin against `REFRESH_SKEW_MS`, the read lands on the
wrong side of the boundary" — was wrong in both quantity and direction. The margin is months,
and the fake clock does not shorten it; it inflates a *cache age* past a five-minute TTL.
Recording that here because the wrong version is already quoted in comments on #3109 and
#3112, and in `260901_release_train_2390/070_outcome.md`.

## Why it will not reproduce locally

Six consecutive single-test runs pass. Six more under deliberate load (six concurrent
suites) pass, at 1320 ms instead of 330 ms. The window is two dynamic `import()`
resolutions wide, and on a warm module cache those microtasks land before `:2251`. A cold
CI runner resolving them from disk under four parallel Bun pools is the environment where
they land after — which is why this is a CI-only failure that no amount of local rerunning
will surface.

## Why this is not fixed in this train

The candidate fix is to install the fake clock **before** `startServer`, so no window
exists. That is a one-line move with a real risk attached: `startServer` does startup
migrations and journal arming, and pinning `Date.now` to 2027 across those paths may change
what they decide. Verifying that is its own unit of work, not a merge-train side quest.

What this train owes is the correction, and it has been delivered where it does damage:
comments on #3109 and #3112 now say the flake is unfixed and tell a reviewer to rerun rather
than read a single red as a regression.

**#3137 stays open, BLOCKED on this.** Its own suites pass (214 / 0) and every check except
`macos` is green; merging it by rerunning until the dice land would be exactly the habit
this document exists to end.
