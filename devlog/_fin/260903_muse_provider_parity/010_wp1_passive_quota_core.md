# wp1 — passive Muse subscription quota: parser, seam, cache

Own PR, base `dev`. Branch: `codex/meta-muse-passive-quota`.

Research: `001` (this unit) and `260903_muse_spark_plan_oauth/003` §E. Implementation only.

## Decisions taken here, so Build does not have to make them

| Question | Decision | Why |
|---|---|---|
| Where to observe | `noteInspectedPayload` in `core.ts:3891`, on the existing `onParsedPayload` seam | `001` §E: covers all three passthrough sites at once; `relay.ts` untouched |
| Which account | `genericFailoverAccountId` read **at event time** | it is rebound at every rotation site; reading it at construction attributes the turn to the account that failed |
| Translated path | **not covered**, deliberately | `openai-responses.ts`'s switch drops unknown types (`004` Q3, answered) |
| `supportsPerAccountQuota` | **stays false** | it gates a probe whose fallback ships a Meta bearer to Anthropic (`quota.ts:1629`) |
| Read path | a new cache-only function, not the probe function behind a flag | `fetchProviderAccountQuotas` probes; a passive provider has nothing to probe |
| Refresh | does not exist | obtaining a fresh value would mean spending an inference turn |
| `tier` | dropped | an opaque numeric id, not the label the CLI prints |

## NEW `src/providers/muse-subscription-usage.ts`

```ts
import { normalizePercent, normalizeResetAt, asRecord } from "./quota-wire";
import type { ProviderQuota, ProviderQuotaWindow } from "./quota-types";

/** The SSE frame type Meta emits on streaming turns. */
export const MUSE_SUBSCRIPTION_USAGE_TYPE = "response.subscription_usage";

export function parseMuseSubscriptionUsage(payload: unknown): ProviderQuota | null;
```

Mapping table, all mandatory:

| Source | Target | Rule |
|---|---|---|
| `subscription.window.used_percent` | `fiveHourPercent` | `normalizePercent`; assign **only** if `window_duration_mins === 300` |
| `subscription.window.resets_at` | `fiveHourResetAt` | `normalizeResetAt` (unix seconds; `epochMillis` scales) |
| `subscription.weekly.used_percent` | `weeklyPercent` | `normalizePercent` |
| `subscription.weekly.resets_at` | `weeklyResetAt` | `normalizeResetAt` |
| `window` with any other `window_duration_mins` | `customWindows[]` | label `"${duration}m"`; never forced into the 5h slot |
| `subscription.tier` | — | dropped |
| — | `updatedAt` | `Date.now()`, never from the payload |

Returns `null` — never throws — when the payload is not an object, carries no
`subscription`, or yields no usable window. Either window may be absent independently.
A window present but unparseable yields no slot rather than a zero.

**Why `window_duration_mins` is checked rather than assumed:** the measured payload says
300, but a plan change could move it, and silently filing a 10-hour window in the
five-hour slot would understate usage by the ratio of the windows — a wrong number
presented with full confidence.

## MODIFY `src/providers/quota.ts`

Three additions, all beside the existing per-account block (after
`setCachedProviderAccountQuotaForTests`, `:1494`).

```ts
/**
 * Providers whose per-account quota is OBSERVED in-band, never probed.
 *
 * Deliberately separate from supportsPerAccountQuota: that predicate gates
 * fetchAccountQuota, whose fallback branch sends any non-Kiro/non-Antigravity bearer to
 * Anthropic's usage endpoint. Meta exposes no quota endpoint at all (17 paths probed,
 * all 404), so there is nothing for that path to call.
 */
export function hasPassiveAccountQuota(provider: string): boolean {
  return provider === "meta-muse";
}

/**
 * Record a quota observed on a streaming turn.
 *
 * The CALLER captures writerGeneration when it resolves the serving credential, not
 * here: a streaming turn is a long await, and capturing at write time cannot see a
 * config change that happened earlier in the same turn.
 */
export function recordPassiveAccountQuota(
  provider: string,
  accountId: string,
  quota: ProviderQuota,
  writerGeneration: number,
): void {
  if (!hasPassiveAccountQuota(provider) || !accountId) return;
  const key = accountCacheKey(provider, accountId);
  if (!mayCommitAccountQuotaKey(key, writerGeneration)) return;
  accountQuotaCache.set(key, { ts: Date.now(), quota });
  persistAccountQuotaCache();
}

/** Cache-only per-account rows for a passive provider. Never probes. */
export function readPassiveProviderAccountQuotas(provider: string): ProviderAccountQuota[] {
  if (!hasPassiveAccountQuota(provider)) return [];
  hydrateAccountQuotaCache();
  const set = getAccountSet(provider);
  if (!set) return [];
  const rows: ProviderAccountQuota[] = [];
  for (const account of set.accounts) {
    const entry = accountQuotaCache.get(accountCacheKey(provider, account.id));
    if (entry?.quota) rows.push({ accountId: account.id, quota: entry.quota });
  }
  return rows;
}
```

Three details that are not arbitrary:

- `hydrateAccountQuotaCache()` must be called in the reader. It is idempotent
  (`diskHydrated`, `quota.ts:1440`) and is otherwise only reached from probe paths that a
  passive provider never enters — without it, a restart shows nothing until the next
  streaming turn even though the row is on disk.
- Absent rows are **omitted**, not returned with `quota: null`. A user who has not run a
  streaming turn has no observation, and `unavailable` would claim a failed probe that
  never happened.
- `sweepExpiredOnWrite` is **not** called here. Existing probe writers call it because
  they run on a poll; this runs on every streaming turn, and a state sweep on the request
  path is exactly the hot-path work `state-store-registrations.ts:97` warns against.

## MODIFY `src/server/responses/core.ts`

One capture at credential resolution, one branch in the existing payload handler.

Near `genericFailoverAccountId` (`:3309`), add:

```ts
// Captured where the credential is resolved, not at write time: see quota.ts
// recordPassiveAccountQuota. Only meta-muse observes a quota, so this stays 0 elsewhere.
let passiveQuotaWriterGeneration = 0;
```

set alongside `genericFailoverAccountId = resolved.accountId` (`:3444`):

```ts
if (hasPassiveAccountQuota(route.providerName)) passiveQuotaWriterGeneration = captureConfigGeneration();
```

Extend `noteInspectedPayload` (`:3891`). The existing body opens with an early return
for the undeclared-tool guard, so the observation goes **before** it:

```ts
const noteInspectedPayload = (payload: unknown) => {
  if (passiveQuotaObserved && route.providerName === "meta-muse") {
    const record = payload as { type?: unknown } | null;
    if (record && typeof record === "object" && record.type === MUSE_SUBSCRIPTION_USAGE_TYPE) {
      const quota = parseMuseSubscriptionUsage(payload);
      // Read the account HERE, not at construction: rotation rebinds it mid-turn.
      const accountId = genericFailoverAccountId;
      if (quota && accountId) {
        recordPassiveAccountQuota("meta-muse", accountId, quota, passiveQuotaWriterGeneration);
      }
    }
  }
  if (!undeclaredToolGuardActive || inspectionSawUndeclaredTool) return;
  // ... unchanged
};
```

where `passiveQuotaObserved` is a `const` computed once beside the handler:

```ts
const passiveQuotaObserved = hasPassiveAccountQuota(route.providerName)
  && route.provider.authMode === "oauth";
```

**Ordering is load-bearing.** The undeclared-tool guard returns early once it has fired
(`inspectionSawUndeclaredTool`), so an observation placed after it would be dropped for
the rest of any turn that tripped the guard — a turn that still legitimately reports
usage.

**Import discipline.** `core.ts` is one of the three files `tests/core-lab-boundary.test.ts`
guards. Both new imports (`src/providers/quota`, `src/providers/muse-subscription-usage`)
are already-reachable or leaf modules: `quota.ts` is imported by `core.ts` today, and the
parser imports only `quota-wire` and `quota-types`. Neither reaches `src/lab/`. The
parser must **not** import `quota.ts` — that would be a cycle.

## MODIFY `src/server/management/oauth-account-routes.ts`

At `:284`, the enrichment gate becomes:

```ts
const passiveQuota = url.searchParams.get("quota") === "1" && hasPassiveAccountQuota(provider);
const wantQuota = url.searchParams.get("quota") === "1" && supportsPerAccountQuota(provider);
if (!wantQuota && !passiveQuota) return jsonResponse(projectAccounts());
const rows = passiveQuota
  // No probe, and ?refresh=1 is ignored: there is nothing to refresh.
  ? readPassiveProviderAccountQuotas(provider)
  : await fetchProviderAccountQuotas(provider, url.searchParams.get("refresh") === "1");
```

The existing `byId` merge below is unchanged and already omits `quotaUnavailable` when
the row does not carry it.

`?refresh=1` is accepted and ignored rather than rejected: the GUI sends it on a manual
refresh for every provider, and a 400 would surface an error for an action that is simply
a no-op here.

## MODIFY `src/oauth/account-quota-rank.ts` — A-gate amendment

**Blocker found at the audit gate, folded here.** `headroomOf` (`:36`) reads
`getCachedProviderAccountQuota` and applies **no staleness bound**:

```ts
// src/providers/quota.ts:1489
export function getCachedProviderAccountQuota(provider: string, accountId: string): ProviderQuota | null {
  const entry = accountQuotaCache.get(accountCacheKey(provider, accountId));
  return entry?.quota ?? null;   // no ts check
}
```

For every provider that exists today this is safe by construction: a row is only written by
a probe, and `fetchAccountQuota` re-probes once `ACCOUNT_QUOTA_TTL_MS` (10 minutes,
`quota-wire.ts:22`) has passed, so a row consulted for routing is at most that old.
**The passive path breaks that invariant.** Nothing re-probes, and `001` §G established
that account-quota rows are not swept on the TTL tick, so a Muse row can be hours or days
old in memory and up to six hours old after a restart.

Left unfixed, `preferredInitialAccount` (`generic-account-failover.ts:281`) would send the
first attempt of every turn to whichever account looked best whenever it was last
observed — plausibly the one that has since been exhausted. That is worse than the
current unranked behaviour, because it is confidently wrong rather than uninformed.

```ts
/**
 * How old a PASSIVELY observed quota may be and still steer routing.
 *
 * A probed row is implicitly fresh: fetchAccountQuota re-probes after
 * ACCOUNT_QUOTA_TTL_MS. A passive row has no such refresh, so the bound is explicit
 * here. It is deliberately longer than the probe TTL — an hour-old reading of a
 * five-hour window is still informative — and deliberately far shorter than the
 * six-hour disk horizon, which exists to preserve a value for DISPLAY, where the age is
 * shown to the user and no automatic decision rides on it.
 */
const PASSIVE_HEADROOM_MAX_AGE_MS = 60 * 60_000;
```

In `headroomOf`, immediately after the null check:

```ts
  if (hasPassiveAccountQuota(provider) && Date.now() - quota.updatedAt > PASSIVE_HEADROOM_MAX_AGE_MS) return null;
```

Returning `null` is the correct shape, not a zero or a low rank: it reproduces "no
evidence", which `rankAccountsByHeadroom` (`:71`) and `hasHeadroomEvidence` (`:87`)
already handle by leaving the ring untouched. The stale-row case therefore degrades to
exactly today's behaviour rather than to a different wrong answer.

The display path is deliberately **not** bounded this way. wp2 shows the age, so an old
number is labelled rather than hidden — the user can judge it, and a routing algorithm
cannot.

Added tests in `tests/muse-passive-quota-cache.test.ts`:

- a passive row younger than the bound produces headroom; one older produces `null`
- `hasHeadroomEvidence` is false for a roster whose only rows are stale
- an `anthropic` row of the same age is unaffected (the bound is passive-only)

## Tests

`tests/muse-subscription-usage.test.ts` — parser, fixture-driven:

- the measured payload from `003` §E → both windows, correct millisecond resets
- `window_duration_mins: 600` → `customWindows`, and `fiveHourPercent` **undefined**
- weekly-only; window-only (each independently absent)
- `used_percent: 150` → clamped to 100 (`normalizePercent` clamps rather than rejects)
- `used_percent: "12"` → 12 (`toFiniteNumber` accepts numeric strings)
- missing `subscription`; non-object; `null`; array → `null`, no throw
- `tier` never appears in the output
- `updatedAt` is local, not the payload's `resets_at`

`tests/muse-passive-quota-cache.test.ts`:

- `recordPassiveAccountQuota` writes under the serving account key and
  `getCachedProviderAccountQuota` reads it back
- a stale `writerGeneration` discards the write
- `readPassiveProviderAccountQuotas` omits accounts with no observation
- the row persists and rehydrates after a simulated restart
- `hasPassiveAccountQuota("meta-muse")` is true while
  `supportsPerAccountQuota("meta-muse")` stays **false** — the exfiltration guard from
  wp4 must survive this phase
- `recordPassiveAccountQuota("anthropic", ...)` is a no-op

`tests/muse-passive-quota-observation.test.ts` — the seam, driven through
`createSseInspector` with a recorded transcript:

- a transcript containing the event invokes the handler exactly once
- a transcript without it never does
- the payload is delivered before the terminal frame is processed
- a handler that throws does not break the pump (guaranteed by `relay.ts:1021`; asserted
  so a future refactor cannot silently remove the guarantee)

No live call, no real Keychain, no network in any test.

## Verification

```bash
bun test tests/muse-subscription-usage.test.ts tests/muse-passive-quota-cache.test.ts \
         tests/muse-passive-quota-observation.test.ts tests/meta-muse-oauth.test.ts \
         tests/provider-account-quota.test.ts tests/oauth-accounts-api.test.ts \
         tests/core-lab-boundary.test.ts
bun run test:changed
bun x tsc --noEmit
bun run privacy:scan
```

`tests/core-lab-boundary.test.ts` is listed explicitly because this phase edits
`core.ts`, one of the three files it guards, and `test:changed` follows the import graph
from changed modules — it would select that test only if the boundary test itself
imports `core.ts`, which is not something to assume.

## Terminal outcome

`DONE` when a streaming `meta-muse` turn populates the serving account's five-hour and
weekly percentages, `/api/oauth/accounts?provider=meta-muse&quota=1` returns them, a
restart preserves the observation, and no code path issues an inference call to refresh a
quota.
