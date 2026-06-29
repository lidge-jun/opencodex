/**
 * Application Default Credentials (ADC) resolution for Vertex AI.
 *
 * Direct WebCrypto + REST implementation (no `google-auth-library`). Sources, in priority order:
 *   1. `GOOGLE_APPLICATION_CREDENTIALS` env → file with `type: "service_account"` (RS256 JWT
 *      exchange) or `type: "authorized_user"` (refresh-token exchange).
 *   2. `~/.config/gcloud/application_default_credentials.json` (user ADC; authorized_user flow).
 *   3. GCE / Cloud Run metadata server.
 *
 * Tokens are cached per source key and refreshed `GOOGLE_VERTEX_REFRESH_SKEW_MS` (default 60s)
 * before expiry. Concurrent callers waiting on a refresh share one in-flight promise.
 *
 * Security: never logs the access token, private key, or refresh token.
 */

import { Buffer } from "node:buffer";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync, existsSync, statSync } from "node:fs";

/** Injectable fetch (tests pass a mock); defaults to the global fetch. */
export type FetchImpl = typeof fetch;

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

const TOKEN_TIMEOUT_MS = 15_000;
const TOKEN_ATTEMPTS = 3;
const TOKEN_RETRY_BASE_MS = 300;

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

interface ServiceAccountCredentials {
  type: "service_account";
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

interface AuthorizedUserCredentials {
  type: "authorized_user";
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

type AdcFileCredentials = ServiceAccountCredentials | AuthorizedUserCredentials;

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
}

const tokenCache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<string>>();

function getRefreshSkewMs(): number {
  const raw = Number(process.env.GOOGLE_VERTEX_REFRESH_SKEW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

function userAdcPath(): string {
  return path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json");
}

/**
 * A content-freshness fingerprint for a credential file, so an in-place rewrite (e.g.
 * `gcloud auth application-default login`, or a rotated service-account key at the same path)
 * changes the cache key and invalidates the stale token. Falls back to the bare path when stat fails.
 */
function fileSourceTag(prefix: string, filePath: string): string {
  try {
    const st = statSync(filePath);
    return `${prefix}:${filePath}:${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return `${prefix}:${filePath}`;
  }
}

function readJsonFile<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined;
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function loadAdcCredentials(): { source: string; creds: AdcFileCredentials } | undefined {
  const gacPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gacPath) {
    const creds = readJsonFile<AdcFileCredentials>(gacPath);
    if (!creds) throw new Error(`GOOGLE_APPLICATION_CREDENTIALS points to a missing file: ${gacPath}`);
    return { source: fileSourceTag("gac", gacPath), creds };
  }
  const userPath = userAdcPath();
  const creds = readJsonFile<AdcFileCredentials>(userPath);
  if (creds) return { source: fileSourceTag("user", userPath), creds };
  return undefined;
}

/**
 * The cache key for the source the NEXT resolve would use, computed cheaply (no network). Lets the
 * cache return a token only when it still matches the active credential source, so an in-process
 * change to GOOGLE_APPLICATION_CREDENTIALS (or the user ADC file) does not keep serving a stale
 * token from a different source. Falls back to "metadata" when no file/env ADC is present.
 */
function currentAdcSourceKey(): string {
  const gacPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gacPath) return fileSourceTag("gac", gacPath);
  const userPath = userAdcPath();
  if (existsSync(userPath)) return fileSourceTag("user", userPath);
  return "metadata";
}

function base64UrlEncode(bytes: Uint8Array | string): string {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  return buf.toString("base64url");
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (!body) throw new Error("Invalid PEM: empty body");
  const buf = Buffer.from(body, "base64");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function signJwtRs256(claims: Record<string, unknown>, privateKeyPem: string, keyId?: string): Promise<string> {
  const header: Record<string, unknown> = { alg: "RS256", typ: "JWT" };
  if (keyId) header.kid = keyId;
  const payload = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const key = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await globalThis.crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(payload)),
  );
  return `${payload}.${base64UrlEncode(signature)}`;
}

function tokenRetryDelayMs(attempt: number): number {
  const exp = TOKEN_RETRY_BASE_MS * 2 ** attempt;
  return Math.floor(exp * (0.8 + Math.random() * 0.4));
}

function isRetryableTokenStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function tokenTimeoutSignal(parent: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(TOKEN_TIMEOUT_MS);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

/**
 * Exchange a grant for a Google access token, hardened with a per-attempt timeout + bounded retry
 * on transient failures (network errors and 429/5xx). Non-retryable statuses (e.g. 400/401 from a
 * bad grant) fail fast. The error message carries only the status code, never the response body
 * (which can leak grant/account details) or the token/key.
 */
async function postForToken(body: URLSearchParams, signal: AbortSignal | undefined, fetchImpl: FetchImpl): Promise<TokenResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < TOKEN_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error("Google OAuth token exchange aborted");
    let response: Response;
    try {
      response = await fetchImpl(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: tokenTimeoutSignal(signal),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
      if (attempt === TOKEN_ATTEMPTS - 1) break;
      await new Promise(resolve => setTimeout(resolve, tokenRetryDelayMs(attempt)));
      continue;
    }
    if (response.ok) return (await response.json()) as TokenResponse;
    if (!isRetryableTokenStatus(response.status) || attempt === TOKEN_ATTEMPTS - 1) {
      throw new Error(`Google OAuth token exchange failed (${response.status})`);
    }
    lastError = new Error(`Google OAuth token exchange failed (${response.status})`);
    await response.body?.cancel().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, tokenRetryDelayMs(attempt)));
  }
  throw lastError instanceof Error ? lastError : new Error("Google OAuth token exchange failed");
}

async function exchangeJwtForToken(creds: ServiceAccountCredentials, signal: AbortSignal | undefined, fetchImpl: FetchImpl): Promise<TokenResponse> {
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJwtRs256(
    { iss: creds.client_email, scope: CLOUD_PLATFORM_SCOPE, aud: OAUTH_TOKEN_URL, exp: now + 3600, iat: now },
    creds.private_key,
    creds.private_key_id,
  );
  return postForToken(new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }), signal, fetchImpl);
}

async function exchangeRefreshToken(creds: AuthorizedUserCredentials, signal: AbortSignal | undefined, fetchImpl: FetchImpl): Promise<TokenResponse> {
  return postForToken(
    new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: "refresh_token",
    }),
    signal,
    fetchImpl,
  );
}

async function fetchMetadataToken(signal: AbortSignal | undefined, fetchImpl: FetchImpl): Promise<TokenResponse | undefined> {
  const timeout = AbortSignal.timeout(2000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetchImpl(METADATA_TOKEN_URL, {
      method: "GET",
      headers: { "Metadata-Flavor": "Google" },
      signal: combined,
    });
    if (!response.ok) return undefined;
    return (await response.json()) as TokenResponse;
  } catch {
    return undefined;
  }
}

async function resolveAccessTokenUncached(signal: AbortSignal | undefined, fetchImpl: FetchImpl): Promise<{ source: string; token: TokenResponse }> {
  const adc = loadAdcCredentials();
  if (adc) {
    const token = adc.creds.type === "service_account"
      ? await exchangeJwtForToken(adc.creds, signal, fetchImpl)
      : await exchangeRefreshToken(adc.creds, signal, fetchImpl);
    return { source: adc.source, token };
  }
  const metadata = await fetchMetadataToken(signal, fetchImpl);
  if (metadata) return { source: "metadata", token: metadata };
  throw new Error(
    "Vertex AI requires Application Default Credentials. Set GOOGLE_APPLICATION_CREDENTIALS, run `gcloud auth application-default login`, or run on a GCE/Cloud Run instance with a service account.",
  );
}

/** Returns a Bearer access token for the `Authorization` header on Vertex AI calls (cached + refreshed). */
export async function getVertexAccessToken(options?: { signal?: AbortSignal; fetch?: FetchImpl }): Promise<string> {
  const fetchImpl = options?.fetch ?? globalThis.fetch.bind(globalThis);
  const skew = getRefreshSkewMs();
  const now = Date.now();

  // Only serve a cached token that matches the source the next resolve would actually use; prune
  // expired or now-stale (different-source) entries so a credential-source change is honored.
  const expectedSource = currentAdcSourceKey();
  for (const [source, cached] of tokenCache) {
    if (source === expectedSource && cached.expiresAtMs - skew > now) return cached.token;
    if (cached.expiresAtMs - skew <= now) tokenCache.delete(source);
  }

  // Dedup in-flight fetches PER source, not globally: if the credential source changes while a
  // fetch is in flight, a new caller must not reuse the old source's promise (cross-source bleed).
  const cacheKey = expectedSource;
  const existing = inflight.get(cacheKey);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const { source, token } = await resolveAccessTokenUncached(options?.signal, fetchImpl);
      const expiresAtMs = Date.now() + Math.max(0, token.expires_in * 1000);
      tokenCache.set(source, { token: token.access_token, expiresAtMs });
      return token.access_token;
    } finally {
      inflight.delete(cacheKey);
    }
  })();
  inflight.set(cacheKey, promise);
  return promise;
}

/** Test seam: clears every cached token + in-flight promise. */
export function __resetVertexTokenCache(): void {
  tokenCache.clear();
  inflight.clear();
}
