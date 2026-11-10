import { computeHourlyIpHash, formatBucketHour, rateLimitClientKey } from "./ingest";
import type { CollectorEnv } from "./types";

/** Shared helpers for the opt-in profile endpoints. */

const HOUR_MS = 3_600_000;
/** Shared-cache lifetime of public profile reads; also the longest a maintainer's hide can take to show. */
export const PUBLIC_PROFILE_MAX_AGE_SECONDS = 60;

export const PROFILE_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "x-robots-tag": "noindex",
});

export function profileJson(
  body: Record<string, unknown>,
  status: number,
  cache: "no-store" | "public" = "no-store",
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...PROFILE_RESPONSE_HEADERS,
      "cache-control": cache === "public" ? `public, max-age=${PUBLIC_PROFILE_MAX_AGE_SECONDS}` : "no-store",
      ...extraHeaders,
    },
  });
}

export function profileError(status: number, error: string, extraHeaders: Record<string, string> = {}): Response {
  return profileJson({ ok: false, error }, status, "no-store", extraHeaders);
}

export function readSalt(env: CollectorEnv): string | null {
  const salt = typeof env.RATE_LIMIT_SALT === "string" ? env.RATE_LIMIT_SALT.trim() : "";
  return salt.length > 0 ? salt : null;
}

export type ProfileRateScope = "create" | "submit" | "me" | "delete" | "read";

/**
 * Count one hit against an hourly limit. Keys are hashed with a "profile:<scope>" domain prefix and
 * stored only in profile_rate_limits, so no value here ever equals an anonymous ingest ip_hash.
 * Returns a 429 response when the limit is reached, otherwise null.
 */
export async function consumeProfileRateLimit(
  env: CollectorEnv,
  salt: string,
  scope: ProfileRateScope,
  key: string,
  limit: number,
  now: number,
): Promise<Response | null> {
  const bucketHour = formatBucketHour(now);
  const keyHash = await computeHourlyIpHash(salt, `profile:${scope}\0${key}`, bucketHour);
  const result = await env.DB
    .prepare(
      "INSERT INTO profile_rate_limits (bucket_hour, scope, key_hash, hits) VALUES (?1, ?2, ?3, 1) " +
      "ON CONFLICT(bucket_hour, scope, key_hash) DO UPDATE SET hits = hits + 1 WHERE profile_rate_limits.hits < ?4",
    )
    .bind(bucketHour, scope, keyHash, limit)
    .run();
  if (Number(result.meta?.changes ?? 0) > 0) return null;
  const nextHourMs = (Math.floor(now / HOUR_MS) + 1) * HOUR_MS;
  const retryAfterSeconds = Math.max(1, Math.ceil((nextHourMs - now) / 1000));
  return profileError(429, "rate limit exceeded", { "retry-after": String(retryAfterSeconds) });
}

export function clientKey(request: Request): string {
  return `client:${rateLimitClientKey(request)}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) hex += view[i]!.toString(16).padStart(2, "0");
  return hex;
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Read at most `maxBytes` of JSON. Returns the parsed value or an error response. */
export async function readJsonBody(request: Request, maxBytes: number): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(contentType.trim())) {
    return { ok: false, response: profileError(400, "content-type must be application/json") };
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared.trim()) || Number(declared.trim()) > maxBytes)) {
    return { ok: false, response: profileError(413, "request body is too large") };
  }
  if (!request.body) return { ok: false, response: profileError(400, "request body is empty") };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* size limit already exceeded */ }
      return { ok: false, response: profileError(413, "request body is too large") };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false, response: profileError(400, "invalid JSON body") };
  }
}

