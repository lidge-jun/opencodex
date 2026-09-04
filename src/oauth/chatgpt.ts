import { OAuthCallbackFlow } from "./callback-server";
import type { OAuthController, OAuthCredentials } from "./types";
import { generatePKCE } from "./pkce";

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

export function extractEmail(idToken?: string, accessToken?: string): string | undefined {
  for (const token of [idToken, accessToken]) {
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    if (!payload) continue;
    if (typeof payload.email === "string") return payload.email.toLowerCase();
  }
  return undefined;
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
