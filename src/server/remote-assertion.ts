import { createHash, createPublicKey, verify } from "node:crypto";
import type { OcxConfig } from "../types";

export const REMOTE_ASSERTION_HEADER = "x-opencodex-remote-assertion";
export const REMOTE_ASSERTION_AUDIENCE = "opencodex-management";

const MAX_ASSERTION_BYTES = 8 * 1024;
const MAX_ASSERTION_LIFETIME_SECONDS = 30;
const CLOCK_SKEW_SECONDS = 5;
const REPLAY_LIMIT = 4096;

interface RemoteAssertionHeader {
  alg: "EdDSA";
  typ: "JWT";
  kid: string;
}

interface RemoteAssertionClaims {
  iss: string;
  aud: string;
  instance_id: string;
  user_id: string;
  method: string;
  path_sha256: string;
  iat: number;
  exp: number;
  jti: string;
}

const seenAssertions = new Map<string, number>();

function decodeJsonSegment<T>(segment: string): T | null {
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as T : null;
  } catch {
    return null;
  }
}

/**
 * Canonicalize only the path/query that the gateway and local proxy are
 * permitted to preserve. Sorting URLSearchParams makes equivalent query order
 * produce one digest while URL parsing normalizes percent encoding.
 */
export function remoteAssertionPathHash(input: string | URL): string {
  const url = input instanceof URL ? new URL(input) : new URL(input, "http://opencodex.invalid");
  url.searchParams.sort();
  const canonical = `${url.pathname}${url.search}`;
  return createHash("sha256").update(canonical).digest("hex");
}

function isSafeIdentifier(value: unknown, maxLength = 128): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isRemoteAssertionShape(
  header: RemoteAssertionHeader | null,
  claims: RemoteAssertionClaims | null,
): header is RemoteAssertionHeader {
  return !!header && !!claims
    && header.alg === "EdDSA"
    && header.typ === "JWT"
    && isSafeIdentifier(header.kid, 64)
    && isSafeIdentifier(claims.iss)
    && claims.aud === REMOTE_ASSERTION_AUDIENCE
    && isSafeIdentifier(claims.instance_id)
    && isSafeIdentifier(claims.user_id)
    && typeof claims.method === "string"
    && /^[A-Z]+$/.test(claims.method)
    && typeof claims.path_sha256 === "string"
    && /^[a-f0-9]{64}$/.test(claims.path_sha256)
    && Number.isInteger(claims.iat)
    && Number.isInteger(claims.exp)
    && isSafeIdentifier(claims.jti, 128);
}

function consumeJti(jti: string, exp: number, nowSeconds: number): boolean {
  for (const [seenJti, seenExp] of seenAssertions) {
    if (seenExp + CLOCK_SKEW_SECONDS < nowSeconds) seenAssertions.delete(seenJti);
  }
  if (seenAssertions.has(jti)) return false;
  while (seenAssertions.size >= REPLAY_LIMIT) {
    const oldest = seenAssertions.keys().next().value as string | undefined;
    if (!oldest) break;
    seenAssertions.delete(oldest);
  }
  seenAssertions.set(jti, exp);
  return true;
}

export function verifyRemoteManagementAssertion(
  req: Request,
  config: OcxConfig,
  now = Date.now(),
): boolean {
  const remote = config.remoteAccess;
  if (!remote?.enabled) return false;
  const token = req.headers.get(REMOTE_ASSERTION_HEADER)?.trim();
  if (!token || token.length > MAX_ASSERTION_BYTES) return false;
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some(segment => !segment)) return false;

  const header = decodeJsonSegment<RemoteAssertionHeader>(segments[0]);
  const claims = decodeJsonSegment<RemoteAssertionClaims>(segments[1]);
  if (!isRemoteAssertionShape(header, claims) || !claims) return false;
  if (claims.iss !== remote.issuer || claims.instance_id !== remote.instanceId) return false;
  if (claims.method !== req.method.toUpperCase()) return false;
  if (claims.path_sha256 !== remoteAssertionPathHash(req.url)) return false;

  const nowSeconds = Math.floor(now / 1000);
  if (claims.iat > nowSeconds + CLOCK_SKEW_SECONDS || claims.exp < nowSeconds - CLOCK_SKEW_SECONDS) return false;
  if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_ASSERTION_LIFETIME_SECONDS) return false;

  const configuredKey = remote.publicKeys.find(key => key.kid === header.kid);
  if (!configuredKey) return false;
  try {
    const signingInput = Buffer.from(`${segments[0]}.${segments[1]}`, "ascii");
    const signature = Buffer.from(segments[2], "base64url");
    const valid = verify(null, signingInput, createPublicKey(configuredKey.publicKeyPem), signature);
    return valid && consumeJti(claims.jti, claims.exp, nowSeconds);
  } catch {
    return false;
  }
}

/** Test-only reset; exported explicitly to keep replay tests deterministic. */
export function resetRemoteAssertionReplayCacheForTest(): void {
  seenAssertions.clear();
}
