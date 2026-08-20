/**
 * Gemini (Google account) OAuth — Code Assist and AI Studio subtypes.
 *
 * Mirrors sub2api `internal/pkg/geminicli` + `internal/service/gemini_oauth_service.go`. Flow:
 * standard Google OAuth (PKCE) → for the Code Assist subtype, discover the Cloud Code Assist
 * project via `loadCodeAssist`, onboarding via `onboardUser` when the account has none yet.
 * The discovered `projectId` is stored on the credential and injected into the CCA request
 * envelope by the google adapter, exactly as the Antigravity flow does.
 *
 * Two subtypes exist because Google gates them behind different OAuth clients and scopes:
 *
 * - `code-assist` — the Gemini CLI public client. Talks to cloudcode-pa.googleapis.com and
 *   requires a CCA project. This is the subtype a Google account (including Google One / AI
 *   Pro / Ultra plans) uses, so it is the default.
 * - `ai-studio` — generativelanguage.googleapis.com with an OAuth credential instead of an API
 *   key. Google's built-in CLI client is not registered for the generative-language scopes, so
 *   this subtype requires operator-supplied client credentials; without them login fails closed
 *   with an actionable message rather than sending a request Google rejects as
 *   `restricted_client`.
 *
 * The Gemini CLI client id/secret are the public OAuth client identifiers embedded in Google's
 * own Gemini CLI (overridable via env), not user secrets. Tokens/refresh are never logged.
 */
import { OAuthCallbackFlow, type OAuthCallbackFlowOptions } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

/** OAuth subtype selected when adding the account. */
export type GeminiOAuthSubtype = "code-assist" | "ai-studio";

export const GEMINI_OAUTH_SUBTYPES: readonly GeminiOAuthSubtype[] = ["code-assist", "ai-studio"];

/** Provider id per subtype: each subtype owns its own account set and provider entry. */
export const GEMINI_CODE_ASSIST_PROVIDER = "gemini-cli";
export const GEMINI_AI_STUDIO_PROVIDER = "gemini-ai-studio";

export function geminiSubtypeForProvider(provider: string): GeminiOAuthSubtype {
  return provider === GEMINI_AI_STUDIO_PROVIDER ? "ai-studio" : "code-assist";
}

// Public Gemini CLI OAuth client (Google ships these in the CLI binary). Overridable so an
// operator can substitute their own registered client.
const CLI_CLIENT_ID = process.env.GEMINI_CLI_OAUTH_CLIENT_ID
  || "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const CLI_CLIENT_SECRET = process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET
  || "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";

// AI Studio has no usable built-in client: Google's CLI client is not registered for the
// generative-language scopes, so the operator must register their own.
const AI_STUDIO_CLIENT_ID = process.env.GEMINI_AI_STUDIO_OAUTH_CLIENT_ID ?? "";
const AI_STUDIO_CLIENT_SECRET = process.env.GEMINI_AI_STUDIO_OAUTH_CLIENT_SECRET ?? "";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";
const CODE_ASSIST_API = "https://cloudcode-pa.googleapis.com";
const API_VERSION = "v1internal";

const CODE_ASSIST_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];
// Google documents the retriever scope (rather than the older bare `generative-language`) for
// OAuth access to generativelanguage.googleapis.com.
const AI_STUDIO_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/generative-language.retriever",
];

// Distinct from the Antigravity flow's 51121 so a Gemini login cannot collide with one already
// listening for an Antigravity callback.
const CALLBACK_PORT = 51122;
const CALLBACK_PATH = "/callback";
// Keep provider-side margins small: the shared OAuth freshness gate applies an additional minute.
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const ONBOARD_ATTEMPTS = 5;
const ONBOARD_POLL_MS = 2_000;
// Matches the Gemini CLI's own UA so Code Assist sees a client shape it recognizes.
const GEMINI_CLI_USER_AGENT = "GeminiCLI/0.1.5 (Windows; AMD64)";
const CODE_ASSIST_METADATA = { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };

export class GeminiOAuthClientNotConfiguredError extends Error {
  constructor() {
    super(
      "Gemini AI Studio OAuth requires your own Google OAuth client: set GEMINI_AI_STUDIO_OAUTH_CLIENT_ID and "
      + "GEMINI_AI_STUDIO_OAUTH_CLIENT_SECRET, then retry. Google's built-in Gemini CLI client is not registered "
      + "for the generative-language scopes.",
    );
    this.name = "GeminiOAuthClientNotConfiguredError";
  }
}

interface GeminiOAuthClient {
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

/** Client id/secret + scopes for a subtype; throws when AI Studio has no configured client. */
export function geminiOAuthClient(subtype: GeminiOAuthSubtype): GeminiOAuthClient {
  if (subtype === "ai-studio") {
    const clientId = AI_STUDIO_CLIENT_ID.trim();
    const clientSecret = AI_STUDIO_CLIENT_SECRET.trim();
    if (!clientId || !clientSecret) throw new GeminiOAuthClientNotConfiguredError();
    return { clientId, clientSecret, scopes: [...AI_STUDIO_SCOPES] };
  }
  return { clientId: CLI_CLIENT_ID, clientSecret: CLI_CLIENT_SECRET, scopes: [...CODE_ASSIST_SCOPES] };
}

/** Whether a subtype can start a login right now (drives the dashboard's disabled state). */
export function isGeminiOAuthSubtypeConfigured(subtype: GeminiOAuthSubtype): boolean {
  try {
    geminiOAuthClient(subtype);
    return true;
  } catch {
    return false;
  }
}

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
    throw new Error(`Gemini token request failed: ${response.status}`);
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

/**
 * The tier to onboard into: the default among `allowedTiers`, else the free tier Gemini CLI
 * uses. Sending a tier the account is not entitled to makes `onboardUser` fail closed.
 */
function extractDefaultTierId(data: Record<string, unknown> | undefined): string {
  const tiers = data?.allowedTiers;
  if (Array.isArray(tiers)) {
    for (const tier of tiers) {
      if (tier && typeof tier === "object"
        && (tier as { isDefault?: unknown }).isDefault === true
        && typeof (tier as { id?: unknown }).id === "string"
        && (tier as { id: string }).id.length > 0) {
        return (tier as { id: string }).id;
      }
    }
  }
  return "free-tier";
}

async function loadCodeAssist(
  accessToken: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  const response = await fetch(`${CODE_ASSIST_API}/${API_VERSION}:loadCodeAssist`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "*/*",
      "Content-Type": "application/json",
      "User-Agent": GEMINI_CLI_USER_AGENT,
    },
    body: JSON.stringify({ metadata: CODE_ASSIST_METADATA }),
    signal: requestSignal(signal),
  });
  if (!response.ok) return undefined;
  return (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
}

async function onboardProject(accessToken: string, tierId: string, signal?: AbortSignal): Promise<string | undefined> {
  for (let attempt = 0; attempt < ONBOARD_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error("Gemini onboarding aborted");
    const response = await fetch(`${CODE_ASSIST_API}/${API_VERSION}:onboardUser`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "*/*",
        "Content-Type": "application/json",
        "User-Agent": GEMINI_CLI_USER_AGENT,
      },
      body: JSON.stringify({ tierId, metadata: CODE_ASSIST_METADATA }),
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
export async function discoverGeminiProject(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
  const loaded = await loadCodeAssist(accessToken, signal);
  return extractProjectId(loaded) ?? (await onboardProject(accessToken, extractDefaultTierId(loaded), signal));
}

function credentialsFromPayload(payload: GoogleTokenPayload, refreshFallback = ""): OAuthCredentials {
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw new Error("Gemini token response did not include an access token");
  }
  const refresh = typeof payload.refresh_token === "string" && payload.refresh_token.length > 0
    ? payload.refresh_token
    : refreshFallback;
  if (!refresh) throw new Error("Gemini token response did not include a refresh token");
  const expiresIn = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 3600;
  const idToken = typeof payload.id_token === "string" ? payload.id_token : undefined;
  return {
    refresh,
    access: payload.access_token,
    expires: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS,
    email: emailFromToken(payload.access_token, idToken),
  };
}

class GeminiOAuthFlow extends OAuthCallbackFlow {
  #verifier = "";
  #subtype: GeminiOAuthSubtype;
  #forceAccountSelect: boolean;

  constructor(ctrl: OAuthController, subtype: GeminiOAuthSubtype, opts?: { forceAccountSelect?: boolean }) {
    super(ctrl, {
      preferredPort: CALLBACK_PORT,
      callbackPath: CALLBACK_PATH,
      callbackHostname: "127.0.0.1",
      callbackBindHostname: "127.0.0.1",
      redirectUri: `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`,
    } satisfies OAuthCallbackFlowOptions);
    this.#subtype = subtype;
    this.#forceAccountSelect = opts?.forceAccountSelect === true;
  }

  async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
    const client = geminiOAuthClient(this.#subtype);
    const pkce = await generatePKCE();
    this.#verifier = pkce.verifier;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: redirectUri,
      scope: client.scopes.join(" "),
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      // select_account lets the user pick a DIFFERENT Google account when adding a second one.
      prompt: this.#forceAccountSelect ? "consent select_account" : "consent",
      state,
    });
    return {
      url: `${AUTH_ENDPOINT}?${params.toString()}`,
      instructions: "Complete Google login in your browser, then paste the redirect URL or code if prompted.",
    };
  }

  async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
    if (!this.#verifier) throw new Error("Gemini OAuth PKCE verifier was not initialized");
    const client = geminiOAuthClient(this.#subtype);
    const payload = await postToken({
      grant_type: "authorization_code",
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: this.#verifier,
    }, this.ctrl.signal);
    const creds = credentialsFromPayload(payload);
    if (this.#subtype === "ai-studio") return creds;
    this.ctrl.onProgress?.("Discovering Cloud Code Assist project");
    const projectId = await discoverGeminiProject(creds.access, this.ctrl.signal);
    if (!projectId) {
      // Fail the login rather than persisting a credential that every request would reject for a
      // missing CCA project — otherwise status shows "logged in" while all calls fail closed.
      throw new Error("Gemini login could not discover a Cloud Code Assist project for this account. Ensure the Google account has Gemini Code Assist access and try again.");
    }
    return { ...creds, projectId };
  }
}

export async function loginGemini(
  ctrl: OAuthController,
  subtype: GeminiOAuthSubtype,
  opts?: { forceAccountSelect?: boolean },
): Promise<OAuthCredentials> {
  return new GeminiOAuthFlow(ctrl, subtype, opts).login();
}

export async function refreshGeminiToken(
  refreshToken: string,
  subtype: GeminiOAuthSubtype,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  if (!refreshToken) throw new Error("Gemini credentials are expired and do not include a refresh token");
  const client = geminiOAuthClient(subtype);
  const payload = await postToken({
    grant_type: "refresh_token",
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
  }, signal);
  const creds = credentialsFromPayload(payload, refreshToken);
  if (subtype === "ai-studio") return creds;
  // Re-discover the project on refresh so a newly-onboarded account fills in projectId.
  const projectId = await discoverGeminiProject(creds.access, signal).catch(() => undefined);
  return projectId ? { ...creds, projectId } : creds;
}

/**
 * Refresh and derive import identity from Google's pinned userinfo endpoint. Imports may not
 * borrow the email written in a local file: that would let one valid token overwrite another
 * account's slot when a refresh response has no id_token.
 */
export async function validateGeminiImportCredential(
  refreshToken: string,
  subtype: GeminiOAuthSubtype,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  const credential = await refreshGeminiToken(refreshToken, subtype, signal);
  const response = await fetch(USERINFO_ENDPOINT, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${credential.access}` },
    signal: requestSignal(signal),
  });
  if (!response.ok) throw new Error(`Gemini identity request failed: ${response.status}`);
  const body = (await response.json().catch(() => undefined)) as { email?: unknown; id?: unknown } | undefined;
  if (typeof body?.email !== "string" || body.email.length === 0) {
    throw new Error("Gemini identity response did not include an email");
  }
  if (typeof body.id !== "string" || body.id.length === 0) {
    throw new Error("Gemini identity response did not include an account id");
  }
  return { ...credential, accountId: body.id, email: body.email.toLowerCase() };
}
