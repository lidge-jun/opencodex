import type { OAuthCredentials } from "./types";

/**
 * What the browser callback grant and the deviceauth grant share: the public PKCE client and the
 * way a token response becomes credentials.
 *
 * This is a leaf on purpose. `./chatgpt-device` needs these, and `./chatgpt` needs the device
 * grant for `flow: "device"`; importing them straight from `./chatgpt` made the pair a cycle.
 */

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";

/** Shared with the deviceauth grant in `./chatgpt-device`: same public PKCE client. */
export const CHATGPT_CLIENT_ID = CLIENT_ID;
export const CHATGPT_TOKEN_URL = TOKEN_URL;

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
