# 010 — Phase 1: the Kiro usage fetcher (foundation)

Work class: C3. Depends on: nothing. Everything else in this unit consumes its output.

## Goal

One function that turns a Kiro account's credential into a `ProviderQuota`, or into an
honest `null`.

## New file: `src/providers/kiro-usage.ts`

A separate module, not an addition to the already-2355-line `quota.ts`. It owns the wire
contract from doc `001` plus the Kiro usage-state seams from `070`. Complete export
surface:

- `kiroUsageManagementUrl(region)` — host construction (exported for tests).
- `fetchKiroUsageSnapshot(ctx)` — the probe.
- `kiroUsageContextForAccount(accountId)` — credential → context (`020`).
- `commitKiroAccountUsageState(key, state)` — called by `quota.ts` inside its existing
  commit guard.
- `getKiroAccountExhaustion(provider, accountId)` — the freshness-checked reader
  consumed by generic failover (`030`).
- `clearKiroAccountUsageState(provider?)` and `reconcileKiroAccountUsageState(liveKeys)`
  — called from `clearAccountQuotaCache` and `reconcileProviderAccountQuotaRows`.

```ts
export interface KiroUsageContext {
  accountId: string;     // keys the usage-state map; see 070
  access: string;
  profileArn?: string;   // request-scoped; Builder ID fallback allowed
  apiRegion?: string;
  ssoRegion?: string;
}

export interface KiroUsageSnapshot {
  quota: ProviderQuota;
  exhausted: boolean;      // limit reached AND overage not enabled
  nextResetAt?: number;    // epoch ms
}

export function kiroUsageManagementUrl(region: string): string;
export async function fetchKiroUsageSnapshot(ctx: KiroUsageContext): Promise<KiroUsageSnapshot | null>;
```

`subscriptionTitle` and `overageEnabled` are deliberately absent (audit round 1,
blocker 2): the first had no consumer and nowhere to render, the second is only an input
to `exhausted` and stays a local inside the parser.

**Prerequisite extraction (audit round 2, blockers 2 and 4).** Phase 1 first splits two
neutral modules out of `quota.ts`, so this module never imports `quota.ts` and the
dependency edge stays one-directional:

- `src/providers/quota-types.ts` — `ProviderQuota`, `ProviderQuotaWindow`,
  `ProviderQuotaCreditsUsd`, `ProviderQuotaReport`.
- `src/providers/quota-wire.ts` — `REQUEST_TIMEOUT_MS`, `normalizePercent`,
  `normalizeResetAt`, `toFiniteNumber`, `asRecord`, `readQuotaJson`.

Both are pure moves; `tests/provider-quota.test.ts` (107 pass today) proves inertness.

### Region resolution

```ts
const REGION_PATTERN = /^[a-z0-9-]{1,32}$/;
const safeRegion = (v: string | undefined): string | undefined =>
  v && REGION_PATTERN.test(v) ? v : undefined;

function usageRegion(ctx: KiroUsageContext): string {
  return safeRegion(ctx.profileArn?.split(":")[3])
    ?? safeRegion(ctx.apiRegion)
    ?? safeRegion(ctx.ssoRegion)
    ?? "us-east-1";
}
```

The ARN is authoritative because an enterprise profile can live in a different region from
the SSO session. The allowlist is not decoration: the region is interpolated into a
hostname, so an unvalidated value is a request-forgery primitive — and `apiRegion` /
`ssoRegion` come from external credential files
(`src/oauth/kiro-credentials.ts:285`), so **every** candidate goes through
`safeRegion`, not only the ARN (audit round 1, blocker 7).

### The request

POST to `https://management.<region>.kiro.dev/` with query `origin=AI_EDITOR`,
`isEmailRequired=true`, and `profileArn` when present; the same three in the JSON body;
headers per doc `001`; `x-amz-target: AmazonCodeWhispererService.GetUsageLimits`.
Bounded by `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` (8s, the existing constant).
Non-2xx → `null`. Body read through the existing `readQuotaJson` size/stall guard.

### Parsing

```ts
const RESOURCE_PRIORITY = ["AGENTIC_REQUEST", "CREDIT"] as const;
```

Select the first breakdown whose `resourceType` matches, in priority order. **No index
fallback** — that is kiro-lb gap #6. If neither is present, return `null` (unknown), which
the cache layer renders as "unavailable" rather than "0%".

Numbers prefer `currentUsageWithPrecision` / `usageLimitWithPrecision`, falling back to
the integer fields. Percent = `used / limit * 100`, run through the existing
`normalizePercent` (which clamps 0-100).

Mapping into `ProviderQuota`:

- The plan allowance is a **monthly** window: `monthlyPercent`, and `monthlyResetAt`
  from `nextDateReset` (seconds → ms via the existing `normalizeResetAt`, which already
  handles both scales).
- `freeTrialInfo` with a positive limit adds `customWindows: [{ label: "Free trial", percent }]`.
- `exhausted` and `nextResetAt` are carried on the snapshot for `030`'s cooldown
  seeder, through the generation-guarded usage-state map defined in `070`. Nothing else
  leaves this module.

`exhausted` = `used >= limit && !overageEnabled`. Overage-enabled accounts keep serving
past the limit (doc `001` rule 3), so exhaustion is not `percent >= 100`.

### Privacy

`userInfo.email` and `userInfo.userId` are **read and discarded**. They are never
returned, never cached, never logged. `privacy:scan` covers the file; the regression test
asserts the snapshot object contains no email even when the payload carries one.

## Accept criteria

| # | Scenario | Observable proof |
| --- | --- | --- |
| 1 | Enterprise payload with `AGENTIC_REQUEST` | `monthlyPercent` = 14.78 for 147.82/1000, `monthlyResetAt` set |
| 2 | Payload where `AGENTIC_REQUEST` is absent but `CREDIT` present | `CREDIT` selected, not index 0 |
| 3 | Payload with only an unknown `resourceType` | returns `null` (activation: proves no index fallback) |
| 4 | Precision and integer fields both present | precision wins (695.17, not 695) |
| 5 | `overageStatus: ENABLED` with used > limit | `exhausted === false`, percent clamped to 100 |
| 6 | `overageStatus: DISABLED` with used >= limit | `exhausted === true` |
| 7 | `freeTrialInfo` present | a "Free trial" custom window appears |
| 8 | Response carries `userInfo.email` | serialized snapshot contains no email substring |
| 9 | Profile ARN region differs from `apiRegion` | request host uses the ARN region |
| 10 | Malformed ARN region (`../evil`) | falls back to `apiRegion`; host never contains the injected text |
| 10b | Malformed `apiRegion` and `ssoRegion` too | falls back to `us-east-1`; host never contains injected text |
| 11 | HTTP 401/429/500 | resolves `null`, does not throw |

## Verifier

`bun test tests/kiro-usage-quota.test.ts` (new file), plus `bun x tsc --noEmit`.
Both run against this exact file. Confirmed present: `bun` resolves and `tests/` is a flat
suite directory, so a new `tests/*.test.ts` is picked up with no config change.

## Out of scope for this phase

No caching, no account iteration, no routing, no surfaces. This phase ends with a pure
function and its tests.
