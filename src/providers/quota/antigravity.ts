import { antigravityUserAgent } from "../../adapters/client-fingerprint";
import { DestinationDnsResolutionError } from "../../lib/destination-policy";
import { PinnedHttpError, type PinnedHttpErrorCode } from "../../lib/pinned-http";
import { ProviderOutboundPolicyError, providerOutboundPost, providerRedirectError, type ProviderOutboundDependencies } from "../../lib/provider-outbound";
import { getValidAccessToken } from "../../oauth";
import { getAccountCredential, getCredential } from "../../oauth/store";
import { asRecord, normalizePercent, normalizeResetAt, readQuotaJson, REQUEST_TIMEOUT_MS, toFiniteNumber } from "../quota-wire";
import { report, type ProviderQuotaReport } from "./report-cache";
import { quotaCredentialIdentity } from "./account-cache";
import type { ProviderQuota, ProviderQuotaWindow, QuotaFailureCode } from "../quota-types";

export function antigravityQuotaDiagnosticIdentity(accountId: string, credential = getAccountCredential("google-antigravity", accountId)): string | undefined {
  return credential ? quotaCredentialIdentity("google-antigravity", accountId, credential, {
    adapter: "google", baseUrl: ANTIGRAVITY_ACCOUNT_QUOTA_BASE, authMode: "oauth",
  }) : undefined;
}


function quotaInfoEntries(modelInfo: Record<string, unknown>): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  const add = (value: unknown, tier?: string) => {
    const rec = asRecord(value);
    if (!rec) return;
    entries.push(tier ? { ...rec, tier } : rec);
  };
  const addArray = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const entry of value) add(entry);
  };

  if (Array.isArray(modelInfo.quotaInfo)) addArray(modelInfo.quotaInfo);
  else add(modelInfo.quotaInfo);
  addArray(modelInfo.quotaInfos);

  const byTier = asRecord(modelInfo.quotaInfoByTier);
  if (byTier) {
    for (const [tier, value] of Object.entries(byTier)) {
      if (Array.isArray(value)) {
        for (const entry of value) add(entry, tier);
      } else {
        add(value, tier);
      }
    }
  }
  return entries;
}

function classifyAntigravityFamily(modelId: string, modelInfo: Record<string, unknown>, quotaInfo: Record<string, unknown>): "Gem" | "Cla" | null {
  const displayName = typeof modelInfo.displayName === "string" ? modelInfo.displayName : "";
  const tier = typeof quotaInfo.tier === "string" ? quotaInfo.tier : "";
  const haystack = `${modelId} ${displayName} ${tier}`.toLowerCase();
  if (haystack.includes("gemini")) return "Gem";
  if (haystack.includes("claude") || haystack.includes("opus") || haystack.includes("sonnet") || haystack.includes("gpt-oss") || haystack.includes("gpt_oss")) return "Cla";
  return null;
}

function antigravityUsedPercent(quotaInfo: Record<string, unknown>): number | undefined {
  const target = asRecord(quotaInfo.remaining) ?? quotaInfo;
  const remaining = normalizePercent(toFiniteNumber(target.remainingFraction) !== undefined
    ? toFiniteNumber(target.remainingFraction)! * 100
    : toFiniteNumber(target.remainingPercentage) !== undefined
      ? toFiniteNumber(target.remainingPercentage)! * 100
      : undefined);
  if (remaining === undefined) return undefined;
  return normalizePercent(100 - remaining);
}

/** Gem/Cla windows from a `fetchAvailableModels` body; shared by the provider and account probes. */
function antigravityWindowsFromModels(body: Record<string, unknown> | null): ProviderQuotaWindow[] {
  const models = asRecord(body?.models);
  if (!models) return [];

  const windows = new Map<string, ProviderQuotaWindow>();
  for (const [modelId, rawModelInfo] of Object.entries(models)) {
    const modelInfo = asRecord(rawModelInfo);
    if (!modelInfo) continue;
    for (const quotaInfo of quotaInfoEntries(modelInfo)) {
      const label = classifyAntigravityFamily(modelId, modelInfo, quotaInfo);
      if (!label || windows.has(label)) continue;
      const percent = antigravityUsedPercent(quotaInfo);
      if (percent === undefined) continue;
      windows.set(label, {
        label,
        percent,
        ...(normalizeResetAt(quotaInfo.resetTime) !== undefined ? { resetAt: normalizeResetAt(quotaInfo.resetTime) } : {}),
      });
    }
  }

  const customWindows = ["Gem", "Cla"].flatMap(label => {
    const window = windows.get(label);
    return window ? [window] : [];
  });
  return customWindows;
}

/**
 * Parse Google Antigravity quota from `v1internal:retrieveUserQuotaSummary`.
 * Groups contain Gemini models and Claude/3P models, each with 5h and weekly limit buckets.
 */
function parseAntigravityQuotaSummary(body: Record<string, unknown> | null): ProviderQuota | null {
  const groups = Array.isArray(body?.groups) ? (body.groups as unknown[]) : [];
  if (groups.length === 0) return null;

  const customWindowsMap = new Map<string, ProviderQuotaWindow>();

  for (const rawGroup of groups) {
    const group = asRecord(rawGroup);
    if (!group) continue;
    const groupName = `${typeof group.displayName === "string" ? group.displayName : ""} ${typeof group.description === "string" ? group.description : ""}`.toLowerCase();
    const isGemini = groupName.includes("gemini");
    const isClaude = groupName.includes("claude") || groupName.includes("3p") || groupName.includes("gpt");

    const buckets = Array.isArray(group.buckets) ? (group.buckets as unknown[]) : [];
    for (const rawBucket of buckets) {
      const bucket = asRecord(rawBucket);
      if (!bucket) continue;
      const windowStr = `${typeof bucket.window === "string" ? bucket.window : ""} ${typeof bucket.bucketId === "string" ? bucket.bucketId : ""} ${typeof bucket.displayName === "string" ? bucket.displayName : ""}`.toLowerCase();
      const percent = antigravityUsedPercent(bucket);
      if (percent === undefined) continue;
      const resetAt = normalizeResetAt(bucket.resetTime);

      const isWeekly = windowStr.includes("week");
      const is5h = windowStr.includes("5h") || windowStr.includes("five");

      if (isGemini) {
        const label = is5h ? "Gem" : isWeekly ? "Gem (Weekly)" : "";
        if (label && !customWindowsMap.has(label)) {
          customWindowsMap.set(label, { label, percent, ...(resetAt !== undefined ? { resetAt } : {}) });
        }
      } else if (isClaude) {
        const label = is5h ? "Cla" : isWeekly ? "Cla (Weekly)" : "";
        if (label && !customWindowsMap.has(label)) {
          customWindowsMap.set(label, { label, percent, ...(resetAt !== undefined ? { resetAt } : {}) });
        }
      } else {
        const baseLabel = typeof group.displayName === "string" ? group.displayName : "Other";
        const label = isWeekly ? `${baseLabel} (Weekly)` : baseLabel;
        if (!customWindowsMap.has(label)) {
          customWindowsMap.set(label, { label, percent, ...(resetAt !== undefined ? { resetAt } : {}) });
        }
      }
    }
  }

  const PREFERRED_ORDER = ["Gem", "Gem (Weekly)", "Cla", "Cla (Weekly)"];
  const customWindows = Array.from(customWindowsMap.values()).sort((a, b) => {
    const ia = PREFERRED_ORDER.indexOf(a.label);
    const ib = PREFERRED_ORDER.indexOf(b.label);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.label.localeCompare(b.label);
  });

  if (customWindows.length === 0) {
    return null;
  }

  return {
    customWindows,
    updatedAt: Date.now(),
  };
}

const ANTIGRAVITY_ACCOUNT_QUOTA_BASE = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_QUOTA_SUMMARY_URL = `${ANTIGRAVITY_ACCOUNT_QUOTA_BASE}/v1internal:retrieveUserQuotaSummary`;
const ANTIGRAVITY_QUOTA_MODELS_URL = `${ANTIGRAVITY_ACCOUNT_QUOTA_BASE}/v1internal:fetchAvailableModels`;

/** Only these fixed accounting destinations may use transparent Fake-IP DNS. */
export function isCanonicalAntigravityQuotaUrl(name: string, url: string): boolean {
  return name === "google-antigravity"
    && (url === ANTIGRAVITY_QUOTA_SUMMARY_URL || url === ANTIGRAVITY_QUOTA_MODELS_URL);
}

let antigravityOutboundDependencies: ProviderOutboundDependencies = {
  isCanonicalUrl: isCanonicalAntigravityQuotaUrl,
};

/** Test seam: inject resolver/pinned transport for provider and per-account probes. */
export function setAntigravityAccountQuotaTransportForTests(dependencies: ProviderOutboundDependencies | null): void {
  antigravityOutboundDependencies = { ...dependencies, isCanonicalUrl: isCanonicalAntigravityQuotaUrl };
}

/**
 * Per-account Antigravity quota (#1082). Always probes Google's own Cloud Code Assist host
 * through the pinned provider-outbound transport: a configured `baseUrl` is a routing choice
 * for requests, not a second source of Google's accounting for a stored credential, and fixing
 * the destination keeps the `provider\0accountId` cache identity exact across config changes.
 * A redirect or non-2xx yields null (unavailable), never a partial row.
 */
type AntigravityQuotaProbeResult =
  | { kind: "available"; quota: ProviderQuota; source: "google-antigravity:retrieveUserQuotaSummary" | "google-antigravity:fetchAvailableModels" }
  | { kind: "unavailable"; failure: QuotaFailureCode; legacy: { kind: "null" } | { kind: "throw"; error: unknown } };

/**
 * Every pinned-transport failure code, classified once.
 *
 * A conditional that named one code and sent the rest to `timeout` was correct only for as long
 * as the union held exactly the codes it was written against. When the transport learned to
 * report a coding it cannot undo, that answer was reported as a timeout, which is a different
 * operational story entirely. A total map makes a new code a compile error here rather than a
 * quiet misdiagnosis.
 */
const PINNED_QUOTA_FAILURES = {
  connect_timeout: "timeout",
  first_byte_timeout: "timeout",
  inactivity_timeout: "timeout",
  // The response arrived and cannot be used: too large, coded in a format this transport cannot
  // undo, or coded bytes that did not decode. None of these is a timing failure.
  output_byte_limit: "response_unusable",
  unsupported_content_encoding: "response_unusable",
  content_decode_failed: "response_unusable",
} satisfies Record<PinnedHttpErrorCode, QuotaFailureCode>;

function quotaTransportFailure(error: unknown): QuotaFailureCode {
  if (error instanceof ProviderOutboundPolicyError) return "destination_blocked";
  if (error instanceof DestinationDnsResolutionError) return "dns_failed";
  if (error instanceof PinnedHttpError) return PINNED_QUOTA_FAILURES[error.code];
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  return "transport_error";
}

function quotaHttpFailure(status: number): QuotaFailureCode {
  if (status >= 300 && status < 400) return "redirect_blocked";
  if (status === 401 || status === 403) return "access_denied";
  if (status === 429) return "rate_limited";
  return "upstream_error";
}

function unavailableAntigravityQuota(failure: QuotaFailureCode): AntigravityQuotaProbeResult {
  return { kind: "unavailable", failure, legacy: { kind: "null" } };
}

/**
 * Prefer a summary network-policy diagnosis over a vaguer fallback. A blocked
 * destination is an actionable local-network fact, while "upstream_error" tells
 * the operator to go look at Google. A successful models probe still clears
 * the first failure completely.
 */
function antigravityUnavailableFailure(
  summaryFailure: QuotaFailureCode | undefined,
  fallbackFailure: QuotaFailureCode,
): QuotaFailureCode {
  if (
    (summaryFailure === "destination_blocked" || summaryFailure === "dns_failed")
    && fallbackFailure !== "destination_blocked"
    && fallbackFailure !== "dns_failed"
  ) {
    return summaryFailure;
  }
  return fallbackFailure;
}

export async function probeAntigravityUsageQuota(accessToken: string, projectId: string): Promise<AntigravityQuotaProbeResult> {
  const fetchQuota = (url: string) => providerOutboundPost("google-antigravity", { baseUrl: ANTIGRAVITY_ACCOUNT_QUOTA_BASE }, url, {
    headers: {
      Accept: "application/json", "Content-Type": "application/json",
      "User-Agent": antigravityUserAgent(), Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ project: projectId }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, antigravityOutboundDependencies);
  let summaryFailure: QuotaFailureCode | undefined;
  try {
    const response = await fetchQuota(ANTIGRAVITY_QUOTA_SUMMARY_URL);
    if (await providerRedirectError(response, ANTIGRAVITY_QUOTA_SUMMARY_URL)) return unavailableAntigravityQuota("redirect_blocked");
    if (response.status === 401 || response.status === 403) return unavailableAntigravityQuota("access_denied");
    if (response.ok) {
      const quota = parseAntigravityQuotaSummary(asRecord(await readQuotaJson(response)));
      if (quota) return { kind: "available", quota, source: "google-antigravity:retrieveUserQuotaSummary" };
    }
  } catch (error) {
    // Existing behavior: summary transport/parse failure may recover through the models probe.
    summaryFailure = quotaTransportFailure(error);
  }
  try {
    const response = await fetchQuota(ANTIGRAVITY_QUOTA_MODELS_URL);
    if (await providerRedirectError(response, ANTIGRAVITY_QUOTA_MODELS_URL)) {
      return unavailableAntigravityQuota(antigravityUnavailableFailure(summaryFailure, "redirect_blocked"));
    }
    if (!response.ok) {
      return unavailableAntigravityQuota(antigravityUnavailableFailure(summaryFailure, quotaHttpFailure(response.status)));
    }
    const customWindows = antigravityWindowsFromModels(asRecord(await readQuotaJson(response)));
    if (!customWindows.length) {
      return unavailableAntigravityQuota(antigravityUnavailableFailure(summaryFailure, "response_unusable"));
    }
    return { kind: "available", quota: { customWindows, updatedAt: Date.now() }, source: "google-antigravity:fetchAvailableModels" };
  } catch (error) {
    // The public compatibility wrapper still rejects this exact fallback error; it never enters a DTO.
    return {
      kind: "unavailable",
      failure: antigravityUnavailableFailure(summaryFailure, quotaTransportFailure(error)),
      legacy: { kind: "throw", error },
    };
  }
}

export async function fetchAntigravityUsageQuota(accessToken: string, projectId: string): Promise<ProviderQuota | null> {
  const result = await probeAntigravityUsageQuota(accessToken, projectId);
  if (result.kind === "available") return result.quota;
  if (result.legacy.kind === "throw") throw result.legacy.error;
  return null;
}

export async function fetchAntigravityQuota(provider: string): Promise<ProviderQuotaReport | null> {
  const credential = getCredential("google-antigravity");
  if (!credential?.projectId) return null;
  let accessToken: string;
  try { accessToken = await getValidAccessToken("google-antigravity"); } catch { return null; }
  const result = await probeAntigravityUsageQuota(accessToken, credential.projectId);
  if (result.kind === "available") return report(provider, result.source, result.quota);
  if (result.legacy.kind === "throw") throw result.legacy.error;
  return null;
}
