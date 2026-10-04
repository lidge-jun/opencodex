import { OAuthCallbackFlow } from "./callback-server";
import { CHATGPT_CLIENT_ID, CHATGPT_TOKEN_URL, credsFromToken, decodeJwtPayload, extractAccountId, extractEmail } from "./chatgpt-shared";
import type { OAuthController, OAuthCredentials } from "./types";
import { generatePKCE } from "./pkce";

/**
 * The client and the token decoding live in `./chatgpt-shared`, a leaf, because
 * `./chatgpt-device` needs them too while this module needs the device grant back for
 * `flow: "device"`. Re-exported so every existing import site keeps one place to import from.
 */
export { CHATGPT_CLIENT_ID, CHATGPT_TOKEN_URL, credsFromToken, decodeJwtPayload, extractAccountId, extractEmail };
const CLIENT_ID = CHATGPT_CLIENT_ID;
const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = CHATGPT_TOKEN_URL;
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const ORIGINATOR = "opencodex";

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
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        redirect_uri: redirectUri,
        code_verifier: this.#verifier,
      }).toString(),
    });
    if (!resp.ok) {
      const errDesc = await safeErrorDescription(resp);
      throw new Error(`ChatGPT token exchange failed: ${resp.status} ${errDesc}`);
    }
    return credsFromToken((await resp.json()) as Record<string, unknown>);
  }
}

function safeErrorDescription(resp: Response): Promise<string> {
  return resp.text().catch(() => "").then(text => {
    try {
      const parsed = JSON.parse(text) as { error?: string; error_description?: string };
      return [parsed.error, parsed.error_description].filter(Boolean).join(": ") || `HTTP ${resp.status}`;
    } catch { return `HTTP ${resp.status}`; }
  });
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
  options: { signal?: AbortSignal } = {},
): Promise<OAuthCredentials> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }).toString(),
    signal: options.signal,
  });
  if (!resp.ok) {
    const errDesc = await safeErrorDescription(resp);
    throw new Error(`ChatGPT refresh failed: ${resp.status} ${errDesc}`);
  }
  return credsFromToken((await resp.json()) as Record<string, unknown>);
}
