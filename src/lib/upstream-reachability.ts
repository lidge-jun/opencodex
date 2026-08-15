/**
 * Classification of upstream fetch rejections that occur before any request
 * bytes can reach the origin: DNS resolution failure and TCP connect refusal.
 *
 * Issue #914: these failures are machine/network-wide, not account-specific —
 * every Codex pool account shares the provider host, so rotating accounts
 * cannot repair them. The transport layer previously mapped every non-timeout
 * rejection to `connect_error`, and at `upstreamFailoverThreshold` that streak
 * soft-avoided a healthy account and cleared thread affinity.
 *
 * Bun collapses DNS failure and TCP refusal into one label class
 * (`ConnectionRefused` / `FailedToOpenSocket`, errno 0); Node's undici emits
 * the classic `ECONNREFUSED` / `ENOTFOUND` / `EAI_AGAIN` / `ENETUNREACH` /
 * `ENETDOWN` / `EHOSTUNREACH` shapes. Both shapes are matched here, on `code`
 * values only, through a bounded cause chain. Message substrings are never
 * trusted (a message-only match is a negative case), and labels that can also
 * appear after the origin saw the credential — `ECONNRESET`, `EPIPE`, TLS
 * errors, unknown shapes — deliberately stay outside the set.
 *
 * Classifier semantics extracted from PR #966 (Yuxin-Qiao) with attribution;
 * sidecar blast radius intentionally not inherited.
 *
 * MUST stay a leaf module: imports nothing from server.ts or adapters.
 */

import { RequestPacingQueueOverloadError } from "../providers/request-pacing";
import { UpstreamRetryEvidenceError } from "./upstream-retry";

export const PRE_CONNECT_REACHABILITY_CODES = new Set([
  // Bun: DNS failure and TCP refusal share this class.
  "ConnectionRefused",
  "FailedToOpenSocket",
  // Node undici / classic Node shapes.
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
]);

/** Upper bound on how far `cause` chains are inspected. */
export const MAX_REACHABILITY_CAUSE_DEPTH = 3;

/**
 * True when the rejection (or a bounded `cause` of it) carries a proven
 * pre-connection reachability code. Never matches message text.
 */
export function isPreConnectReachabilityError(err: unknown): boolean {
  let current: unknown = err;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < MAX_REACHABILITY_CAUSE_DEPTH; depth++) {
    if (!(current instanceof Error) || seen.has(current)) return false;
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && PRE_CONNECT_REACHABILITY_CODES.has(code)) return true;
    current = current.cause;
  }
  return false;
}

export type TransportFailureKind = "timeout" | "connect_neutral" | "connect_error";

/**
 * Shared transport rejection classification for Codex pool upstream sends.
 * Timeouts keep their existing identity (account-transient); proven pre-connect
 * reachability failures become account-neutral; everything else (ECONNRESET,
 * EPIPE, TLS, unknown shapes) keeps the existing `connect_error`
 * account-attributed behavior.
 */
export function classifyTransportFailureKind(err: unknown): TransportFailureKind {
  // A local pacing admission failure happened before transport classification and must
  // remain a client-visible overload, not account or host health evidence.
  if (err instanceof RequestPacingQueueOverloadError) throw err;
  const evidence = err instanceof UpstreamRetryEvidenceError ? err : undefined;
  const rejection = evidence ? evidence.cause : err;
  if (rejection instanceof Error && rejection.name === "TimeoutError") return "timeout";
  if (isPreConnectReachabilityError(rejection)) {
    // A transient upstream response (5xx) or a credential-visible connection
    // reset before the rejection proves the host and credential path were
    // reached: the failure is account-attributable, never the pre-connection
    // neutral class (issue #914 review).
    if (evidence && (evidence.transientStatuses.length > 0 || evidence.resetSeen)) return "connect_error";
    return "connect_neutral";
  }
  return "connect_error";
}

/** Stable `code` carried by a transport rejection, when there is one. */
export function transportErrorCode(err: unknown): string | undefined {
  const rejection = err instanceof UpstreamRetryEvidenceError ? err.cause : err;
  if (!(rejection instanceof Error)) return undefined;
  const code = (rejection as { code?: unknown }).code;
  return typeof code === "string" && code !== "" ? code : undefined;
}
