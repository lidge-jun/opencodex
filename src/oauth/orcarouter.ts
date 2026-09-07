/** OrcaRouter browser authorization: OAuth-style consent + PKCE, yielding a durable API key. */
import { OAuthCallbackFlow, type OAuthCallbackFlowOptions } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

export const ORCAROUTER_DEFAULT_API_BASE_URL = "https://api.orcarouter.ai";
export const ORCAROUTER_DEFAULT_AUTH_BASE_URL = "https://www.orcarouter.ai";
/** Backwards-compatible name for the inference/API origin. */
export const ORCAROUTER_DEFAULT_BASE_URL = ORCAROUTER_DEFAULT_API_BASE_URL;
const ORCAROUTER_CALLBACK_PORT = 51733;
const ORCAROUTER_CALLBACK_PATH = "/callback";
const ORCAROUTER_KEY_PREFIX = "sk-orca-";
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

export interface OrcaRouterLoginOptions {
  /** Inference base URL. A non-public value also acts as the auth origin for one-origin self-hosting. */
  baseUrl?: string;
  /** Optional dedicated auth origin; the public service defaults to www.orcarouter.ai. */
  authBaseUrl?: string;
}

interface OrcaRouterKeyPayload {
  key?: unknown;
  user_id?: unknown;
  scope?: unknown;
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Resolve the one configurable OrcaRouter origin used by both auth and inference.
 * Plain HTTP is accepted only on loopback so a long-lived key is never sent over a
 * clear-text remote connection by a typo in `ORCAROUTER_BASE_URL`.
 */
export function normalizeOrcaRouterBaseUrl(raw = ORCAROUTER_DEFAULT_BASE_URL): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    // Do not echo malformed input: it may contain credentials pasted into the URL.
    throw new Error("OrcaRouter base URL is invalid");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("OrcaRouter base URL must use HTTPS (HTTP is allowed only on loopback)");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("OrcaRouter base URL must not contain credentials, a query, or a fragment");
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path && path !== "/v1") {
    throw new Error("OrcaRouter base URL path must be empty or /v1");
  }
  return parsed.origin;
}

export function orcaRouterInferenceBaseUrl(raw?: string): string {
  return `${normalizeOrcaRouterBaseUrl(raw)}/v1`;
}

export function orcaRouterAuthBaseUrl(apiBaseUrl?: string, authBaseUrl?: string): string {
  if (authBaseUrl) return normalizeOrcaRouterBaseUrl(authBaseUrl);
  const apiOrigin = normalizeOrcaRouterBaseUrl(apiBaseUrl);
  return apiOrigin === ORCAROUTER_DEFAULT_API_BASE_URL
    ? ORCAROUTER_DEFAULT_AUTH_BASE_URL
    : apiOrigin;
}

function parseKeyPayload(value: unknown): OAuthCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OrcaRouter key exchange returned an invalid response");
  }
  const payload = value as OrcaRouterKeyPayload;
  const key = typeof payload.key === "string" ? payload.key.trim() : "";
  if (!key.startsWith(ORCAROUTER_KEY_PREFIX) || key.length > 4096 || /[\r\n]/.test(key)) {
    throw new Error("OrcaRouter key exchange did not return a valid API key");
  }
  if (payload.scope !== "api") {
    throw new Error("OrcaRouter key exchange did not grant the required api scope");
  }
  const accountId = typeof payload.user_id === "string"
    ? payload.user_id.trim()
    : typeof payload.user_id === "number" && Number.isSafeInteger(payload.user_id)
      ? String(payload.user_id)
      : "";
  if (!accountId || accountId.length > 256 || /[\x00-\x1f\x7f]/.test(accountId)) {
    throw new Error("OrcaRouter key exchange did not return a valid user id");
  }
  // OrcaRouter issues a normal long-lived API key, not a refresh token. The OAuth
  // store requires both fields, so mirror the established Command Code key-grant
  // representation. `expires` prevents background refresh; an upstream 401 asks the
  // user to reconnect and mint a replacement key.
  return {
    access: key,
    refresh: key,
    expires: Number.MAX_SAFE_INTEGER,
    accountId,
    source: "oauth",
  };
}

function assertDurableApiKey(apiKey: string): void {
  const key = apiKey.trim();
  if (!key.startsWith(ORCAROUTER_KEY_PREFIX) || key.length > 4096 || /[\r\n]/.test(key)) {
    throw new Error("OrcaRouter API key is invalid; reconnect with ocx login orcarouter-oauth");
  }
}

export class OrcaRouterOAuthFlow extends OAuthCallbackFlow {
  readonly #authBaseUrl: string;
  #verifier = "";

  constructor(ctrl: OAuthController, options: OrcaRouterLoginOptions = {}) {
    super(ctrl, {
      preferredPort: ORCAROUTER_CALLBACK_PORT,
      callbackPath: ORCAROUTER_CALLBACK_PATH,
      callbackHostname: "127.0.0.1",
      callbackBindHostname: "127.0.0.1",
    } satisfies OAuthCallbackFlowOptions);
    this.#authBaseUrl = orcaRouterAuthBaseUrl(options.baseUrl, options.authBaseUrl);
  }

  async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions: string }> {
    const pkce = await generatePKCE();
    this.#verifier = pkce.verifier;
    const url = new URL("/auth", this.#authBaseUrl);
    url.search = new URLSearchParams({
      callback_url: redirectUri,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state,
      app_name: "OpenCodex",
      scope: "api",
    }).toString();
    return {
      url: url.toString(),
      instructions:
        "Approve access in your browser. If the browser cannot reach this machine, choose the displayed-code option and paste the code here.",
    };
  }

  async exchangeToken(code: string, _state: string, _redirectUri: string): Promise<OAuthCredentials> {
    if (!this.#verifier) throw new Error("OrcaRouter PKCE verifier was not initialized");
    let response: Response;
    try {
      response = await fetch(new URL("/api/v1/auth/keys", this.#authBaseUrl), {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          code_verifier: this.#verifier,
          code_challenge_method: "S256",
        }),
        redirect: "error",
        signal: requestSignal(this.ctrl.signal),
      });
    } catch (error) {
      if (this.ctrl.signal?.aborted) {
        throw this.ctrl.signal.reason ?? new DOMException("OrcaRouter login aborted", "AbortError");
      }
      throw new Error("OrcaRouter key exchange failed: network error", { cause: error });
    }
    if (!response.ok) {
      // The body is deliberately not reflected: authentication error payloads must
      // never turn a code, verifier, or accidentally returned key into console output.
      throw new Error(`OrcaRouter key exchange failed with HTTP ${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("OrcaRouter key exchange returned invalid JSON");
    }
    return parseKeyPayload(payload);
  }
}

export async function loginOrcaRouter(
  ctrl: OAuthController,
  options: OrcaRouterLoginOptions = {},
): Promise<OAuthCredentials> {
  if (ctrl.signal?.aborted) {
    throw ctrl.signal.reason ?? new DOMException("OrcaRouter login aborted", "AbortError");
  }
  return new OrcaRouterOAuthFlow(ctrl, options).login();
}

export async function refreshOrcaRouterKey(apiKey: string): Promise<never> {
  assertDurableApiKey(apiKey);
  // This hook is reached only after upstream rejected the durable key. There is no refresh
  // grant to replay, so classify the credential as terminal and let the shared generation-safe
  // refresh path mark this exact account as needing a new browser login.
  throw new Error("invalid_grant: OrcaRouter API keys cannot be refreshed; reconnect with ocx login orcarouter-oauth");
}
