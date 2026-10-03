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
import { mintMuseApiKey, MuseDeviceLoginError } from "../oauth/meta-muse-device";
import { museUsageWindowsToQuota } from "./muse-subscription-usage";
import type { ProviderQuota, QuotaFailureCode } from "./quota-types";

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

export type MuseKeyQuotaOutcome =
  | { kind: "quota"; quota: ProviderQuota }
  | { kind: "empty" }
  | { kind: "terminal"; failure: QuotaFailureCode }
  | { kind: "transient"; failure: QuotaFailureCode }
  | { kind: "throttled"; quota: ProviderQuota | null };

export interface MuseKeyQuotaDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Keyed by account id: one account's rate limit must not silence another's. */
const backoffUntil = new Map<string, number>();
const backoffFailure = new Map<string, QuotaFailureCode>();
const lastSuccessAt = new Map<string, { at: number; quota: ProviderQuota | null }>();
/**
 * One in-flight probe per account.
 *
 * The TTL check alone is not atomic: `?refresh=1` and the reset poller can both pass it
 * before either writes `lastSuccessAt`, which would spend two mints inside one window.
 * Concurrent callers share the first request instead of racing it.
 */
const inFlight = new Map<string, Promise<MuseKeyQuotaOutcome>>();

/** Test seam only. */
export function resetMuseKeyQuotaBackoff(): void {
  backoffUntil.clear();
  backoffFailure.clear();
  lastSuccessAt.clear();
  inFlight.clear();
}

function stateKey(accountId: string, identity?: string): string {
  return `${accountId}\u0000${identity ?? ""}`;
}

export function museKeyQuotaBackoffRemainingMs(accountId: string, now = Date.now(), identity?: string): number {
  return Math.max(0, (backoffUntil.get(stateKey(accountId, identity)) ?? 0) - now);
}

export async function fetchMuseKeyQuotaOutcome(
  accountId: string,
  oauthAccessToken: string,
  deps: MuseKeyQuotaDeps = {},
  signal?: AbortSignal,
  identity?: string,
): Promise<MuseKeyQuotaOutcome> {
  const now = deps.now ?? Date.now;
  const at = now();
  const key = stateKey(accountId, identity);
  if (museKeyQuotaBackoffRemainingMs(accountId, at, identity) > 0) {
    const failure = backoffFailure.get(key) ?? "upstream_error";
    return { kind: failure === "access_denied" ? "terminal" : "transient", failure };
  }
  // Success spacing, enforced even for a forced refresh. See SUCCESS_TTL_MS.
  const last = lastSuccessAt.get(key);
  if (last && at - last.at < SUCCESS_TTL_MS) return { kind: "throttled", quota: last.quota };
  const running = inFlight.get(key);
  if (running) return await running;
  const attempt = probe(key, oauthAccessToken, deps, signal);
  inFlight.set(key, attempt);
  try {
    return await attempt;
  } finally {
    if (inFlight.get(key) === attempt) inFlight.delete(key);
  }
}

export async function fetchMuseKeyQuotaSnapshot(
  accountId: string,
  oauthAccessToken: string,
  deps: MuseKeyQuotaDeps = {},
  signal?: AbortSignal,
): Promise<ProviderQuota | null> {
  const outcome = await fetchMuseKeyQuotaOutcome(accountId, oauthAccessToken, deps, signal);
  return outcome.kind === "quota" ? outcome.quota : null;
}

async function probe(
  key: string,
  oauthAccessToken: string,
  deps: MuseKeyQuotaDeps,
  signal?: AbortSignal,
): Promise<MuseKeyQuotaOutcome> {
  const now = deps.now ?? Date.now;
  try {
    // No `onboard`: this is a read, not a login. Onboarding on a poll would be a
    // side effect on the user's account.
    const payload = await mintMuseApiKey(oauthAccessToken, {}, deps, signal);
    if (payload.isSubsActive === false || payload.requirePayment === true || payload.actionUrl) {
      markSuccess(null);
      return { kind: "empty" };
    }
    const quota = museUsageWindowsToQuota(payload.subsUsage);
    if (quota) {
      markSuccess(quota);
      return { kind: "quota", quota };
    }
    return fail("transient", "response_unusable");
  } catch (error) {
    // Every failure backs off, including 401/403. An expired account token cannot be
    // refreshed (001 A), so retrying it on the next poll is pure noise; the next real
    // request surfaces the auth problem through the existing reauth path.
    const failure = classifyFailure(error);
    return fail(failure === "access_denied" ? "terminal" : "transient", failure);
  }

  function fail(kind: "terminal" | "transient", failure: QuotaFailureCode): MuseKeyQuotaOutcome {
    backoffUntil.set(key, now() + FAILURE_BACKOFF_MS);
    backoffFailure.set(key, failure);
    return { kind, failure };
  }

  function markSuccess(quota: ProviderQuota | null): void {
    backoffUntil.delete(key);
    backoffFailure.delete(key);
    lastSuccessAt.set(key, { at: now(), quota });
  }
}

function classifyFailure(error: unknown): QuotaFailureCode {
  if (error instanceof MuseDeviceLoginError) {
    if (error.kind === "mint-rate-limited") return "rate_limited";
    if (error.kind === "mint-invalid") return "response_unusable";
    if (error.status === 401 || error.status === 403) return "access_denied";
    if (error.status !== undefined && error.status >= 300 && error.status < 400) return "redirect_blocked";
    return "upstream_error";
  }
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  return "transport_error";
}
