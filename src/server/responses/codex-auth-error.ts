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
import {
  MAIN_CODEX_ACCOUNT_ID,
  MainAccountTokenRefreshError,
  MainAuthJsonChangedDuringRefreshError,
} from "../../codex/main-account";

export interface CodexAuthContextErrorResponseOptions {
  accountSelector?: string;
  now: number;
}

export function nativeMainRefreshFailureResponse(error: unknown): Response {
  if (error instanceof MainAccountTokenRefreshError && error.reason === "reauth") {
    return formatErrorResponse(401, "authentication_error", "Codex main account needs reauthentication");
  }
  if (error instanceof MainAccountTokenRefreshError
    || error instanceof MainAuthJsonChangedDuringRefreshError) {
    const response = formatErrorResponse(
      503,
      "server_busy",
      "Codex main credential refresh did not complete; retry this request",
    );
    const headers = new Headers(response.headers);
    headers.set("Retry-After", "1");
    return new Response(response.body, { status: response.status, headers });
  }
  return formatErrorResponse(401, "authentication_error", "No usable Codex main credential to serve this request");
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
    if (error.accountId === MAIN_CODEX_ACCOUNT_ID) {
      return nativeMainRefreshFailureResponse(error.cause);
    }
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
