/**
 * Devin / Cognition OAuth.
 *
 * Login opens the Auth0 browser sign-in flow (windsurf.com/windsurf/signin
 * with redirect_uri=show-auth-token), then exchanges the pasted Firebase ID
 * token via Cognition's RegisterUser for a long-lived API key.
 */
import { randomUUID } from "node:crypto";
import type { OAuthController, OAuthCredentials } from "./types";
import { DEFAULT_REGION, type WindsurfRegion } from "./devin/types";
import { registerUser } from "./devin/register-user";

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_API_SERVER = "https://server.codeium.com";
export const DEVIN_DEFAULT_API_SERVER = DEFAULT_API_SERVER;

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length < 2 || !payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function identityFromApiKey(apiKey: string): { accountId?: string; email?: string } {
  const jwtPart = apiKey.includes("$") ? apiKey.slice(apiKey.indexOf("$") + 1) : apiKey;
  const payload = decodeJwtPayload(jwtPart);
  const email = typeof payload?.email === "string" && payload.email.length > 0 ? payload.email : undefined;
  const sub = typeof payload?.sub === "string" && payload.sub.length > 0 ? payload.sub : undefined;
  const authUid = typeof payload?.auth_uid === "string" && payload.auth_uid.length > 0 ? payload.auth_uid : undefined;
  return { ...(email ? { email } : {}), ...(sub || authUid ? { accountId: sub ?? authUid } : {}) };
}

function credentialsFromApiKey(apiKey: string, source: OAuthCredentials["source"] = "oauth"): OAuthCredentials {
  const identity = identityFromApiKey(apiKey);
  return {
    access: apiKey,
    refresh: "",
    expires: Date.now() + ONE_YEAR_MS,
    source,
    apiBaseUrl: DEFAULT_API_SERVER,
    ...identity,
  };
}

function buildSignInUrl(region: WindsurfRegion): string {
  const params = new URLSearchParams({
    response_type: "token",
    client_id: region.oauthClientId,
    redirect_uri: "show-auth-token",
    state: randomUUID(),
    prompt: "login",
  });
  return region.website + "/windsurf/signin?" + params.toString();
}

async function loginDevinBrowser(ctrl: OAuthController, region: WindsurfRegion): Promise<OAuthCredentials> {
  const url = buildSignInUrl(region);
  ctrl.onAuth?.({
    url,
    instructions: "Sign in with your Cognition/Devin account, then paste the on-screen auth token here.",
  });
  ctrl.onProgress?.("Waiting for the pasted auth token...");
  const pasted = (await ctrl.onManualCodeInput?.())?.trim();
  if (!pasted) throw new Error("No auth token pasted; cannot complete Devin sign-in.");
  const result = await registerUser(pasted, region);
  return {
    ...credentialsFromApiKey(result.apiKey, "oauth"),
    ...(result.name ? { email: result.name } : {}),
    apiBaseUrl: result.apiServerUrl || DEFAULT_API_SERVER,
  };
}

export async function loginDevin(ctrl: OAuthController): Promise<OAuthCredentials> {
  return loginDevinBrowser(ctrl, DEFAULT_REGION);
}

export async function refreshDevinToken(
  _refreshToken: string,
  _signal?: AbortSignal,
  credential?: OAuthCredentials,
): Promise<OAuthCredentials> {
  if (credential?.access) {
    return {
      ...credential,
      refresh: credential.refresh ?? "",
      expires: Math.max(credential.expires, Date.now() + ONE_YEAR_MS),
    };
  }
  throw new Error("Devin API keys do not refresh. Run ocx login devin again.");
}
