import type { AdapterEvent } from "../../types";
import type { StepProtocolErrorPayload } from "./stdio-frames";

type StepSessionErrorCode =
  | "step_cli_session_failed"
  | "step_cli_session_busy"
  | "step_cli_binary_missing"
  | "step_cli_capability_missing"
  | "step_cli_protocol_violation"
  | "step_cli_cleanup_failed"
  | "step_cli_not_logged_in"
  | "step_cli_subscription_cooldown"
  | "timeout";

export class StepSessionError extends Error {
  constructor(message: string, readonly code: StepSessionErrorCode = "step_cli_session_failed") {
    super(message);
    this.name = "StepSessionError";
  }
}

const SESSION_FAILURE = "StepCode could not complete the request.";

/** Child diagnostics are classifier input only. The resulting error is safe to publish. */
export function classifyStepChildError({ code, message }: StepProtocolErrorPayload): StepSessionError {
  if (code === "SESSION_BUSY") {
    return new StepSessionError("StepCode is still finishing its previous query.", "step_cli_session_busy");
  }
  if (/not signed in|please run \/login|未登录/i.test(message)) {
    return new StepSessionError("StepCode is not signed in. Run `step login` once and retry.", "step_cli_not_logged_in");
  }
  if (/quota|credit|429|rate limit/i.test(message)) {
    return new StepSessionError("StepCode subscription temporarily rate limited or out of quota.", "step_cli_subscription_cooldown");
  }
  if (/did not answer .* in time|timed out/i.test(message)) {
    return new StepSessionError("StepCode timed out while processing the request.", "timeout");
  }
  return new StepSessionError(SESSION_FAILURE);
}

/**
 * Failure text for this route.
 *
 * Every other failure on a CLI-backed provider becomes an event on the client stream rather than a
 * thrown error, so a refusal is what the operator actually reads. Keeping the mapping in one module
 * means the wording and the status a client can retry on are decided in one place.
 */

export function refusal(
  message: string,
  status: number,
  code: string,
  errorType = "invalid_request_error",
  retryable = false,
): AdapterEvent {
  return { type: "error", message, status, errorType, code, retryable };
}

/** Translate a transport failure into the actionable error an operator can act on. */
export function mapSessionFailure(error: unknown): AdapterEvent {
  const failure = error instanceof StepSessionError ? error : new StepSessionError(SESSION_FAILURE);
  switch (failure.code) {
    case "step_cli_binary_missing":
    case "step_cli_capability_missing":
      return refusal(failure.message, 400, failure.code);
    case "step_cli_not_logged_in":
      return refusal(failure.message, 401, failure.code, "authentication_error");
    case "step_cli_subscription_cooldown":
      return refusal(failure.message, 429, failure.code, "rate_limit_error");
    case "timeout":
      return refusal(failure.message, 504, failure.code, "upstream_error", true);
    default:
      return refusal(failure.message, 502, failure.code, "upstream_error", true);
  }
}
