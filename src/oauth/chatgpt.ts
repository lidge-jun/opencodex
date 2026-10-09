import { OAuthCallbackFlow } from "./callback-server";
import type { OAuthController, OAuthCredentials } from "./types";
import { generatePKCE } from "./pkce";
import { classifyChatgptRefreshFailure } from "../codex/chatgpt-refresh-failure";
import { readBoundedResponseBytes } from "../lib/bounded-body";

/**
 * Per-fetch deadline for ChatGPT auth endpoint calls. The deviceauth grant got the
 * same bound in #3898 after one stuck TCP connection held the login slot for the
 * whole grant; a hung refresh would pin the refresh intent lock indefinitely.
 */
export const CHATGPT_FETCH_TIMEOUT_MS = 30_000;

/** Non-HTTP failures retain no caller reason, upstream error, or cause. */
export class ChatGptTokenRequestError extends Error {
  readonly terminal = false;

  constructor(kind: "abort" | "timeout" | "transport") {
    super(kind === "abort" ? "ChatGPT token request cancelled"
      : kind === "timeout" ? "ChatGPT token request timed out" : "ChatGPT token request failed");
    this.name = kind === "abort" ? "AbortError" : kind === "timeout" ? "TimeoutError" : "ChatGptTokenRequestError";
  }
}

const CHATGPT_ERROR_BODY_MAX_BYTES = 16 * 1024;
const CHATGPT_SUCCESS_BODY_MAX_BYTES = 64 * 1024;

/** One deadline covers headers and body; every settled call detaches its caller. */
async function chatGptTokenRequest(
  body: URLSearchParams,
  label: "ChatGPT refresh" | "ChatGPT token exchange",
  options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<OAuthCredentials> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(new ChatGptTokenRequestError("abort"));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(new ChatGptTokenRequestError("timeout")),
    options.timeoutMs ?? CHATGPT_FETCH_TIMEOUT_MS);
  let endpointError: ChatGptTokenError | undefined;
  try {
    controller.signal.throwIfAborted();
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
    const result = await readBoundedResponseBytes(response, {
      signal: controller.signal,
      maxBytes: response.ok ? CHATGPT_SUCCESS_BODY_MAX_BYTES : CHATGPT_ERROR_BODY_MAX_BYTES,
    });
    controller.signal.throwIfAborted();
    const text = new TextDecoder().decode(result.bytes);
    if (!response.ok) {
      endpointError = chatGptTokenError(response.status, result.oversized ? "" : text, label);
      throw endpointError;
    }
    if (result.oversized) throw new ChatGptTokenRequestError("transport");
    return credsFromToken(JSON.parse(text) as Record<string, unknown>);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (endpointError && error === endpointError) throw endpointError;
    throw new ChatGptTokenRequestError("transport");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Token-endpoint failure carrying the HTTP status, the allowlisted OAuth error code,
 * and a terminal verdict requiring an explicit grant-refusal code. The shared
 * Codex classifier supplies the code vocabulary; free text is never grant evidence.
 */
export class ChatGptTokenError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly oauthError: string | undefined,
    public readonly terminal: boolean,
    message: string,
  ) {
    super(message);
    this.name = "ChatGptTokenError";
  }
}

function chatGptTokenError(status: number, body: string, label: string): ChatGptTokenError {
  const failure = classifyChatgptRefreshFailure(status, body);
  // Reclassify the allowlisted code alone to reuse the shared terminal vocabulary
  // without its description-only compatibility rule for other Codex callers.
  const terminal = failure.reason !== "unknown" && failure.code !== undefined
    && classifyChatgptRefreshFailure(status, JSON.stringify({ error: failure.code })).reason !== "unknown";
  // The message carries the status and the allowlisted OAuth code only — never the
  // free-text `error_description`, which can echo OAuth material into log surfaces
  // (the same closed vocabulary the pool's noteChatgptRefreshFailure logs with).
  return new ChatGptTokenError(
    status,
    failure.code,
    terminal,
    `${label} failed: ${status} code=${failure.code ?? "none"}`,
  );
}

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";

/** Shared with the deviceauth grant in `./chatgpt-device`: same public PKCE client. */
export const CHATGPT_CLIENT_ID = CLIENT_ID;
export const CHATGPT_TOKEN_URL = TOKEN_URL;
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const ORIGINATOR = "opencodex";

export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function extractAccountId(idToken?: string, accessToken?: string): string | undefined {
  for (const token of [idToken, accessToken]) {
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    if (!payload) continue;
    if (typeof payload.chatgpt_account_id === "string") return payload.chatgpt_account_id;
    const ns = payload["https://api.openai.com/auth"];
    if (ns && typeof ns === "object" && typeof (ns as Record<string, unknown>).chatgpt_account_id === "string") {
      return (ns as Record<string, unknown>).chatgpt_account_id as string;
    }
    const orgs = payload.organizations;
    if (Array.isArray(orgs) && orgs[0] && typeof orgs[0].id === "string") return orgs[0].id as string;
  }
  return undefined;
}

/**
 * Three-way answer to "is this token marked as belonging to the ChatGPT account domain".
 * Only ChatGPT-specific claims count as markers: a top-level chatgpt_account_id or the
 * https://api.openai.com/auth namespace claim. A generic organizations claim is NOT domain
 * evidence. JWT claims are decoded locally as routing markers, never as authenticity proof.
 *
 * absent  — no JWT, a payload that is not a JSON object, or an object carrying neither
 *           marker key: the token may be a foreign credential and legacy foreign handling
 *           applies. This function is total; it never throws on an attacker-shaped token.
 * invalid — a marker key is present but yields no usable account id (non-string, blank,
 *           namespace that is not an object, namespace without the claim) or the two
 *           markers disagree. Presence is decided by the KEY, not by its shape, so a token
 *           that claims this domain can never fall through to foreign handling just
 *           because its marker is malformed.
 * valid   — one consistent, non-blank ChatGPT account id.
 */
export type ChatGptDomainClaim =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "valid"; accountId: string };

const CHATGPT_AUTH_NAMESPACE = "https://api.openai.com/auth";

/** A usable account id is a non-blank string; blank or non-string values are malformed. */
function usableAccountId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function inspectChatGptDomainClaim(token: string): ChatGptDomainClaim {
  const payload: unknown = decodeJwtPayload(token);
  // decodeJwtPayload returns whatever the payload segment parses to, which may be a
  // primitive or an array. Those carry no marker and must not reach the key lookups,
  // where `in`/hasOwn would throw and take the whole request down.
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { kind: "absent" };
  const claims = payload as Record<string, unknown>;
  // Presence is the KEY being there, as an own key. A reserved namespace that is null, a
  // primitive, an array, or an object without the claim is a present-but-broken marker, so
  // it stays invalid instead of being treated as a foreign token.
  const topPresent = Object.hasOwn(claims, "chatgpt_account_id");
  const nsPresent = Object.hasOwn(claims, CHATGPT_AUTH_NAMESPACE);
  if (!topPresent && !nsPresent) return { kind: "absent" };
  const topId = topPresent ? usableAccountId(claims.chatgpt_account_id) : undefined;
  if (topPresent && !topId) return { kind: "invalid" };
  let nsId: string | undefined;
  if (nsPresent) {
    const ns = claims[CHATGPT_AUTH_NAMESPACE];
    const nsObj = ns !== null && typeof ns === "object" && !Array.isArray(ns)
      ? ns as Record<string, unknown> : undefined;
    nsId = nsObj ? usableAccountId(nsObj.chatgpt_account_id) : undefined;
    if (!nsId) return { kind: "invalid" };
  }
  if (topId && nsId && topId !== nsId) return { kind: "invalid" };
  const accountId = topId ?? nsId;
  return accountId ? { kind: "valid", accountId } : { kind: "invalid" };
}

export function extractEmail(idToken?: string, accessToken?: string): string | undefined {
  for (const token of [idToken, accessToken]) {
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    if (!payload) continue;
    if (typeof payload.email === "string") return payload.email.toLowerCase();
  }
  return undefined;
}

/**
 * Identity-agreement view of one token for security-sensitive bindings. `accountId` follows the
 * existing extractAccountId precedence (top-level, then namespaced, then organizations[0]).
 * `conflict` is true only when the two chatgpt_account_id encodings are both present and
 * disagree — organizations entries are workspace memberships, not identity, so they never
 * participate. Never logs token material.
 */
export function extractAccountIdClaims(token?: string): { accountId: string | undefined; conflict: boolean } {
  if (!token) return { accountId: undefined, conflict: false };
  const payload = decodeJwtPayload(token);
  if (!payload) return { accountId: undefined, conflict: false };
  const top = typeof payload.chatgpt_account_id === "string" ? payload.chatgpt_account_id : undefined;
  const ns = payload["https://api.openai.com/auth"];
  const namespaced = ns && typeof ns === "object"
    && typeof (ns as Record<string, unknown>).chatgpt_account_id === "string"
    ? (ns as Record<string, unknown>).chatgpt_account_id as string
    : undefined;
  const orgs = payload.organizations;
  const org = Array.isArray(orgs) && orgs[0] && typeof orgs[0].id === "string"
    ? orgs[0].id as string
    : undefined;
  return {
    accountId: top ?? namespaced ?? org,
    conflict: top !== undefined && namespaced !== undefined && top !== namespaced,
  };
}

export function credsFromToken(data: Record<string, unknown>): OAuthCredentials {
  const idToken = typeof data.id_token === "string" ? data.id_token : undefined;
  // This parses a response from an external boundary, so the access token is
  // validated rather than cast. A 200 carrying no access_token would otherwise
  // resolve a login as successful with an undefined credential, which then gets
  // silently declined at persistence — a success message and no account.
  const accessToken = typeof data.access_token === "string" && data.access_token.length > 0
    ? data.access_token
    : undefined;
  if (!accessToken) throw new Error("ChatGPT token response missing access token");
  const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : "";
  // ?? only guards null/undefined; NaN or a string expires_in would otherwise
  // produce a NaN expiry that never compares as expired, and a negative duration
  // would stamp an already-past expiry — both block refresh semantics.
  const expiresIn =
    typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in >= 0
      ? data.expires_in
      : 3600;
  // The computed timestamp itself must stay finite: Number.MAX_VALUE passes
  // Number.isFinite but overflows to Infinity once multiplied by 1000.
  const computedExpires = Date.now() + expiresIn * 1000;
  const expires = Number.isFinite(computedExpires) ? computedExpires : Date.now() + 3600 * 1000;
  return {
    access: accessToken,
    refresh: refreshToken,
    expires,
    accountId: extractAccountId(idToken, accessToken),
    email: extractEmail(idToken, accessToken),
  };
}

export class ChatGPTOAuthFlow extends OAuthCallbackFlow {
  #verifier = "";
  forceLogin = false;

  constructor(ctrl: OAuthController) {
    super(ctrl, {
      preferredPort: CALLBACK_PORT,
      callbackPath: CALLBACK_PATH,
      callbackHostname: "localhost",
      callbackBindHostname: "127.0.0.1",
      redirectUri: `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`,
    });
  }

  async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
    const pkce = await generatePKCE();
    this.#verifier = pkce.verifier;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      scope: SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state,
      codex_cli_simplified_flow: "true",
      originator: ORIGINATOR,
    });
    params.set("id_token_add_organizations", "true");
    if (this.forceLogin) params.set("prompt", "login");
    return {
      url: `${AUTH_URL}?${params}`,
      instructions: "Complete ChatGPT login in your browser.",
    };
  }

  async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
    if (!this.#verifier) throw new Error("ChatGPT PKCE verifier not initialized");
    return chatGptTokenRequest(new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: this.#verifier,
    }), "ChatGPT token exchange", { signal: this.ctrl.signal });
  }
}

/**
 * How the user proves identity. `browser` runs the localhost:1455 callback flow;
 * `device` runs the deviceauth grant, which needs no local browser or listener
 * and is the only workable path on a headless or remote hub (#3366).
 */
export type ChatGPTLoginFlow = "browser" | "device";

export async function loginChatGPT(
  ctrl: OAuthController,
  opts?: { forceLogin?: boolean; flow?: ChatGPTLoginFlow },
): Promise<OAuthCredentials> {
  if (opts?.flow === "device") {
    // Imported lazily so the callback flow does not pay for a module it never uses.
    const { loginChatGPTDevice } = await import("./chatgpt-device");
    return loginChatGPTDevice(ctrl);
  }
  const flow = new ChatGPTOAuthFlow(ctrl);
  if (opts?.forceLogin) flow.forceLogin = true;
  return flow.login();
}

// Note: uses form-urlencoded per OAuth 2.0 spec (RFC 6749 §6).
// Codex-rs uses JSON for refresh — intentional divergence; both accepted by auth.openai.com.
export async function refreshChatGPTToken(
  refreshToken: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<OAuthCredentials> {
  return chatGptTokenRequest(new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  }), "ChatGPT refresh", options);
}
