# 030 — Phase 3: quota-aware pool selection

Work class: C3. Depends on: `020` (cached per-account quota).

## The gap

Rotation today is **reactive and order-blind**: on a 429 it walks the stored account order
from the failed account and takes the first non-cooled, non-reauth account
(`src/oauth/generic-account-failover.ts:157`). If the very next account is at 99% used, we
rotate into it, 429 again, and burn a second rotation from a budget of three.

This is the axis on which kiro-lb is genuinely ahead: it *ranks* by remaining fraction
before choosing. We should be ahead of it instead — it ranks with 15-minute-stale data and
ignores the requested model entirely (doc `002`, gaps 1 and 2).

## Design

Add an **ordering** step, not a new pool. The real owner is
`rotateGenericOAuthAccountOn429` (`src/oauth/generic-account-failover.ts:157`); it keeps
its contract (cooldowns, reauth skipping, request-local rotation, never mutating
`activeAccountId`) and gains a rank step in place of its inline ring walk:

```ts
// src/oauth/account-quota-rank.ts
export function rankAccountsByHeadroom(provider: string, ring: string[]): string[];
```

### The ring is built first, then ranked

This ordering is load-bearing and easy to get wrong. `eligibleFailoverAccounts` returns
ids in **stored** order (`:143`), while the existing traversal starts **after the failed
account** (`:184`). Ranking the stored-order list would silently change today's behaviour:
with roster `[A, B, C]` and `B` failing, stored order picks `A` where the ring picks
`C`.

So the caller constructs the ring explicitly, then ranks it:

```ts
const order = set.accounts.map(a => a.id);
const start = order.indexOf(failedAccountId);
const ring = start >= 0 ? [...order.slice(start + 1), ...order.slice(0, start)] : order;
const candidates = ring.filter(id => eligible.includes(id) && id !== failedAccountId);
return rankAccountsByHeadroom(providerName, candidates)[0] ?? null;
```

Rules, in order:

1. **Synchronous only.** It reads `getCachedProviderAccountQuota(provider, id)`
   (`src/providers/quota.ts:1470`), which never probes the network. Rotation happens
   mid-request while a 429 is in hand; it cannot await a usage call.
2. **Three categories, no numeric weight.** Accounts fall into
   `known-healthy` → `unknown` → `known-exhausted`, where exhausted is our own verdict
   from `010` (limit reached with overage disabled). No borrowed constant: an unknown
   account must obviously be tried before one we measured as empty and after one we
   measured as full, and that ordering needs no tuning parameter.
3. **Within known-healthy, sort by descending headroom.** Headroom = `100 - percent` of
   the monthly window (Kiro's plan window), or the minimum across known windows for
   providers reporting several.
4. **Stable within a bucket.** Ties preserve ring order, so the deterministic
   walk-the-roster property survives. Deterministic by choice: with a handful of accounts
   and a fresh rank per request, randomization buys nothing and costs reproducibility.
5. **Zero quota data anywhere → identity.** Returns the ring unchanged, so behaviour for
   every provider without per-account quota is byte-for-byte what it is today.

## No live decrement (withdrawn after audit round 1)

An earlier draft proposed nudging the cached percent after each successful turn to close
kiro-lb's 15-minute staleness gap. It is removed: `ProviderQuota` carries no absolute
limit to divide by, and Kiro bills fractional credits, so a per-turn increment would be
fabricated. Stale truth beats invented precision.

Be precise about the freshness we do claim, because there are **two** different TTLs:

- **Provider-level display** rows cache for 5 minutes (`src/providers/quota.ts:37`).
- **Per-account** rows — which are what this ranking reads — cache for **10 minutes**
  (`:1425`), deliberately longer because the cost multiplies by account count.

So recovery ranking can act on data up to 10 minutes old. That is still better than
kiro-lb's 15-minute default poll, but the honest margin is 10-vs-15, not 5-vs-15.

## Exhaustion cooldown

When `010`'s snapshot says `exhausted`, seed the failover cooldown for that account until
`nextResetAt` (clamped: minimum 5 minutes, maximum 24 hours) instead of the default 60s.
Retrying a monthly-exhausted account every minute is pure waste. The clamp keeps a bogus
upstream reset date from parking an account for a month — kiro-lb allows a 32-day
quarantine, which we consider too much rope.

The exhaustion state is owned by the generation-guarded store described in `070`, not by
an ad-hoc module map; a stale `exhausted` flag surviving an account removal would hand a
replacement account a 24-hour cooldown it never earned.

## Accept criteria

| # | Scenario | Observable proof |
| --- | --- | --- |
| 1 | A at 10% used, B at 90% used | A ranks first |
| 2 | A unknown, B at 95% used but NOT exhausted | B ranks first — B is known-healthy, and the categorical rule has no "known-low" tier |
| 3 | A unknown, B at 5% used | B ranks first (known-high beats unknown) |
| 3b | A unknown, B exhausted (limit reached, overage off) | A ranks first (unknown beats known-exhausted) |
| 4 | No quota data for any account | order identical to input (activation: proves the no-op path) |
| 5 | Equal headroom | ring order preserved |
| 6 | Rank called during rotation | zero network calls (assert fetch not invoked) |
| 7 | Exhausted + `nextResetAt` in 3 days | cooldown clamped to 24h, not 3 days |
| 8 | Exhausted + `nextResetAt` in 30 seconds | cooldown floored at 5 minutes |
| 9 | Roster [A,B,C], B fails, no quota data | C selected (ring), not A (stored order) |
| 10 | Rotation still skips cooled/reauth accounts | existing failover tests stay green |

## Blast radius

`rankAccountsByHeadroom` runs for every generic-failover provider, so criterion 4 is the
one that protects xAI, Cursor, Copilot, Kimi and Antigravity from behaviour change.
`tests/generic-oauth-failover.test.ts` and `tests/adapter-event-oauth-failover.test.ts`
must stay green untouched.

## Verifier

`bun test tests/kiro-pool-rank.test.ts tests/generic-oauth-failover.test.ts tests/adapter-event-oauth-failover.test.ts`
