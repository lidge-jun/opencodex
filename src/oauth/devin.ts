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
import { DEVIN_DEFAULT_API_SERVER, resolveDevinApiBaseUrl, validateDevinApiBaseUrl } from "./devin/api-base";
import { getCredential } from "./store";

export { DEVIN_DEFAULT_API_SERVER } from "./devin/api-base";

/**
 * The api-server host this account must talk to.
 *
 * RegisterUser hands EU and FedStart tenants a host of their own and it is kept
 * on the credential, so the signed-in account decides the destination. The
 * configured provider baseUrl is the fallback, and the US default is the last
 * resort; both are re-validated because neither is trusted more than the
 * network value.
 */
export function resolveDevinApiServer(configuredBaseUrl?: string, providerId = "devin"): string {
  return (
    // Provider-scoped. `devin` and `devin-cli` share this transport and this token
    // format but sign in to different accounts, and an EU or FedStart tenant is
    // recorded on the credential rather than in the registry. Reading a fixed
    // "devin" slot sent one provider's key to the other's host.
    validateDevinApiBaseUrl(getCredential(providerId)?.apiBaseUrl) ??
    validateDevinApiBaseUrl(configuredBaseUrl) ??
    DEVIN_DEFAULT_API_SERVER
  );
}

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

export function identityFromApiKey(apiKey: string): { accountId?: string; email?: string } {
  const jwtPart = apiKey.includes("$") ? apiKey.slice(apiKey.indexOf("$") + 1) : apiKey;
  const payload = decodeJwtPayload(jwtPart);
  const email = typeof payload?.email === "string" && payload.email.length > 0 ? payload.email : undefined;
  const sub = typeof payload?.sub === "string" && payload.sub.length > 0 ? payload.sub : undefined;
  const authUid = typeof payload?.auth_uid === "string" && payload.auth_uid.length > 0 ? payload.auth_uid : undefined;
  return { ...(email ? { email } : {}), ...(sub || authUid ? { accountId: sub ?? authUid } : {}) };
}

function credentialsFromApiKey(
  apiKey: string,
  apiBaseUrl: string,
  source: OAuthCredentials["source"] = "oauth",
): OAuthCredentials {
  const identity = identityFromApiKey(apiKey);
  return {
    access: apiKey,
    // Cognition issues a durable key and exposes no refresh endpoint. Carrying
    // the key here rather than "" is the house pattern for durable-key
    // providers: an empty refresh makes detectOAuthWarning report
    // stale_credentials for every Devin account from the moment it logs in.
    refresh: apiKey,
    // No expiry to model. A synthetic one-year deadline only produces a
    // refresh attempt against an endpoint that does not exist.
    expires: Number.MAX_SAFE_INTEGER,
    source,
    apiBaseUrl,
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

/**
 * Shape of the value the sign-in page hands back.
 *
 * It is not always a JWT. A live free-tier sign-in against
 * windsurf.com/windsurf/signin returns a 47-character one-time token of the
 * form `ott$<base64url>`, and RegisterUser accepts it; an earlier JWT-only
 * check here would have rejected every real login. So this is deliberately a
 * shape check for "one opaque credential-looking word" rather than a format
 * check: the point is to tell a token from a pasted URL or a sentence, not to
 * second-guess what the vendor mints.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9._$~+/=-]{20,4096}$/;

const TOKEN_PARAM_NAMES = ["firebase_id_token", "access_token", "id_token", "token"] as const;

/**
 * Turn whatever the user pasted into the Firebase ID token RegisterUser expects.
 *
 * The sign-in page shows a bare token, but a user who copies the address bar
 * instead hands us a callback URL whose fragment carries it. Posting that URL
 * as `firebase_id_token` produces an opaque server-side rejection, so pull the
 * token out and refuse a paste that has none rather than sending something that
 * cannot work.
 */
export function parseDevinAuthPaste(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("No auth token pasted; cannot complete Devin sign-in.");
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error("That paste is not a usable Devin auth token or sign-in URL.");
    }
    const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    for (const params of [new URLSearchParams(hash), url.searchParams]) {
      for (const name of TOKEN_PARAM_NAMES) {
        const value = params.get(name)?.trim();
        if (value && TOKEN_SHAPE.test(value)) return value;
      }
    }
    throw new Error("That sign-in URL carries no auth token. Paste the token shown on the Windsurf page instead.");
  }
  if (TOKEN_SHAPE.test(trimmed)) return trimmed;
  throw new Error("That paste is not a Devin auth token. Copy the token shown on the Windsurf sign-in page.");
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
  const firebaseIdToken = parseDevinAuthPaste(pasted);
  const result = await registerUser(firebaseIdToken, region, ctrl.signal);
  const credentials = credentialsFromApiKey(result.apiKey, resolveDevinApiBaseUrl(result.apiServerUrl), "oauth");
  // The display name is not an identity. Use it only when the key carried no
  // email, otherwise reauth compares a label against an address and mismatches.
  if (!credentials.email && result.name) credentials.email = result.name;
  return credentials;
}

export async function loginDevin(ctrl: OAuthController): Promise<OAuthCredentials> {
  return loginDevinBrowser(ctrl, DEFAULT_REGION);
}

export async function refreshDevinToken(
  _refreshToken: string,
  _signal?: AbortSignal,
  _credential?: OAuthCredentials,
): Promise<OAuthCredentials> {
  // Cognition has no refresh endpoint. Extending the stored expiry here is what
  // the carried implementation did, and it makes a revoked key look valid
  // forever. Throwing lets the request path mark the account needsReauth the
  // first time a forced refresh happens.
  throw new Error("invalid_grant: Devin API keys do not refresh. Run ocx login devin again.");
}
