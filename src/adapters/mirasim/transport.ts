import { createHash, randomUUID } from "node:crypto";
import type { AdapterFetchContext, AdapterRequest } from "../base";
import { createAdapterPhysicalSend } from "../physical-send";
import { credentialGeneration, getAccountSet } from "../../oauth/store";
import { mirasimClientVersion } from "../../oauth/mirasim";
import type { MirasimOAuthMetadata } from "../../oauth/types";
import { readBoundedResponseBytes } from "../../lib/bounded-body";
import {
  providerOutboundGet,
  providerOutboundPost,
  type ProviderOutboundDependencies,
} from "../../lib/provider-outbound";
import type { OcxProviderConfig } from "../../types";
import {
  createMirasimDeviceIdentity,
  sealedMirasimHeaders,
  signMirasimRequest,
} from "./crypto";

const DEVICE_SESSION_PATH = "/v1/device/session";
const TICKET_REFRESH_LEAD_MS = 2 * 60 * 1000;
const TICKET_DEFAULT_TTL_MS = 10 * 60 * 1000;
const TICKET_404_QUIET_MS = 60 * 1000;
const TICKET_501_QUIET_MS = 15 * 60 * 1000;
const MAX_CONTROL_BODY = 64 * 1024;
const INTERNAL_THREAD_HEADER = "x-opencodex-mirasim-thread";
const INTERNAL_WIRE_HEADER = "x-opencodex-mirasim-wire";
const CONTROL_PROVIDER_HEADER_NAMES = new Set(["x-mirasim-probe"]);

class MirasimRelayStatusError extends Error {
  readonly status: number;
  readonly retryAfter?: string;

  constructor(status: number, retryAfter?: string | null) {
    super(`Mirasim relay rejected device-session mint with HTTP ${status}`);
    this.name = "MirasimRelayStatusError";
    this.status = status;
    this.retryAfter = retryAfter?.trim() || undefined;
  }
}

function statusErrorResponse(error: MirasimRelayStatusError): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (error.retryAfter) headers.set("retry-after", error.retryAfter);
  return new Response(JSON.stringify({ error: "Mirasim authentication failed" }), {
    status: error.status,
    headers,
  });
}

interface StoredMirasimCredential {
  accountSlotId: string;
  accountIdentity: string;
  generation: string;
  accessToken: string;
  metadata: MirasimOAuthMetadata;
}

interface TicketAuth {
  credential: string;
  usedTicket: boolean;
}

interface TicketState {
  generation: string;
  ticket?: string;
  expiresAt?: number;
  unmintableUntil?: number;
  retryAt?: number;
  failures: number;
  lastStatus?: number;
  refusedUntil?: number;
  accessRefreshRequired?: boolean;
  mintFlight?: Promise<TicketAuth>;
  sessionId?: string;
  lastUsedAt: number;
}

type PhysicalSend = ReturnType<typeof createAdapterPhysicalSend>;

const TICKET_BACKOFF_BASE_MS = 1_000;
const TICKET_BACKOFF_MAX_MS = 30_000;
const TICKET_RETRY_MAX_MS = 15 * 60 * 1000;
const TICKET_REFUSAL_FLOOR_MS = 30_000;
const TRANSPORT_STATE_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
const TRANSPORT_STATE_MAX_ENTRIES = 128;

const transportStateCache = new Map<string, TicketState>();

function cleanMetadataValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 512 || /[\0\r\n]/.test(trimmed)) return undefined;
  return trimmed;
}

function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function relaySubAccount(accessToken: string): string | undefined {
  const claims = decodeJwtClaims(accessToken);
  for (const name of ["account_id", "accountId"]) {
    const value = claims?.[name];
    if (typeof value === "string") {
      const clean = cleanMetadataValue(value);
      if (clean) return clean;
    }
  }
  return undefined;
}

function matchingCredential(accessToken: string): StoredMirasimCredential {
  const set = getAccountSet("mirasim");
  const matches = set?.accounts.filter(account => account.credential.access === accessToken) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? "Mirasim OAuth credential changed before request dispatch; retry the request"
        : "Mirasim OAuth credential is ambiguous across account slots",
    );
  }
  const account = matches[0]!;
  const credential = account.credential;
  if (!credential.mirasim) throw new Error("Mirasim credential is missing device signing metadata");
  return {
    accountSlotId: account.id,
    accountIdentity: credential.accountId ?? account.id,
    generation: credentialGeneration(credential),
    accessToken,
    metadata: {
      ...credential.mirasim,
      // Protocol version belongs to this executable, not the persisted account snapshot.
      // Upgrades must not keep sending an obsolete client version until the user signs in again.
      clientVersion: mirasimClientVersion(),
    },
  };
}

/**
 * Stable, non-secret cache scope for one Mirasim account/device pair. Access-token rotation must
 * not invalidate roster/model capabilities, while a re-login into another account or device
 * must never inherit them. Tests and pre-dispatch serializers may use synthetic tokens that are
 * not in the store yet, so fall back to a token fingerprint only when no stored credential exists.
 */
export function mirasimCredentialCacheScope(accessToken: string): string {
  const set = getAccountSet("mirasim");
  const matches = set?.accounts.filter(account => account.credential.access === accessToken) ?? [];
  if (matches.length === 0) {
    return createHash("sha256").update(accessToken).digest("hex");
  }
  if (matches.length > 1) {
    throw new Error("Mirasim OAuth credential is ambiguous across account slots");
  }
  const account = matches[0]!;
  const metadata = account.credential.mirasim;
  if (!metadata) throw new Error("Mirasim credential is missing device signing metadata");
  const deviceId = createMirasimDeviceIdentity(metadata.devicePrivateKey).deviceId;
  return createHash("sha256")
    .update([account.id, account.credential.accountId ?? account.id, deviceId].join("\0"))
    .digest("hex");
}

function stableTransportKey(credential: StoredMirasimCredential, deviceId: string): string {
  return createHash("sha256")
    .update([credential.accountSlotId, credential.accountIdentity, deviceId].join("\0"))
    .digest("hex");
}

function transportBudgetTargetKey(credential: StoredMirasimCredential): string {
  return `mirasim:${new URL(credential.metadata.relayUrl).origin}:${credential.accountSlotId}`;
}

function pruneTransportState(now: number, keepKey: string): void {
  for (const [key, state] of transportStateCache) {
    if (key === keepKey || state.mintFlight) continue;
    if (now - state.lastUsedAt > TRANSPORT_STATE_IDLE_TTL_MS) transportStateCache.delete(key);
  }
  if (transportStateCache.size < TRANSPORT_STATE_MAX_ENTRIES) return;
  const candidates = [...transportStateCache.entries()]
    .filter(([key, state]) => key !== keepKey && !state.mintFlight)
    .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
  while (transportStateCache.size >= TRANSPORT_STATE_MAX_ENTRIES && candidates.length > 0) {
    const [key] = candidates.shift()!;
    transportStateCache.delete(key);
  }
}

function transportStateFor(
  credential: StoredMirasimCredential,
  deviceId: string,
  now = Date.now(),
): { key: string; state: TicketState } {
  const key = stableTransportKey(credential, deviceId);
  pruneTransportState(now, key);
  let state = transportStateCache.get(key);
  if (!state) {
    state = {
      generation: credential.generation,
      failures: 0,
      lastUsedAt: now,
    };
    transportStateCache.set(key, state);
  } else {
    state.lastUsedAt = now;
    if (state.generation !== credential.generation) {
      // Access/refresh tokens rotate; account/device identity and session identity do not.
      // A ticket is credential-generation scoped, so drop only ticket/refusal state.
      state.generation = credential.generation;
      state.ticket = undefined;
      state.expiresAt = undefined;
      state.retryAt = undefined;
      state.failures = 0;
      state.lastStatus = undefined;
      state.refusedUntil = undefined;
      state.accessRefreshRequired = false;
      state.mintFlight = undefined;
    }
  }
  return { key, state };
}

function resolveTicketExpiry(now: number, payload: Record<string, unknown>): number {
  const expiresIn = payload.expiresIn ?? payload.expires_in;
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    return now + Math.floor(expiresIn * 1000);
  }
  const expiresAt = payload.expiresAt ?? payload.expires_at;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) {
    const candidate = Math.floor(expiresAt * 1000);
    if (candidate > now) return candidate;
  }
  return now + TICKET_DEFAULT_TTL_MS;
}

async function boundedControlJson(
  response: Response,
  inactivityTimeoutMs?: number,
): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CONTROL_BODY) {
    try { await response.body?.cancel(); } catch { /* already closed */ }
    throw new Error("Mirasim device-session response is too large");
  }
  const bounded = await readBoundedResponseBytes(response, {
    maxBytes: MAX_CONTROL_BODY,
    ...(inactivityTimeoutMs && inactivityTimeoutMs > 0 ? { inactivityTimeoutMs } : {}),
  });
  if (bounded.oversized) throw new Error("Mirasim device-session response is too large");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bounded.bytes);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("Mirasim device-session response is invalid");
  }
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function responseHeaderDeadline(
  parent: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal | undefined; clear: () => void } {
  if (!timeoutMs || timeoutMs <= 0) return { signal: parent, clear: () => {} };
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException("Mirasim response header timeout", "TimeoutError")),
    timeoutMs,
  );
  return {
    signal: parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal,
    clear: () => clearTimeout(timer),
  };
}

function retryAfterMs(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - now);
}

function noteTicketFailure(
  state: TicketState,
  status: number,
  retryAfter: string | null,
  retryable: boolean,
  now: number,
): void {
  let delay = TICKET_BACKOFF_MAX_MS;
  if (retryable) {
    delay = Math.min(TICKET_BACKOFF_BASE_MS * (2 ** state.failures), TICKET_BACKOFF_MAX_MS);
    state.failures += 1;
  }
  delay = retryAfterMs(retryAfter, now) ?? delay;
  delay = Math.max(TICKET_BACKOFF_BASE_MS, Math.min(delay, TICKET_RETRY_MAX_MS));
  state.retryAt = now + delay;
  state.lastStatus = status;
}

function lowercaseHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  return out;
}

async function mintDeviceTicket(
  credential: StoredMirasimCredential,
  ctx: AdapterFetchContext,
  send: PhysicalSend,
): Promise<TicketAuth> {
  const identity = createMirasimDeviceIdentity(credential.metadata.devicePrivateKey);
  const { state } = transportStateFor(credential, identity.deviceId);
  const now = Date.now();

  if (state.accessRefreshRequired) {
    if (state.refusedUntil && now < state.refusedUntil) {
      throw new MirasimRelayStatusError(401);
    }
    // Give a transiently unavailable auth service a bounded escape hatch: after the refusal
    // floor expires, allow the same access token to mint a fresh ticket on a later request.
    state.accessRefreshRequired = false;
    state.refusedUntil = undefined;
  }
  if (state.ticket && state.expiresAt && now < state.expiresAt - TICKET_REFRESH_LEAD_MS) {
    return { credential: state.ticket, usedTicket: true };
  }
  if (state.unmintableUntil && now < state.unmintableUntil) {
    return { credential: credential.accessToken, usedTicket: false };
  }
  if (state.retryAt && now < state.retryAt) {
    if (state.ticket && state.expiresAt && now < state.expiresAt) {
      return { credential: state.ticket, usedTicket: true };
    }
    const retrySeconds = Math.max(1, Math.ceil((state.retryAt - now) / 1_000)).toString();
    throw new MirasimRelayStatusError(state.lastStatus ?? 503, retrySeconds);
  }
  if (state.mintFlight) return state.mintFlight;

  const generation = credential.generation;
  const flight = (async (): Promise<TicketAuth> => {
    const body = JSON.stringify({ publicKey: identity.publicKeyBase64, deviceId: identity.deviceId });
    const signed = signMirasimRequest({
      method: "POST",
      path: DEVICE_SESSION_PATH,
      deviceId: identity.deviceId,
      clientVersion: credential.metadata.clientVersion,
      credential: credential.accessToken,
      body: Buffer.from(body, "utf8"),
      privateKeyPem: identity.privateKeyPem,
    });
    const url = `${credential.metadata.relayUrl.replace(/\/$/, "")}${DEVICE_SESSION_PATH}`;
    const providerExecutor = ctx.executor as (typeof globalThis.fetch & {
      unoverriddenFetch?: typeof globalThis.fetch;
    }) | undefined;
    const physicalFetch = providerExecutor?.unoverriddenFetch;
    const response = await send({
      url,
      budgetTargetKey: transportBudgetTargetKey(credential),
      physicalFetch,
      dispatch: executor => executor(url, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${credential.accessToken}`,
          ...lowercaseHeaders(signed.headers),
        },
        body,
        signal: combineSignal(ctx.abortSignal, ctx.timeoutMs),
      }),
    });

    const observedAt = Date.now();
    if (response.status === 404 || response.status === 501) {
      try { await response.body?.cancel(); } catch { /* already closed */ }
      if (state.generation === generation) {
        state.ticket = undefined;
        state.expiresAt = undefined;
        state.retryAt = undefined;
        state.failures = 0;
        state.lastStatus = undefined;
        state.unmintableUntil = observedAt
          + (response.status === 404 ? TICKET_404_QUIET_MS : TICKET_501_QUIET_MS);
      }
      return { credential: credential.accessToken, usedTicket: false };
    }
    if (!response.ok) {
      const status = response.status;
      const retryAfter = response.headers.get("retry-after");
      try { await response.body?.cancel(); } catch { /* already closed */ }
      if (state.generation === generation) {
        noteTicketFailure(
          state,
          status,
          retryAfter,
          status === 429 || status >= 500,
          observedAt,
        );
      }
      if (state.ticket && state.expiresAt && observedAt < state.expiresAt) {
        return { credential: state.ticket, usedTicket: true };
      }
      throw new MirasimRelayStatusError(status, retryAfter);
    }

    const payload = await boundedControlJson(response, ctx.timeoutMs);
    const ticket = typeof payload.ticket === "string" ? payload.ticket.trim() : "";
    if (!ticket || ticket.length > MAX_CONTROL_BODY || /[\r\n\0]/.test(ticket)) {
      if (state.generation === generation) {
        noteTicketFailure(state, 502, null, false, observedAt);
      }
      throw new Error("Mirasim device-session response contains an invalid ticket");
    }
    const expiresAt = resolveTicketExpiry(observedAt, payload);
    if (state.generation === generation) {
      state.ticket = ticket;
      state.expiresAt = expiresAt;
      state.unmintableUntil = undefined;
      state.retryAt = undefined;
      state.failures = 0;
      state.lastStatus = undefined;
      state.accessRefreshRequired = false;
    }
    return { credential: ticket, usedTicket: true };
  })();

  state.mintFlight = flight;
  try {
    return await flight;
  } finally {
    if (state.mintFlight === flight) state.mintFlight = undefined;
  }
}

function cleanBaseHeaders(headers: Readonly<Record<string, string>>): {
  headers: Record<string, string>;
  threadId?: string;
} {
  const out: Record<string, string> = {};
  let threadId: string | undefined;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === INTERNAL_THREAD_HEADER) {
      threadId = cleanMetadataValue(value);
      continue;
    }
    if (lower === INTERNAL_WIRE_HEADER) continue;
    if (
      lower === "authorization"
      || lower === "proxy-authorization"
      || lower === "x-api-key"
      || lower.startsWith("x-mirasim-")
    ) continue;
    out[lower] = value;
  }
  return { headers: out, threadId };
}

function collectEnabled(): boolean {
  const value = process.env.MIRASIM_COLLECT?.trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off" && value !== "no";
}

function sessionId(state: TicketState, accountIdentity: string, threadId: string | undefined): string {
  if (threadId) {
    return `mirasim_${createHash("sha256")
      .update(`${accountIdentity}\0${threadId}`)
      .digest("hex")
      .slice(0, 32)}`;
  }
  if (state.sessionId) return state.sessionId;
  state.sessionId = `mirasim_${randomUUID()}`;
  return state.sessionId;
}

function inferenceMetadata(
  credential: StoredMirasimCredential,
  deviceId: string,
  requestPath: string,
  threadId?: string,
): Record<string, string> {
  const { state } = transportStateFor(credential, deviceId);
  const metadata: Record<string, string> = {
    "x-mirasim-session": sessionId(state, credential.accountIdentity, threadId),
    "x-mirasim-agent": requestPath.startsWith("/v1/responses") || requestPath.startsWith("/v1/alpha/search")
      ? "codex"
      : "claude",
    "x-mirasim-call": randomUUID(),
  };
  const account = relaySubAccount(credential.accessToken);
  if (account) metadata["x-mirasim-account"] = account;
  const locale = cleanMetadataValue(process.env.MIRASIM_LOCALE);
  if (locale) metadata["x-mirasim-locale"] = locale;
  if (!collectEnabled()) metadata["x-mirasim-collect"] = "off";
  return metadata;
}

function assertRelayTarget(url: URL, configuredRelayUrl: string): void {
  const relay = new URL(configuredRelayUrl);
  if (url.origin !== relay.origin) {
    throw new Error("Mirasim request destination does not match the credential relay origin");
  }
}

function invalidateTicket(
  credential: StoredMirasimCredential,
  deviceId: string,
): TicketState {
  const { state } = transportStateFor(credential, deviceId);
  state.ticket = undefined;
  state.expiresAt = undefined;
  return state;
}

/**
 * Mirrors the reference client's ticket-refusal floor. The first authenticated relay 401
 * invalidates the device ticket. A second refusal within the floor is evidence that the
 * account access credential, not only the ticket, must be refreshed by the outer OAuth owner.
 */
function noteTicketRefusal(
  credential: StoredMirasimCredential,
  deviceId: string,
  now = Date.now(),
): void {
  const state = invalidateTicket(credential, deviceId);
  state.accessRefreshRequired = true;
  state.refusedUntil = now + TICKET_REFUSAL_FLOOR_MS;
}


async function buildPhysicalRequest(
  request: AdapterRequest,
  ctx: AdapterFetchContext,
  credential: StoredMirasimCredential,
  forceFreshTicket: boolean,
  controlPlane = false,
  controlCredentialMode: "device-ticket" | "access-token" = "device-ticket",
  send: PhysicalSend = createAdapterPhysicalSend(ctx),
): Promise<{ budgetTargetKey: string; init: RequestInit; usedTicket: boolean; url: string }> {
  const target = new URL(request.url);
  assertRelayTarget(target, credential.metadata.relayUrl);
  const path = target.pathname;
  const identity = createMirasimDeviceIdentity(credential.metadata.devicePrivateKey);
  const clean = cleanBaseHeaders(request.headers);
  if (forceFreshTicket && controlCredentialMode === "device-ticket") {
    invalidateTicket(credential, identity.deviceId);
  }
  const auth = controlPlane && controlCredentialMode === "access-token"
    ? { credential: credential.accessToken, usedTicket: false }
    : await mintDeviceTicket(credential, ctx, send);
  const metadata = controlPlane
    ? undefined
    : inferenceMetadata(credential, identity.deviceId, path, clean.threadId);
  const signed = signMirasimRequest({
    method: request.method,
    path,
    deviceId: identity.deviceId,
    clientVersion: credential.metadata.clientVersion,
    credential: auth.credential,
    metadata,
    body: Buffer.from(request.body, "utf8"),
    privateKeyPem: identity.privateKeyPem,
  });
  const authenticatedHeaders = { ...clean.headers, ...signed.headers };
  const signedAndSealed = controlPlane
    ? lowercaseHeaders(authenticatedHeaders)
    : sealedMirasimHeaders(authenticatedHeaders, request.method, path);
  const method = request.method.toUpperCase();
  return {
    url: target.toString(),
    budgetTargetKey: transportBudgetTargetKey(credential),
    usedTicket: auth.usedTicket,
    init: {
      method: request.method,
      redirect: "manual",
      headers: { ...signedAndSealed, authorization: `Bearer ${auth.credential}` },
      ...(method === "GET" || method === "HEAD" ? {} : { body: request.body }),
      signal: controlPlane ? combineSignal(ctx.abortSignal, ctx.timeoutMs) : ctx.abortSignal,
    },
  };
}

function providerControlExecutor(
  providerName: string,
  provider: OcxProviderConfig,
  dependencies: ProviderOutboundDependencies = {},
): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (method === "GET") {
      return providerOutboundGet(providerName, provider, url, { headers, signal }, dependencies);
    }
    if (method === "POST") {
      const rawBody = init?.body;
      if (rawBody != null && typeof rawBody !== "string") {
        throw new Error("Mirasim control-plane POST body must be a UTF-8 string");
      }
      const body = rawBody ?? "";
      return providerOutboundPost(providerName, provider, url, { headers, body, signal }, dependencies);
    }
    throw new Error(`Mirasim control-plane method ${method} is not supported`);
  }) as typeof globalThis.fetch;
}

export interface MirasimControlRequestOptions {
  method?: "GET" | "POST";
  headers?: Readonly<Record<string, string>>;
  /** Provider-owned headers appended after signing; caller-supplied x-mirasim-* remains blocked. */
  providerHeaders?: Readonly<Record<string, string>>;
  /**
   * Most relay control endpoints accept the device-session bearer used by inference. A small
   * account-scoped subset (currently /v1/model-roster) authenticates the login access token
   * directly instead. Both modes still carry the device signature.
   */
  credentialMode?: "device-ticket" | "access-token";
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  outboundDependencies?: ProviderOutboundDependencies;
}

function validatedControlProviderHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim().toLowerCase();
    const value = rawValue.trim();
    if (!CONTROL_PROVIDER_HEADER_NAMES.has(name)) {
      throw new Error(`Unsupported Mirasim provider-owned control header: ${rawName}`);
    }
    if (!value || value.length > 512 || /[\0\r\n]/.test(value)) {
      throw new Error(`Invalid Mirasim provider-owned control header: ${rawName}`);
    }
    out[name] = value;
  }
  return out;
}

function appendControlProviderHeaders(
  physical: { init: RequestInit; usedTicket: boolean; url: string },
  providerHeaders: Readonly<Record<string, string>>,
): void {
  if (Object.keys(providerHeaders).length === 0) return;
  const headers = new Headers(physical.init.headers);
  for (const [name, value] of Object.entries(providerHeaders)) headers.set(name, value);
  physical.init = { ...physical.init, headers };
}

async function fetchMirasimControlOnce(
  providerName: string,
  provider: OcxProviderConfig,
  credential: StoredMirasimCredential,
  path: string,
  options: MirasimControlRequestOptions,
): Promise<Response> {
  const relayBase = credential.metadata.relayUrl.replace(/\/$/, "");
  const normalizedPath = `/${path.trim().replace(/^\/+/, "")}`;
  const executor = providerControlExecutor(providerName, provider, options.outboundDependencies);
  const ctx: AdapterFetchContext = {
    executor,
    ...(options.signal ? { abortSignal: options.signal } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  };
  const send = createAdapterPhysicalSend(ctx);
  const request: AdapterRequest = {
    url: `${relayBase}${normalizedPath}`,
    method: options.method ?? "GET",
    headers: { accept: "application/json", ...(options.headers ?? {}) },
    body: options.body ?? "",
  };
  const providerHeaders = validatedControlProviderHeaders(options.providerHeaders);
  const credentialMode = options.credentialMode ?? "device-ticket";
  const identity = createMirasimDeviceIdentity(credential.metadata.devicePrivateKey);
  let physical = await buildPhysicalRequest(
    request,
    ctx,
    credential,
    false,
    true,
    credentialMode,
    send,
  );
  appendControlProviderHeaders(physical, providerHeaders);
  const budgetTargetKey = transportBudgetTargetKey(credential);
  const response = await send({
    url: physical.url,
    budgetTargetKey,
    dispatch: physicalExecutor => physicalExecutor(physical.url, physical.init),
  });
  if (response.status === 401 && physical.usedTicket) {
    noteTicketRefusal(credential, identity.deviceId);
  }
  return response;
}

/**
 * Send a Mirasim control-plane request without inference metadata or the sealed
 * x-mirasim-enc envelope. Device-ticket authentication remains the default; endpoints whose
 * control-plane contract is tied to the login identity can opt into the access-token credential
 * while retaining device signing. One authenticated 401 may force-refresh the same account
 * generation and replay once, matching the main inference path.
 */
export async function fetchMirasimControl(
  providerName: string,
  provider: OcxProviderConfig,
  accessToken: string,
  path: string,
  options: MirasimControlRequestOptions = {},
): Promise<Response> {
  const credential = matchingCredential(accessToken);
  let response: Response;
  try {
    response = await fetchMirasimControlOnce(providerName, provider, credential, path, options);
  } catch (error) {
    if (!(error instanceof MirasimRelayStatusError) || error.status !== 401) throw error;
    response = statusErrorResponse(error);
  }
  if (response.status !== 401) return response;

  try {
    const { forceRefreshOAuthAccessSnapshot } = await import("../../oauth");
    const refreshed = await forceRefreshOAuthAccessSnapshot({
      provider: "mirasim",
      accountId: credential.accountSlotId,
      generation: credential.generation,
      accessToken: credential.accessToken,
    });
    const replacement = await fetchMirasimControlOnce(
      providerName,
      provider,
      matchingCredential(refreshed.accessToken),
      path,
      options,
    );
    try { await response.body?.cancel(); } catch { /* already closed */ }
    return replacement;
  } catch {
    return response;
  }
}

async function sendInferencePhysical(
  send: PhysicalSend,
  physical: Awaited<ReturnType<typeof buildPhysicalRequest>>,
  ctx: AdapterFetchContext,
  options: { sendClass?: AdapterFetchContext["sendClass"]; recovery?: AdapterFetchContext["recovery"] } = {},
): Promise<Response> {
  const deadline = responseHeaderDeadline(ctx.abortSignal, ctx.timeoutMs);
  try {
    return await send({
      url: physical.url,
      budgetTargetKey: physical.budgetTargetKey,
      ...(options.sendClass ? { sendClass: options.sendClass } : {}),
      ...(options.recovery ? { recovery: options.recovery } : {}),
      dispatch: executor => executor(physical.url, { ...physical.init, signal: deadline.signal }),
    });
  } finally {
    // Header deadline ends when fetch resolves. The returned body keeps only the caller's
    // abort signal, so a long healthy SSE stream is not killed by the connect/header timeout.
    deadline.clear();
  }
}

export async function fetchMirasim(
  request: AdapterRequest,
  accessToken: string,
  ctx: AdapterFetchContext = {},
): Promise<Response> {
  const credential = matchingCredential(accessToken);
  const identity = createMirasimDeviceIdentity(credential.metadata.devicePrivateKey);
  const send = createAdapterPhysicalSend(ctx);
  let physical: Awaited<ReturnType<typeof buildPhysicalRequest>>;
  try {
    physical = await buildPhysicalRequest(request, ctx, credential, false, false, "device-ticket", send);
  } catch (error) {
    if (error instanceof MirasimRelayStatusError && error.status === 401) {
      return statusErrorResponse(error);
    }
    throw error;
  }

  const response = await sendInferencePhysical(send, physical, ctx);
  if (response.status === 401 && physical.usedTicket) {
    // One relay rejection is enough to hand control back to the OAuth owner. A same-token
    // ticket re-mint plus an OAuth replay would require six physical sends; OpenCodex's shared
    // request budget intentionally caps the whole logical turn at four. Refreshing access first
    // remints the ticket as part of the bounded replay and covers both stale-ticket and stale-token
    // cases in exactly four sends (ticket + inference, refreshed ticket + inference).
    noteTicketRefusal(credential, identity.deviceId);
  }
  return response;

}

export const MIRASIM_INTERNAL_WIRE_HEADER = INTERNAL_WIRE_HEADER;
export const MIRASIM_INTERNAL_THREAD_HEADER = INTERNAL_THREAD_HEADER;

/** Tests only: observe the stable no-thread session identity for a stored credential. */
export function mirasimSessionIdForTests(accessToken: string): string | undefined {
  const credential = matchingCredential(accessToken);
  const identity = createMirasimDeviceIdentity(credential.metadata.devicePrivateKey);
  return transportStateFor(credential, identity.deviceId).state.sessionId;
}

export function resetMirasimTransportStateForTests(): void {
  transportStateCache.clear();
}
