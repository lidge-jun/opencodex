/**
 * Nous Portal OAuth flow (device authorization grant, RFC 8628).
 *
 * Nous Research's unified subscription gateway — the same backend Hermes Agent
 * uses. The Portal is a single account surface for both the paid subscription
 * (billed against the account) and a set of free models (the `:free` slugs such
 * as `tencent/hy3:free`, `inclusionai/ling-3.0-flash:free`).
 *
 * Verified against Hermes `hermes_cli/auth.py` (2026-08):
 * - device endpoint:  POST {portal}/api/oauth/device/code
 * - token endpoint:   POST {portal}/api/oauth/token
 * - the access token returned by the token endpoint IS the per-request
 *   inference JWT (scope `inference:invoke`) and is used directly as
 *   `Authorization: Bearer` against the OpenAI-compatible inference API at
 *   https://inference-api.nousresearch.com/v1.
 * - refresh sends the refresh token in the `x-nous-refresh-token` HEADER (not
 *   the body): `POST /api/oauth/token` with `grant_type=refresh_token` +
 *   `client_id`, header `x-nous-refresh-token: <rt>`.
 * - Nous refresh tokens are SINGLE-USE: every successful refresh rotates the
 *   token, and reuse (e.g. two processes refreshing concurrently) is treated as
 *   token theft and revokes the whole session (`refresh_token_reused`).
 *   OpenCodex's refresh path persists the rotated token immediately
 *   (`mergeAccountCredential`), which is exactly the discipline the Portal
 *   expects; proactive background refresh must stay off for this provider.
 */
import type { OAuthController, OAuthCredentials } from "./types";

export const NOUS_PORTAL_BASE_URL = "https://portal.nousresearch.com";
export const NOUS_INFERENCE_BASE_URL = "https://inference-api.nousresearch.com/v1";
export const NOUS_OAUTH_CLIENT_ID = "hermes-cli";
export const NOUS_OAUTH_SCOPE = "inference:invoke";

const DEFAULT_POLL_INTERVAL_MS = 5000;
const MAX_POLL_INTERVAL_MS = 30_000;
const DEFAULT_DEVICE_FLOW_TTL_MS = 15 * 60 * 1000;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const OAUTH_EXPIRY_SKEW_MS = 2 * 60 * 1000;

interface NousDeviceAuthorizationResponse {
  device_code?: unknown;
  user_code?: unknown;
  verification_uri?: unknown;
  verification_uri_complete?: unknown;
  expires_in?: unknown;
  interval?: unknown;
}

interface NousTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  scope?: unknown;
  inference_base_url?: unknown;
  error?: unknown;
  error_description?: unknown;
  interval?: unknown;
}

interface NousJwtPayload {
  sub?: unknown;
  email?: unknown;
  exp?: unknown;
  [key: string]: unknown;
}

function resolvePortalBaseUrl(): string {
  return (process.env.NOUS_PORTAL_BASE_URL || NOUS_PORTAL_BASE_URL).replace(/\/+$/, "");
}

function decodeJwtPayload(token: string): NousJwtPayload | undefined {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as NousJwtPayload;
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Best-effort multiauth identity from the Nous inference JWT claims. The Portal
 * mints these tokens per login; `sub` is the stable subject and `email` is
 * lowercased when present. Opaque tokens yield no identity (account still
 * works, single-account only).
 */
export function identityFromNousTokens(accessToken: string): { accountId?: string; email?: string } {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return {};
  const accountId = nonEmptyString(payload.sub);
  const email = nonEmptyString(payload.email)?.toLowerCase();
  return {
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
  };
}

/** JWT `exp` (epoch seconds) → expiry ms, when present and sane. */
function jwtExpiryMs(payload: NousJwtPayload | undefined): number | undefined {
  const exp = payload?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
  return exp * 1000;
}

export class NousTokenError extends Error {
  constructor(
    public readonly status: number | undefined,
    public readonly oauthError: string | undefined,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "NousTokenError";
  }
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Login cancelled"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("Login cancelled")); }, { once: true });
  });
}

async function readTokenError(response: Response): Promise<NousTokenError> {
  let oauthError: string | undefined;
  let detail = "";
  try {
    const body = (await response.json()) as { error?: unknown; error_description?: unknown };
    if (typeof body.error === "string") oauthError = body.error;
    if (typeof body.error_description === "string") detail = body.error_description;
  } catch {
    // Non-JSON error body — fall through to the status-only message.
  }
  const suffix = detail ? `: ${detail}` : oauthError ? `: ${oauthError}` : "";
  return new NousTokenError(response.status, oauthError, `Nous Portal token request failed: ${response.status}${suffix}`);
}

function parseTokenPayload(payload: NousTokenResponse, refreshFallback?: string): OAuthCredentials {
  const access = nonEmptyString(payload.access_token);
  if (!access) throw new Error("Nous Portal token response did not include an access token");
  const refresh = nonEmptyString(payload.refresh_token) ?? refreshFallback;
  if (!refresh) throw new Error("Nous Portal token response did not include a refresh token");

  const jwtPayload = decodeJwtPayload(access);
  const expMs = jwtExpiryMs(jwtPayload);
  const expiresInMs = typeof payload.expires_in === "number" ? payload.expires_in * 1000 : undefined;
  // Prefer the JWT `exp` claim when present (it is the authoritative inference
  // JWT lifetime), else fall back to `expires_in`.
  const expires = (expMs ?? (expiresInMs !== undefined ? Date.now() + expiresInMs : Date.now() + DEFAULT_DEVICE_FLOW_TTL_MS))
    - OAUTH_EXPIRY_SKEW_MS;
  return {
    access,
    refresh,
    expires,
    ...identityFromNousTokens(access),
  };
}

async function requestDeviceAuthorization(signal?: AbortSignal): Promise<{
  userCode: string;
  deviceCode: string;
  verificationUriComplete: string;
  expiresInMs: number;
  intervalMs: number;
}> {
  const response = await fetch(`${resolvePortalBaseUrl()}/api/oauth/device/code`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: NOUS_OAUTH_CLIENT_ID,
      scope: NOUS_OAUTH_SCOPE,
    }),
    signal: requestSignal(signal),
  });
  if (!response.ok) throw await readTokenError(response);
  const payload = (await response.json()) as NousDeviceAuthorizationResponse;
  const userCode = nonEmptyString(payload.user_code);
  const deviceCode = nonEmptyString(payload.device_code);
  const verificationUri = nonEmptyString(payload.verification_uri_complete) ?? nonEmptyString(payload.verification_uri);
  if (!userCode || !deviceCode || !verificationUri) {
    throw new Error("Nous Portal device authorization response missing required fields");
  }
  return {
    userCode,
    deviceCode,
    verificationUriComplete: verificationUri,
    expiresInMs: typeof payload.expires_in === "number" && payload.expires_in > 0
      ? payload.expires_in * 1000
      : DEFAULT_DEVICE_FLOW_TTL_MS,
    intervalMs: typeof payload.interval === "number" && payload.interval > 0
      ? payload.interval * 1000
      : DEFAULT_POLL_INTERVAL_MS,
  };
}

async function pollForToken(
  deviceCode: string,
  intervalMs: number,
  expiresInMs: number,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  const deadline = Date.now() + expiresInMs;
  let waitMs = Math.max(1000, intervalMs);
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Login cancelled");
    const response = await fetch(`${resolvePortalBaseUrl()}/api/oauth/token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: NOUS_OAUTH_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal: requestSignal(signal),
    });
    const payload = (await response.json().catch(() => ({}))) as NousTokenResponse;
    if (response.ok && nonEmptyString(payload.access_token)) return parseTokenPayload(payload);
    const error = payload.error;
    if (error === "authorization_pending") {
      await sleep(waitMs, signal);
      continue;
    }
    if (error === "slow_down") {
      waitMs = Math.min(MAX_POLL_INTERVAL_MS, waitMs + 5000);
      const retryAfter = typeof payload.interval === "number" ? payload.interval * 1000 : undefined;
      if (retryAfter && retryAfter > waitMs) waitMs = Math.min(MAX_POLL_INTERVAL_MS, retryAfter);
      await sleep(waitMs, signal);
      continue;
    }
    if (error === "expired_token") throw new NousTokenError(response.status, "expired_token", "Nous Portal device authorization expired");
    if (error === "access_denied") throw new NousTokenError(response.status, "access_denied", "Nous Portal device authorization denied");
    throw await readTokenError(response);
  }
  throw new NousTokenError(undefined, "expired_token", "Nous Portal device flow timed out");
}

export async function loginNous(ctrl: OAuthController): Promise<OAuthCredentials> {
  const device = await requestDeviceAuthorization(ctrl.signal);
  ctrl.onAuth?.({
    url: device.verificationUriComplete,
    instructions: `Sign in to Nous Portal and enter the code: ${device.userCode}`,
    deviceCode: device.userCode,
  });
  return pollForToken(device.deviceCode, device.intervalMs, device.expiresInMs, ctrl.signal);
}

/**
 * Refresh a Nous Portal session. The refresh token travels in the
 * `x-nous-refresh-token` header; the server rotates it on every successful
 * refresh, and the rotated token is what the caller persists.
 */
export async function refreshNousToken(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredentials> {
  const response = await fetch(`${resolvePortalBaseUrl()}/api/oauth/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "x-nous-refresh-token": refreshToken,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: NOUS_OAUTH_CLIENT_ID,
    }),
    signal: requestSignal(signal),
  });
  if (!response.ok) throw await readTokenError(response);
  return parseTokenPayload((await response.json()) as NousTokenResponse, refreshToken);
}
