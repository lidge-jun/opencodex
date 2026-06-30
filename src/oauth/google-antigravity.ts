/**
 * Google Antigravity (Cloud Code Assist) OAuth + project discovery.
 *
 * Mirrors CLIProxyAPI `internal/auth/antigravity/*`. Flow: standard Google OAuth (PKCE) → discover
 * the Cloud Code Assist project via `loadCodeAssist`, onboarding via `onboardUser` when the account
 * has no project yet. The discovered `projectId` is stored on the credential and injected into the
 * CCA request envelope by the google adapter.
 *
 * The client id/secret below are the public OAuth client identifiers embedded in the Antigravity
 * desktop client (overridable via env), not user secrets. Tokens/refresh are never logged.
 */
import { OAuthCallbackFlow, type OAuthCallbackFlowOptions } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";
import { antigravityUserAgent, ANTIGRAVITY_GOOG_API_CLIENT_UA } from "../adapters/client-fingerprint";

const CLIENT_ID = process.env.GOOGLE_ANTIGRAVITY_CLIENT_ID
  || "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = process.env.GOOGLE_ANTIGRAVITY_CLIENT_SECRET
  || "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";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const PROD_API = "https://cloudcode-pa.googleapis.com";
const DAILY_API = "https://daily-cloudcode-pa.googleapis.com";
const API_VERSION = "v1internal";
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];
const CALLBACK_PORT = 51121;
const CALLBACK_PATH = "/callback";
const REFRESH_SKEW_MS = 50 * 60 * 1000; // refresh proactively ~50min before nominal 1h expiry
const REQUEST_TIMEOUT_MS = 30_000;
const ONBOARD_ATTEMPTS = 5;
const ONBOARD_POLL_MS = 2_000;

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

interface GoogleTokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function emailFromToken(accessToken: string, idToken: string | undefined): string | undefined {
  const payload = (idToken ? decodeJwtPayload(idToken) : undefined) ?? decodeJwtPayload(accessToken);
  const email = payload?.email;
  return typeof email === "string" && email.length > 0 ? email.toLowerCase() : undefined;
}

async function postToken(body: Record<string, string>, signal?: AbortSignal): Promise<GoogleTokenPayload> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: requestSignal(signal),
  });
  if (!response.ok) {
    // Status only — the body can carry grant/account details.
    throw new Error(`Antigravity token request failed: ${response.status}`);
  }
  return (await response.json()) as GoogleTokenPayload;
}

/** Pull a Cloud Code Assist project id out of a loadCodeAssist/onboardUser response shape. */
function extractProjectId(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
      return (value as { id: string }).id;
    }
  }
  return undefined;
}

async function loadCodeAssistProject(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
  const response = await fetch(`${PROD_API}/${API_VERSION}:loadCodeAssist`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "*/*", "Content-Type": "application/json", "User-Agent": antigravityUserAgent() },
    body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
    signal: requestSignal(signal),
  });
  if (!response.ok) return undefined;
  return extractProjectId((await response.json().catch(() => undefined)) as Record<string, unknown> | undefined);
}

async function onboardProject(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
  for (let attempt = 0; attempt < ONBOARD_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error("Antigravity onboarding aborted");
    const response = await fetch(`${DAILY_API}/${API_VERSION}:onboardUser`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "*/*", "Content-Type": "application/json", "User-Agent": antigravityUserAgent(), "x-goog-api-client": ANTIGRAVITY_GOOG_API_CLIENT_UA },
      body: JSON.stringify({ tier_id: "free-tier", metadata: { ide_type: "ANTIGRAVITY", ide_name: "antigravity", ide_version: antigravityUserAgent() } }),
      signal: requestSignal(signal),
    });
    if (!response.ok) {
      // Transient (429/5xx): keep polling within the attempt budget. Hard 4xx: give up now.
      if (response.status === 429 || response.status >= 500) {
        await new Promise(resolve => setTimeout(resolve, ONBOARD_POLL_MS));
        continue;
      }
      return undefined;
    }
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (data.done === true) {
      return extractProjectId(data.response as Record<string, unknown> | undefined);
    }
    await new Promise(resolve => setTimeout(resolve, ONBOARD_POLL_MS));
  }
  return undefined;
}

/** Discover the CCA project for an access token (loadCodeAssist → onboardUser fallback). */
export async function discoverAntigravityProject(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
  return (await loadCodeAssistProject(accessToken, signal)) ?? (await onboardProject(accessToken, signal));
}

function credentialsFromPayload(payload: GoogleTokenPayload, refreshFallback = ""): OAuthCredentials {
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw new Error("Antigravity token response did not include an access token");
  }
  const refresh = typeof payload.refresh_token === "string" && payload.refresh_token.length > 0
    ? payload.refresh_token
    : refreshFallback;
  if (!refresh) throw new Error("Antigravity token response did not include a refresh token");
  const expiresIn = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 3600;
  const idToken = typeof payload.id_token === "string" ? payload.id_token : undefined;
  return {
    refresh,
    access: payload.access_token,
    expires: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS,
    email: emailFromToken(payload.access_token, idToken),
  };
}

class AntigravityOAuthFlow extends OAuthCallbackFlow {
  #verifier = "";

  constructor(ctrl: OAuthController) {
    super(ctrl, {
      preferredPort: CALLBACK_PORT,
      callbackPath: CALLBACK_PATH,
      callbackHostname: "127.0.0.1",
      callbackBindHostname: "127.0.0.1",
      redirectUri: `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`,
    } satisfies OAuthCallbackFlowOptions);
  }

  async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
    const pkce = await generatePKCE();
    this.#verifier = pkce.verifier;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      scope: SCOPES.join(" "),
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return {
      url: `${AUTH_ENDPOINT}?${params.toString()}`,
      instructions: "Complete Google (Antigravity) login in your browser, then paste the redirect URL or code if prompted.",
    };
  }

  async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
    if (!this.#verifier) throw new Error("Antigravity OAuth PKCE verifier was not initialized");
    const payload = await postToken({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      code_verifier: this.#verifier,
    }, this.ctrl.signal);
    const creds = credentialsFromPayload(payload);
    this.ctrl.onProgress?.("Discovering Cloud Code Assist project");
    const projectId = await discoverAntigravityProject(creds.access, this.ctrl.signal);
    if (!projectId) {
      // Fail the login rather than persisting a credential that every request would reject for a
      // missing CCA project — otherwise status shows "logged in" while all calls fail closed.
      throw new Error("Antigravity login could not discover a Cloud Code Assist project for this account. Ensure the account has Antigravity/Cloud Code Assist access and try again.");
    }
    return { ...creds, projectId };
  }
}

export async function loginAntigravity(ctrl: OAuthController): Promise<OAuthCredentials> {
  return new AntigravityOAuthFlow(ctrl).login();
}

export async function refreshAntigravityToken(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredentials> {
  if (!refreshToken) throw new Error("Antigravity credentials are expired and do not include a refresh token");
  const payload = await postToken({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
  }, signal);
  const creds = credentialsFromPayload(payload, refreshToken);
  // Re-discover the project on refresh so a newly-onboarded account fills in projectId.
  const projectId = await discoverAntigravityProject(creds.access, signal).catch(() => undefined);
  return projectId ? { ...creds, projectId } : creds;
}
