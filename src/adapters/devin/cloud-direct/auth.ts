/*
 * Derived from rsvedant/opencode-windsurf-auth (src/cloud-direct/), MIT licensed,
 * Copyright (c) 2026 Vedant. The full notice is in ./index.ts.
 */
/**
 * Mint the short-lived `user_jwt` that accompanies the persistent OAuth-issued
 * `api_key`. The catalog RPC uses it. The hosted chat path does not need it and
 * only sends it when an operator opts in, so a mint failure here cannot take
 * down a turn.
 *
 *   POST https://server.codeium.com/exa.auth_pb.AuthService/GetUserJwt
 *   Content-Type: application/proto             ← unary, NOT streaming
 *   Body: GetUserJwtRequest { metadata: Metadata }
 *   Response: GetUserJwtResponse { user_jwt: string }  (field 1)
 *
 * The returned JWT has a payload like:
 *   {
 *     "api_key": "devin-synthetic-apikey$account-…$user-…",
 *     "auth_uid": "devin-auth-uid$…",
 *     "email": "user@example.com",
 *     "exp": <unix-seconds>,         ← ~24 minute TTL
 *     "pro": true,
 *     "teams_tier": "TEAMS_TIER_DEVIN_PRO",
 *     ...
 *   }
 *
 * The JWT is signed HS256 by the server — can't be forged client-side. We
 * cache it and refresh shortly before `exp`.
 */

import * as crypto from 'crypto';
import { encodeMessage, iterFields } from './wire.js';
import { buildMetadata } from './metadata.js';
import { anySignal } from '../../../lib/abort.js';
import { validateDevinApiBaseUrl } from '../../../oauth/devin/api-base.js';

const DEFAULT_HOST = 'https://server.codeium.com';

export interface MintedUserJwt {
  jwt: string;
  /** Unix epoch seconds when the JWT expires. */
  expiresAt: number;
}

export class CloudAuthError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'CloudAuthError';
  }
}

/**
 * Default mint timeout — 30s is generous (the endpoint responds in ~200ms
 * in steady state) but enough headroom for slow networks. Callers can pass
 * a tighter `signal` to override.
 */
const MINT_TIMEOUT_MS = 30_000;

/**
 * Mint a fresh user_jwt by calling exa.auth_pb.AuthService/GetUserJwt.
 * `host` defaults to https://server.codeium.com — pass your tenant URL if your
 * RegisterUser response gave a different host.
 *
 * Always applies an internal 30s timeout so a network stall here can't
 * deadlock every concurrent chat request. If the caller passes a `signal`,
 * we honor whichever fires first via AbortSignal.any.
 */
export async function mintUserJwt(
  apiKey: string,
  host: string = DEFAULT_HOST,
  signal?: AbortSignal,
): Promise<MintedUserJwt> {
  const metadata = buildMetadata({
    apiKey,
    sessionId: crypto.randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID(),
  });
  // GetUserJwtRequest { metadata: Metadata }   — Metadata is field 1
  const req = encodeMessage(1, metadata);

  // Compose caller signal with our internal timeout via `anySignal` — a
  // small polyfill of `AbortSignal.any` for runtimes (Node 18 / older
  // Bun) that lack the built-in. The previous fallback silently dropped
  // the CALLER's signal on those runtimes, so a chat-cancel during a
  // GetUserJwt mint would keep the network request alive for up to the
  // full 30s timeout.
  const timeoutSignal = AbortSignal.timeout(MINT_TIMEOUT_MS);
  const composed = signal ? anySignal([signal, timeoutSignal]) : undefined;
  const combinedSignal: AbortSignal = composed?.signal ?? timeoutSignal;

  // The host arrives from RegisterUser via the credential store. It is checked
  // again here because this request carries the long-lived api_key inside the
  // protobuf body, and a host that slipped past persistence would exfiltrate it.
  const base = validateDevinApiBaseUrl(host);
  if (!base) {
    throw new CloudAuthError(`Refusing to mint a user_jwt against a non-Cognition host.`);
  }
  let resp: Response;
  try {
    resp = await fetch(`${base}/exa.auth_pb.AuthService/GetUserJwt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/proto',
      'Connect-Protocol-Version': '1',
    },
    body: new Uint8Array(req),
    // A redirect would replay this POST - whose body holds the api_key - at
    // whatever host Location names.
    redirect: 'error',
    signal: combinedSignal,
    });
  } finally {
    // The caller's signal belongs to a whole turn; do not keep a listener on it.
    composed?.cleanup();
  }
  const buf = Buffer.from(await resp.arrayBuffer());

  if (!resp.ok) {
    // The body is not echoed. A Connect error here can quote the request, and
    // the request contains the api_key; this message reaches CLI output, the
    // adapter's error event, and /api/logs.
    throw new CloudAuthError(`GetUserJwt failed (HTTP ${resp.status})`, resp.status);
  }

  // Response is GetUserJwtResponse { user_jwt: string } where user_jwt is
  // field 1, length-delimited. Decode the field properly instead of
  // regex-scanning the whole buffer — the previous regex would pick up
  // any JWT-shaped substring in the response (trace IDs, signature
  // headers, any cached token inadvertently logged) and could even land
  // on a non-user_jwt if Cognition ever embeds another JWT in a sibling
  // field.
  let jwt: string | null = null;
  for (const f of iterFields(buf)) {
    if (f.num === 1 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      const s = (f.value as Buffer).toString('utf8');
      // Sanity-check the shape — defensive: if the cloud ever moves user_jwt
      // out from field 1 we want a clean error, not silently wrong creds.
      // base64url with OPTIONAL `=` padding on each segment. Most modern
      // JWTs omit the `=`, but the spec allows it and a future server-side
      // change could re-introduce it; either way it's still a valid token.
      if (/^eyJ[A-Za-z0-9_-]{10,}={0,2}\.[A-Za-z0-9_-]+={0,2}\.[A-Za-z0-9_-]+={0,2}$/.test(s)) {
        jwt = s;
        break;
      }
    }
  }
  if (!jwt) {
    throw new CloudAuthError(
      // Same reason: a 200 whose field-1 value failed the shape check may still
      // be a live token, so only the size is reported.
      `GetUserJwt returned 200 without a usable field-1 JWT (${buf.length} bytes)`,
    );
  }

  // Decode the payload to get the expiry.
  let expiresAt = Math.floor(Date.now() / 1000) + 600;   // fallback: 10 min
  try {
    const parts = jwt.split('.');
    const pad = (s: string) => s + '='.repeat((4 - (s.length % 4)) % 4);
    const payload = JSON.parse(
      Buffer.from(pad(parts[1]).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
    if (typeof payload.exp === 'number') expiresAt = payload.exp;
  } catch { /* fall back to default */ }

  return { jwt, expiresAt };
}

// ----------------------------------------------------------------------------
// In-memory cache — refresh ~60s before expiry
// ----------------------------------------------------------------------------

interface CacheEntry {
  jwt: string;
  expiresAt: number;
  apiKey: string;
  host: string;
}

/**
 * Cache is keyed by (apiKey, host). A single shared `cache` slot only holds
 * the MOST RECENTLY USED entry — common case is one account at a time, so
 * a single slot is enough. inFlight is a per-key map so a JWT mint for
 * account A doesn't get returned to a concurrent request for account B.
 *
 * Previously `inFlight` was a singleton — if account A's mint was in flight
 * and a request for account B arrived, B got A's JWT. That's the M1
 * "concurrent requests after account switch get wrong JWT" bug.
 */
let cache: CacheEntry | null = null;
const inFlight = new Map<string, Promise<MintedUserJwt>>();
/**
 * Monotonic epoch counter. Incremented on every `clearCachedUserJwt()`
 * call so an in-flight mint that started BEFORE the clear can't
 * repopulate the cache after-the-fact. Without this, a logout that
 * happened concurrently with a mint would silently get its just-
 * invalidated JWT cached and served for the next ~24 minutes.
 */
let cacheEpoch = 0;

function flightKey(apiKey: string, host: string): string {
  return `${host}\x1f${apiKey}`;
}

/**
 * Get a cached user_jwt or mint a new one. Refreshes when the cached JWT is
 * within 60s of expiry. Multiple concurrent callers for the SAME (apiKey, host)
 * share the same in-flight mint; concurrent callers for DIFFERENT keys each
 * get their own mint.
 */
export async function getCachedUserJwt(apiKey: string, host: string = DEFAULT_HOST, signal?: AbortSignal): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cache && cache.apiKey === apiKey && cache.host === host && cache.expiresAt > now + 60) {
    return cache.jwt;
  }
  // Race the caller's signal against the shared promise so one caller's
  // cancellation doesn't propagate to unrelated callers sharing the mint.
  // mintUserJwt has its own MINT_TIMEOUT_MS guard for the shared lifetime.
  const raceSignal = <T>(p: Promise<T>): Promise<T> =>
    signal
      ? Promise.race([
          p,
          new Promise<T>((_, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
        ])
      : p;
  const key = flightKey(apiKey, host);
  const existing = inFlight.get(key);
  if (existing) {
    const minted = await raceSignal(existing);
    return minted.jwt;
  }
  const promise = mintUserJwt(apiKey, host);
  inFlight.set(key, promise);
  // Snapshot the epoch BEFORE awaiting the mint. If clearCachedUserJwt()
  // fires while we're awaiting (logout-during-mint), the epoch changes
  // and we won't repopulate the cache with the just-invalidated JWT.
  const epochAtStart = cacheEpoch;
  try {
    const minted = await raceSignal(promise);
    if (cacheEpoch === epochAtStart) {
      cache = { jwt: minted.jwt, expiresAt: minted.expiresAt, apiKey, host };
    }
    return minted.jwt;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Drop the in-memory JWT cache. Call after credential changes (logout,
 * account switch) so long-running opencode processes don't keep using a
 * JWT minted from a now-invalid api_key. Also bumps the cache epoch so
 * any in-flight mint racing with this clear can't repopulate cache
 * with the stale JWT after-the-fact.
 */
export function clearCachedUserJwt(): void {
  cache = null;
  inFlight.clear();
  cacheEpoch++;
}
