/**
 * Application Default Credentials (ADC) resolution for Vertex AI.
 *
 * Direct WebCrypto + REST implementation (no `google-auth-library`). Sources, in priority order:
 *   0. A `gcp-sa:<account>` reference (the provider's active key resolving to one) → the Service
 *      Account / authorized_user JSON stored in the OS credential store under that account
 *      (`keychain:<account>` secret, written by the key-store save path when the user pastes a
 *      credential JSON directly into the API-key slot). See resolveGcpCredentialMarker.
 *   1. `GOOGLE_APPLICATION_CREDENTIALS` env → file with `type: "service_account"` (RS256 JWT
 *      exchange) or `type: "authorized_user"` (refresh-token exchange).
 *   2. gcloud user ADC (`CLOUDSDK_CONFIG`, else `%APPDATA%\gcloud` on Windows, else
 *      `~/.config/gcloud`) `application_default_credentials.json` (authorized_user flow).
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
import { readFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { GCP_CREDENTIAL_MARKER_PREFIX, providerKeychainEntry } from "../providers/api-key-resolve";
import { vertexAmbientKeyIsCurrent, type VertexAmbientKeyAuthority } from "../providers/vertex-environment-authority";
export { isGcpCredentialMaterial } from "./gcp-credential-input";
import {
  captureConfigGeneration,
  sweepExpiredOnWrite,
  type GenerationContext,
} from "./state-store-sweeper";

/** Injectable fetch (tests pass a mock); defaults to the global fetch. */
export type FetchImpl = typeof fetch;

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

const TOKEN_TIMEOUT_MS = 15_000;
const TOKEN_ATTEMPTS = 3;
const TOKEN_RETRY_BASE_MS = 300;

/**
 * Reference prefix stored in `provider.apiKey` (and `apiKeyPool` entries) when the user pastes a
 * GCP credential JSON directly into an API-key slot. The secret JSON lives in the OS credential
 * store under the same service the `keychain:` references use; only the marker is persisted to
 * `config.json`. The leaf reference prefix also identifies already-stored material for migration.
 */
export { GCP_CREDENTIAL_MARKER_PREFIX } from "../providers/api-key-resolve";

/** Extract a marker account; malformed explicit markers never opt into host ADC. */
export function gcpCredentialMarkerAccount(value: string | undefined): string | undefined {
  if (typeof value !== "string" || !value.startsWith(GCP_CREDENTIAL_MARKER_PREFIX)) return undefined;
  const account = value.slice(GCP_CREDENTIAL_MARKER_PREFIX.length);
  if (!account.trim()) throw new Error("GCP credential marker requires a non-empty account");
  return account;
}

/**
 * Whether a pasted API-key value is in fact a GCP credential JSON. Used by the save path to
 * divert JSON material out of the literal-key flow before it reaches `config.json`. Deliberately
 * strict: only a `type` field with a known ADC credential type counts, so a user's literal API
 * key that happens to start with `{` is never eaten.
 */
export function parseGcpCredentialJson(value: string): AdcFileCredentials | undefined {
  const trimmed = (value ?? "").trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed?.type === "service_account") {
      if (typeof parsed.client_email !== "string" || !parsed.client_email.trim()) return undefined;
      if (typeof parsed.private_key !== "string" || !parsed.private_key.trim()) return undefined;
      return parsed as unknown as AdcFileCredentials;
    }
    if (parsed?.type === "authorized_user") {
      if (typeof parsed.client_id !== "string" || !parsed.client_id.trim()) return undefined;
      if (typeof parsed.client_secret !== "string" || !parsed.client_secret.trim()) return undefined;
      if (typeof parsed.refresh_token !== "string" || !parsed.refresh_token.trim()) return undefined;
      return parsed as unknown as AdcFileCredentials;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
  generation: number;
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
type VertexTokenAuthority = { token: string; source: string; generation: number; markerAccount?: string };
type TokenWaiter = { beforeSend?: () => void };
type InflightToken = { controller: AbortController; promise: Promise<VertexTokenAuthority>; waiters: Set<TokenWaiter>; settled: boolean };
const inflight = new Map<string, InflightToken>();
const sourceObservations = new Map<string, { source: string; generation: number }>();
let sourceEpoch = 0;
let lastReconciledGeneration = 0;
let liveSources = new Set<string>();

export function sweepExpiredGcpAdcTokens(now = Date.now()): number {
  const skew = getRefreshSkewMs();
  let removed = 0;
  for (const [source, cached] of tokenCache) {
    if (cached.expiresAtMs - skew > now) continue;
    tokenCache.delete(source);
    removed += 1;
  }
  return removed;
}

export function reconcileGcpAdcTokens(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  // The periodic sweep registration has no request context, so no marker is active here: markers
  // travel per-request via getVertexAccessToken(options.markerAccount), and a marker-token cache
  // entry whose account no longer resolves is simply pruned by this sweep when it expires.
  const currentSource = currentAdcSourceKey(undefined);
  let removed = 0;
  for (const source of tokenCache.keys()) {
    if (source === currentSource) continue;
    tokenCache.delete(source);
    removed += 1;
  }
  liveSources = new Set([currentSource]);
  lastReconciledGeneration = context.generation;
  return removed;
}

function getRefreshSkewMs(): number {
  const raw = Number(process.env.GOOGLE_VERTEX_REFRESH_SKEW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/** gcloud config dir, matching the SDK's own resolution order. */
function gcloudConfigDir(): string {
  const explicit = process.env.CLOUDSDK_CONFIG?.trim();
  if (explicit) return explicit;
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "gcloud");
  }
  return path.join(os.homedir(), ".config", "gcloud");
}

function userAdcPath(): string {
  return path.join(gcloudConfigDir(), "application_default_credentials.json");
}

// Cache identity is keyed and process-local: neither credential contents nor their digest is public.
const sourceDigestKey = randomBytes(32);
function sourceTag(kind: string, identity: string, content: string): string {
  const digest = createHmac("sha256", sourceDigestKey)
    .update(kind).update("\0").update(identity).update("\0").update(content).digest("hex");
  return `${kind}:${digest}`;
}

function readJsonFile<T>(filePath: string): { value: T; content: string } | undefined {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Vertex ADC credential file could not be read");
  }
  try { return { value: JSON.parse(content) as T, content }; }
  catch { throw new Error("Vertex ADC credential file is invalid"); }
}

/**
 * Read the credential JSON for a `gcp-sa:<account>` marker from the OS credential store. Uses the
 * same service name and the same injectable entry factory as the `keychain:` API-key references
 * (api-key-resolve.providerKeychainEntry), so one probe surface and one test seam cover both.
 * Mirrors `readKeychain`'s fail-closed policy: an unreadable entry yields no credential (the
 * caller surfaces the failure instead of silently falling through to the next ADC source).
 */
function readMarkerCredential(account: string): AdcFileCredentials | undefined {
  try {
    const raw = providerKeychainEntry(account).getPassword();
    if (typeof raw !== "string" || !raw.trim()) return undefined;
    return parseGcpCredentialJson(raw);
  } catch {
    return undefined;
  }
}

function loadAdcCredentials(markerAccount: string | undefined): { source: string; creds: AdcFileCredentials } | undefined {
  if (markerAccount) {
    const creds = readMarkerCredential(markerAccount);
    if (!creds) throw new Error("GCP credential marker is set but its credential could not be read from the OS credential store");
    return { source: sourceTag("marker", markerAccount, JSON.stringify(creds)), creds };
  }
  const gacPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gacPath) {
    const creds = readJsonFile<AdcFileCredentials>(gacPath);
    if (!creds) throw new Error(`GOOGLE_APPLICATION_CREDENTIALS points to a missing file: ${gacPath}`);
    return { source: sourceTag("gac", gacPath, creds.content), creds: creds.value };
  }
  const userPath = userAdcPath();
  const creds = readJsonFile<AdcFileCredentials>(userPath);
  if (creds) return { source: sourceTag("user", userPath, creds.content), creds: creds.value };
  return undefined;
}

/**
 * The cache key for the source the NEXT resolve would use, computed cheaply (no network). Lets the
 * cache return a token only when it still matches the active credential source, so an in-process
 * change to GOOGLE_APPLICATION_CREDENTIALS (or the user ADC file) does not keep serving a stale
 * token from a different source. Falls back to "metadata" when no marker/file/env ADC is present.
 */
function currentAdcSourceKey(markerAccount: string | undefined): string {
  try {
    return loadAdcCredentials(markerAccount)?.source ?? "metadata";
  } catch {
    return "invalid";
  }
}

/** Every observed source transition gets a fresh incarnation, including A→B→A. */
function observeAdcSource(markerAccount: string | undefined): { source: string; generation: number } {
  const scope = markerAccount ? `marker:${markerAccount}` : "host";
  const source = currentAdcSourceKey(markerAccount);
  const previous = sourceObservations.get(scope);
  if (previous?.source === source) return previous;
  const next = { source, generation: ++sourceEpoch };
  sourceObservations.delete(scope);
  sourceObservations.set(scope, next);
  if (sourceObservations.size > 512) sourceObservations.delete(sourceObservations.keys().next().value!);
  return next;
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
async function postForToken(body: URLSearchParams, signal: AbortSignal | undefined, fetchImpl: FetchImpl, beforeSend: () => void): Promise<TokenResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < TOKEN_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error("Google OAuth token exchange aborted");
    beforeSend();
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

async function exchangeJwtForToken(creds: ServiceAccountCredentials, signal: AbortSignal | undefined, fetchImpl: FetchImpl, beforeSend: () => void): Promise<TokenResponse> {
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJwtRs256(
    { iss: creds.client_email, scope: CLOUD_PLATFORM_SCOPE, aud: OAUTH_TOKEN_URL, exp: now + 3600, iat: now },
    creds.private_key,
    creds.private_key_id,
  );
  return postForToken(new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }), signal, fetchImpl, beforeSend);
}

async function exchangeRefreshToken(creds: AuthorizedUserCredentials, signal: AbortSignal | undefined, fetchImpl: FetchImpl, beforeSend: () => void): Promise<TokenResponse> {
  return postForToken(
    new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: "refresh_token",
    }),
    signal,
    fetchImpl,
    beforeSend,
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

async function resolveAccessTokenUncached(markerAccount: string | undefined, signal: AbortSignal | undefined, fetchImpl: FetchImpl, beforeSend: () => void): Promise<{ source: string; token: TokenResponse }> {
  const adc = loadAdcCredentials(markerAccount);
  if (adc) {
    const token = adc.creds.type === "service_account"
      ? await exchangeJwtForToken(adc.creds, signal, fetchImpl, beforeSend)
      : await exchangeRefreshToken(adc.creds, signal, fetchImpl, beforeSend);
    return { source: adc.source, token };
  }
  beforeSend();
  const metadata = await fetchMetadataToken(signal, fetchImpl);
  if (metadata) return { source: "metadata", token: metadata };
  throw new Error(
    "Vertex AI requires Application Default Credentials. Set GOOGLE_APPLICATION_CREDENTIALS, run `gcloud auth application-default login`, or run on a GCE/Cloud Run instance with a service account.",
  );
}

/** Returns a Bearer access token for the `Authorization` header on Vertex AI calls (cached + refreshed). */
export async function getVertexAccessTokenWithAuthority(options?: { signal?: AbortSignal; fetch?: FetchImpl; markerAccount?: string; beforeSend?: () => void }): Promise<VertexTokenAuthority> {
  // The marker travels as an argument, never as process-global state: a module-level "active
  // marker" written by the router would race across concurrent requests for different providers
  // and could resolve one provider's Vertex call with another provider's service account. The
  // adapter passes `gcpCredentialMarkerAccount(provider.apiKey)` per request instead.
  const markerAccount = options?.markerAccount;
  options?.signal?.throwIfAborted();
  const fetchImpl = options?.fetch ?? globalThis.fetch.bind(globalThis);
  const skew = getRefreshSkewMs();
  const now = Date.now();

  // Only serve a cached token that matches the source the next resolve would actually use; prune
  // expired or now-stale (different-source) entries so a credential-source change is honored.
  const expected = observeAdcSource(markerAccount);
  const expectedSource = expected.source;
  // A cached bearer token is usable only while the explicitly selected store entry remains
  // readable. Removal or a locked store must fail closed before the cache can return it.
  if (markerAccount && !readMarkerCredential(markerAccount)) {
    tokenCache.delete(expectedSource);
    throw new Error("GCP credential marker is set but its credential could not be read from the OS credential store");
  }
  const writerGeneration = captureConfigGeneration();
  for (const [source, cached] of tokenCache) {
    if (source === expectedSource && cached.generation === expected.generation && cached.expiresAtMs - skew > now) {
      return { token: cached.token, source, generation: expected.generation, markerAccount };
    }
    if (cached.expiresAtMs - skew <= now) tokenCache.delete(source);
  }

  // Dedup in-flight fetches PER source, not globally: if the credential source changes while a
  // fetch is in flight, a new caller must not reuse the old source's promise (cross-source bleed).
  const cacheKey = `${expectedSource}:${expected.generation}`;
  let entry = inflight.get(cacheKey);
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, waiters: new Set(), settled: false, promise: undefined as unknown as Promise<VertexTokenAuthority> };
    const owned = entry;
    const beforeSend = () => {
      const current = observeAdcSource(markerAccount);
      if (current.source !== expected.source || current.generation !== expected.generation) throw new Error("Vertex ADC source changed before token exchange");
      let failure: unknown;
      for (const waiter of owned.waiters) {
        try { waiter.beforeSend?.(); return; }
        catch (error) { failure = error; }
      }
      throw failure ?? new Error("Vertex token exchange has no authorized waiter");
    };
    owned.promise = Promise.resolve().then(async () => {
    try {
      const { source, token } = await resolveAccessTokenUncached(markerAccount, controller.signal, fetchImpl, beforeSend);
      const current = observeAdcSource(markerAccount);
      if (source !== expectedSource || current.source !== source || current.generation !== expected.generation) {
        throw new Error("Vertex ADC source changed during token exchange");
      }
      const expiresAtMs = Date.now() + Math.max(0, token.expires_in * 1000);
      if (writerGeneration >= lastReconciledGeneration || liveSources.has(source)) {
        tokenCache.set(source, { token: token.access_token, expiresAtMs, generation: expected.generation });
        sweepExpiredOnWrite(Date.now());
      }
      return { token: token.access_token, source, generation: expected.generation, markerAccount };
    } finally {
      owned.settled = true;
      if (inflight.get(cacheKey) === owned) inflight.delete(cacheKey);
    }
    });
    inflight.set(cacheKey, owned);
  }
  const owned = entry;
  const waiter: TokenWaiter = { beforeSend: options?.beforeSend };
  owned.waiters.add(waiter);
  return new Promise<VertexTokenAuthority>((resolve, reject) => {
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      options?.signal?.removeEventListener("abort", onAbort);
      owned.waiters.delete(waiter);
      if (owned.waiters.size === 0 && !owned.settled) {
        if (inflight.get(cacheKey) === owned) inflight.delete(cacheKey);
        owned.controller.abort();
      }
      return true;
    };
    const onAbort = () => { if (finish()) reject(options?.signal?.reason ?? new Error("Google OAuth token exchange aborted")); };
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    owned.promise.then(value => {
      if (!finish()) return;
      try { waiter.beforeSend?.(); resolve(value); } catch (error) { reject(error); }
    }, error => { if (finish()) reject(error); });
  });
}

/** Compatibility wrapper for callers that only need the access token. */
export async function getVertexAccessToken(options?: { signal?: AbortSignal; fetch?: FetchImpl; markerAccount?: string }): Promise<string> {
  return (await getVertexAccessTokenWithAuthority(options)).token;
}

type VertexRequestAuthority = { source?: string; generation?: number; markerAccount?: string; ambientKey?: VertexAmbientKeyAuthority; target: string; headerDigest: string };
const requestAuthorities = new WeakMap<object, VertexRequestAuthority>();
const requestDigestKey = randomBytes(32);
function requestDigest(value: string): string {
  return createHmac("sha256", requestDigestKey).update(value).digest("hex");
}

/** Bind the exact credential and target used by a built Vertex request without storing the secret. */
export function bindVertexRequestAuthority(request: object, target: string, header: string,
  authority: { source: string; generation: number; markerAccount?: string } | { ambientKey: VertexAmbientKeyAuthority }): void {
  requestAuthorities.set(request, {
    target, headerDigest: requestDigest(header),
    ...authority,
  });
}

/** Rebuilds reuse the original request object, so transfer or clear its previous authority. */
export function copyVertexRequestAuthority(from: object, to: object): void {
  const authority = requestAuthorities.get(from);
  if (authority) requestAuthorities.set(to, authority);
  else requestAuthorities.delete(to);
}

export function hasVertexRequestAuthority(request: object): boolean {
  return requestAuthorities.has(request);
}

/** Fail closed if the locally observable credential source or final request changed. */
export function vertexRequestAuthorityIsCurrent(request: object, target?: string, headers?: Headers): boolean {
  const authority = requestAuthorities.get(request);
  if (!authority) return true;
  if (authority.source) {
    const current = observeAdcSource(authority.markerAccount);
    if (current.source !== authority.source || current.generation !== authority.generation) return false;
  }
  if (authority.ambientKey && !vertexAmbientKeyIsCurrent(authority.ambientKey)) return false;
  if (target !== undefined && target !== authority.target) return false;
  if (headers) {
    const actual = authority.source ? headers.get("authorization") : headers.get("x-goog-api-key");
    if (!actual || requestDigest(actual) !== authority.headerDigest) return false;
  }
  return true;
}

/** Test seam: restores complete process-local token and reconciliation state. */
export function __resetVertexTokenCache(): void {
  tokenCache.clear();
  for (const entry of inflight.values()) entry.controller.abort();
  inflight.clear();
  sourceObservations.clear();
  lastReconciledGeneration = 0;
  liveSources = new Set();
}
