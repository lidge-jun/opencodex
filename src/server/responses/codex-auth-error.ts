import { markProxyError } from "../../lib/client-error-body";
import { CodexInstallationIdUnavailableError } from "../../codex/installation-id";
import { formatErrorResponse } from "../../bridge";
import {
  CodexAccountCooldownError, CodexMainAccountHardLockError, CodexMainAccountCreditsOffError, CodexPoolAccountCreditsOffError, CodexReserveUnavailableError, CodexRecoveryWithheldError,
  codexMainProfileDrainingResponse,
  cooldownErrorResponse,
  CodexAuthContextError,
  CodexDirectAuthenticationError,
  CodexMainProfileDrainingError,
  CodexMainSubstitutionUnavailableError,
  CodexModelAvailabilityError,
  CodexPoolAuthenticationError,
  CodexThreadAffinityExpiredError,
} from "../../codex/auth-context";
import {
  MAIN_CODEX_ACCOUNT_ID,
  MainAccountTokenRefreshError,
  MainAuthJsonChangedDuringRefreshError,
} from "../../codex/main-account";
import { NativeProfileError } from "../../codex/native-profile-types";
import { markCodexAccountCooldownResponse } from "../../codex/account-cooldown-response";

export interface CodexAuthContextErrorResponseOptions {
  accountSelector?: string;
  now: number;
}

export function codexModelAvailabilityErrorResponse(error: CodexModelAvailabilityError): Response {
  if (error.reason === "temporarily_unavailable") {
    return markProxyError(formatErrorResponse(429, "rate_limit_error", error.message), "model_availability");
  }
  return markProxyError(formatErrorResponse(400, "invalid_request_error", error.message), "model_availability");
}

/** Actionable sign-in guidance without guessing which upstream revocation cause occurred. */
export const CODEX_MAIN_SIGN_IN_REQUIRED_MESSAGE =
  "Codex main account needs sign-in. Run `codex login` to sign in again.";

export function nativeMainRefreshFailureResponse(error: unknown): Response {
  if (error instanceof MainAccountTokenRefreshError && error.reason === "reauth") {
    // Same sentence the quarantine produces on every later request, so the first refusal and the
    // ones after it do not describe one dead credential two different ways.
    return markProxyError(formatErrorResponse(401, "authentication_error", CODEX_MAIN_SIGN_IN_REQUIRED_MESSAGE));
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
    const response = markProxyError(formatErrorResponse(
      503,
      "server_busy",
      "Codex main credential refresh did not complete; retry this request. "
        + "If it keeps failing, sign in to the main Codex account again.",
    ));
    const headers = new Headers(response.headers);
    headers.set("Retry-After", "1");
    return markProxyError(new Response(response.body, { status: response.status, headers }));
  }
  return markProxyError(formatErrorResponse(401, "authentication_error", "No usable Codex main credential to serve this request"));
}

/** Shared HTTP contract for Codex auth-context failures on Responses surfaces. */
export function mapCodexAuthContextErrorToResponse(
  error: unknown,
  options: CodexAuthContextErrorResponseOptions,
): Response | undefined {
  if (error instanceof CodexInstallationIdUnavailableError) {
    return markProxyError(formatErrorResponse(503, "server_busy", error.message));
  }
  if (error instanceof CodexAccountCooldownError) {
    const response = cooldownErrorResponse(error, options.now, options.accountSelector);
    // Exact class only (#7850): main hard-lock, credit, Reserve, recovery-withheld and future
    // policy subclasses keep their own retry semantics, including in combo target cooldowns.
    const presentation = error instanceof CodexMainAccountHardLockError ? "hard_lock"
      : error instanceof CodexRecoveryWithheldError ? "recovery"
      : error instanceof CodexMainAccountCreditsOffError || error instanceof CodexPoolAccountCreditsOffError || error instanceof CodexReserveUnavailableError ? undefined
      : options.accountSelector ? "cooldown_pinned" : "cooldown";
    return markProxyError(error.constructor === CodexAccountCooldownError ? markCodexAccountCooldownResponse(response) : response, presentation);
  }
  if (error instanceof CodexMainProfileDrainingError) {
    return markProxyError(codexMainProfileDrainingResponse());
  }
  if (error instanceof CodexThreadAffinityExpiredError) {
    return markProxyError(formatErrorResponse(
      409,
      "invalid_request_error",
      "Codex thread account affinity expired; start a new session",
    ));
  }
  if (error instanceof CodexAuthContextError) {
    if (error.accountId === MAIN_CODEX_ACCOUNT_ID) {
      return nativeMainRefreshFailureResponse(error.cause);
    }
    return markProxyError(formatErrorResponse(
      401,
      "authentication_error",
      "Selected Codex account needs reauthentication",
    ));
  }
  if (error instanceof CodexModelAvailabilityError) {
    return codexModelAvailabilityErrorResponse(error);
  }
  if (error instanceof CodexPoolAuthenticationError || error instanceof CodexDirectAuthenticationError) {
    return markProxyError(formatErrorResponse(401, "authentication_error",
      error instanceof CodexPoolAuthenticationError && error.quarantinedMain
        ? CODEX_MAIN_SIGN_IN_REQUIRED_MESSAGE : error.message));
  }
  if (error instanceof CodexMainSubstitutionUnavailableError) {
    return markProxyError(formatErrorResponse(
      401,
      "authentication_error",
      "No usable Codex main credential to serve this request",
    ));
  }
  return undefined;
}
