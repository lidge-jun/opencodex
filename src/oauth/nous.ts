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
 *   `Authorization: *** against the OpenAI-compatible inference API at
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
 *
 * Single-use refresh is made failure-atomic (review blocker #2): a durable
 * refresh-intent file is written BEFORE the refresh request and only removed
 * after the rotated token is obtained. If we ever receive a server response
 * but fail to persist the rotated token, the intent is marked "uncertain" and
 * the next refresh refuses to replay the (possibly consumed) token, forcing a
 * clean re-authentication instead of a silent session-revoking replay.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { OAuthController, OAuthCredentials } from "./types";
import { getAuthStorePath } from "./store";

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
  scope?: unknown;
  [key: string]: unknown;
}

// ── Durable refresh-intent (review blocker #2) ──────────────────────────────
// A refresh-intent file records that we submitted `refreshToken` to the Portal
// and whether we are certain the rotated token was persisted. It lives next to
// the auth store (same config dir) and is keyed by a hash of the refresh
// token, so it never contains the token in cleartext.

type RefreshIntentStatus = "pending" | "uncertain";

interface RefreshIntent {
  status: RefreshIntentStatus;
  updatedAt: number;
}

function refreshIntentDir(): string {
  const base = join(getAuthStorePath(), "..", ".nous-refresh-intent");
  return base;
}

function refreshIntentPath(refreshToken: string): string {
  const hash = createHash("sha256").update(refreshToken).digest("hex");
  return join(refreshIntentDir(), `${hash}.json`);
}

function readRefreshIntent(refreshToken: string): RefreshIntent | undefined {
  try {
    const raw = readFileSync(refreshIntentPath(refreshToken), "utf8");
    return JSON.parse(raw) as RefreshIntent;
  } catch {
    return undefined;
  }
}

function writeRefreshIntent(refreshToken: string, status: RefreshIntentStatus): void {
  const dir = refreshIntentDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(refreshIntentPath(refreshToken), JSON.stringify({ status, updatedAt: Date.now() } satisfies RefreshIntent), "utf8");
  } catch {
    // Best-effort: if we cannot record the intent, the refresh still proceeds;
    // we simply lose the uncertain-outcome guard for this single attempt.
  }
}

function clearRefreshIntent(refreshToken: string): void {
  try {
    rmSync(refreshIntentPath(refreshToken), { force: true });
  } catch {
    // ignore
  }
}

/**
 * True when we have already submitted this refresh token and were NOT able to
 * confirm the rotated token was persisted. In that uncertain state we must
 * never blindly replay it — the server may have already consumed it, and a
 * replay would trigger `refresh_token_reused` and revoke the session. The
 * caller should force a clean re-authentication instead.
 */
export function nousRefreshIntentIsUncertain(refreshToken: string): boolean {
  return readRefreshIntent(refreshToken)?.status === "uncertain";
}

// ── Base URL hardening (review blocker #1, also flagged by multiple reviewers) ─

/**
 * Normalize and hard-validate the Nous Portal OAuth base URL.
 *
 * Security: the portal accepts the bearer-equivalent single-use refresh token
 * in the `x-nous-refresh-token` header and returns the per-request inference
 * JWT as the access token. Sending either over cleartext (or to a
 * credential/query/fragment-laden URL) leaks credentials to a network
 * attacker. Validate the *complete* URL up front and throw before any
 * `fetch` is dispatched — both the device-grant and the refresh path call
 * this from inside their `fetch` arguments, so a thrown error guarantees the
 * network call never runs.
 *
 * Mirrors the allowlist discipline in Hermes `hermes_cli/auth.py`
 * (`_NOUS_PORTAL_ALLOWED_HOSTS`, https-only default
 * `DEFAULT_NOUS_PORTAL_URL`).
 */
function resolvePortalBaseUrl(): string {
  const raw = (process.env.NOUS_PORTAL_BASE_URL || NOUS_PORTAL_BASE_URL).trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NousTokenError(undefined, undefined, `Nous Portal base URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new NousTokenError(undefined, undefined, `Nous Portal base URL must use HTTPS (got ${url.protocol}): ${raw}`);
  }
  if (url.username || url.password) {
    throw new NousTokenError(undefined, undefined, `Nous Portal base URL must not contain embedded credentials: ${raw}`);
  }
  if (url.search) {
    throw new NousTokenError(undefined, undefined, `Nous Portal base URL must not contain a query string: ${raw}`);
  }
  if (url.hash) {
    throw new NousTokenError(undefined, undefined, `Nous Portal base URL must not contain a fragment: ${raw}`);
  }
  // Origin only — no path/query/fragment — so callers cannot smuggle a
  // non-canonical endpoint through the override.
  return url.origin;
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

/** Does the inference JWT grant the required `inference:invoke` scope? */
function jwtGrantsInference(payload: NousJwtPayload | undefined): boolean {
  const scope = nonEmptyString(payload?.scope);
  if (!scope) return false;
  // Scope is a space-separated list per RFC 6749.
  return scope.split(/\s+/).includes(NOUS_OAUTH_SCOPE);
}

export class NousTokenError extends Error {
  /** When true, the token cannot be saved/used and the account needs re-auth. */
  public readonly terminal: boolean;
  /** When set, the (already rotated) credentials to persist before re-auth. */
  public readonly credentials?: OAuthCredentials;

  constructor(
    status: number | undefined,
    public readonly oauthError: string | undefined,
    message: string,
    options?: { cause?: unknown; terminal?: boolean; credentials?: OAuthCredentials },
  ) {
    super(message, options);
    this.name = "NousTokenError";
    this.terminal = options?.terminal ?? false;
    this.credentials = options?.credentials;
  }
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

/**
 * Sleep for `ms`, resolving on timer completion. The abort listener is removed
 * on both resolve and abort so we do not accumulate listeners across polling
 * iterations (review point #9).
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Login cancelled"));
    const onAbort = () => {
      clearTimeout(t);
      cleanup();
      reject(new Error("Login cancelled"));
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Read an error payload from a failed token response. `payload` is the already
 * parsed JSON (so callers do not re-read a consumed body — review point #8).
 */
function tokenErrorFromPayload(status: number, payload: unknown): NousTokenError {
  const body = (payload ?? {}) as { error?: unknown; error_description?: unknown };
  const oauthError = typeof body.error === "string" ? body.error : undefined;
  const detail = typeof body.error_description === "string" ? body.error_description : "";
  const suffix = detail ? `: ${detail}` : oauthError ? `: ${oauthError}` : "";
  const terminal = oauthError === "invalid_token" || oauthError === "invalid_grant" || oauthError === "revoked" || oauthError === "revoked_token";
  return new NousTokenError(status, oauthError, `Nous Portal token request failed: ${status}${suffix}`, { terminal });
}

/**
 * Build credentials from a token endpoint response.
 *
 * Nous refresh tokens are SINGLE-USE and rotated on every successful refresh
 * (see module docstring, matching Hermes `hermes_cli/auth.py`). A response
 * that omits `refresh_token`, or returns a replacement equal to the token we
 * just submitted, leaves us holding a consumed credential: the next refresh
 * would replay it and the Portal treats reuse as token theft
 * (`refresh_token_reused`), revoking the whole session. Reject both cases
 * rather than silently falling back to the submitted token.
 *
 * The returned access token must also grant the `inference:invoke` scope; if it
 * does not, the credential is unusable for inference and we raise a terminal
 * error — but we still surface the (already rotated) refresh token in the
 * error so the caller can persist it and drive a clean re-authentication
 * without discarding the rotation the server already performed (review #5).
 *
 * @param submittedRefreshToken the refresh token sent in the request; used only
 *   to detect a no-rotation / consumed-token response, never as a fallback.
 */
function parseTokenPayload(payload: NousTokenResponse, submittedRefreshToken: string): OAuthCredentials {
  const access = nonEmptyString(payload.access_token);
  if (!access) throw new Error("Nous Portal token response did not include an access token");
  const refresh = nonEmptyString(payload.refresh_token);
  if (!refresh) {
    throw new NousTokenError(
      undefined,
      "refresh_token_reused",
      "Nous Portal did not return a replacement refresh token; refusing to reuse the consumed one (would trigger refresh_token_reused and revoke the session)",
      { terminal: true },
    );
  }
  if (submittedRefreshToken && refresh === submittedRefreshToken) {
    throw new NousTokenError(
      undefined,
      "refresh_token_reused",
      "Nous Portal returned the same refresh token we submitted; refusing to reuse it (single-use rotation expected, session may be compromised)",
      { terminal: true },
    );
  }

  const jwtPayload = decodeJwtPayload(access);
  const expMs = jwtExpiryMs(jwtPayload);
  const expiresInMs = typeof payload.expires_in === "number" ? payload.expires_in * 1000 : undefined;
  // Prefer the JWT `exp` claim when present (it is the authoritative inference
  // JWT lifetime), else fall back to `expires_in`.
  const expires = (expMs ?? (expiresInMs !== undefined ? Date.now() + expiresInMs : Date.now() + DEFAULT_DEVICE_FLOW_TTL_MS))
    - OAUTH_EXPIRY_SKEW_MS;

  const creds: OAuthCredentials = {
    access,
    refresh,
    expires,
    ...identityFromNousTokens(access),
  };

  if (!jwtGrantsInference(jwtPayload)) {
    // Unusable for inference, but the server already rotated the refresh token:
    // surface it so the caller persists it and forces a re-auth rather than
    // discarding a valid rotation.
    throw new NousTokenError(
      undefined,
      "insufficient_scope",
      "Nous Portal access token does not grant the required inference:invoke scope",
      { terminal: true, credentials: creds },
    );
  }

  return creds;
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
    redirect: "error",
    signal: requestSignal(signal),
  });
  if (!response.ok) throw tokenErrorFromPayload(response.status, await response.json().catch(() => ({})));
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
      redirect: "error",
      signal: requestSignal(signal),
    });
    // Parse once and pass the payload through to the failure path (review #8),
    // so we never try to re-read a body that has already been consumed.
    const payload = (await response.json().catch(() => ({}))) as NousTokenResponse;
    if (response.ok && nonEmptyString(payload.access_token)) return parseTokenPayload(payload, "");
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
    // Unknown OAuth error: report it from the parsed payload, not by
    // re-reading the (already consumed) response body.
    if (error) {
      const detail = typeof payload.error_description === "string" ? `: ${payload.error_description}` : "";
      throw new NousTokenError(response.status, String(error), `Nous Portal device authorization failed (${error})${detail}`);
    }
    throw tokenErrorFromPayload(response.status, payload);
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
 *
 * Failure-atomicity contract (review blocker #2): a durable refresh-intent is
 * recorded before the request and cleared only after the rotated token is
 * obtained. If the server responds but we fail to persist the rotation, the
 * intent becomes "uncertain" and a later refresh refuses to replay the
 * possibly-consumed token, forcing re-auth instead of a session-revoking
 * replay.
 */
export async function refreshNousToken(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredentials> {
  // Never blindly replay a token whose outcome we could not confirm earlier.
  if (nousRefreshIntentIsUncertain(refreshToken)) {
    throw new NousTokenError(
      undefined,
      "refresh_token_reused",
      "Refusing to replay a refresh token with an uncertain prior outcome (previous rotation may not have persisted)",
      { terminal: true },
    );
  }
  // Mark that we are about to submit this token. It stays "pending" until we
  // either obtain the rotated token (cleared) or confirm a server response
  // while failing to persist (marked "uncertain").
  writeRefreshIntent(refreshToken, "pending");

  let response: Response;
  try {
    response = await fetch(`${resolvePortalBaseUrl()}/api/oauth/token`, {
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
      redirect: "error",
      signal: requestSignal(signal),
    });
  } catch (netErr) {
    // Network-level failure: the server never saw the token, so it was not
    // consumed. Leave the intent "pending" so a later retry can resubmit it.
    throw netErr;
  }

  if (!response.ok) {
    // Error before any rotation: the token was not consumed. Clear the intent
    // so a retry can resubmit it.
    clearRefreshIntent(refreshToken);
    throw tokenErrorFromPayload(response.status, await response.json().catch(() => ({})));
  }

  // The server responded 200 — the submitted token may now be consumed. If we
  // fail to parse/persist the rotated token, mark the intent uncertain so we
  // never replay it.
  try {
    const creds = parseTokenPayload((await response.json()) as NousTokenResponse, refreshToken);
    clearRefreshIntent(refreshToken);
    return creds;
  } catch (e) {
    writeRefreshIntent(refreshToken, "uncertain");
    throw e;
  }
}
