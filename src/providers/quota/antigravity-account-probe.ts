import { parseUpstreamJsonPayload } from "../../adapters/upstream-http-error";
import { maskedAccountLabel } from "../../lib/privacy";
import { peekAuthStore } from "../../oauth/store";
import type { ProviderAccount } from "../../oauth/types";
import type { ProviderQuota } from "../quota-types";
import { fetchAntigravityQuotaSummaryOnce, type AntigravitySummaryOnceResult } from "./antigravity";

/**
 * Per-account probe verdicts. `paused` and `token_expired` are decided locally and send nothing;
 * every other value is derived from the single upstream answer.
 */
export const ACCOUNT_PROBE_STATUSES = [
  "ok",
  "paused",
  "token_expired",
  "suspended",
  "verification_required",
  "rate_limited",
  "permission_denied",
  "error",
] as const;
export type AccountProbeStatus = typeof ACCOUNT_PROBE_STATUSES[number];

export interface AccountProbeResult {
  accountId: string;
  maskedLabel?: string;
  active: boolean;
  paused: boolean;
  needsReauth: boolean;
  status: AccountProbeStatus;
  /** Upstream HTTP status; null when no request was sent or no response arrived. */
  httpStatus: number | null;
  /** Closed upstream or local reason code. Unknown upstream strings are omitted. */
  reason: string | null;
  /** Optional local diagnostic. */
  message: string | null;
  /** Stored access-token expiry (epoch ms); null when the credential has none. */
  expiresAt: number | null;
  latencyMs: number;
  quota: ProviderQuota | null;
}

const PROVIDER = "google-antigravity";
const PROBE_CONCURRENCY = 4;
const SAFE_REASONS = new Set(["VALIDATION_REQUIRED", "SERVICE_DISABLED", "PERMISSION_DENIED", "RESOURCE_EXHAUSTED", "UNAUTHENTICATED"]);
const SUSPENDED_PATTERN = /suspend|account (?:has been |is |was )?disabled|user_disabled|account_disabled|terms of service|tos_violation|banned/;
const VERIFICATION_PATTERN = /validation_required|validation required|verify your account|account verification/;

interface GoogleErrorEnvelope { enumStatus?: string; message?: string; reasons: string[] }

function readGoogleError(bodyText: string): GoogleErrorEnvelope {
  const parsed = parseUpstreamJsonPayload(bodyText);
  const root = Array.isArray(parsed) ? parsed[0] : parsed;
  const error = root && typeof root === "object" ? (root as { error?: unknown }).error : undefined;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    const text = bodyText.trim();
    return { reasons: [], ...(text && !text.startsWith("{") && !text.startsWith("[") ? { message: text } : {}) };
  }
  const record = error as { status?: unknown; message?: unknown; details?: unknown };
  const reasons = Array.isArray(record.details)
    ? record.details.flatMap(detail => detail?.["@type"] === "type.googleapis.com/google.rpc.ErrorInfo" && typeof detail.reason === "string"
      ? [detail.reason] : [])
    : [];
  return {
    reasons,
    ...(typeof record.status === "string" && record.status ? { enumStatus: record.status } : {}),
    ...(typeof record.message === "string" && record.message.trim() ? { message: record.message.trim() } : {}),
  };
}

/** Map one upstream answer to a verdict. Pure; exported for tests. */
export function classifyAntigravityProbeResponse(httpStatus: number, bodyText: string): Pick<AccountProbeResult, "status" | "reason" | "message"> {
  if (httpStatus >= 200 && httpStatus < 300) return { status: "ok", reason: null, message: null };
  const envelope = readGoogleError(bodyText);
  const reason = [...envelope.reasons, envelope.enumStatus].find(code => code !== undefined && SAFE_REASONS.has(code)) ?? null;
  const message = null;
  const haystack = `${envelope.reasons.join(" ")} ${envelope.enumStatus ?? ""} ${envelope.message ?? ""}`.toLowerCase();
  if (envelope.reasons.includes("VALIDATION_REQUIRED") || (httpStatus === 403 && VERIFICATION_PATTERN.test(haystack))) {
    return { status: "verification_required", reason: "VALIDATION_REQUIRED", message };
  }
  if (httpStatus === 429 || envelope.enumStatus === "RESOURCE_EXHAUSTED") return { status: "rate_limited", reason, message };
  if (httpStatus === 403) {
    // A disabled *API/service* on the project is a project-setup fault, not a suspended account.
    if (!envelope.reasons.includes("SERVICE_DISABLED") && SUSPENDED_PATTERN.test(haystack)) {
      return { status: "suspended", reason, message };
    }
    return { status: "permission_denied", reason: reason ?? "PERMISSION_DENIED", message };
  }
  return { status: "error", reason, message };
}

function verdictFromRaw(raw: AntigravitySummaryOnceResult): Pick<AccountProbeResult, "status" | "httpStatus" | "reason" | "message" | "quota"> {
  if (raw.kind === "transport") return { status: "error", httpStatus: null, reason: raw.failure, message: null, quota: null };
  if (raw.kind === "redirect") return { status: "error", httpStatus: null, reason: "redirect_blocked", message: null, quota: null };
  const verdict = classifyAntigravityProbeResponse(raw.status, raw.bodyText);
  return {
    ...verdict, httpStatus: raw.status, quota: raw.quota,
    ...(verdict.status === "ok" && !raw.quota ? { message: "no quota groups in response" } : {}),
  };
}

async function probeOneAntigravityAccount(
  account: ProviderAccount,
  activeAccountId: string | undefined,
  now: number,
  signal?: AbortSignal,
): Promise<AccountProbeResult> {
  const credential = account.credential;
  const maskedLabel = maskedAccountLabel(credential?.email);
  const expiresAt = typeof credential?.expires === "number" && Number.isFinite(credential.expires) ? credential.expires : null;
  const base = {
    accountId: account.id,
    ...(maskedLabel ? { maskedLabel } : {}),
    active: account.id === activeAccountId,
    paused: account.paused === true,
    needsReauth: account.needsReauth === true,
    expiresAt,
  };
  const local = (status: AccountProbeStatus, reason: string | null): AccountProbeResult => ({
    ...base, status, httpStatus: null, reason, message: null, latencyMs: 0, quota: null,
  });
  // A paused account is left alone: no request, so probing never touches an account the operator parked.
  if (account.paused === true) return local("paused", null);
  if (!credential?.access) return local("error", "missing_token");
  // Read-only contract: an expired token is reported, never refreshed.
  if (expiresAt !== null && expiresAt <= now) return local("token_expired", null);
  if (!credential.projectId) return local("error", "missing_project");
  const started = Date.now();
  const raw = await fetchAntigravityQuotaSummaryOnce(credential.access, credential.projectId, signal, () => {
    const current = peekAuthStore()[PROVIDER]?.accounts.find(row => row.id === account.id);
    return current !== undefined && current.paused !== true && current.credential.access === credential.access
      && current.credential.projectId === credential.projectId && current.credential.expires === credential.expires
      && (expiresAt === null || expiresAt > Date.now());
  });
  return { ...base, ...verdictFromRaw(raw), latencyMs: Date.now() - started };
}

/**
 * Probe stored Google Antigravity accounts with their own stored access tokens.
 *
 * Uses passive store reads and never changes the credential, active account or health.
 * Returns null when `accountId` names no stored account.
 */
export async function probeAntigravityAccounts(options: {
  accountId?: string;
  now?: number;
  signal?: AbortSignal;
} = {}): Promise<AccountProbeResult[] | null> {
  const accountIds = [...new Set(peekAuthStore()[PROVIDER]?.accounts.map(account => account.id))];
  const targets = options.accountId === undefined ? accountIds : [options.accountId];
  if (options.accountId !== undefined && !accountIds.includes(options.accountId)) return null;
  const results = new Array<AccountProbeResult | undefined>(targets.length);
  let next = 0;
  const worker = async () => {
    while (next < targets.length && !options.signal?.aborted) {
      const index = next++;
      // Re-read the roster as each probe starts: a pause made after the snapshot must suppress the request.
      const latest = peekAuthStore()[PROVIDER];
      const current = latest?.accounts.find(account => account.id === targets[index]);
      if (current) results[index] = await probeOneAntigravityAccount(current, latest?.activeAccountId, options.now ?? Date.now(), options.signal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, targets.length) }, worker));
  return results.filter(result => result !== undefined);
}
