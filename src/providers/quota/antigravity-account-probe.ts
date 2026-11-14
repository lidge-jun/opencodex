import { parseUpstreamJsonPayload, sanitizeUpstreamErrorText } from "../../adapters/upstream-http-error";
import { maskedAccountLabel } from "../../lib/privacy";
import { getAccountSet } from "../../oauth/store";
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
  /** Machine reason: Google's ErrorInfo reason / enum status, or a local code such as `missing_project`. */
  reason: string | null;
  /** Google's error message, secret-redacted and truncated. Never contains the bearer. */
  message: string | null;
  /** Stored access-token expiry (epoch ms); null when the credential has none. */
  expiresAt: number | null;
  latencyMs: number;
  quota: ProviderQuota | null;
}

export const ACCOUNT_PROBE_PROVIDERS: ReadonlySet<string> = new Set(["google-antigravity"]);

const MESSAGE_MAX_CHARS = 300;
const PROBE_CONCURRENCY = 4;
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
    ? record.details.flatMap(detail => detail && typeof detail === "object" && typeof (detail as { reason?: unknown }).reason === "string"
      ? [(detail as { reason: string }).reason] : [])
    : [];
  return {
    reasons,
    ...(typeof record.status === "string" && record.status ? { enumStatus: record.status } : {}),
    ...(typeof record.message === "string" && record.message.trim() ? { message: record.message.trim() } : {}),
  };
}

function safeMessage(message: string | undefined): string | null {
  if (!message) return null;
  const clean = sanitizeUpstreamErrorText(message).replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, MESSAGE_MAX_CHARS) : null;
}

/** Map one upstream answer to a verdict. Pure; exported for tests. */
export function classifyAntigravityProbeResponse(httpStatus: number, bodyText: string): Pick<AccountProbeResult, "status" | "reason" | "message"> {
  if (httpStatus >= 200 && httpStatus < 300) return { status: "ok", reason: null, message: null };
  const envelope = readGoogleError(bodyText);
  const reason = envelope.reasons[0] ?? envelope.enumStatus ?? null;
  const message = safeMessage(envelope.message);
  const haystack = `${envelope.reasons.join(" ")} ${envelope.enumStatus ?? ""} ${envelope.message ?? ""}`.toLowerCase();
  if (envelope.reasons.includes("VALIDATION_REQUIRED") || (httpStatus === 403 && VERIFICATION_PATTERN.test(haystack))) {
    return { status: "verification_required", reason: reason ?? "VALIDATION_REQUIRED", message };
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
  const raw = await fetchAntigravityQuotaSummaryOnce(credential.access, credential.projectId, signal);
  return { ...base, ...verdictFromRaw(raw), latencyMs: Date.now() - started };
}

/**
 * Probe stored Google Antigravity accounts with their own stored access tokens.
 *
 * Reads the auth store once and never writes it: no refresh, no re-login, no pause/active/health
 * change. Returns null when `accountId` names no stored account.
 */
export async function probeAntigravityAccounts(options: {
  accountId?: string;
  now?: number;
  signal?: AbortSignal;
} = {}): Promise<AccountProbeResult[] | null> {
  const set = getAccountSet("google-antigravity");
  const accounts = set?.accounts ?? [];
  const targets = options.accountId === undefined ? accounts : accounts.filter(account => account.id === options.accountId);
  if (options.accountId !== undefined && targets.length === 0) return null;
  const now = options.now ?? Date.now();
  const results = new Array<AccountProbeResult>(targets.length);
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const index = next++;
      const target = targets[index]!;
      // Re-read the roster as each probe starts: a pause made after the snapshot must suppress the request.
      const latest = getAccountSet("google-antigravity");
      const current = latest?.accounts.find(account => account.id === target.id) ?? target;
      results[index] = await probeOneAntigravityAccount(current, latest?.activeAccountId ?? set?.activeAccountId, now, options.signal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, targets.length) }, worker));
  return results;
}
