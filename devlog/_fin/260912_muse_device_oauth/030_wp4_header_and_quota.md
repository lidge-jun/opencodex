# wp4 — the version header, and quota on demand

Two independent changes, both enabled by wp3's stored account token.

**MODIFY** `src/providers/registry.ts` — `staticHeaders`, and the quota sentence in the note
**MODIFY** `src/providers/muse-subscription-usage.ts` — extract the shared window mapper
**NEW** `src/providers/muse-key-quota.ts` — the mint-endpoint probe
**MODIFY** `src/providers/quota.ts` — one new wrapper, one changed dispatch line

## A. `x-api-version` on the wire

```
  {
    id: "meta-muse",
    label: "Meta Muse Code (CLI credential)",
    adapter: "openai-responses",
    baseUrl: "https://api.meta.ai/v1",
+   // Meta's own client sends this on every Muse Code call (001 A). We have never sent
+   // it, so a future server-side requirement would break every Muse request with no
+   // local signal. Declared here rather than in a transport hook so it also covers
+   // model discovery (src/oauth/index.ts:1176) and still yields to a user-set header
+   // (mergeRegistryStaticHeaders, src/providers/registry.ts:3494).
+   staticHeaders: { "x-api-version": "1.0.0" },
    authKind: "oauth",
    oauthId: "meta-muse",
```

That is the whole change. The path it travels is already built: `src/router.ts:332` merges
`staticHeaders` into `provider.headers`, `src/adapters/openai-responses.ts:2365` assigns
`provider.headers` onto the outbound request after `Authorization`, and
`src/providers/derive.ts:236` seeds the same headers into a provider entry written at first
login. `opencode-free` (`registry.ts:3198-3210`) is the working precedent for the field.

`meta-model`, the pay-as-you-go sibling on the same `api.meta.ai/v1` base URL, is
deliberately NOT changed here — it is a different credential class and out of this unit's
scope. `040` records it as a follow-up.

## B. The shared usage mapper

The mint response's `subs_usage` and the in-stream frame's `subscription` carry the same
two windows with the same field names (`001` §C). One mapper, two callers.

In `src/providers/muse-subscription-usage.ts`, the body of `parseMuseSubscriptionUsage`
moves into a new exported function and the old entry point becomes a two-line adapter:

```
+/**
+ * Map Meta's `{ window?, weekly? }` usage object onto a ProviderQuota.
+ *
+ * Shared deliberately: the streaming frame nests it under `subscription`, the
+ * muse-code/key response under `subs_usage` (001 C). Two parsers would drift, and the
+ * five-hour-window discrimination below is the part that must not.
+ */
+export function museUsageWindowsToQuota(usage: unknown): ProviderQuota | null {
+  const subscription = asRecord(usage);
+  if (!subscription) return null;
+  // ... body of today's parseMuseSubscriptionUsage from `const quota` to the final
+  // `return sawWindow ? quota : null;`, unchanged, including every comment
+}
+
 export function parseMuseSubscriptionUsage(payload: unknown): ProviderQuota | null {
-  const subscription = asRecord(asRecord(payload)?.subscription);
-  if (!subscription) return null;
-  ... existing body ...
+  return museUsageWindowsToQuota(asRecord(payload)?.subscription);
 }
```

Behaviour-preserving by construction. `tests/providers/muse-subscription-usage.test.ts`
must pass **unmodified**; if it does not, the extraction is wrong.

## C. `src/providers/muse-key-quota.ts`

```ts
/**
 * On-demand Muse Code quota, read from the subscription key endpoint.
 *
 * Until now this provider's quota could only be OBSERVED: Meta publishes no quota
 * endpoint (17 REST paths probed, all 404 — devlog/_fin/260903_muse_spark_plan_oauth/003
 * E), so the only measurement arrived mid-stream and a dashboard load could not refresh
 * it without spending an inference turn (src/providers/quota.ts:1606-1613).
 *
 * A device-logged-in account changes that, because it holds the Meta ACCOUNT token and the
 * key-mint response carries `subs_usage` (001 B-C). That makes this an auth-plane read,
 * not an inference call.
 *
 * Three properties matter:
 *
 * 1. NEVER THROWS. A quota probe runs behind a dashboard poll. A failure must cost a row,
 *    not a page.
 * 2. BACKS OFF. The mint endpoint is rate-limited, and this is the first quota source in
 *    this repository with a real failure backoff — quota.ts:2171 negative-caches by TTL,
 *    which is not the same thing.
 * 3. DISCARDS THE KEY. The response contains `api_key`. It is never read here, never
 *    logged, and never returned.
 */
import { mintMuseApiKey } from "../oauth/meta-muse-device";
import { museUsageWindowsToQuota } from "./muse-subscription-usage";
import type { ProviderQuota } from "./quota-types";

/** Matches the reference implementation's own bound for the same endpoint. */
const FAILURE_BACKOFF_MS = 5 * 60_000;

/**
 * [audit fold] Minimum spacing between two SUCCESSFUL mints for one account.
 *
 * A failure backoff alone is not enough. Two callers bypass the ordinary quota cache:
 * GET /api/provider-quotas?refresh=1 (src/server/management/provider-routes.ts:747-748)
 * and the reset poller, which forces every tick (src/quota/reset-poller.ts:83). Without
 * this, a user holding down a refresh button would drive one key-mint per click.
 *
 * This TTL is deliberately NOT conditioned on forceRefresh: a forced refresh may skip a
 * display cache, but it may not spend another mint. When the TTL holds, the probe returns
 * null and the caller serves the row this probe already wrote to the account cache.
 */
const SUCCESS_TTL_MS = 5 * 60_000;

export interface MuseKeyQuotaDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Keyed by account id: one account's rate limit must not silence another's. */
const backoffUntil = new Map<string, number>();
const lastSuccessAt = new Map<string, number>();

/** Test seam only. */
export function resetMuseKeyQuotaBackoff(): void {
  backoffUntil.clear();
  lastSuccessAt.clear();
}

export function museKeyQuotaBackoffRemainingMs(accountId: string, now = Date.now()): number {
  return Math.max(0, (backoffUntil.get(accountId) ?? 0) - now);
}

export async function fetchMuseKeyQuotaSnapshot(
  accountId: string,
  oauthAccessToken: string,
  deps: MuseKeyQuotaDeps = {},
  signal?: AbortSignal,
): Promise<ProviderQuota | null> {
  const now = deps.now ?? Date.now;
  const at = now();
  if (museKeyQuotaBackoffRemainingMs(accountId, at) > 0) return null;
  // Success spacing, enforced even for a forced refresh. See SUCCESS_TTL_MS.
  const last = lastSuccessAt.get(accountId);
  if (last !== undefined && at - last < SUCCESS_TTL_MS) return null;
  try {
    // No `onboard`: this is a read, not a login. Onboarding on a poll would be a
    // side effect on the user's account.
    const payload = await mintMuseApiKey(oauthAccessToken, {}, deps, signal);
    backoffUntil.delete(accountId);
    lastSuccessAt.set(accountId, now());
    if (payload.isSubsActive === false) return null;
    return museUsageWindowsToQuota(payload.subsUsage);
  } catch {
    // Every failure backs off, including 401/403. An expired account token cannot be
    // refreshed (001 A), so retrying it on the next poll is pure noise; the next real
    // request surfaces the auth problem through the existing reauth path.
    backoffUntil.set(accountId, now() + FAILURE_BACKOFF_MS);
    return null;
  }
}
```

## D. `src/providers/quota.ts`

### The wrapper, placed immediately above `fetchPassiveProviderQuota`

```ts
/**
 * Provider-level row probed from the key endpoint, for an account that can be probed.
 *
 * Written through the same account cache the passive path reads, so the measurement
 * survives a restart and the per-account rows at oauth-account-routes.ts:313 pick it up
 * without any mode change.
 */
async function fetchMuseKeyQuota(provider: string): Promise<ProviderQuotaReport | null> {
  const probedAccountId = getAccountSet(provider)?.activeAccountId;
  if (!probedAccountId) return null;
  const oauthAccessToken = getAccountCredential(provider, probedAccountId)?.muse?.oauthAccessToken;
  // An imported or pasted credential has no account token and never will: it is
  // capability, not provider id, that decides whether a probe is possible (002 C).
  if (!oauthAccessToken) return null;
  const probedAccountKey = accountCacheKey(provider, probedAccountId);
  const writerGeneration = captureConfigGeneration();
  const quota = await fetchMuseKeyQuotaSnapshot(probedAccountId, oauthAccessToken);
  if (!quota) return null;
  if (mayCommitAccountQuotaKey(probedAccountKey, writerGeneration)) {
    // Hydrate before writing, for the same reason recordPassiveAccountQuota does:
    // persistAccountQuotaCache serializes the whole map.
    hydrateAccountQuotaCache();
    accountQuotaCache.set(probedAccountKey, { ts: Date.now(), quota });
    persistAccountQuotaCache();
  }
  return report(provider, `${provider}:key-endpoint`, quota);
}
```

### The dispatch line (`quota.ts:3035-3037`)

```
-    // Passive providers (meta-muse): Meta publishes no quota endpoint, so there is no
-    // probe to run — the row is the active account's last in-band observation.
-    if (provider.authMode === "oauth" && hasPassiveAccountQuota(name)) return fetchPassiveProviderQuota(name);
+    // meta-muse: a device-logged-in account can be probed at the key endpoint; an
+    // imported or pasted one cannot, and falls back to its last in-band observation.
+    // The probe is tried first and its failure is never fatal to the row.
+    if (provider.authMode === "oauth" && hasPassiveAccountQuota(name)) {
+      return (await fetchMuseKeyQuota(name)) ?? await fetchPassiveProviderQuota(name);
+    }
```

### What is deliberately NOT changed

`providerOAuthAccountQuotaMode` (`quota.ts:1769-1771`) keeps returning `"passive"` for
`meta-muse`, and `supportsPerAccountQuota` (`quota.ts:1760`) keeps excluding it. Flipping
the mode looks tempting and is a regression: `src/server/management/oauth-account-routes.ts:313`
uses the mode to choose `readPassiveProviderAccountQuotas`, and the probed per-account path
it would switch to is gated on `supportsPerAccountQuota`, which has no `meta-muse` reader.
The GUI account list would go from showing observations to showing nothing.

Writing the probe result into the account cache achieves the goal without that risk: the
passive per-account reader serves a *probed* row transparently. The existing assertion
`expect(providerOAuthAccountQuotaMode("meta-muse")).toBe("passive")`
(`tests/providers/provider-account-quota.test.ts:506`) therefore stays valid and unedited.

`observed: true` is also not set on the probed report. That tag means "not probed"
(`quota.ts:1624-1626`), and `tests/providers/provider-quota-observed-marker.test.ts` depends
on the distinction.

## E. The note sentence that becomes false

In the `meta-muse` registry note, this clause must change with the code:

| Current | Replacement |
|---|---|
| "OpenCodex reads Meta's subscription windows from streaming responses and shows the last observed value with its age; there is no endpoint to query them on demand, so refreshing one requires another streaming turn, and translated (non-passthrough) turns report none." | "For an account signed in with the device login, OpenCodex refreshes Meta's subscription windows on demand from the key endpoint. For an imported or pasted key it can only show the last value observed on a streaming turn, with its age, and translated (non-passthrough) turns report none." |

`tests/ci-workflows/docs-provider-billing-claims.test.ts:45` checks the billing claim for
this provider, not the quota sentence; confirm it still passes rather than assuming it.

## F. Risks specific to this phase

| Risk | Disposition |
|---|---|
| Calling the mint endpoint rotates the key | `001` §B records that Meta returns the same key for an account, which is why the reference reuses the endpoint the same way. If it ever rotated, the stored key would 401 and the existing reauth path would surface it; the probe still never writes a key. |
| The probe counts against the subscription | Auth-plane call per `001` §B, and rate-limited on BOTH outcomes: at most one success and one failure attempt per account per 5 minutes, enforced even when the caller forces a refresh. Never invoked on the request path. |
| A held-down refresh button, or the reset poller, drives repeated mints | `SUCCESS_TTL_MS` ignores `forceRefresh` by design. Verified callers: `provider-routes.ts:747-748` (`?refresh=1`) and `reset-poller.ts:83` (`force=true` per tick). |
| `subs_usage` absent on a non-onboarding mint | `museUsageWindowsToQuota` returns `null`, the wrapper returns `null`, and the passive row is served. Absence is never rendered as zero usage. |
