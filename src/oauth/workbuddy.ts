import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { WORKBUDDY_PROFILE, workBuddyHeaderValue, workBuddyHeaders, type WorkBuddyProfile } from "../providers/workbuddy";
import type { OAuthController, OAuthCredentials, WorkBuddyOAuthMetadata } from "./types";

type Json = Record<string, unknown>;
function record(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

export class WorkBuddyApiError extends Error {
  constructor(readonly status: number, readonly code: number, label = WORKBUDDY_PROFILE.label) {
    super(`${label} request failed (HTTP ${status}, code ${code})`);
  }
}

/** Fixed-origin, bounded reads; upstream error/profile text never enters diagnostics. */
export async function workBuddyApi(
  path: string, headers: Record<string, string>, signal?: AbortSignal, post = false, payload: Json = {},
  profile: WorkBuddyProfile = WORKBUDDY_PROFILE, origin = profile.origin,
): Promise<Json> {
  const label = profile.label;
  const timeout = AbortSignal.timeout(15_000);
  const boundedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(`${origin}${path}`, {
    method: post ? "POST" : "GET", redirect: "error", signal: boundedSignal,
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": profile.identity["User-Agent"], ...headers },
    ...(post ? { body: JSON.stringify(payload) } : {}),
  }).catch(() => {
    signal?.throwIfAborted();
    throw new Error(`${label} request unavailable`);
  });
  const body = await readBoundedResponseBody(response, {
    signal: boundedSignal, maxBytes: 256 * 1024, totalTimeoutMs: 15_000, inactivityTimeoutMs: 15_000, fatalUtf8: true,
  }).catch(() => {
    signal?.throwIfAborted();
    throw new Error(`${label} response unavailable`);
  });
  let env: Json;
  try {
    if (body.oversized || body.truncated || !body.displaySafe) throw new Error();
    env = record(JSON.parse(body.text));
  } catch {
    signal?.throwIfAborted();
    if (!response.ok) throw new WorkBuddyApiError(response.status, -1, label);
    throw new Error(`${label} returned an invalid response`);
  }
  const code = typeof env.code === "number" || typeof env.code === "string" && /^\d+$/.test(env.code)
    ? Number(env.code) : NaN;
  if (!response.ok || !Number.isFinite(code) || code !== 0) {
    throw new WorkBuddyApiError(response.status, Number.isSafeInteger(code) ? code : -1, label);
  }
  return record(env.data);
}

function expiry(got: Json, absolute: string, relative: string, fallback?: number): number | undefined {
  const at = got[absolute], seconds = got[relative];
  if (typeof at === "number" && Number.isSafeInteger(at) && at > 0) return at;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    const result = Date.now() + seconds * 1000;
    if (Number.isSafeInteger(result)) return result;
  }
  return fallback;
}
function credentials(got: Json, metadata: WorkBuddyOAuthMetadata, label: string, previous?: OAuthCredentials): OAuthCredentials {
  const access = got.accessToken;
  const refresh = got.refreshToken ?? previous?.refresh;
  const expires = expiry(got, "expiresAt", "expiresIn");
  const domain = got.domain ?? metadata.domain;
  if (!workBuddyHeaderValue(access, 32768) || !workBuddyHeaderValue(refresh, 32768)
    || !expires || expires <= Date.now() || !workBuddyHeaderValue(domain)) throw new Error(`${label} returned invalid credentials`);
  return {
    access, refresh, expires, source: "oauth",
    // A uid may belong to both a personal plan and a team; they are separate account slots.
    accountId: JSON.stringify([metadata.uid, metadata.enterpriseId ?? ""]),
    workbuddy: { ...metadata, domain,
      refreshExpiresAt: expiry(got, "refreshExpiresAt", "refreshExpiresIn", metadata.refreshExpiresAt) },
  };
}

async function poll(
  profile: WorkBuddyProfile, path: string, headers: Record<string, string>, retryCode: number, signal: AbortSignal,
): Promise<Json> {
  while (true) {
    signal.throwIfAborted();
    try {
      const result = await workBuddyApi(path, headers, signal, false, {}, profile, profile.loginOrigin);
      if (Object.keys(result).length) return result;
    } catch (error) {
      if (!(error instanceof WorkBuddyApiError) || (error.code !== retryCode && ![408, 429].includes(error.status))) throw error;
    }
    await delay(1000, undefined, { signal });
  }
}

export async function loginWorkBuddy(ctrl: OAuthController, profile: WorkBuddyProfile = WORKBUDDY_PROFILE): Promise<OAuthCredentials> {
  const label = profile.label;
  const deadline = AbortSignal.timeout(5 * 60_000);
  const signal = ctrl.signal ? AbortSignal.any([ctrl.signal, deadline]) : deadline;
  signal.throwIfAborted();
  const state = await workBuddyApi(`/v2/plugin/auth/state?platform=${profile.loginPlatform}`, {
    "X-No-Authorization": "true", "X-No-User-Id": "true",
    "X-No-Enterprise-Id": "true", "X-No-Department-Info": "true",
  }, signal, true, {}, profile, profile.loginOrigin);
  if (!workBuddyHeaderValue(state.state, 4096) || typeof state.authUrl !== "string" || state.authUrl.length > 8192) throw new Error(`${label} returned an invalid login state`);
  let url: URL;
  try { url = new URL(state.authUrl); } catch { throw new Error(`${label} returned an invalid login URL`); }
  const trusted = profile === WORKBUDDY_PROFILE ? [profile.origin, "https://www.codebuddy.ai"] : [profile.loginOrigin, profile.origin];
  if (!trusted.includes(url.origin) || url.username || url.password) throw new Error(`${label} returned an untrusted login URL`);
  url.searchParams.set("version", "2.0.0");
  url.searchParams.set("loginSessionId", randomUUID());
  ctrl.onAuth?.({ url: url.href, instructions: `Sign in to ${label} in your browser. OpenCodex will finish automatically.` });
  const query = encodeURIComponent(state.state);
  const token = await poll(profile, `/v2/plugin/auth/token?state=${query}`, {}, 11217, signal);
  if (!workBuddyHeaderValue(token.accessToken, 32768)) throw new Error(`${label} returned no access token`);
  const domain = token.domain ?? profile.defaultDomain;
  if (!workBuddyHeaderValue(domain)) throw new Error(`${label} returned an invalid account domain`);
  const headers = { Authorization: `Bearer ${token.accessToken}`, "X-Domain": domain, "X-No-User-Id": "true", "X-No-Enterprise-Id": "true" };
  const who = await poll(profile, `/v2/plugin/login/account?state=${query}`, headers, 12151, signal);
  if (!workBuddyHeaderValue(who.uid)) throw new Error(`${label} account identity unavailable`);
  let enterpriseId = who.enterpriseId;
  if (!enterpriseId && typeof who.type === "string" && who.type.toLowerCase() !== "personal") {
    const result = await workBuddyApi("/v2/plugin/accounts", headers, signal, false, {}, profile, profile.loginOrigin);
    const mine = (Array.isArray(result.accounts) ? result.accounts : []).map(record)
      .filter(a => a.uid === who.uid && workBuddyHeaderValue(a.enterpriseId));
    const same = mine.filter(a => a.type === who.type), last = mine.filter(a => a.lastLogin === true);
    enterpriseId = (same.length === 1 ? same[0] : last.length === 1 ? last[0] : mine.length === 1 ? mine[0] : undefined)?.enterpriseId;
    if (!enterpriseId) throw new Error(`${label} team identity unavailable; sign in again`);
  }
  if (enterpriseId !== undefined && enterpriseId !== "" && !workBuddyHeaderValue(enterpriseId)) throw new Error(`${label} returned an invalid team identity`);
  return credentials(token, { uid: who.uid, domain, ...(enterpriseId ? { enterpriseId: enterpriseId as string } : {}) }, label);
}

export async function refreshWorkBuddyToken(
  refresh: string, signal?: AbortSignal, previous?: OAuthCredentials, profile: WorkBuddyProfile = WORKBUDDY_PROFILE,
): Promise<OAuthCredentials> {
  const label = profile.label;
  const metadata = previous?.workbuddy;
  if (!metadata || !workBuddyHeaderValue(refresh, 32768)) throw new Error(`${label} requires a new browser login`);
  if (metadata.refreshExpiresAt && metadata.refreshExpiresAt <= Date.now()) throw new Error(`${label} refresh token expired; sign in again`);
  const headers = workBuddyHeaders(undefined, metadata, profile);
  headers["X-Refresh-Token"] = refresh;
  headers["X-Auth-Refresh-Source"] = "plugin";
  const token = await workBuddyApi("/v2/plugin/auth/token/refresh", headers, signal, true, {}, profile);
  return credentials(token, metadata, label, previous);
}
