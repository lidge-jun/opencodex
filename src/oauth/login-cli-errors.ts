import { AnthropicTokenError } from "./anthropic";
import { OAuthProviderNamespaceCollisionError, OAuthProviderPublicationError, publicOAuthAuthenticationErrorMessage } from "./index";
import { XaiTokenRequestError } from "./xai";
import { AnthropicInstanceCollisionError, AnthropicInstanceConfigReadError } from "./store-anthropic-instance";

// Standard RFC 6749 / RFC 6750 / RFC 8628 error codes. A provider's `error` field is printed only
// when it is one of these, so a body that echoes request parameters there still prints nothing.
const STANDARD_OAUTH_ERROR_CODES = new Set([
  "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client",
  "unsupported_grant_type", "invalid_scope", "access_denied", "unsupported_response_type",
  "server_error", "temporarily_unavailable", "invalid_token", "insufficient_scope",
  "authorization_pending", "slow_down", "expired_token",
]);

/** Fixed, machine-readable reason for a failed login; never derived from free-form text. */
export function oauthLoginFailureDiagnostic(error: unknown): string {
  if (error instanceof OAuthProviderNamespaceCollisionError || error instanceof OAuthProviderPublicationError
    || error instanceof AnthropicInstanceCollisionError || error instanceof AnthropicInstanceConfigReadError) {
    return "configuration_error";
  }
  const status = error instanceof AnthropicTokenError ? error.httpStatus
    : error instanceof XaiTokenRequestError ? error.status : undefined;
  const oauthError = error instanceof AnthropicTokenError || error instanceof XaiTokenRequestError
    ? error.oauthError : undefined;
  const parts: string[] = [];
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) parts.push(`HTTP ${status}`);
  if (typeof oauthError === "string" && STANDARD_OAUTH_ERROR_CODES.has(oauthError)) parts.push(oauthError);
  if (parts.length > 0) return parts.join(" ");
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  // fetch() reports refused connections and DNS failures as a TypeError carrying a string code; a
  // programming TypeError carries none and stays in the generic bucket.
  const code = error instanceof TypeError ? (error as { code?: unknown }).code : undefined;
  if ((error instanceof AnthropicTokenError && error.requestNotSent)
    || (error instanceof XaiTokenRequestError && error.status === undefined)
    || (typeof code === "string" && code !== "")) return "network_error";
  return "oauth_authentication_failed";
}

/** Keep terminal login failures within the public OAuth error vocabulary. */
export function reportOAuthLoginError(error: unknown): never {
  console.error(`\n❌ OAuth login failed (${oauthLoginFailureDiagnostic(error)}): ${publicOAuthAuthenticationErrorMessage(error)}`);
  process.exit(1);
}
