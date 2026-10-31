import { markAnthropicFamilyEnumeration } from "./quota/anthropic-family-headers";
import { rawAnthropicUsageWindows } from "./quota/anthropic-decision-windows";
import { anthropicUsageBuckets } from "./quota/anthropic-usage-windows";
import { bindRawDecisionWindows } from "./quota-decision-publication";
import { decisionQuotaSinkActive } from "../lib/decision-quota-sink";
import { CLAUDE_CLI_USER_AGENT } from "./claude-cli-identity";
import { asRecord, normalizePercent, normalizeResetAt, readQuotaJson, REQUEST_TIMEOUT_MS } from "./quota-wire";
import type { ProviderQuota, ProviderQuotaWindow, QuotaFailureCode } from "./quota-types";
import { httpQuotaFailure } from "./quota/failure-codes";
const hasQuotaRows = (q: ProviderQuota) => q.fiveHourPercent !== undefined || q.weeklyPercent !== undefined || Boolean(q.customWindows?.length);

/** Read the Anthropic OAuth usage endpoint for an access token and return the parsed quota, or null on a non-OK or malformed response. */
export async function readAnthropicUsageQuota(accessToken: string): Promise<ProviderQuota | null> {
  return (await probeAnthropicUsageQuota(accessToken)).quota;
}

/** A usage read plus, when it yields no quota, the closed reason why. A thrown fetch still throws. */
export interface AnthropicUsageProbe {
  quota: ProviderQuota | null;
  failure?: QuotaFailureCode;
}

export async function probeAnthropicUsageQuota(accessToken: string): Promise<AnthropicUsageProbe> {
  const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "User-Agent": CLAUDE_CLI_USER_AGENT,
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05",
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* Best-effort release; the status is the diagnosis. */ }
    return { quota: null, failure: httpQuotaFailure(response.status) };
  }
  const body = asRecord(await readQuotaJson(response));
  if (!body) return { quota: null, failure: "response_unusable" };
  const { buckets, familyEnumeration } = anthropicUsageBuckets(body);
  const shared: Partial<ProviderQuota> = {};
  const customWindows: ProviderQuotaWindow[] = [];
  for (const { window, row, percentField } of buckets) {
    const percent = normalizePercent(row[percentField]);
    const resetAt = normalizeResetAt(row.resets_at);
    if (window === "5h" || window === "weekly") {
      if (percent !== undefined) shared[window === "5h" ? "fiveHourPercent" : "weeklyPercent"] = percent;
      if (resetAt !== undefined) shared[window === "5h" ? "fiveHourResetAt" : "weeklyResetAt"] = resetAt;
    } else if (percent !== undefined) {
      const label = { fable: "Fable", opus: "Opus", sonnet: "Sonnet" }[window];
      customWindows.push({ label, scope: "model", percent, ...(resetAt !== undefined ? { resetAt } : {}) });
    }
  }
  const quota: ProviderQuota = {
    ...shared,
    ...(customWindows.length > 0 ? { customWindows } : {}),
    updatedAt: Date.now(),
  };
  if (decisionQuotaSinkActive()) bindRawDecisionWindows(quota, rawAnthropicUsageWindows(body, quota.updatedAt));
  // Empty / schema-changed payloads must not cache as "success with no bars".
  if (!hasQuotaRows(quota)) return { quota: null, failure: "response_unusable" };
  return { quota: markAnthropicFamilyEnumeration(quota, familyEnumeration) };
}

