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
 * clean re-authentication instead of a silent session-revoking replay. After
 * dispatch, ANY non-2xx outcome (429, unknown/custom 4xx, 5xx, gateway errors)
 * retains the durable intent: no HTTP status class proves the single-use token
 * was not consumed, so the submitted token is never automatically replayed.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OAuthController, OAuthCredentials } from "./types";
import { getAuthStorePath } from "./store";
import { atomicWriteFile, hardenConfigDir, hardenExistingSecret } from "../config";
import { BOUNDED_BODY_MAX_BYTES, readBoundedResponseBytes } from "../lib/bounded-body";

export const NOUS_PORTAL_BASE_URL = "https://portal.nousresearch.com";
export const NOUS_INFERENCE_BASE_URL = "https://inference-api.nousresearch.com/v1";
export const NOUS_OAUTH_CLIENT_ID = "hermes-cli";
export const NOUS_OAUTH_SCOPE = "inference:invoke";

const DEFAULT_POLL_INTERVAL_MS = 5000;
const MAX_POLL_INTERVAL_MS = 30_000;
const DEFAULT_DEVICE_FLOW_TTL_MS = 15 * 60 * 1000;
// Fallback lifetime for an inference access token when neither the JWT `exp`
// claim nor `expires_in` is present. Kept distinct from the device-flow window:
// the two are unrelated durations.
const DEFAULT_ACCESS_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
// Upper bound on a plausible inference-JWT lifetime; guards against a bad `exp`
// unit (ms instead of s) or a badly skewed clock.
const MAX_PLAUSIBLE_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
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

async function readOAuthBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const { bytes, oversized } = await readBoundedResponseBytes(response, {
    maxBytes: BOUNDED_BODY_MAX_BYTES,
    signal,
  });
  if (oversized) {
    throw new NousTokenError(
      response.status,
      "response_too_large",
      `Nous Portal OAuth response exceeded the ${BOUNDED_BODY_MAX_BYTES}-byte limit`,
    );
  }
  return bytes;
}

function parseOAuthJson(bytes: Uint8Array): unknown {
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

async function readOAuthJson(response: Response, signal: AbortSignal): Promise<unknown> {
  return parseOAuthJson(await readOAuthBytes(response, signal));
}

async function readOAuthJsonOrEmpty(response: Response, signal: AbortSignal): Promise<unknown> {
  const bytes = await readOAuthBytes(response, signal);
  try {
    return parseOAuthJson(bytes);
  } catch {
    // Preserve the pre-PR behavior for empty/HTML/malformed JSON only. Body
    // read failures, timeouts, caller cancellation, and size-limit errors have
    // already escaped readOAuthBytes and must retain their real identity.
    return {};
  }
}

// ── Durable refresh-intent (review blocker #2) ──────────────────────────────
// A refresh-intent file records that we submitted `refreshToken` to the Portal
// and whether we are certain the rotated token was persisted. It lives next to
// the auth store (same config dir) and is keyed by a hash of the refresh
// token, so it never contains the token in cleartext.
//
// The mechanism reuses the repository's hardened config IO (atomicWriteFile +
// hardenConfigDir from ../config and ./store) and is FAIL-CLOSED: if we cannot
// durably create or read the intent, we refuse the refresh rather than silently
// disable the guard. An unreadable/corrupt intent is treated as "uncertain"
// (replay refused), never as "absent".
//
// States:
//  - "submitted": we sent this token and a server response was received (so it
//    may have been consumed). We leave it set after a successful rotation until
//    the store confirms persistence of the rotated token; if we crash before
//    that, a later replay of the same token is refused.
//  - "uncertain": the dispatch may have reached the server (we saw an error
//    after sending, or failed to parse/persist the rotated token). Replay is
//    refused.

type RefreshIntentStatus = "submitted" | "uncertain";

interface RefreshIntent {
  status: RefreshIntentStatus;
  updatedAt: number;
}

export class RefreshIntentIOError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause ? { cause } : undefined);
    this.name = "RefreshIntentIOError";
  }
}

function refreshIntentDir(): string {
  return join(getAuthStorePath(), "..", ".nous-refresh-intent");
}

function refreshIntentPath(refreshToken: string): string {
  const hash = createHash("sha256").update(refreshToken).digest("hex");
  return join(refreshIntentDir(), `${hash}.json`);
}

/**
 * Validate a persisted refresh-intent payload BEFORE trusting it. A syntactically
 * valid JSON blob is not enough: `{}` or a wrong-shaped object must not silently
 * produce `status === undefined` (which would bypass the replay guard). We only
 * accept an object whose `status` is exactly one supported state and whose
 * `updatedAt` is a finite number. Anything else is treated as `uncertain` —
 * never as absent — so a corrupt intent can never make a possibly-consumed
 * token replayable.
 */
function parseRefreshIntent(raw: string): RefreshIntent {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "uncertain", updatedAt: Date.now() };
  }
  if (typeof value !== "object" || value === null) {
    return { status: "uncertain", updatedAt: Date.now() };
  }
  const candidate = value as Record<string, unknown>;
  const status = candidate.status;
  if (status !== "submitted" && status !== "uncertain") {
    return { status: "uncertain", updatedAt: Date.now() };
  }
  if (typeof candidate.updatedAt !== "number" || !Number.isFinite(candidate.updatedAt)) {
    return { status: "uncertain", updatedAt: Date.now() };
  }
  return { status, updatedAt: candidate.updatedAt };
}

function readRefreshIntent(refreshToken: string): RefreshIntent | undefined {
  const path = refreshIntentPath(refreshToken);
  try {
    // Mirror the repository's hardened read: chmod/ACL-harden the secret path
    // before reading, and treat any read/parse error as uncertain (fail-closed)
    // rather than silently absent.
    hardenExistingSecret(path);
    return parseRefreshIntent(readFileSync(path, "utf8"));
  } catch (error) {
    // ENOENT means we never recorded an intent for this token -> safe to proceed.
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    // Any other failure (corrupt JSON, permission, ACL) => uncertain: never
    // assume the token is replayable.
    return { status: "uncertain", updatedAt: Date.now() };
  }
}

function writeRefreshIntent(refreshToken: string, status: RefreshIntentStatus): void {
  const dir = refreshIntentDir();
  // Hardened, owner-only directory + atomic (temp+rename) write. Throws on
  // failure so the caller can fail closed instead of refreshing blind.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync only applies the mode at creation; re-apply owner-only on an
  // existing directory so a permissive pre-existing dir is corrected. Fail
  // closed: if the directory cannot be hardened to owner-only, do not write
  // refresh-intent data into a directory a local attacker may observe.
  chmodSync(dir, 0o700);
  hardenConfigDir();
  const path = refreshIntentPath(refreshToken);
  try {
    atomicWriteFile(path, JSON.stringify({ status, updatedAt: Date.now() } satisfies RefreshIntent));
  } catch (error) {
    throw new RefreshIntentIOError(`Failed to durably record Nous refresh intent (${status}); refusing refresh to avoid replaying a possibly-consumed token`, error);
  }
}

function clearRefreshIntent(refreshToken: string): void {
  try {
    rmSync(refreshIntentPath(refreshToken), { force: true });
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    // A non-ENOENT failure to clear is concerning but non-fatal for the caller;
    // the next replay guard still keys off the (now possibly stale) file.
    throw new RefreshIntentIOError("Failed to clear Nous refresh intent", error);
  }
}

/**
 * True when replaying this refresh token is unsafe: we previously submitted it
 * and either got a response (so it may have been consumed) or failed to confirm
 * the rotation persisted. In that uncertain state we must never blindly replay
 * it — a replay could trigger `refresh_token_reused` and revoke the session.
 * The caller should force a clean re-authentication instead.
 */
export function nousRefreshIntentBlocksReplay(refreshToken: string): boolean {
  return readRefreshIntent(refreshToken)?.status !== undefined;
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
 * Mirrors the https-only default in Hermes `hermes_cli/auth.py`
 * (`DEFAULT_NOUS_PORTAL_URL`). Note: unlike Hermes, this function does not pin
 * the host to an allowlist; any HTTPS origin passes.
 */
function resolvePortalBaseUrl(): string {
  const raw = (process.env.NOUS_PORTAL_BASE_URL || NOUS_PORTAL_BASE_URL).trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Do not echo the raw value: it may contain embedded credentials. Identify
    // the configuration problem without reflecting secret-bearing input.
    throw new NousTokenError(undefined, undefined, "Nous Portal base URL is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new NousTokenError(undefined, undefined, `Nous Portal base URL must use HTTPS (got ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw new NousTokenError(undefined, undefined, "Nous Portal base URL must not contain embedded credentials");
  }
  if (url.search) {
    throw new NousTokenError(undefined, undefined, "Nous Portal base URL must not contain a query string");
  }
  if (url.hash) {
    throw new NousTokenError(undefined, undefined, "Nous Portal base URL must not contain a fragment");
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
 * lowercased when present. Opaque (non-JWT) tokens carry no identity and are
 * rejected downstream by the `inference:invoke` scope gate (parseTokenPayload),
 * so a usable access token is always a decodable JWT.
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
  const expMs = exp * 1000;
  // Ignore an implausible claim (past, or absurdly far in the future) and let
  // the caller fall back to `expires_in`. A too-large `exp` (e.g. ms instead of
  // seconds, or clock skew) would otherwise pin the credential as never
  // expiring, and a too-small one would force an immediate refresh that burns a
  // single-use token.
  if (expMs <= Date.now() || expMs > Date.now() + MAX_PLAUSIBLE_TOKEN_LIFETIME_MS) return undefined;
  return expMs;
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
  /**
   * When set, the (already rotated) refresh token to persist before re-auth, so
   * the caller can drive a clean re-authentication without discarding the
   * rotation the server already performed (review #5). Only the refresh token
   * is retained (never the access token), and the property is non-enumerable so
   * it is not leaked by structured logging/serialization (review: credentials
   * must not be enumerable Error properties).
   */
  private readonly rotatedRefresh?: string;

  constructor(
    status: number | undefined,
    public readonly oauthError: string | undefined,
    message: string,
    options?: { cause?: unknown; terminal?: boolean; credentials?: OAuthCredentials },
  ) {
    super(message, options);
    this.name = "NousTokenError";
    this.terminal = options?.terminal ?? false;
    this.rotatedRefresh = options?.credentials?.refresh;
    // Non-enumerable so JSON.stringify / util.inspect / logging sinks do not
    // surface a live credential. Read it via getRotatedRefresh().
    Object.defineProperty(this, "rotatedRefresh", { enumerable: false, configurable: true });
  }

  /** The rotated refresh token to persist before re-auth, if any. */
  getRotatedRefresh(): string | undefined {
    return this.rotatedRefresh;
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
  if (!access) {
    // A response without a usable access token cannot be used for inference;
    // classify it as terminal so the coordinator forces re-authentication.
    throw new NousTokenError(
      undefined,
      "invalid_token",
      "Nous Portal token response did not include an access token",
      { terminal: true },
    );
  }
  const refresh = nonEmptyString(payload.refresh_token);
  if (!refresh) {
    if (submittedRefreshToken) {
      // Rotation path: the server consumed RT-A but returned no replacement, so
      // reusing RT-A would trigger refresh_token_reused and revoke the session.
      throw new NousTokenError(
        undefined,
        "refresh_token_reused",
        "Nous Portal did not return a replacement refresh token; refusing to reuse the consumed one (would trigger refresh_token_reused and revoke the session)",
        { terminal: true },
      );
    }
    // Device-login path: no refresh token was submitted; a missing refresh_token
    // in the initial token response is an unusable response, not a reuse.
    throw new NousTokenError(
      undefined,
      "invalid_token",
      "Nous Portal token response did not include a refresh token",
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
  const rawExpires = expMs
    ?? (expiresInMs !== undefined ? Date.now() + expiresInMs : Date.now() + DEFAULT_ACCESS_TOKEN_TTL_MS);
  const expires = Math.max(0, rawExpires - OAUTH_EXPIRY_SKEW_MS);

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
  const effectiveSignal = requestSignal(signal);
  const response = await fetch(`${resolvePortalBaseUrl()}/api/oauth/device/code`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: NOUS_OAUTH_CLIENT_ID,
      scope: NOUS_OAUTH_SCOPE,
    }),
    redirect: "error",
    signal: effectiveSignal,
  });
  if (!response.ok) {
    throw tokenErrorFromPayload(response.status, await readOAuthJsonOrEmpty(response, effectiveSignal));
  }
  // A successful HTTP response may still carry an empty/HTML/non-JSON body.
  // Fall back to an empty object so the required-field check below produces the
  // clear "missing required fields" validation error instead of leaking a raw
  // JSON parser exception.
  const payload = await readOAuthJsonOrEmpty(response, effectiveSignal) as NousDeviceAuthorizationResponse;
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
  // Deadline-aware retry wait: never sleep past the device-flow deadline, so a
  // late retry cannot delay the expiration report or accept a stale response.
  const sleepUntilDeadline = async (ms: number) => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await sleep(Math.min(ms, remainingMs), signal);
    return true;
  };
  let waitMs = Math.max(1000, intervalMs);
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Login cancelled");
    let response: Response;
    const effectiveSignal = requestSignal(signal);
    try {
      response = await fetch(`${resolvePortalBaseUrl()}/api/oauth/token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: NOUS_OAUTH_CLIENT_ID,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        redirect: "error",
        signal: effectiveSignal,
      });
    } catch (netErr) {
      // Genuine cancellation must abort immediately. Any other transport-level
      // failure (timeout, DNS, dropped connection, proxy reset) must not destroy
      // a device session that is still within its deadline: retry with the
      // current wait interval. The device-code grant is idempotent for the
      // pending case, so a retried poll is safe (unlike the refresh path).
      if (signal?.aborted) throw new Error("Login cancelled");
      if (await sleepUntilDeadline(waitMs)) continue;
      break;
    }
    // Parse under the same deadline that covered the request headers. Keep the
    // read outside the fetch retry catch: a bounded-reader error or caller
    // cancellation is an observed response failure, not a safe poll retry.
    const payload = await readOAuthJsonOrEmpty(response, effectiveSignal) as NousTokenResponse;
    // Parse once and pass the payload through to the failure path (review #8),
    // so we never try to re-read a body that has already been consumed.
    // Normalize a successful-but-non-object body (for example valid JSON
    // `null`) to an empty object so the required-field validation below
    // produces a terminal NousTokenError instead of a raw TypeError.
    if (Date.now() >= deadline) break;
    if (response.ok) return parseTokenPayload(payload, "");
    const error = payload.error;
    if (error === "authorization_pending") {
      if (!(await sleepUntilDeadline(waitMs))) break;
      continue;
    }
    if (error === "slow_down") {
      waitMs = Math.min(MAX_POLL_INTERVAL_MS, waitMs + 5000);
      const retryAfter = typeof payload.interval === "number" ? payload.interval * 1000 : undefined;
      if (retryAfter && retryAfter > waitMs) waitMs = Math.min(MAX_POLL_INTERVAL_MS, retryAfter);
      if (!(await sleepUntilDeadline(waitMs))) break;
      continue;
    }
    if (error === "expired_token") {
      throw new NousTokenError(response.status, "expired_token", "Nous Portal device authorization expired", { terminal: true });
    }
    if (error === "access_denied") {
      throw new NousTokenError(response.status, "access_denied", "Nous Portal device authorization denied", { terminal: true });
    }
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
 * obtained. After dispatch, every non-2xx response (including 429 and unknown
 * 4xx) leaves the intent "uncertain" — a client-class status does not prove the
 * single-use token was not consumed, so the old token stays blocked and a later
 * refresh refuses to replay it, forcing re-auth instead of a session-revoking
 * replay. The intent is cleared only after the rotated credential is durably
 * persisted by the store.
 */
export async function refreshNousToken(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredentials> {
  // Validate the OAuth base URL first (independent of the token): a malformed
  // or non-HTTPS override must fail before we record any refresh intent, so a
  // bad URL never leaves a "submitted" intent behind (which would otherwise
  // make the next call refuse to replay the token).
  const baseUrl = resolvePortalBaseUrl();
  // Never blindly replay a token whose outcome we could not confirm earlier:
  // a prior submission got a server response (so it may have been consumed) or
  // failed to persist its rotation. Replaying it could trigger
  // `refresh_token_reused` and revoke the session.
  if (nousRefreshIntentBlocksReplay(refreshToken)) {
    throw new NousTokenError(
      undefined,
      "refresh_token_reused",
      "Refusing to replay a refresh token with an unconfirmed prior outcome (previous rotation may not have persisted)",
      { terminal: true },
    );
  }
  // Record that we are about to submit this token. It stays "submitted" after a
  // successful rotation until the store confirms persistence of the rotated
  // token (via clearNousRefreshIntent) — so a crash before persistence leaves
  // the old token refused on replay instead of silently reused.
  // Fail-closed: if we cannot durably record the intent, refuse the refresh.
  try {
    writeRefreshIntent(refreshToken, "submitted");
  } catch (ioErr) {
    // The write happens BEFORE dispatch, so the credential has not been
    // rejected or consumed. Fail closed (abort the refresh) but surface a
    // NON-terminal operational error: the coordinator must not mark the account
    // needsReauth merely because local persistence infrastructure is broken.
    throw new RefreshIntentIOError(
      "Refusing refresh: could not durably record the refresh-intent guard (fail-closed)",
      ioErr,
    );
  }

  let response: Response;
  const effectiveSignal = requestSignal(signal);
  try {
    response = await fetch(`${baseUrl}/api/oauth/token`, {
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
      signal: effectiveSignal,
    });
  } catch (netErr) {
    // The request may have reached the server and rotated the token even on a
    // timeout/abort/connection error — we cannot prove it did NOT. Mark the
    // intent uncertain so the submitted token is never replayed; the next
    // refresh will force a clean re-auth instead of risking reuse.
    try {
      writeRefreshIntent(refreshToken, "uncertain");
    } catch {
      // If we cannot even mark uncertain, the worst case is a later blind
      // replay; prefer surfacing the original network error so it is retried
      // through the normal path, which will re-encounter the guard if the file
      // later becomes readable.
    }
    throw netErr;
  }

  if (!response.ok) {
    const status = response.status;
    // The request reached the Portal's token endpoint. A non-2xx response does
    // NOT establish that the single-use refresh token was not consumed: 429
    // rate limits, unknown/custom 4xx, and gateway-generated client-class
    // errors can all be returned AFTER the remote side processed (and consumed)
    // the token. Only a response whose documented OAuth semantics prove
    // non-consumption would be safe to retry, and no such Nous contract is
    // documented (invalid_grant/refresh_token_reused are explicitly terminal).
    // Fail closed: retain the durable intent as uncertain so the submitted
    // token is never automatically replayed.
    try {
      writeRefreshIntent(refreshToken, "uncertain");
    } catch {
      // The pre-dispatch "submitted" intent is still on disk, which also
      // blocks replay; surface the original HTTP error below.
    }
    const payload = await readOAuthJsonOrEmpty(response, effectiveSignal);
    throw tokenErrorFromPayload(status, payload);
  }

  // The server responded 200 — the submitted token may now be consumed. If we
  // fail to parse the rotated token, mark the intent uncertain so we never
  // replay it. On success we deliberately LEAVE the intent as "submitted"
  // (the store clears it once the rotated token is persisted).
  try {
    const creds = parseTokenPayload(
      (await readOAuthJson(response, effectiveSignal)) as NousTokenResponse,
      refreshToken,
    );
    return creds;
  } catch (e) {
    try {
      writeRefreshIntent(refreshToken, "uncertain");
    } catch {
      // already throwing the parse error below; do not mask it
    }
    throw e;
  }
}

/**
 * Clear the durable refresh-intent for a token. The account store calls this
 * after `mergeAccountCredential` persists the rotated token, closing the
 * uncertain-outcome window opened by `refreshNousToken`.
 */
export function clearNousRefreshIntent(refreshToken: string): void {
  clearRefreshIntent(refreshToken);
}
