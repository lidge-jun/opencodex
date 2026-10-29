/**
 * The quota windows this instance's upstream accounts report about themselves.
 *
 * `/v1/usage` answers with a hub's cost-and-token summary, scoped to the calling
 * data key. This companion route answers a different question - how full are the
 * subscription windows the instance routes through (an Anthropic 5-hour bar, a
 * Cursor monthly bar) - with the small windows-only body an upstream usage poller
 * decodes. The windows belong to the upstream accounts, not to the caller's key,
 * so there is no per-key scoping to get wrong: admission only proves the caller
 * holds a real secret (a configured data key, or the instance's own environment
 * token, exactly the two kinds the chat routes admit), and the body carries
 * percentages and reset times only - no account id, no label, no upstream text.
 */
import type { OcxConfig } from "../types";
import { cachedProviderQuotaIsExhausted } from "../combos/resolve";
import { authorizationCredential } from "../lib/authorization-scheme";
import { accountQuotaCache, hydrateAccountQuotaCache } from "../providers/quota/account-cache";
import { isAllowedRequestOrigin, resolveDataPlaneAdmissionSecret, withCors, type DataPlaneAdmissionOptions, type RequestPolicyView } from "./auth-cors";

/** One window of the public body. `resetsAt` is epoch millis, as the poller contract names it. */
interface UsageWindow {
  label: string;
  percent: number;
  limited: boolean;
  resetsAt: number;
}

/** Slot names order the public list; the display label is separate (custom windows name themselves). */
const SLOT_ORDER: Record<string, number> = { "5-hour": 0, weekly: 1, monthly: 2, custom: 3 };

function displayName(provider: string): string {
  return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : provider;
}

function finitePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, value));
}

function futureReset(value: unknown, now: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= now) return undefined;
  if (!Number.isFinite(new Date(value).getTime())) return undefined;
  return value;
}

/**
 * Merge one account's quota into the shared window map.
 *
 * Every window must carry a reset time still in the future: a percentage without
 * a bounded window can go stale silently, and a rolled-over window's reading
 * describes an allowance that already renewed. Where several accounts of one
 * provider report the same slot, the fullest reading wins - the caller is asking
 * "can this subscription still serve me", and the answer is only as good as the
 * most-used account rotation might land on.
 */
function collectWindow(
  windows: Map<string, UsageWindow>,
  provider: string,
  slot: string,
  label: string,
  percent: number | undefined,
  resetAt: number | undefined,
  exhausted: boolean,
): void {
  if (percent === undefined) return;
  const reset = futureReset(resetAt, Date.now());
  if (reset === undefined) return;
  const key = `${provider}\u0000${slot}\u0000${label}`;
  const previous = windows.get(key);
  if (!previous) {
    windows.set(key, { label: `${displayName(provider)} ${label}`, percent, limited: exhausted, resetsAt: reset });
    return;
  }
  if (percent > previous.percent) {
    previous.percent = percent;
    previous.resetsAt = reset;
  }
  if (exhausted) previous.limited = true;
}

/** Read only the windows of explicitly authenticated upstream accounts. */
export async function handleHubUsageWindows(req: Request, config: OcxConfig, policy: RequestPolicyView): Promise<Response> {
  const reply = (body: unknown, status = 200) => withCors(Response.json(body, {
    status, headers: { "cache-control": "no-store" },
  }), req, policy);
  const error = (code: string, message: string, status: number) => reply({ error: { code, message } }, status);
  const token = req.headers.get("x-opencodex-api-key")?.trim() || authorizationCredential(req.headers)?.trim() || "";
  const options: DataPlaneAdmissionOptions = { linkIngress: policy.linkIngress?.allowedKeyIds };
  // Unlike `/v1/usage` there is no caller-scoped fact to protect, so the stricter
  // configured-only rule there is not repeated here: either admitted secret works.
  const admission = resolveDataPlaneAdmissionSecret(token, config, "dedicated", options);
  if (!admission) return error("usage_windows_unauthorized", "A client data key is required", 401);
  if (!isAllowedRequestOrigin(req, policy)) return error("origin_rejected", "Cross-origin request blocked", 403);
  hydrateAccountQuotaCache();
  const now = Date.now();
  const windows = new Map<string, UsageWindow>();
  for (const [key, entry] of accountQuotaCache) {
    const separator = key.indexOf("\u0000");
    if (separator < 0) continue;
    const provider = key.slice(0, separator);
    const quota = entry.quota;
    if (!quota) continue;
    const exhausted = cachedProviderQuotaIsExhausted(quota, now);
    collectWindow(windows, provider, "5-hour", "5-hour", finitePercent(quota.fiveHourPercent), quota.fiveHourResetAt, exhausted);
    collectWindow(windows, provider, "weekly", "Weekly", finitePercent(quota.weeklyPercent), quota.weeklyResetAt, exhausted);
    collectWindow(windows, provider, "monthly", "Monthly", finitePercent(quota.monthlyPercent), quota.monthlyResetAt, exhausted);
    // Per-model rows duplicate a family bar the dialog already shows; vendor-level
    // custom windows (Cursor's "First-party models") are the subscription truth.
    for (const custom of quota.customWindows ?? []) {
      if (custom.modelId !== undefined) continue;
      if (custom.rejected === true && custom.resetAt === undefined) continue;
      collectWindow(windows, provider, "custom", custom.label, finitePercent(custom.percent), custom.resetAt, exhausted || (custom.rejected === true));
    }
  }
  const body = {
    windows: [...windows.entries()].sort((a, b) => {
      const [keyA, windowA] = a;
      const [keyB, windowB] = b;
      return (SLOT_ORDER[keyA.split("\u0000")[1]!] ?? 9) - (SLOT_ORDER[keyB.split("\u0000")[1]!] ?? 9)
        || windowA.label.localeCompare(windowB.label);
    }).map(([, window]) => window),
  };
  return reply(body);
}
