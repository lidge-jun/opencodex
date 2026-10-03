import { formatErrorResponse } from "../../bridge";
import { isAccountNeedsReauth } from "../../codex/account-runtime-state";
import {
  CodexAccountCooldownError,
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

export interface CodexAuthContextErrorResponseOptions {
  accountSelector?: string;
  now: number;
}

export function codexModelAvailabilityErrorResponse(error: CodexModelAvailabilityError): Response {
  if (error.reason === "temporarily_unavailable") {
    return formatErrorResponse(429, "rate_limit_error", error.message);
  }
  return formatErrorResponse(400, "invalid_request_error", error.message);
}

/**
 * The refusal a revoked or downgraded ChatGPT session earns, on the request that discovers it
 * and on every request after.
 *
 * "No usable account credential" is true and useless: it reads as a proxy fault and sends the
 * operator to the provider's status page. The two things they need are that the credential was
 * rejected by OpenAI rather than by this proxy, and the command that fixes it.
 */
export const CODEX_MAIN_SIGN_IN_REQUIRED_MESSAGE =
  "Codex account needs sign-in: OpenAI rejected its credential (token invalidated — revoked "
  + "session or plan change). Run `codex login` to sign in again.";

const DEFAULT_POOL_AUTHENTICATION_MESSAGE = new CodexPoolAuthenticationError().message;

export function nativeMainRefreshFailureResponse(error: unknown): Response {
  if (error instanceof MainAccountTokenRefreshError && error.reason === "reauth") {
    // Same sentence the quarantine produces on every later request, so the first refusal and the
    // ones after it do not describe one dead credential two different ways.
    return formatErrorResponse(401, "authentication_error", CODEX_MAIN_SIGN_IN_REQUIRED_MESSAGE);
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
  if (error instanceof CodexModelAvailabilityError) {
    return codexModelAvailabilityErrorResponse(error);
  }
  if (error instanceof CodexPoolAuthenticationError || error instanceof CodexDirectAuthenticationError) {
    // An empty pool because native main was quarantined, not because none is configured: say which,
    // so the refusal names the thing the operator has to do.
    const quarantinedMain = error instanceof CodexPoolAuthenticationError
      && error.message === DEFAULT_POOL_AUTHENTICATION_MESSAGE
      && isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    return formatErrorResponse(401, "authentication_error",
      quarantinedMain ? CODEX_MAIN_SIGN_IN_REQUIRED_MESSAGE : error.message);
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
