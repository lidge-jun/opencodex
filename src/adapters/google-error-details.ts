/**
 * Structured details from a Google error body (google.rpc.Status `details`).
 *
 * Google states the reason for a refusal and when to retry in typed detail entries:
 * `google.rpc.ErrorInfo` (`reason`, `domain`, `metadata.quotaResetDelay`) and `google.rpc.RetryInfo`
 * (`retryDelay`). Those are the stable contract; the prose in `error.message` changes. Reading them is
 * bounded and never throws: an unreadable body yields an empty result.
 */
import { parseUpstreamJsonPayload } from "./upstream-http-error";

export interface GoogleErrorDetails {
  /** `ErrorInfo.reason` from an entry typed `google.rpc.ErrorInfo`. */
  reason?: string;
  /** A `reason` found on an untyped detail entry (Cloud Code Assist sometimes omits `@type`). Retry hints only. */
  reasonUntyped?: string;
  domain?: string;
  /** `RetryInfo.retryDelay`, then `ErrorInfo.metadata.quotaResetDelay`, then "reset after <duration>" in the message. */
  retryDelayMs?: number;
}

const ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo";
const RETRY_INFO_TYPE = "type.googleapis.com/google.rpc.RetryInfo";
const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1_000;
const UNIT_MS: Readonly<Record<string, number>> = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1, us: 0.001, "µs": 0.001, ns: 0.000001 };

/**
 * Google duration text as milliseconds: protobuf Duration JSON ("30s", "0.5s") and Go-style compound
 * durations ("1h2m3s", "1.5h", "500ms"). Undefined for anything else, a negative value or more than 30 days.
 */
export function parseGoogleDurationMs(raw: string): number | undefined {
  const text = raw.trim();
  if (!text || text.length > 64) return undefined;
  const pattern = /(\d+(?:\.\d+)?)(ms|us|µs|ns|h|m|s)/gy;
  let total = 0;
  let consumed = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index !== consumed) return undefined;
    total += Number(match[1]) * UNIT_MS[match[2]!]!;
    consumed += match[0].length;
  }
  if (consumed !== text.length || !Number.isFinite(total) || total < 0 || total > MAX_DURATION_MS) return undefined;
  return total;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function googleErrorDetails(payloadText: string): GoogleErrorDetails {
  const parsed = parseUpstreamJsonPayload(payloadText);
  const root = Array.isArray(parsed) ? parsed[0] : parsed;
  const error = isRecord(root) ? (isRecord(root.error) ? root.error : root) : undefined;
  if (!error) return {};
  const out: GoogleErrorDetails = {};
  // Only a positive delay says when to retry; a typed RetryInfo outranks ErrorInfo's quotaResetDelay,
  // which outranks an untyped detail, whatever order Google lists them in.
  const positive = (ms: number | undefined) => (ms !== undefined && ms > 0 ? ms : undefined);
  let typedRetryDelay: number | undefined;
  let quotaResetDelay: number | undefined;
  let untypedRetryDelay: number | undefined;
  for (const detail of Array.isArray(error.details) ? error.details.slice(0, 32) : []) {
    if (!isRecord(detail)) continue;
    const type = detail["@type"];
    if (type === ERROR_INFO_TYPE) {
      if (typeof detail.reason === "string" && out.reason === undefined) out.reason = detail.reason;
      if (typeof detail.domain === "string" && out.domain === undefined) out.domain = detail.domain;
      const metadata = detail.metadata;
      if (isRecord(metadata) && typeof metadata.quotaResetDelay === "string") quotaResetDelay ??= positive(parseGoogleDurationMs(metadata.quotaResetDelay));
    } else if (type === RETRY_INFO_TYPE) {
      if (typeof detail.retryDelay === "string") typedRetryDelay ??= positive(parseGoogleDurationMs(detail.retryDelay));
    } else if (type === undefined) {
      if (typeof detail.reason === "string" && out.reasonUntyped === undefined) out.reasonUntyped = detail.reason;
      if (typeof detail.retryDelay === "string") untypedRetryDelay ??= positive(parseGoogleDurationMs(detail.retryDelay));
      const metadata = detail.metadata;
      if (isRecord(metadata) && typeof metadata.quotaResetDelay === "string") untypedRetryDelay ??= positive(parseGoogleDurationMs(metadata.quotaResetDelay));
    }
  }
  const stated = typedRetryDelay ?? quotaResetDelay ?? untypedRetryDelay;
  if (stated !== undefined) out.retryDelayMs = stated;
  if (!out.retryDelayMs && typeof error.message === "string") {
    const match = /\bafter\s+(\d[\w.µ]*?)[.,;]?(?:\s|$)/i.exec(error.message.slice(0, 2_000));
    if (match) out.retryDelayMs = parseGoogleDurationMs(match[1]!);
  }
  if (!out.retryDelayMs) delete out.retryDelayMs;
  return out;
}

/**
 * A Cloud Code Assist account suspension, judged only from the original body with CPA's shape:
 * an object root (not an array), `error.code` 403, `error.status` PERMISSION_DENIED, and a typed
 * `google.rpc.ErrorInfo` entry anywhere in `details` whose reason is TOS_VIOLATION. Prose, untyped
 * reasons and other codes never qualify.
 */
export function isAntigravityTosViolationBody(payloadText: string): boolean {
  const parsed = parseUpstreamJsonPayload(payloadText);
  if (!isRecord(parsed) || !isRecord(parsed.error)) return false;
  const error = parsed.error;
  if (error.code !== 403 || error.status !== "PERMISSION_DENIED" || !Array.isArray(error.details)) return false;
  return error.details.slice(0, 32).some(detail => isRecord(detail) && detail["@type"] === ERROR_INFO_TYPE && detail.reason === "TOS_VIOLATION");
}
