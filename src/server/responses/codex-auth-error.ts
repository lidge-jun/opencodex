import { formatErrorResponse } from "../../bridge";
import {
  CodexAccountCooldownError,
  codexMainProfileDrainingResponse,
  cooldownErrorResponse,
  CodexAuthContextError,
  CodexDirectAuthenticationError,
  CodexMainProfileDrainingError,
  CodexMainSubstitutionUnavailableError,
  CodexPoolAuthenticationError,
  CodexThreadAffinityExpiredError,
} from "../../codex/auth-context";

export interface CodexAuthContextErrorResponseOptions {
  accountSelector?: string;
  now: number;
}

/** Shared HTTP contract for Codex auth-context failures on Responses surfaces. */
export function mapCodexAuthContextErrorToResponse(
  error: unknown,
  options: CodexAuthContextErrorResponseOptions,
): Response | undefined {
  if (error instanceof CodexAccountCooldownError) {
    return cooldownErrorResponse(error, options.now, options.accountSelector);
  }
  if (error instanceof CodexMainProfileDrainingError) {
    return codexMainProfileDrainingResponse();
  }
  if (error instanceof CodexThreadAffinityExpiredError) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "Codex thread account affinity expired; start a new session",
    );
  }
  if (error instanceof CodexAuthContextError) {
    return formatErrorResponse(
      401,
      "authentication_error",
      "Selected Codex account needs reauthentication",
    );
  }
  if (error instanceof CodexPoolAuthenticationError || error instanceof CodexDirectAuthenticationError) {
    return formatErrorResponse(401, "authentication_error", error.message);
  }
  if (error instanceof CodexMainSubstitutionUnavailableError) {
    return formatErrorResponse(
      401,
      "authentication_error",
      "No usable Codex main credential to serve this request",
    );
  }
  return undefined;
}
