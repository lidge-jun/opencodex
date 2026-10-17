import type { AdapterEvent } from "../../types";
import { StepSessionError } from "./session";

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

/**
 * Refuse image input the way the Qoder and Claude Code rows do.
 *
 * `query.input` does carry an image block to the model, but this route publishes text-only models,
 * and an image the harness silently drops produces a confident answer to the wrong question. An
 * operator with the vision sidecar on the request path still gets pictures captioned into text.
 */

/** Translate a transport failure into the actionable error an operator can act on. */
export function mapSessionFailure(error: unknown): AdapterEvent {
  if (!(error instanceof StepSessionError)) {
    return {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
  }
  if (error.code === "step_cli_binary_missing" || error.code === "step_cli_capability_missing") {
    return refusal(error.message, 400, error.code);
  }
  if (/not signed in|please run \/login|未登录/i.test(error.message)) {
    return {
      type: "error",
      message:
        "StepCode is not signed in, so this subscription provider has no account to spend. " +
        `Run \`step login\` once and retry. CLI reported: ${error.message}`,
      status: 401,
      errorType: "authentication_error",
      code: "step_cli_not_logged_in",
      retryable: false,
    };
  }
  if (/quota|credit|429|rate limit/i.test(error.message)) {
    return {
      type: "error",
      message: error.message,
      status: 429,
      errorType: "rate_limit_error",
      code: "step_cli_subscription_cooldown",
      retryable: false,
    };
  }
  if (/did not answer .* in time|timed out/i.test(error.message)) {
    return {
      type: "error",
      message: error.message,
      status: 504,
      errorType: "upstream_error",
      code: "timeout",
      retryable: true,
    };
  }
  return {
    type: "error",
    message: error.message,
    status: 502,
    errorType: "upstream_error",
    code: error.code,
    retryable: true,
  };
}

/**
 * Run Codex turns against a StepCode subscription.
 *
 * One StepCode process serves one conversation, and this adapter never executes a tool itself: it
 * declares the client's catalog as StepCode SDK tools, allows the permission check the client's own
 * request already implies, and holds the tool call open so the result the client computes on its next
 * request is delivered back into the query the model is running.
 */
