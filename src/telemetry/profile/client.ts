import { signalWithTimeout } from "../../lib/abort";
import { parseCalendarUtcDayMs } from "../contract";
import {
  PROFILE_SECRET_RE,
  parseProfileRankV1,
  type ProfileCreateV1,
  type ProfileDayV1,
  type ProfileRankV1,
  type PublicProfileV1,
} from "./contract";

/** Collector base for profile calls. A constant, like the anonymous endpoint; not configurable. */
export const TELEMETRY_PROFILE_API_BASE = "https://telemetry.opencodex.me";
export const TELEMETRY_PROFILE_TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_MS = 7 * 86_400_000;
const DEFAULT_RETRY_AFTER_MS = 15 * 60 * 1000;

export interface ProfileClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type ProfileCallResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status?: number; error: string; code?: string; retryAfterMs?: number };

let testOverrides: ProfileClientOptions | null = null;

export function setProfileClientOverridesForTests(overrides: ProfileClientOptions | null): void {
  testOverrides = overrides;
}

function retryAfterMs(header: string | null | undefined): number {
  const trimmed = header?.trim() ?? "";
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (seconds > 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  return DEFAULT_RETRY_AFTER_MS;
}

async function call<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  options: ProfileClientOptions,
  init: { secret?: string; body?: unknown } = {},
): Promise<ProfileCallResult<T>> {
  const base = options.baseUrl ?? testOverrides?.baseUrl ?? TELEMETRY_PROFILE_API_BASE;
  const fetchImpl = options.fetch ?? testOverrides?.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? testOverrides?.timeoutMs ?? TELEMETRY_PROFILE_TIMEOUT_MS;
  const deadline = signalWithTimeout(timeoutMs, options.signal ?? testOverrides?.signal);
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.secret !== undefined) headers.authorization = `Bearer ${init.secret}`;
  try {
    const response = await fetchImpl(new URL(path, base).toString(), {
      method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: deadline.signal,
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const error = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `collector responded ${response.status}`;
      const code = body && typeof body === "object" && typeof (body as { code?: unknown }).code === "string"
        ? (body as { code: string }).code
        : undefined;
      return {
        ok: false,
        status: response.status,
        error,
        ...(code ? { code } : {}),
        ...(response.status === 429 || response.status === 503
          ? { retryAfterMs: retryAfterMs(response.headers?.get?.("retry-after")) }
          : {}),
      };
    }
    return { ok: true, status: response.status, body: body as T };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    deadline.cleanup();
  }
}

export interface CreatedProfile {
  profile: PublicProfileV1;
  secret: string;
  /** The collector's own creation day; only later days are accepted, so it is the client's floor too. */
  createdDay: string | null;
}

export async function createProfile(
  body: ProfileCreateV1,
  options: ProfileClientOptions = {},
): Promise<ProfileCallResult<CreatedProfile>> {
  const result = await call<{ profile?: PublicProfileV1; secret?: unknown; createdDay?: unknown }>("POST", "/v1/profiles", options, { body });
  if (!result.ok) return result;
  const secret = result.body?.secret;
  const profile = result.body?.profile;
  if (typeof secret !== "string" || !PROFILE_SECRET_RE.test(secret) || !profile || typeof profile.handle !== "string") {
    return { ok: false, status: result.status, error: "collector returned an invalid profile" };
  }
  const rawDay = result.body?.createdDay;
  const createdDay = typeof rawDay === "string" && parseCalendarUtcDayMs(rawDay) !== null ? rawDay : null;
  return { ok: true, status: result.status, body: { profile, secret, createdDay } };
}

export async function submitProfileDay(
  secret: string,
  day: ProfileDayV1,
  options: ProfileClientOptions = {},
): Promise<ProfileCallResult<{ deduplicated?: boolean }>> {
  return call("POST", "/v1/profiles/me/days", options, { secret, body: day });
}

export async function fetchOwnProfileRank(
  secret: string,
  options: ProfileClientOptions = {},
): Promise<ProfileCallResult<ProfileRankV1>> {
  const result = await call<unknown>("GET", "/v1/profiles/me", options, { secret });
  if (!result.ok) return result;
  const rank = parseProfileRankV1(result.body);
  if (!rank) return { ok: false, status: result.status, error: "collector returned an invalid rank" };
  return { ok: true, status: result.status, body: rank };
}

/**
 * Delete the profile and every row submitted for it. A 401 also counts as deleted: the collector
 * no longer knows the secret, so nothing remains to delete.
 */
export async function deleteProfile(
  secret: string,
  options: ProfileClientOptions = {},
): Promise<{ deleted: boolean; error?: string; retryAfterMs?: number }> {
  const result = await call<{ deleted?: boolean }>("DELETE", "/v1/profiles/me", options, { secret });
  if (result.ok) return { deleted: true };
  if (result.status === 401) return { deleted: true };
  return { deleted: false, error: result.error, ...(result.retryAfterMs ? { retryAfterMs: result.retryAfterMs } : {}) };
}

