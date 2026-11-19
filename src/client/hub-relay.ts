import { stripMachineAuthHeaders } from "./machine-auth";
import { homeUnreachableBody } from "./home-unreachable";
import {
  HUB_RELAY_ENROLLMENT_ID_HEADER, HUB_RELAY_ENROLLMENT_PROOF_HEADER, HUB_RELAY_PROOF_TIME_HEADER, HUB_RELAY_READ_PREFIX,
  hubRelayBootstrapAllowed, hubRelayLogoutAllowed, hubRelayReadAllowed,
} from "../remote/hub-management-relay";
import type { readHubRelayAdmission } from "./hub-session";

export interface HubRelayTarget {
  managementUrl: string;
  browserOrigin: string;
}

type HubRelayCredentialSource = (method: string, target: string) => ReturnType<typeof readHubRelayAdmission>;

export const HUB_RELAY_REQUEST_BODY_MAX_BYTES = 4 * 1024 * 1024;
export const HUB_RELAY_RESPONSE_BODY_MAX_BYTES = 16 * 1024 * 1024;
export const HUB_RELAY_DEFAULT_TIMEOUT_MS = 15_000;
export const HUB_RELAY_HEADER_MAX_BYTES = 64 * 1024;
export const HUB_RELAY_EXPECTED_TARGET_HEADER = "x-opencodex-expected-target";
export const HUB_RELAY_EXPECTED_TARGET_MAX_BYTES = 512;
const HUB_RELAY_REFRESH_INTERVAL_MS = 60_000;

const REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "cache-control",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "origin",
  "x-opencodex-api-key",
  "x-opencodex-csrf-token",
  "x-opencodex-gui-origin",
]);
const RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-language",
  "content-type",
  "etag",
  "expires",
  "last-modified",
  "pragma",
  "retry-after",
  "vary",
]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

export type HubRelayRawHeaderValidation =
  | { ok: true; connectionNamed: Set<string> }
  | { ok: false; reason: "smuggling" | "invalid" };

export function validateHubRelayRequestHeaders(raw: readonly (readonly [string, string])[]): HubRelayRawHeaderValidation {
  let contentLengths = 0;
  let transferEncoding = false;
  const connectionNamed = new Set<string>();
  for (const [rawName, value] of raw) {
    const name = rawName.trim().toLowerCase();
    if (!name || /[\r\n]/.test(rawName) || /[\r\n]/.test(value)) return { ok: false, reason: "invalid" };
    if (name === "content-length") {
      contentLengths += 1;
      if (!/^\d+$/.test(value.trim())) return { ok: false, reason: "smuggling" };
    }
    if (name === "transfer-encoding") transferEncoding = true;
    if (name === "upgrade") return { ok: false, reason: "smuggling" };
    if (name === "connection") {
      for (const token of value.split(",")) {
        const normalized = token.trim().toLowerCase();
        if (normalized) connectionNamed.add(normalized);
      }
    }
  }
  if (transferEncoding || contentLengths > 1) return { ok: false, reason: "smuggling" };
  return { ok: true, connectionNamed };
}

function relayError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/** The Hub did not answer (OCX-11 `home_unreachable`); the 502 status is kept. */
function hubUnreachable(): Response {
  return Response.json(homeUnreachableBody("hub relay unavailable"), { status: 502 });
}

function canonicalOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:")
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** A canonical HTTP(S) origin, no userinfo/path/query/fragment/trailing slash. */
function canonicalExpectedOrigin(value: string): string | null {
  const origin = canonicalOrigin(value);
  return origin && value === origin ? origin : null;
}

function relayDestination(suffix: string, target: HubRelayTarget, method: string): URL | null {
  const origin = canonicalOrigin(target.managementUrl);
  if (!origin) return null;
  if (hubRelayBootstrapAllowed(method, suffix) || hubRelayLogoutAllowed(method, suffix)) return new URL(suffix, origin);
  return hubRelayReadAllowed(method, suffix) ? new URL(HUB_RELAY_READ_PREFIX + suffix, origin) : null;
}

export async function readBoundedRelayRequestBody(
  stream: ReadableStream<Uint8Array> | null,
  declared: string | null,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!stream) return null;
  const contentLength = declared === null ? null : Number(declared);
  if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > limit)) {
    throw new RangeError("body_too_large");
  }
  const reader = stream.getReader();
  const chunks: Uint8Array<ArrayBufferLike>[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new RangeError("body_too_large");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  // BodyInit requires an ArrayBuffer-backed view, not a SharedArrayBuffer-capable view.
  const body: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(length));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function filterRelayHeaders(
  source: Headers,
  allowlist?: ReadonlySet<string>,
  omitted: ReadonlySet<string> = new Set(),
): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    const normalized = name.toLowerCase();
    if ((!allowlist || allowlist.has(normalized)) && !HOP_BY_HOP_HEADERS.has(normalized) && !omitted.has(normalized)) headers.append(name, value);
  }
  return headers;
}

export function headersWithinLimit(headers: Headers): boolean {
  let bytes = 0;
  for (const [name, value] of headers) {
    bytes += name.length + value.length + 4;
    if (bytes > HUB_RELAY_HEADER_MAX_BYTES) return false;
  }
  return true;
}

export function boundedRelayResponseStream(
  body: ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal,
  cleanup: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let bytes = 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    signal.removeEventListener("abort", onAbort);
    cleanup();
    try { reader.releaseLock(); } catch { /* a pending read may still own it */ }
  };
  const onAbort = () => {
    if (finished) return;
    try { void reader.cancel(signal.reason).catch(() => undefined).finally(finish); }
    catch { finish(); }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          finish();
          controller.close();
          return;
        }
        bytes += next.value.byteLength;
        if (bytes > limit) {
          try { await reader.cancel(new RangeError("hub relay response body too large")); } catch { /* best effort */ }
          finish();
          controller.error(new RangeError("hub relay response body too large"));
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch { /* best effort */ }
      finish();
    },
  });
}

export async function relayHubManagementRequest(
  req: Request,
  suffix: string,
  target: HubRelayTarget,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number; readCredential?: HubRelayCredentialSource } = {},
): Promise<Response> {
  const method = req.method;
  const destination = relayDestination(suffix, target, method);
  if (!destination || (deps.readCredential && !hubRelayReadAllowed(method, suffix))) return relayError(404, "hub relay path refused");
  const requestHeaderValidation = validateHubRelayRequestHeaders([...req.headers]);
  if (!requestHeaderValidation.ok) return relayError(400, "hub relay request headers refused");

  // The expected-target claim is checked against the same immutable target snapshot used
  // for forwarding, before the body is read. Absence keeps the legacy caller contract.
  const expectedTarget = req.headers.get(HUB_RELAY_EXPECTED_TARGET_HEADER);
  if (expectedTarget !== null) {
    if (expectedTarget.includes(",") || new TextEncoder().encode(expectedTarget).byteLength > HUB_RELAY_EXPECTED_TARGET_MAX_BYTES) {
      return relayError(400, "invalid_expected_target");
    }
    const claimed = canonicalExpectedOrigin(expectedTarget);
    const current = canonicalOrigin(target.managementUrl);
    if (!claimed || !current) return relayError(400, "invalid_expected_target");
    if (claimed !== current) {
      return new Response(JSON.stringify({ error: "target_changed" }), {
        status: 409,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
  }

  const stripped = stripMachineAuthHeaders(req.headers);
  const headers = filterRelayHeaders(stripped, REQUEST_HEADERS, requestHeaderValidation.connectionNamed);
  if (hubRelayLogoutAllowed(method, suffix) && !headers.get("x-opencodex-api-key")?.startsWith("ocx_session_")) {
    return relayError(401, "caller Hub GUI session required");
  }

  let body: Uint8Array<ArrayBuffer> | null;
  try {
    body = method === "GET" || method === "HEAD"
      ? null
      : await readBoundedRelayRequestBody(req.body, req.headers.get("content-length"), HUB_RELAY_REQUEST_BODY_MAX_BYTES);
  } catch {
    return relayError(413, "hub relay request body too large");
  }

  const stored = deps.readCredential?.(method, destination.pathname + destination.search);
  if (deps.readCredential && !stored) return relayError(401, "Hub relay credential unavailable");
  if (stored) {
    headers.set("x-opencodex-api-key", stored.token);
    headers.set(HUB_RELAY_ENROLLMENT_ID_HEADER, stored.keyId);
    headers.set(HUB_RELAY_ENROLLMENT_PROOF_HEADER, stored.proof);
    headers.set(HUB_RELAY_PROOF_TIME_HEADER, stored.at);
    for (const name of ["origin", "x-opencodex-gui-origin", "x-opencodex-csrf-token"]) headers.delete(name);
  }
  if (!headersWithinLimit(headers)) return relayError(431, "hub relay request headers too large");
  const browserOrigin = canonicalOrigin(target.browserOrigin);
  const mutation = method !== "GET" && method !== "HEAD";
  const suppliedOrigin = headers.get("origin");
  if (!stored && (!browserOrigin || (mutation ? suppliedOrigin !== browserOrigin : suppliedOrigin !== null && suppliedOrigin !== browserOrigin))) {
    return relayError(403, "hub relay browser origin refused");
  }

  const timeoutMs = typeof deps.timeoutMs === "number" && Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0
    ? Math.min(Math.floor(deps.timeoutMs), 120_000)
    : HUB_RELAY_DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const relayAbort = new AbortController();
  const signal = relayAbort.signal;
  const cleanup = () => {
    timeoutSignal.removeEventListener("abort", onTimeout);
    req.signal.removeEventListener("abort", onClientAbort);
  };
  const onTimeout = () => { relayAbort.abort(timeoutSignal.reason); cleanup(); };
  const onClientAbort = () => { relayAbort.abort(req.signal.reason); cleanup(); };
  timeoutSignal.addEventListener("abort", onTimeout, { once: true });
  req.signal.addEventListener("abort", onClientAbort, { once: true });
  if (req.signal.aborted) onClientAbort();
  else if (timeoutSignal.aborted) onTimeout();
  let upstream: Response;
  try {
    upstream = await (deps.fetchImpl ?? fetch)(destination, {
      method,
      headers,
      ...(body ? { body } : {}),
      redirect: "manual",
      signal,
    });
  } catch {
    cleanup();
    return hubUnreachable();
  }
  if (signal.aborted) {
    cleanup();
    try { await upstream.body?.cancel(); } catch { /* best effort */ }
    return hubUnreachable();
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    cleanup();
    try { await upstream.body?.cancel(); } catch { /* best effort */ }
    return relayError(502, "hub relay redirect refused");
  }

  const responseConnectionNamed = new Set((upstream.headers.get("connection") ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean));
  const responseHeaders = filterRelayHeaders(upstream.headers, RESPONSE_HEADERS, responseConnectionNamed);
  if (!headersWithinLimit(responseHeaders)) {
    cleanup();
    try { await upstream.body?.cancel(); } catch { /* best effort */ }
    return relayError(502, "hub relay response headers too large");
  }
  const declaredResponseLength = upstream.headers.get("content-length");
  if (declaredResponseLength !== null && (!/^\d+$/.test(declaredResponseLength)
    || Number(declaredResponseLength) > HUB_RELAY_RESPONSE_BODY_MAX_BYTES)) {
    cleanup();
    try { await upstream.body?.cancel(); } catch { /* best effort */ }
    return relayError(502, "hub relay response body too large");
  }
  let responseBody: ReadableStream<Uint8Array> | null = null;
  if (method === "HEAD" || !upstream.body) {
    cleanup();
    try { await upstream.body?.cancel(); } catch { /* best effort */ }
  } else {
    responseBody = boundedRelayResponseStream(upstream.body, HUB_RELAY_RESPONSE_BODY_MAX_BYTES, signal, cleanup);
  }
  return new Response(responseBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

function scheduleLeaseRefresh(run: () => Promise<void>): () => void {
  void run();
  const timer = setInterval(() => { void run(); }, HUB_RELAY_REFRESH_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** Keep an idle serving client enrolled using the same passive read admission as the CLI. */
export function startHubRelayLeaseRefresh(
  managementUrl: string, readCredential: HubRelayCredentialSource,
  deps: { fetchImpl?: typeof fetch; schedule?: typeof scheduleLeaseRefresh } = {},
): { stop(): void } {
  const abort = new AbortController();
  const path = "/api/codex-auth/active";
  let inFlight = false;
  const cancel = (deps.schedule ?? scheduleLeaseRefresh)(async () => {
    if (abort.signal.aborted || inFlight) return;
    inFlight = true;
    try {
      const req = new Request("http://127.0.0.1" + path, { method: "HEAD", signal: abort.signal });
      await relayHubManagementRequest(req, path, { managementUrl, browserOrigin: "" }, { fetchImpl: deps.fetchImpl, readCredential });
    } catch {
      // The next tick retries. The Hub still expires an unrenewed lease.
    } finally {
      inFlight = false;
    }
  });
  return { stop() { cancel(); abort.abort(); } };
}
