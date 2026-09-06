import { stripMachineAuthHeaders } from "./machine-auth";

export interface HubRelayTarget {
  managementUrl: string;
  browserOrigin: string;
}

export const HUB_RELAY_REQUEST_BODY_MAX_BYTES = 4 * 1024 * 1024;
export const HUB_RELAY_RESPONSE_BODY_MAX_BYTES = 16 * 1024 * 1024;
export const HUB_RELAY_DEFAULT_TIMEOUT_MS = 15_000;
export const HUB_RELAY_HEADER_MAX_BYTES = 64 * 1024;

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
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

function relayDestination(suffix: string, target: HubRelayTarget, method: string): URL | null {
  const origin = canonicalOrigin(target.managementUrl);
  const browserOrigin = canonicalOrigin(target.browserOrigin);
  if (!origin || !browserOrigin || !ALLOWED_METHODS.has(method)) return null;
  if (!suffix.startsWith("/") || suffix.startsWith("//") || suffix.includes("\\") || suffix.includes("#")) return null;
  if (/%(?:2f|5c)/i.test(suffix) || /%(?:2e)(?:%2e|\.)?/i.test(suffix)) return null;
  const rawPath = suffix.split("?", 1)[0]!;
  for (const segment of rawPath.split("/")) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { return null; }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) return null;
  }
  if (rawPath === "/opencodex-session") {
    if (suffix !== rawPath || (method !== "GET" && method !== "POST")) return null;
  } else if (!rawPath.startsWith("/api/")) {
    return null;
  }
  let destination: URL;
  try { destination = new URL(suffix, `${origin}/`); } catch { return null; }
  if (destination.origin !== origin || destination.username || destination.password || destination.hash) return null;
  if (destination.pathname !== rawPath) return null;
  return destination;
}

async function boundedBody(
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

function filteredHeaders(source: Headers, allowlist: Set<string>, omitted: ReadonlySet<string> = new Set()): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    const normalized = name.toLowerCase();
    if (allowlist.has(normalized) && !HOP_BY_HOP_HEADERS.has(normalized) && !omitted.has(normalized)) headers.append(name, value);
  }
  return headers;
}

function headersWithinLimit(headers: Headers): boolean {
  let bytes = 0;
  for (const [name, value] of headers) {
    bytes += name.length + value.length + 4;
    if (bytes > HUB_RELAY_HEADER_MAX_BYTES) return false;
  }
  return true;
}

function boundedRelayResponseStream(
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
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Response> {
  const method = req.method.toUpperCase();
  const destination = relayDestination(suffix, target, method);
  if (!destination) return relayError(404, "hub relay path refused");
  const requestHeaderValidation = validateHubRelayRequestHeaders([...req.headers]);
  if (!requestHeaderValidation.ok) return relayError(400, "hub relay request headers refused");

  let body: Uint8Array<ArrayBuffer> | null;
  try {
    body = method === "GET" || method === "HEAD"
      ? null
      : await boundedBody(req.body, req.headers.get("content-length"), HUB_RELAY_REQUEST_BODY_MAX_BYTES);
  } catch {
    return relayError(413, "hub relay request body too large");
  }

  const stripped = stripMachineAuthHeaders(req.headers);
  const headers = filteredHeaders(stripped, REQUEST_HEADERS, requestHeaderValidation.connectionNamed);
  if (!headersWithinLimit(headers)) return relayError(431, "hub relay request headers too large");
  const browserOrigin = canonicalOrigin(target.browserOrigin);
  const mutation = method !== "GET" && method !== "HEAD";
  const suppliedOrigin = headers.get("origin");
  if (!browserOrigin || (mutation ? suppliedOrigin !== browserOrigin : suppliedOrigin !== null && suppliedOrigin !== browserOrigin)) {
    return relayError(403, "hub relay browser origin refused");
  }

  const timeoutMs = typeof deps.timeoutMs === "number" && Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0
    ? Math.min(Math.floor(deps.timeoutMs), 120_000)
    : HUB_RELAY_DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const relayAbort = new AbortController();
  const signal = relayAbort.signal;
  const stopDeadline = () => timeoutSignal.removeEventListener("abort", onTimeout);
  const cleanup = () => {
    stopDeadline();
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
    return relayError(502, "hub relay unavailable");
  }
  if (signal.aborted) {
    cleanup();
    try { await upstream.body?.cancel(); } catch { /* best effort */ }
    return relayError(502, "hub relay unavailable");
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    cleanup();
    try { await upstream.body?.cancel(); } catch { /* best effort */ }
    return relayError(502, "hub relay redirect refused");
  }

  const responseConnectionNamed = new Set((upstream.headers.get("connection") ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean));
  const responseHeaders = filteredHeaders(upstream.headers, RESPONSE_HEADERS, responseConnectionNamed);
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
  // Only this known, successfully established SSE endpoint outlives the handshake.
  // Its body remains byte-bounded and connected to the browser's abort signal.
  if (method === "GET" && destination.pathname === "/api/accounts/events" && !destination.search
    && upstream.status === 200
    && responseHeaders.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream") {
    stopDeadline();
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
