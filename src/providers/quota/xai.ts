import { XAI_GROK_CLIENT_VERSION, XAI_GROK_COMPATIBILITY } from "../xai-transport";
import { asRecord, normalizePercent, normalizeResetAt, readQuotaJson, REQUEST_TIMEOUT_MS, toFiniteNumber } from "../quota-wire";
import type { ProviderQuota, QuotaFailureCode } from "../quota-types";
import type { ProviderQuotaReport } from "./report-cache";

const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const XAI_CREDITS_URL = `${XAI_BILLING_URL}?format=credits`;
type XaiQuotaContext = { accessToken: string; upstreamAccountId?: string };
type QuotaRead = { quota: ProviderQuota; failure?: never } | { quota?: never; failure: QuotaFailureCode };
export type XaiQuotaProbeResult = { report: ProviderQuotaReport | null; failure?: QuotaFailureCode };

/** Decode JWT payload `sub` for xAI weekly credits when the stored credential lacks accountId. */
function xaiUserIdFromAccessToken(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { sub?: unknown };
    return typeof payload.sub === "string" && payload.sub.trim() ? payload.sub.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Grok Build weekly credits envelope:
 * `{ config: { creditUsagePercent?, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end } } }`.
 * Omitted percent is treated as 0 (proto3 default).
 */
export function parseXaiCreditsResponse(value: unknown): { percent: number; resetAt?: number } | null {
  const body = asRecord(value);
  const config = asRecord(body?.config);
  if (!config) return null;
  const period = asRecord(config.currentPeriod);
  if (!period || period.type !== "USAGE_PERIOD_TYPE_WEEKLY") return null;
  let percent = 0;
  if (config.creditUsagePercent !== undefined) {
    const normalized = normalizePercent(config.creditUsagePercent);
    if (normalized === undefined) return null;
    percent = normalized;
  }
  const resetAt = normalizeResetAt(period.end);
  return {
    percent,
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

function httpFailure(status: number): QuotaFailureCode {
  if (status >= 300 && status < 400) return "redirect_blocked";
  if (status === 401 || status === 403) return "access_denied";
  if (status === 429) return "rate_limited";
  return "upstream_error";
}

function transportFailure(error: unknown): QuotaFailureCode {
  const value = asRecord(error);
  if (value?.name === "TimeoutError" || value?.name === "AbortError") return "timeout";
  const code = value?.code ?? asRecord(value?.cause)?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns_failed";
  return "transport_error";
}

async function readQuota(
  url: string,
  headers: Record<string, string>,
  parse: (value: unknown) => ProviderQuota | null,
): Promise<QuotaRead> {
  try {
    const response = await fetch(url, {
      redirect: "error", headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      // Failure bodies may contain private upstream details; the status is sufficient.
      try { void response.body?.cancel().catch(() => undefined); } catch { /* best effort */ }
      return { failure: httpFailure(response.status) };
    }
    const quota = parse(await readQuotaJson(response));
    return quota ? { quota } : { failure: "response_unusable" };
  } catch (error) {
    return { failure: transportFailure(error) };
  }
}

function parseMonthlyQuota(value: unknown): ProviderQuota | null {
  const config = asRecord(asRecord(value)?.config);
  const limit = toFiniteNumber(asRecord(config?.monthlyLimit)?.val);
  const used = toFiniteNumber(asRecord(config?.used)?.val);
  if (limit === undefined || used === undefined || limit <= 0) return null;
  const percent = normalizePercent((used / limit) * 100);
  if (percent === undefined) return null;
  return { monthlyPercent: percent, monthlyResetAt: normalizeResetAt(config?.billingPeriodEnd), updatedAt: Date.now() };
}

/** Safe diagnosis is separate from quota validity, billing entitlement and account health. */
export async function probeXaiQuota(provider: string, context: XaiQuotaContext): Promise<XaiQuotaProbeResult> {
  const { accessToken } = context;
  const userId = context.upstreamAccountId?.trim() || xaiUserIdFromAccessToken(accessToken);
  let weeklyFailure: QuotaFailureCode | undefined;
  // Prefer the SuperGrok weekly credits window that actually gates prompting (#1283).
  if (userId) {
    const weekly = await readQuota(XAI_CREDITS_URL, {
      Accept: "application/json", Authorization: `Bearer ${accessToken}`,
      [XAI_GROK_COMPATIBILITY.headers.tokenAuth]: "xai-grok-cli",
      [XAI_GROK_COMPATIBILITY.headers.authenticateResponse]: "authenticate-response",
      "x-userid": userId,
      [XAI_GROK_COMPATIBILITY.headers.clientVersion]: XAI_GROK_CLIENT_VERSION,
    }, value => {
      const parsed = parseXaiCreditsResponse(value);
      return parsed ? { weeklyPercent: parsed.percent,
        ...(parsed.resetAt !== undefined ? { weeklyResetAt: parsed.resetAt } : {}), updatedAt: Date.now() } : null;
    });
    // Keep this wire reader off the report-cache facade's static import cycle.
    if (weekly.quota) return { report: (await import("./report-cache")).report(provider, "xai:grok-billing-credits", weekly.quota) };
    weeklyFailure = weekly.failure;
  }
  // Preserve legacy monthly fallback. A valid fallback clears a failed weekly diagnosis.
  const monthly = await readQuota(XAI_BILLING_URL,
    { Accept: "application/json", Authorization: `Bearer ${accessToken}` }, parseMonthlyQuota);
  if (monthly.quota) return { report: (await import("./report-cache")).report(provider, "xai:grok-billing", monthly.quota) };
  // An unusable legacy response must not erase the preferred weekly endpoint's failure.
  return { report: null, failure: weeklyFailure ?? monthly.failure };
}

/** Compatibility facade for provider-level callers which consume reports only. */
export async function fetchXaiQuota(provider: string, context: XaiQuotaContext): Promise<ProviderQuotaReport | null> {
  return (await probeXaiQuota(provider, context)).report;
}
