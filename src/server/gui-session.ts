import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { OcxConfig } from "../types";
import { canonicalGuiBrowserOrigin } from "../lib/gui-pair-capability";
import {
  isAllowedManagementOrigin,
  isApiAuthRequired,
  isLoopbackHostname,
  managementRequestOrigin,
  parseHttpHost,
} from "./auth-cors";

export type GuiSessionIssuance =
  | "loopback"
  | "tailscale-identity"
  | "pairing";

export interface GuiSessionRecord {
  serverOrigin: string;
  browserOrigin: string;
  csrfToken: string;
  expiresAt: number;
  issuance: GuiSessionIssuance;
}

export interface GuiSessionBootstrap extends GuiSessionRecord {
  token: string;
}

export interface GuiPairingGrantRecord {
  serverOrigin: string;
  browserOrigin: string;
  expiresAt: number;
  failedAttempts?: number;
}

export interface PairingAttemptContext {
  ingress: "public" | "hub-management";
  peerAddress: string | null;
  tailscaleUser: string | null;
  browserOrigin: string;
}

export type PairingAttemptResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; reason: "grant" | "source" | "capacity" };
type PairingAttemptRefusal = Extract<PairingAttemptResult, { allowed: false }>;

export interface GuiSessionState {
  sessions: Map<string, GuiSessionRecord>;
  pairingGrants: Map<string, GuiPairingGrantRecord>;
}

export interface GuiSessionRequestContext {
  trustedTailscaleIngress: boolean;
  now?: number;
}

export type GuiSessionAdmission =
  | { ok: true; principal: "gui-session"; session: GuiSessionRecord }
  | { ok: false; reason: "missing" | "expired" | "server-origin" | "browser-origin" | "csrf" };

export const LOOPBACK_GUI_SESSION_TTL_MS = 5 * 60_000;
export const REMOTE_GUI_SESSION_TTL_MS = 12 * 60 * 60_000;
export const GUI_PAIRING_GRANT_TTL_MS = 5 * 60_000;
export const GUI_SESSION_LIMIT = 128;
export const GUI_PAIRING_GRANT_LIMIT = 128;
export const GUI_PAIRING_GRANT_RATE_LIMIT = 8;
export const GUI_PAIRING_GRANT_RATE_WINDOW_MS = 60_000;

const pairingGrantCreations = new WeakMap<GuiSessionState, number[]>();
const pairingSourceAttempts = new WeakMap<GuiSessionState, Map<string, { failures: number; windowStartedAt: number }>>();
const PAIRING_SOURCE_WINDOW_MS = 10 * 60_000;
const PAIRING_SOURCE_FAILURE_LIMIT = 10;
const PAIRING_SOURCE_LIMIT = 1_024;
const PAIRING_GRANT_FAILURE_LIMIT = 5;

export class GuiPairingGrantRateLimitError extends Error {
  constructor() {
    super("GUI pairing grant rate limit exceeded");
    this.name = "GuiPairingGrantRateLimitError";
  }
}

function equalSecret(actual: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(actual);
  const right = encoder.encode(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function canonicalHttpOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function isRemoteGuiBrowserOriginAllowed(browserOrigin: string, config: OcxConfig): boolean {
  const canonical = canonicalGuiBrowserOrigin(browserOrigin);
  if (!canonical || canonical !== browserOrigin) return false;
  const publicOrigin = canonicalHttpOrigin(config.hub?.managementPublicOrigin);
  if (publicOrigin === canonical) return true;
  return (config.corsAllowOrigins ?? []).some(value => canonicalGuiBrowserOrigin(value) === canonical);
}

function pruneExpired(state: GuiSessionState, now: number): void {
  for (const [token, session] of state.sessions) {
    if (session.expiresAt <= now) state.sessions.delete(token);
  }
  for (const [digest, grant] of state.pairingGrants) {
    if (grant.expiresAt <= now) state.pairingGrants.delete(digest);
  }
}

function evictOldestSession(state: GuiSessionState): void {
  while (state.sessions.size >= GUI_SESSION_LIMIT) {
    const oldest = state.sessions.keys().next().value as string | undefined;
    if (!oldest) return;
    state.sessions.delete(oldest);
  }
}

function mintSession(
  serverOrigin: string,
  browserOrigin: string,
  issuance: GuiSessionIssuance,
  state: GuiSessionState,
  now: number,
): GuiSessionBootstrap {
  pruneExpired(state, now);
  evictOldestSession(state);
  let token: string;
  do {
    token = `ocx_session_${randomBytes(32).toString("base64url")}`;
  } while (state.sessions.has(token));
  const session: GuiSessionRecord = {
    serverOrigin,
    browserOrigin,
    csrfToken: randomBytes(32).toString("base64url"),
    expiresAt: now + (issuance === "loopback" ? LOOPBACK_GUI_SESSION_TTL_MS : REMOTE_GUI_SESSION_TTL_MS),
    issuance,
  };
  state.sessions.set(token, session);
  return {
    token,
    serverOrigin: session.serverOrigin,
    browserOrigin: session.browserOrigin,
    csrfToken: session.csrfToken,
    issuance: session.issuance,
    get expiresAt() { return session.expiresAt; },
    set expiresAt(value) { session.expiresAt = value; },
  };
}

function tailscaleLoginAllowed(req: Request, config: OcxConfig): boolean {
  const login = req.headers.get("Tailscale-User-Login");
  if (!login) return false;
  return (config.remoteGui?.allowedTailscaleUsers ?? []).some(user => user === login);
}

export function issueGuiSession(
  req: Request,
  config: OcxConfig,
  state: GuiSessionState,
  context: GuiSessionRequestContext = { trustedTailscaleIngress: false },
): GuiSessionBootstrap | null {
  if (req.method !== "GET") return null;
  const host = parseHttpHost(req.headers.get("Host"));
  if (!host) return null;
  const now = context.now ?? Date.now();

  if (!isApiAuthRequired(config)) {
    if (!isLoopbackHostname(host.hostname) || !isAllowedManagementOrigin(req, config)) return null;
    const origin = managementRequestOrigin(req, config);
    return origin ? mintSession(origin, origin, "loopback", state, now) : null;
  }

  if (
    config.runtimeRole !== "hub"
    || !context.trustedTailscaleIngress
    || !tailscaleLoginAllowed(req, config)
    || !isAllowedManagementOrigin(req, config)
  ) return null;
  const serverOrigin = managementRequestOrigin(req, config);
  if (!serverOrigin || new URL(serverOrigin).protocol !== "https:") return null;
  const browserOrigin = canonicalGuiBrowserOrigin(req.headers.get("Origin") ?? serverOrigin);
  if (!browserOrigin || !isRemoteGuiBrowserOriginAllowed(browserOrigin, config)) return null;
  return mintSession(serverOrigin, browserOrigin, "tailscale-identity", state, now);
}

function pairingGrantDigest(grant: string): string {
  return createHash("sha256").update(grant).digest("base64url");
}

function pairingSourceKey(context: PairingAttemptContext): string {
  const identity = context.ingress === "hub-management" && context.tailscaleUser
    ? `tailscale:${context.tailscaleUser}`
    : context.peerAddress
      ? `peer:${context.peerAddress}`
      : "anonymous";
  return createHash("sha256").update(identity).digest("base64url");
}

function recordSourceFailure(
  state: GuiSessionState,
  context: PairingAttemptContext,
  now: number,
): PairingAttemptResult {
  let attempts = pairingSourceAttempts.get(state);
  if (!attempts) {
    attempts = new Map();
    pairingSourceAttempts.set(state, attempts);
  }
  for (const [key, record] of attempts) {
    if (record.windowStartedAt + PAIRING_SOURCE_WINDOW_MS <= now) attempts.delete(key);
  }
  const key = pairingSourceKey(context);
  let record = attempts.get(key);
  if (!record) {
    if (attempts.size >= PAIRING_SOURCE_LIMIT) {
      return { allowed: false, retryAfterSeconds: 1, reason: "capacity" };
    }
    record = { failures: 0, windowStartedAt: now };
    attempts.set(key, record);
  }
  record.failures += 1;
  if (record.failures < PAIRING_SOURCE_FAILURE_LIMIT) return { allowed: true };
  const remaining = Math.max(1, record.windowStartedAt + PAIRING_SOURCE_WINDOW_MS - now);
  return { allowed: false, retryAfterSeconds: Math.ceil(remaining / 1000), reason: "source" };
}

function findPairingGrant(
  grant: string,
  state: GuiSessionState,
): [string, GuiPairingGrantRecord] | null {
  const digest = pairingGrantDigest(grant);
  for (const [candidate, record] of state.pairingGrants) {
    if (equalSecret(candidate, digest)) return [candidate, record];
  }
  return null;
}

function consumeGrantRateSlot(state: GuiSessionState, now: number): void {
  const recent = (pairingGrantCreations.get(state) ?? [])
    .filter(createdAt => createdAt > now - GUI_PAIRING_GRANT_RATE_WINDOW_MS);
  if (recent.length >= GUI_PAIRING_GRANT_RATE_LIMIT) throw new GuiPairingGrantRateLimitError();
  recent.push(now);
  pairingGrantCreations.set(state, recent);
}

export function createGuiPairingGrant(
  browserOrigin: string,
  config: OcxConfig,
  state: GuiSessionState,
  now = Date.now(),
): { grant: string; browserOrigin: string; serverOrigin: string; expiresAt: number } {
  const canonicalBrowserOrigin = canonicalGuiBrowserOrigin(browserOrigin);
  const serverOrigin = canonicalHttpOrigin(config.hub?.managementPublicOrigin);
  if (
    config.runtimeRole !== "hub"
    || !canonicalBrowserOrigin
    || canonicalBrowserOrigin !== browserOrigin
    || !serverOrigin
    || !isRemoteGuiBrowserOriginAllowed(canonicalBrowserOrigin, config)
  ) throw new TypeError("remote GUI origin is not allowed");
  pruneExpired(state, now);
  consumeGrantRateSlot(state, now);
  if (state.pairingGrants.size >= GUI_PAIRING_GRANT_LIMIT) throw new GuiPairingGrantRateLimitError();
  let grant: string;
  let digest: string;
  do {
    grant = `ocx_pair_${randomBytes(32).toString("base64url")}`;
    digest = pairingGrantDigest(grant);
  } while (state.pairingGrants.has(digest));
  const expiresAt = now + GUI_PAIRING_GRANT_TTL_MS;
  state.pairingGrants.set(digest, { browserOrigin: canonicalBrowserOrigin, serverOrigin, expiresAt });
  return { grant, browserOrigin: canonicalBrowserOrigin, serverOrigin, expiresAt };
}

function strictPairingGrantBody(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.grant !== "string") return null;
  return /^ocx_pair_[A-Za-z0-9_-]{43}$/.test(record.grant) ? record.grant : null;
}

function hasAlternateCredential(req: Request): boolean {
  return req.headers.has("authorization")
    || req.headers.has("x-opencodex-api-key")
    || req.headers.has("x-api-key");
}

export function consumeGuiPairingGrant(
  req: Request,
  body: unknown,
  config: OcxConfig,
  state: GuiSessionState,
  now?: number,
): GuiSessionBootstrap | null;
export function consumeGuiPairingGrant(
  req: Request,
  body: unknown,
  config: OcxConfig,
  state: GuiSessionState,
  now: number,
  attemptContext: PairingAttemptContext,
): GuiSessionBootstrap | PairingAttemptRefusal | null;
export function consumeGuiPairingGrant(
  req: Request,
  body: unknown,
  config: OcxConfig,
  state: GuiSessionState,
  now = Date.now(),
  attemptContext?: PairingAttemptContext,
): GuiSessionBootstrap | PairingAttemptRefusal | null {
  if (req.method !== "POST" || hasAlternateCredential(req) || config.runtimeRole !== "hub") return null;
  // Scheme check FIRST, before the grant is parsed or looked up.
  //
  // A grant is single-use, so consuming one and then refusing to mint would burn the
  // operator's code on a request that was never going to succeed — an unauthenticated
  // caller could strip TLS termination and spend every code the operator prints. Refusing
  // here leaves the grant intact for a later request over a scheme that can carry it.
  //
  // There is no opt-in for plaintext. An earlier revision allowed non-loopback HTTP when
  // `remoteGui.allowInsecureHttp` was true; a reusable grant on plaintext HTTP is readable
  // by anything on the path and the session it mints is reusable, so the flag recorded a
  // risk the operator could not bound rather than controlling one.
  const destination = managementRequestOrigin(req, config);
  if (!destination || !isPairingTransportPermitted(destination)) return null;
  const grant = strictPairingGrantBody(body);
  const browserOrigin = canonicalGuiBrowserOrigin(req.headers.get("Origin"));
  if (!grant || !browserOrigin) return null;
  const context = attemptContext ?? {
    ingress: "public",
    peerAddress: null,
    tailscaleUser: null,
    browserOrigin,
  };
  // Source throttling is only a cost bound for invalid guesses. Look up the grant
  // first so callers sharing a proxy address cannot lock out a valid redemption.
  const found = findPairingGrant(grant, state);
  if (!found) {
    // Cross-origin browser requests must not create limiter state as a side effect.
    if (!isRemoteGuiBrowserOriginAllowed(browserOrigin, config)) return null;
    const source = recordSourceFailure(state, context, now);
    return attemptContext && !source.allowed ? source : null;
  }
  const [digest, record] = found;
  if (record.expiresAt <= now) {
    state.pairingGrants.delete(digest);
    return null;
  }
  if (browserOrigin !== record.browserOrigin) {
    record.failedAttempts = (record.failedAttempts ?? 0) + 1;
    const source = recordSourceFailure(state, context, now);
    if (record.failedAttempts >= PAIRING_GRANT_FAILURE_LIMIT) {
      state.pairingGrants.delete(digest);
      return attemptContext ? { allowed: false, retryAfterSeconds: 1, reason: "grant" } : null;
    }
    return attemptContext && !source.allowed ? source : null;
  }
  const serverOrigin = managementRequestOrigin(req, config);
  if (serverOrigin !== record.serverOrigin) return null;
  // Re-checked against the grant's own recorded origin rather than only the request's:
  // the two are compared just above, but this keeps the transport rule true of the value
  // the session is actually minted from.
  if (!isPairingTransportPermitted(record.serverOrigin)) return null;
  state.pairingGrants.delete(digest);
  return mintSession(record.serverOrigin, record.browserOrigin, "pairing", state, now);
}

/**
 * A pairing grant may cross loopback or authenticated HTTPS, and nothing else.
 *
 * Loopback plaintext is admissible because the bytes never leave the machine. Non-loopback
 * plaintext is not, and no configuration re-opens it.
 */
function isPairingTransportPermitted(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHostname(url.hostname);
}

function requestCredential(req: Request): string | null {
  return req.headers.get("x-opencodex-api-key")?.trim()
    || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim()
    || null;
}

function findSession(
  credential: string,
  state: GuiSessionState,
): [string, GuiSessionRecord] | null {
  for (const [token, session] of state.sessions) {
    if (equalSecret(credential, token)) return [token, session];
  }
  return null;
}

export function authorizeGuiSessionRequest(
  req: Request,
  config: OcxConfig,
  state: GuiSessionState,
  now = Date.now(),
): GuiSessionAdmission {
  const credential = requestCredential(req);
  if (!credential) return { ok: false, reason: "missing" };
  const found = findSession(credential, state);
  if (!found) return { ok: false, reason: "missing" };
  const [token, session] = found;
  if (session.expiresAt <= now) {
    state.sessions.delete(token);
    return { ok: false, reason: "expired" };
  }
  if (managementRequestOrigin(req, config) !== session.serverOrigin) {
    return { ok: false, reason: "server-origin" };
  }
  const claimedBrowserOrigin = req.headers.get("x-opencodex-gui-origin");
  const browserOrigin = req.headers.get("Origin");
  const safeMethod = req.method === "GET" || req.method === "HEAD";
  if (
    claimedBrowserOrigin !== session.browserOrigin
    || (browserOrigin !== null && browserOrigin !== session.browserOrigin)
    || (!safeMethod && browserOrigin !== session.browserOrigin)
  ) return { ok: false, reason: "browser-origin" };
  if (!safeMethod) {
    const csrf = req.headers.get("x-opencodex-csrf-token")?.trim();
    if (!csrf || !equalSecret(csrf, session.csrfToken)) return { ok: false, reason: "csrf" };
  }
  if (session.issuance !== "loopback") session.expiresAt = now + REMOTE_GUI_SESSION_TTL_MS;
  return { ok: true, principal: "gui-session", session };
}
