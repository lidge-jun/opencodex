/**
 * Kiro usage limits — the account-scoped quota read behind the Kiro pool.
 *
 * Kiro's generation traffic goes to `runtime.<region>.kiro.dev`, but the usage numbers
 * live behind a different subdomain and a different AWS JSON-RPC operation:
 * `AmazonCodeWhispererService.GetUsageLimits` on `management.<region>.kiro.dev`. The
 * operation is undocumented, so every field here is best-effort: a shape we do not
 * recognise resolves to `null` ("unknown"), never to a fabricated zero.
 *
 * This module also owns the small amount of state that quota percentages cannot express —
 * whether an account is actually out of allowance, and when its window rolls over — because
 * the pool needs those two answers to decide how long to cool a 429'd account.
 */
import { getValidAccessSnapshotForAccount } from "../oauth";
import type { ProviderQuota, ProviderQuotaWindow } from "./quota-types";
import {
  ACCOUNT_QUOTA_TTL_MS,
  asRecord,
  normalizePercent,
  normalizeResetAt,
  QUOTA_JSON_READ_FAILURE,
  readQuotaJson,
  REQUEST_TIMEOUT_MS,
  toFiniteNumber,
} from "./quota-wire";

const AMZ_USAGE_TARGET = "AmazonCodeWhispererService.GetUsageLimits";

/**
 * Regions are interpolated into a hostname, and two of the three candidates below are read
 * out of credential files this process did not write. An allowlist keeps a crafted region
 * from redirecting the request somewhere else entirely.
 */
const REGION_PATTERN = /^[a-z0-9-]{1,32}$/;

/**
 * Which usage bucket represents the plan allowance, in preference order.
 *
 * Selecting by position instead would mean an upstream reordering silently reweights the
 * pool against an unrelated resource, so an unrecognised list resolves to unknown.
 */
const RESOURCE_PRIORITY = ["AGENTIC_REQUEST", "CREDIT"] as const;

export interface KiroUsageContext {
  /** Keys the usage-state row; always the stored account id, never the active account. */
  accountId: string;
  access: string;
  profileArn?: string;
  apiRegion?: string;
  ssoRegion?: string;
}

export interface KiroUsageSnapshot {
  quota: ProviderQuota;
  /** Allowance is spent AND overage is not enabled — not merely "percent hit 100". */
  exhausted: boolean;
  /** Epoch ms when the plan window rolls over, when upstream reports it. */
  nextResetAt?: number;
}

interface KiroUsageStateEntry {
  exhausted: boolean;
  nextResetAt?: number;
  ts: number;
}

/**
 * Exhaustion state, keyed exactly like the per-account quota cache in `quota.ts`.
 *
 * It is written only inside that cache's commit guard and cleared through the same
 * logout/reconcile paths, so a removed account cannot leave a verdict behind for whatever
 * account replaces it.
 */
const usageState = new Map<string, KiroUsageStateEntry>();

function safeRegion(value: string | undefined): string | undefined {
  return value && REGION_PATTERN.test(value) ? value : undefined;
}

/**
 * The profile ARN wins because an enterprise profile can live in a different region from
 * the SSO session that minted the token.
 */
function usageRegion(ctx: KiroUsageContext): string {
  return safeRegion(ctx.profileArn?.split(":")[3])
    ?? safeRegion(ctx.apiRegion)
    ?? safeRegion(ctx.ssoRegion)
    ?? "us-east-1";
}

export function kiroUsageManagementUrl(region: string): string {
  return `https://management.${region}.kiro.dev/`;
}

/** Credit balances are fractional; the integer fields round 695.17 down to 695. */
function preciseNumber(row: Record<string, unknown>, precise: string, whole: string): number | undefined {
  return toFiniteNumber(row[precise]) ?? toFiniteNumber(row[whole]);
}

function selectBreakdown(list: unknown): Record<string, unknown> | null {
  if (!Array.isArray(list)) return null;
  const rows = list.map(asRecord).filter((row): row is Record<string, unknown> => row !== null);
  for (const wanted of RESOURCE_PRIORITY) {
    const match = rows.find(row => String(row.resourceType ?? "").trim().toUpperCase() === wanted);
    if (match) return match;
  }
  return null;
}

function parseKiroUsage(body: unknown): KiroUsageSnapshot | null {
  const payload = asRecord(body);
  if (!payload) return null;
  const breakdown = selectBreakdown(payload.usageBreakdownList);
  if (!breakdown) return null;

  const used = preciseNumber(breakdown, "currentUsageWithPrecision", "currentUsage");
  const limit = preciseNumber(breakdown, "usageLimitWithPrecision", "usageLimit");
  if (used === undefined || limit === undefined || limit <= 0) return null;

  const percent = normalizePercent((used / limit) * 100);
  if (percent === undefined) return null;

  const nextResetAt = normalizeResetAt(payload.nextDateReset);
  const customWindows: ProviderQuotaWindow[] = [];

  // A trial allowance is a separate pool: folding it into the plan window would understate
  // what the account can actually spend.
  const trial = asRecord(breakdown.freeTrialInfo);
  if (trial) {
    const trialUsed = preciseNumber(trial, "currentUsageWithPrecision", "currentUsage");
    const trialLimit = preciseNumber(trial, "usageLimitWithPrecision", "usageLimit");
    if (trialUsed !== undefined && trialLimit !== undefined && trialLimit > 0) {
      const trialPercent = normalizePercent((trialUsed / trialLimit) * 100);
      if (trialPercent !== undefined) customWindows.push({ label: "Free trial", percent: trialPercent });
    }
  }

  const quota: ProviderQuota = {
    monthlyPercent: percent,
    ...(nextResetAt !== undefined ? { monthlyResetAt: nextResetAt } : {}),
    ...(customWindows.length > 0 ? { customWindows } : {}),
    updatedAt: Date.now(),
  };

  // Enterprise accounts with overage enabled keep serving past the included limit, so
  // "used >= limit" is not by itself a reason to stop routing to the account.
  const overageEnabled = String(asRecord(payload.overageConfiguration)?.overageStatus ?? "")
    .trim()
    .toUpperCase() === "ENABLED";

  return {
    quota,
    exhausted: used >= limit && !overageEnabled,
    ...(nextResetAt !== undefined ? { nextResetAt } : {}),
  };
}

/**
 * Read one account's usage. Resolves `null` for any transport, status, or schema failure —
 * the caller renders that as "unavailable" and keeps whatever it knew before.
 *
 * `userInfo` in the response carries an email and a user id. Both are read past and
 * discarded here: nothing identifying an operator's person reaches the cache, the API, or
 * a log line.
 */
export async function fetchKiroUsageSnapshot(ctx: KiroUsageContext): Promise<KiroUsageSnapshot | null> {
  const region = usageRegion(ctx);
  const url = new URL(kiroUsageManagementUrl(region));
  url.searchParams.set("origin", "AI_EDITOR");
  url.searchParams.set("isEmailRequired", "true");
  if (ctx.profileArn) url.searchParams.set("profileArn", ctx.profileArn);

  // The modeled arguments appear in BOTH the query string and the body. That duplication is
  // the observed Kiro CLI contract, not an oversight; we have no way to test which side the
  // service actually reads, so we reproduce both.
  const body: Record<string, unknown> = { origin: "AI_EDITOR", isEmailRequired: true };
  if (ctx.profileArn) body.profileArn = ctx.profileArn;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.access}`,
        "content-type": "application/x-amz-json-1.0",
        accept: "application/json",
        "x-amz-target": AMZ_USAGE_TARGET,
        "x-amzn-codewhisperer-optout": "true",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const json = await readQuotaJson(response);
    if (json === QUOTA_JSON_READ_FAILURE) return null;
    return parseKiroUsage(json);
  } catch {
    return null;
  }
}

/**
 * Assemble the probe context from ONE account-scoped snapshot.
 *
 * Reading the bearer and the routing metadata from a single snapshot is what keeps account
 * A's token from being sent with account B's profile ARN — the same pairing class of defect
 * #2841 fixed for Copilot origins.
 */
export async function kiroUsageContextForAccount(accountId: string): Promise<KiroUsageContext> {
  const snapshot = await getValidAccessSnapshotForAccount("kiro", accountId);
  return {
    accountId,
    access: snapshot.accessToken,
    ...(snapshot.kiro?.profileArn ? { profileArn: snapshot.kiro.profileArn } : {}),
    ...(snapshot.kiro?.apiRegion ? { apiRegion: snapshot.kiro.apiRegion } : {}),
    ...(snapshot.kiro?.ssoRegion ? { ssoRegion: snapshot.kiro.ssoRegion } : {}),
  };
}

/** Record exhaustion for a probed account. Called from the quota cache's commit guard. */
export function commitKiroAccountUsageState(key: string, snapshot: KiroUsageSnapshot | null): void {
  if (!snapshot) {
    usageState.delete(key);
    return;
  }
  usageState.set(key, {
    exhausted: snapshot.exhausted,
    ...(snapshot.nextResetAt !== undefined ? { nextResetAt: snapshot.nextResetAt } : {}),
    ts: Date.now(),
  });
}

/**
 * Is this account known to be out of allowance right now?
 *
 * Returns `null` (unknown) rather than a stale `true`: an expired reading, or one whose
 * reset time has already passed, must degrade to "try it again", never to "keep it parked".
 */
export function getKiroAccountExhaustion(
  key: string,
  now = Date.now(),
): { exhausted: boolean; nextResetAt?: number } | null {
  const entry = usageState.get(key);
  if (!entry) return null;
  if (now - entry.ts >= ACCOUNT_QUOTA_TTL_MS) return null;
  if (entry.nextResetAt !== undefined && entry.nextResetAt <= now) return null;
  return {
    exhausted: entry.exhausted,
    ...(entry.nextResetAt !== undefined ? { nextResetAt: entry.nextResetAt } : {}),
  };
}

/** Drop rows for one provider prefix, or all of them. Mirrors clearAccountQuotaCache. */
export function clearKiroAccountUsageState(prefix?: string): void {
  if (!prefix) {
    usageState.clear();
    return;
  }
  for (const key of [...usageState.keys()]) {
    if (key.startsWith(prefix)) usageState.delete(key);
  }
}

/** Drop rows whose account no longer exists. Mirrors reconcileProviderAccountQuotaRows. */
export function reconcileKiroAccountUsageState(liveKeys: ReadonlySet<string>): number {
  let removed = 0;
  for (const key of [...usageState.keys()]) {
    if (liveKeys.has(key)) continue;
    usageState.delete(key);
    removed += 1;
  }
  return removed;
}
