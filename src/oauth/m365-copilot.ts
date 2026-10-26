import type { OAuthController, OAuthCredentials } from "./types";
import { generatePKCE } from "./pkce";
import { captureM365BrowserCode } from "./m365-copilot-browser";

/** Microsoft's M365 Chat Client, documented in MicrosoftDocs/entra-docs known-guids.json. */
export const M365_COPILOT_CLIENT_ID = "c0ab8ce9-e9a0-42e7-b064-33d422df41f1";
export const M365_COPILOT_REDIRECT_URI = "https://login.microsoftonline.com/common/oauth2/nativeclient";
const AUTHORITY = "https://login.microsoftonline.com/organizations/oauth2/v2.0";
const SCOPE = "openid profile offline_access https://substrate.office.com/sydney/M365Chat.Read https://substrate.office.com/sydney/sydney.readwrite";

export interface M365CopilotClaims { oid: string; tid: string; exp: number; preferred_username?: string; upn?: string }
export function m365CopilotClaims(token: string): M365CopilotClaims {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!guid.test(claims.oid) || !guid.test(claims.tid) || !Number.isFinite(claims.exp)) throw new Error();
    return claims;
  } catch { throw new Error("Microsoft 365 Copilot returned an invalid work-account token"); }
}

export function m365CopilotAuthorizationUrl(challenge: string, state: string): string {
  const url = new URL(AUTHORITY + "/authorize");
  url.search = new URLSearchParams({ client_id: M365_COPILOT_CLIENT_ID, response_type: "code", response_mode: "query",
    redirect_uri: M365_COPILOT_REDIRECT_URI, scope: SCOPE, code_challenge: challenge, code_challenge_method: "S256", state,
    prompt: "select_account" }).toString();
  return url.toString();
}

async function exchangeM365Token(parameters: Record<string, string>, signal?: AbortSignal): Promise<OAuthCredentials> {
  const response = await fetch(AUTHORITY + "/token", {
    method: "POST", redirect: "error", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: M365_COPILOT_CLIENT_ID, scope: SCOPE, ...parameters }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  const refresh = typeof body?.refresh_token === "string" ? body.refresh_token : parameters.refresh_token;
  if (!response.ok || typeof body?.access_token !== "string" || typeof refresh !== "string") {
    const code = body?.error === "invalid_grant" ? "invalid_grant" : body?.error === "access_denied" ? "access_denied" : "token_request_failed";
    throw new Error("Microsoft 365 Copilot OAuth " + code);
  }
  const claims = m365CopilotClaims(body.access_token);
  const email = typeof claims.preferred_username === "string" ? claims.preferred_username : typeof claims.upn === "string" ? claims.upn : undefined;
  return { access: body.access_token, refresh, expires: claims.exp * 1_000, ...(email ? { email } : {}),
    accountId: claims.oid + "@" + claims.tid, source: "oauth" };
}

export async function loginM365Copilot(ctrl: OAuthController): Promise<OAuthCredentials> {
  const { verifier, challenge } = await generatePKCE();
  const state = crypto.randomUUID();
  const code = await captureM365BrowserCode(m365CopilotAuthorizationUrl(challenge, state), state, ctrl);
  return exchangeM365Token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: M365_COPILOT_REDIRECT_URI }, ctrl.signal);
}
export function refreshM365CopilotToken(refresh: string, signal?: AbortSignal): Promise<OAuthCredentials> {
  return exchangeM365Token({ grant_type: "refresh_token", refresh_token: refresh }, signal);
}
