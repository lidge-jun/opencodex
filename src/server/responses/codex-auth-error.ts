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
import { NativeProfileError } from "../../codex/native-profile-types";

export interface CodexAuthContextErrorResponseOptions {
  accountSelector?: string;
  now: number;
}

export function nativeMainRefreshFailureResponse(error: unknown): Response {
  if (error instanceof MainAccountTokenRefreshError && error.reason === "reauth") {
    return formatErrorResponse(401, "authentication_error", "Codex main account needs reauthentication");
  }
  if (error instanceof MainAccountTokenRefreshError
    || error instanceof MainAuthJsonChangedDuringRefreshError
    || (error instanceof NativeProfileError && error.retryable)) {
    // A bare "retry this request" reads as a transient server fault, which is how #4212's reporter
    // concluded the proxy had broken while one account was the thing that needed them. The refusal
    // stays a retryable 503 because the refresh genuinely may succeed, but it now names what is
    // failing and what to do when retrying stops helping.
    //
    // It says "sign in to the main Codex account again" and deliberately does NOT say
    // "reauthentication", for the same reason the pool counterpart does not — see
    // `poolCredentialRefreshIncompleteResponse` in ./core.ts. `classifyError` runs
    // `isAuthenticationMessage` before it reaches the `status === 503` arm, and that check is
    // status-blind on the bare substring "authentication", which "reauthentication" contains.
    // A body carrying that word is reclassified to `authentication_error` / `invalid_api_key`
    // even though the HTTP status stays 503, and Codex keys its retry-after backoff on
    // `server_is_overloaded` — so the word alone turns a transient refresh into what reads as a
    // bad API key and the client stops retrying. The pool path documented this trap and this one
    // walked into it anyway, which is why the test below now asserts the classification and not
    // just the sentence.
    const response = formatErrorResponse(
      503,
      "server_busy",
      "Codex main credential refresh did not complete; retry this request. "
        + "If it keeps failing, sign in to the main Codex account again.",
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
