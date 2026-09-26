import {
  boundedRelayResponseStream,
  filterRelayHeaders,
  headersWithinLimit,
  validateHubRelayRequestHeaders,
} from "./hub-relay";
import { linkRouteAllowed } from "../link/routes";
import { isLinkPort } from "../link/ports";
import { resolveInboundBodyLimitBytes } from "../server/request-decompress";

export interface LinkRelayTarget {
  tunnelPort: number;
  /**
   * The stored link key. The relay sends it in place of every caller credential, so the Home
   * admits the request as this link and serves it with its own accounts.
   */
  admissionKey: string;
}

export interface LinkRelayClock {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

export interface LinkRelayDeps {
  fetchImpl?: typeof fetch;
  clock?: LinkRelayClock;
  /** Time allowed for the Home's response headers; a caller abort still ends the wait sooner. */
  headerTimeoutMs?: number;
  sseIdleTimeoutMs?: number;
  /** Byte cap for the streamed request body and for a non-SSE response body. */
  bodyLimitBytes?: number;
}

export const LINK_RELAY_RETRY_AFTER_SECONDS = 1;
export const LINK_RELAY_SSE_IDLE_TIMEOUT_MS = 300_000;
/**
 * The Home may hold a turn (remote compaction, a slow first byte) far past the management
 * relay's 15 s, so the data plane waits for response headers as long as its SSE idle limit.
 */
export const LINK_RELAY_HEADER_TIMEOUT_MS = 300_000;
/** The data-plane default: the same inbound limit a standalone listener admits. */
export const LINK_RELAY_BODY_MAX_BYTES = resolveInboundBodyLimitBytes(undefined);

const defaultClock: LinkRelayClock = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};
const REQUEST_OMITTED_HEADERS = new Set(["content-length", "host"]);
const RESPONSE_OMITTED_HEADERS = new Set(["content-encoding", "content-length"]);
/**
 * Caller credentials never cross the tunnel. The Child's own ChatGPT or Anthropic credential
 * stays on the Child, and the Home sees exactly one admission: the link key.
 */
const CALLER_CREDENTIAL_HEADERS = ["authorization", "x-api-key", "x-opencodex-api-key", "chatgpt-account-id", "cookie"] as const;

function jsonError(status: number, error: string, retry = false): Response {
  const headers = retry ? { "Retry-After": String(LINK_RELAY_RETRY_AFTER_SECONDS) } : undefined;
  return Response.json({ error }, { status, headers });
}

export function linkRelayDestination(url: URL, target: Pick<LinkRelayTarget, "tunnelPort">): string {
  if (!isLinkPort(target.tunnelPort)) {
    throw new RangeError("invalid link tunnel port");
  }
  return `http://127.0.0.1:${target.tunnelPort}${url.pathname}${url.search}`;
}

/**
 * The caller's headers for the framing check. The listener's HTTP parser has already de-chunked
 * the body, and the relay re-frames it from the stream, so a lone `Transfer-Encoding: chunked`
 * with no Content-Length is admitted, as a standalone admits it. Any other Transfer-Encoding, or
 * one next to a Content-Length, stays in the list and is refused as ambiguous framing.
 */
function linkFramingHeaders(source: Headers): Array<[string, string]> {
  const raw = [...source];
  const transferEncoding = source.get("transfer-encoding");
  if (transferEncoding === null || transferEncoding.trim().toLowerCase() !== "chunked" || source.has("content-length")) return raw;
  return raw.filter(([name]) => name.toLowerCase() !== "transfer-encoding");
}

/**
 * The headers sent to the Home: hop-by-hop, Connection-nominated and caller credential headers
 * dropped, then the link key attached. `GET /v1/usage` admits only the dedicated header; every
 * other link route takes the key as a Bearer, the same wire an `env_key` Codex config sent.
 */
export function forwardLinkRequestHeaders(source: Headers, admissionKey: string, pathname: string): Headers {
  const validation = validateHubRelayRequestHeaders(linkFramingHeaders(source));
  if (!validation.ok) return new Headers();
  return linkRequestHeaders(source, admissionKey, pathname, validation.connectionNamed);
}

function linkRequestHeaders(
  source: Headers,
  admissionKey: string,
  pathname: string,
  connectionNamed: ReadonlySet<string>,
): Headers {
  const omitted = new Set<string>([...REQUEST_OMITTED_HEADERS, ...CALLER_CREDENTIAL_HEADERS, ...connectionNamed]);
  const headers = filterRelayHeaders(source, undefined, omitted);
  if (pathname === "/v1/usage") headers.set("x-opencodex-api-key", admissionKey);
  else headers.set("authorization", `Bearer ${admissionKey}`);
  return headers;
}

export function sanitizeLinkResponseHeaders(source: Headers): Headers {
  const connectionNamed = new Set((source.get("connection") ?? "")
    .split(",").map(value => value.trim().toLowerCase()).filter(Boolean));
  return filterRelayHeaders(source, undefined, new Set([...RESPONSE_OMITTED_HEADERS, ...connectionNamed]));
}

function isSse(headers: Headers): boolean {
  return headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
}

function positive(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * The caller's body streamed through unchanged while its bytes are counted. Nothing is
 * buffered: each chunk goes to the upstream as it arrives, and crossing `limit` errors the
 * stream, which fails the upstream fetch.
 */
function byteCappedRequestBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
  onOverflow: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let bytes = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        bytes += next.value.byteLength;
        if (bytes > limit) {
          const error = new RangeError("link relay request body too large");
          onOverflow();
          try { await reader.cancel(error); } catch { /* best effort */ }
          controller.error(error);
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch { /* best effort */ }
    },
  });
}

function idleBoundedStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  clock: LinkRelayClock,
  idleTimeoutMs: number,
  onIdle: () => void,
  cleanup: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let closed = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const clearIdleTimer = () => {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    clearIdleTimer();
    signal.removeEventListener("abort", onAbort);
    cleanup();
    try { reader.releaseLock(); } catch { /* a pending read may still own it */ }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    try { controllerRef?.close(); } catch { /* the consumer may have cancelled */ }
  };
  const cancelUpstream = (reason: unknown, closeResponse: boolean) => {
    if (finished) return;
    clearIdleTimer();
    try {
      void reader.cancel(reason).catch(() => undefined).finally(() => {
        finish();
        if (closeResponse) close();
      });
    } catch {
      finish();
      if (closeResponse) close();
    }
  };
  const onAbort = () => cancelUpstream(signal.reason, true);
  const armIdleTimer = () => {
    clearIdleTimer();
    timer = clock.setTimeout(() => {
      onIdle();
      cancelUpstream(new DOMException("link relay SSE idle timeout", "TimeoutError"), true);
    }, idleTimeoutMs);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (signal.aborted) onAbort();
      else armIdleTimer();
    },
    async pull(controller) {
      if (closed) return;
      try {
        const next = await reader.read();
        if (next.done) {
          finish();
          closed = true;
          controller.close();
          return;
        }
        if (next.value.byteLength > 0) armIdleTimer();
        controller.enqueue(next.value);
      } catch (error) {
        finish();
        if (!closed) {
          closed = true;
          controller.error(error);
        }
      }
    },
    async cancel(reason) {
      cancelUpstream(reason, false);
    },
  });
}

export async function relayLinkDataRequest(
  req: Request,
  target: LinkRelayTarget,
  deps: LinkRelayDeps = {},
): Promise<Response> {
  const url = new URL(req.url);
  if (!linkRouteAllowed(url, req)) return jsonError(404, "not_found");
  let destination: string;
  try { destination = linkRelayDestination(url, target); } catch { return jsonError(404, "not_found"); }
  const validation = validateHubRelayRequestHeaders(linkFramingHeaders(req.headers));
  if (!validation.ok) return jsonError(400, "link relay request headers refused");

  const bodyLimit = positive(deps.bodyLimitBytes) ?? LINK_RELAY_BODY_MAX_BYTES;
  // The check admits at most one all-digit Content-Length, and Transfer-Encoding only as a lone
  // `chunked` without one; the byte cap below bounds a chunked body instead.
  const declaredLength = req.headers.get("content-length")?.trim() ?? null;
  if (declaredLength !== null && Number(declaredLength) > bodyLimit) {
    return jsonError(413, "link relay request body too large");
  }
  const headers = linkRequestHeaders(req.headers, target.admissionKey, url.pathname, validation.connectionNamed);
  if (!headersWithinLimit(headers)) {
    return jsonError(431, "link relay request headers too large");
  }

  const relayAbort = new AbortController();
  const clock = deps.clock ?? defaultClock;
  let headerTimer: ReturnType<typeof setTimeout> | undefined = clock.setTimeout(() => {
    headerTimer = undefined;
    relayAbort.abort(new DOMException("link relay header deadline", "TimeoutError"));
  }, positive(deps.headerTimeoutMs) ?? LINK_RELAY_HEADER_TIMEOUT_MS);
  const stopHeaderDeadline = () => {
    if (headerTimer !== undefined) clock.clearTimeout(headerTimer);
    headerTimer = undefined;
  };
  const onClientAbort = () => relayAbort.abort(req.signal.reason);
  req.signal.addEventListener("abort", onClientAbort, { once: true });
  const cleanup = () => {
    stopHeaderDeadline();
    req.signal.removeEventListener("abort", onClientAbort);
  };
  if (req.signal.aborted) onClientAbort();

  let bodyOverflow = false;
  const body = req.method === "GET" || req.method === "HEAD" || !req.body
    ? null
    : byteCappedRequestBody(req.body, bodyLimit, () => { bodyOverflow = true; });
  // A streamed body keeps the caller's Content-Length, so the Home sees the same framing a
  // buffered body produced instead of a chunked upload.
  if (body && declaredLength !== null) headers.set("content-length", declaredLength);

  let upstream: Response;
  try {
    const init: RequestInit & { duplex?: "half" } = {
      method: req.method,
      headers,
      redirect: "manual",
      signal: relayAbort.signal,
      ...(body ? { body, duplex: "half" } : {}),
    };
    upstream = await (deps.fetchImpl ?? fetch)(destination, init);
  } catch {
    cleanup();
    return bodyOverflow
      ? jsonError(413, "link relay request body too large")
      : jsonError(503, "link tunnel unavailable", true);
  }
  if (relayAbort.signal.aborted) {
    cleanup();
    try { await upstream.body?.cancel(); } catch { /* best effort */ }
    return jsonError(503, "link tunnel unavailable", true);
  }

  const sse = isSse(upstream.headers);
  const responseHeaders = sanitizeLinkResponseHeaders(upstream.headers);
  if (!headersWithinLimit(responseHeaders)) {
    cleanup();
    try { await upstream.body?.cancel(); } catch { /* best effort */ }
    return jsonError(502, "link relay response headers too large");
  }
  const responseLength = upstream.headers.get("content-length");
  if (!sse && responseLength !== null && (!/^\d+$/.test(responseLength)
    || Number(responseLength) > bodyLimit)) {
    cleanup();
    try { await upstream.body?.cancel(); } catch { /* best effort */ }
    return jsonError(502, "link relay response body too large");
  }
  if (req.method === "HEAD" || !upstream.body) {
    cleanup();
    try { await upstream.body?.cancel(); } catch { /* best effort */ }
    return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
  }

  // The header deadline ends once a response exists. The body owns cleanup after that.
  stopHeaderDeadline();
  const responseBody = sse
    ? idleBoundedStream(upstream.body, relayAbort.signal, clock,
      deps.sseIdleTimeoutMs ?? LINK_RELAY_SSE_IDLE_TIMEOUT_MS, () => relayAbort.abort(new DOMException("link relay SSE idle timeout", "TimeoutError")), cleanup)
    : boundedRelayResponseStream(upstream.body, bodyLimit, relayAbort.signal, cleanup);
  return new Response(responseBody, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}
