import http, { type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import https from "node:https";
import { classifyContentCoding, isNullBodyStatus } from "./http-response-semantics";

export type PinnedAddress = { address: string; family: number };

export type PinnedHttpErrorCode =
  | "connect_timeout"
  | "first_byte_timeout"
  | "inactivity_timeout"
  | "output_byte_limit"
  | "unsupported_content_encoding"
  | "content_decode_failed";

export class PinnedHttpError extends Error {
  override readonly name = "PinnedHttpError";
  constructor(readonly code: PinnedHttpErrorCode, message: string) { super(message); }
}

export interface PinnedHttpRequestOptions {
  headers?: HeadersInit;
  maxBytes?: number;
  /** Optional deadline for establishing the TCP connection and, for HTTPS, completing TLS. */
  connectTimeoutMs?: number;
  /** Optional deadline from connection establishment until response headers arrive. */
  firstByteTimeoutMs?: number;
  /** Optional maximum idle interval between response-body chunks. */
  inactivityTimeoutMs?: number;
  /** @deprecated Use firstByteTimeoutMs and inactivityTimeoutMs. */
  idleTimeoutMs?: number;
  rejectUnauthorized?: boolean;
  context?: string;
}

/** @deprecated Use {@link PinnedHttpRequestOptions}. */
export type PinnedHttpGetOptions = PinnedHttpRequestOptions;

/**
 * Undo the content-coding this transport has to undo itself, under the caller's byte ceiling.
 *
 * `maxBytes` keeps its existing meaning for the bytes that arrive on the socket, and gains the
 * same meaning for the bytes the caller ends up reading. Bounding only the coded side would let
 * a small compressed response expand past a ceiling the caller set precisely so it would not
 * have to hold an unbounded body in memory.
 *
 * A completed body is not torn down here. The response already ended, so there is nothing to
 * release, and destroying it would take a connection the agent is entitled to reuse. That
 * matches the identity path, which also only closes. Teardown belongs to the paths that end a
 * response early: a decode failure, an exceeded ceiling, and a caller that cancels.
 *
 * Only a decoder failure is renamed. A mid-body reset, a stalled response and an exceeded
 * socket-byte ceiling all reach this pipeline as "the stream failed", and calling any of them a
 * decode failure would tell the caller the peer sent unreadable bytes when the truth is that the
 * connection died. The source failure is recorded as it passes so the original error survives;
 * what is left after that is the decompressor's own, and that one is named because the caller's
 * alternative is a bare TypeError from a stream it never constructed.
 */
function decodedBody(
  source: ReadableStream<Uint8Array>,
  format: "gzip" | "deflate",
  maxBytes: number | undefined,
  context: string,
  release: () => void,
): ReadableStream<Uint8Array> {
  // Interposed purely to attribute failures. Once bytes enter the decompressor, a transport
  // error and a corrupt trailer are indistinguishable from the far side of the pipe.
  let sourceFailure: { error: unknown } | undefined;
  const sourceReader = source.getReader();
  const attributed = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await sourceReader.read();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        sourceFailure = { error };
        controller.error(error);
      }
    },
    cancel(reason) {
      return sourceReader.cancel(reason);
    },
  });
  // `DecompressionStream` declares its writable side as `WritableStream<BufferSource>`, and
  // TypeScript measures `WritableStream` as invariant in its chunk type, so the pair is not
  // assignable to `ReadableWritablePair<Uint8Array, Uint8Array>` even though every chunk this
  // body produces is a valid `BufferSource`. The conversion states that relationship and
  // nothing else; it does not widen what is actually written.
  const decompressor = new DecompressionStream(format) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const reader = attributed.pipeThrough(decompressor).getReader();
  let decoded = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        decoded += next.value.byteLength;
        if (maxBytes !== undefined && decoded > maxBytes) {
          throw new PinnedHttpError("output_byte_limit", `${context} exceeds ${maxBytes} byte cap`);
        }
        controller.enqueue(next.value);
      } catch (error) {
        // A failure the socket stream raised is the caller's answer, whatever shape it has.
        // Only what the decompressor itself rejected is renamed.
        const named = sourceFailure !== undefined
          ? sourceFailure.error
          : error instanceof PinnedHttpError
            ? error
            : new PinnedHttpError("content_decode_failed", `${context} could not decode its ${format} body`);
        // Cancelling the decoded reader propagates back through the decompressor to the socket
        // stream's own `cancel`, which destroys the request; `release` covers the case where
        // that propagation is already finished.
        await reader.cancel(named).catch(() => { /* already torn down */ });
        controller.error(named);
        release();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => { /* already torn down */ });
      release();
    },
  });
}

function pinnedHttpRequest(
  url: string,
  pinned: PinnedAddress,
  method: "GET" | "POST",
  body: string | undefined,
  signal?: AbortSignal,
  options?: PinnedHttpRequestOptions,
): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${options?.context ?? "request"} must use HTTP or HTTPS, got ${parsed.protocol}`);
  }
  const context = options?.context ?? "request";
  const connectTimeoutMs = options?.connectTimeoutMs;
  const legacyIdleTimeoutMs = options?.idleTimeoutMs ?? 60_000;
  const usesLegacyIdleTimeout = options?.firstByteTimeoutMs === undefined
    && options?.inactivityTimeoutMs === undefined;
  const firstByteTimeoutMs = options?.firstByteTimeoutMs ?? legacyIdleTimeoutMs;
  const inactivityTimeoutMs = options?.inactivityTimeoutMs ?? legacyIdleTimeoutMs;
  const legacyFirstByteDisabled = usesLegacyIdleTimeout && legacyIdleTimeoutMs === 0;
  const maxBytes = options?.maxBytes;
  const headers = new Headers(options?.headers);
  headers.set("host", parsed.host);
  // This transport assembles the response itself, so a coding it did not ask for becomes its own
  // problem to undo. Ask for none by default and leave an explicit caller choice alone, which is
  // the same rule `src/lib/socks5-fetch.ts` applies to the other raw route.
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
  if (body !== undefined && !headers.has("content-length")) {
    headers.set("content-length", String(Buffer.byteLength(body)));
  }
  const requestHeaders: Record<string, string> = {};
  headers.forEach((value, key) => { requestHeaders[key] = value; });

  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }

    let settled = false;
    let req: ClientRequest | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let firstByteTimer: ReturnType<typeof setTimeout> | undefined;
    const clearConnectTimer = () => {
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      connectTimer = undefined;
    };
    const clearFirstByteTimer = () => {
      if (firstByteTimer !== undefined) clearTimeout(firstByteTimer);
      firstByteTimer = undefined;
    };
    const fail = (error: unknown) => {
      clearConnectTimer();
      clearFirstByteTimer();
      try { req?.destroy(); } catch { /* ignore */ }
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const startFirstByteTimer = () => {
      clearFirstByteTimer();
      if (settled || legacyFirstByteDisabled) return;
      firstByteTimer = setTimeout(
        () => fail(new PinnedHttpError("first_byte_timeout", `${context} first byte timed out`)),
        firstByteTimeoutMs,
      );
    };
    const requestOptions: RequestOptions & { servername?: string } = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers: requestHeaders,
      ...(parsed.protocol === "https:"
        ? {
          servername: parsed.hostname,
          rejectUnauthorized: options?.rejectUnauthorized ?? true,
        }
        : {}),
      lookup(_hostname, lookupOptions, callback) {
        const opts = typeof lookupOptions === "function" ? undefined : lookupOptions;
        const cb = typeof lookupOptions === "function" ? lookupOptions : callback;
        if (!cb) return;
        if (opts && typeof opts === "object" && "all" in opts && opts.all) {
          (cb as (error: NodeJS.ErrnoException | null, addresses: PinnedAddress[]) => void)(
            null,
            [{ address: pinned.address, family: pinned.family }],
          );
          return;
        }
        (cb as (error: NodeJS.ErrnoException | null, address: string, family: 4 | 6) => void)(
          null,
          pinned.address,
          pinned.family as 4 | 6,
        );
      },
    };

    const onResponse = (response: IncomingMessage) => {
      clearConnectTimer();
      clearFirstByteTimer();
      const status = response.statusCode ?? 0;
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const item of value) responseHeaders.append(key, String(item));
        } else {
          responseHeaders.set(key, String(value));
        }
      }

      if (status < 200 || status >= 300) {
        try { response.destroy(); } catch { /* ignore */ }
        try { req?.destroy(); } catch { /* ignore */ }
        if (settled) return;
        settled = true;
        resolve(new Response(null, { status, headers: responseHeaders }));
        return;
      }

      // A success status can still be null-body. `new Response(stream, { status: 204 })` throws a
      // TypeError, so attaching the body below would turn a correct no-content answer into a
      // construction failure raised inside this event handler rather than a resolved response.
      // Nothing is coming on the socket either, so streaming one of these would hold the caller
      // until the peer closed a connection it is entitled to keep alive. The headers still
      // describe the representation the peer would have sent and are preserved as they arrived.
      if (isNullBodyStatus(status)) {
        try { response.destroy(); } catch { /* ignore */ }
        try { req?.destroy(); } catch { /* ignore */ }
        if (settled) return;
        settled = true;
        resolve(new Response(null, { status, headers: responseHeaders }));
        return;
      }

      // The peer may have coded the body whatever this request asked for. Classify before the
      // stream takes the socket so a coding this transport cannot undo fails on the ordinary
      // error path rather than reaching the caller as bytes its parser cannot read.
      const coding = classifyContentCoding(responseHeaders);
      if (coding.kind === "unsupported") {
        try { response.destroy(); } catch { /* ignore */ }
        fail(new PinnedHttpError(
          "unsupported_content_encoding",
          `${context} returned an unsupported content-encoding: ${coding.coding}`,
        ));
        return;
      }
      if (coding.kind === "decodable") {
        responseHeaders.delete("content-encoding");
        // The declared length counted the coded bytes, not what the caller now reads.
        responseHeaders.delete("content-length");
      }

      let received = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let bodySettled = false;
          const failBody = (error: Error) => {
            if (bodySettled) return;
            bodySettled = true;
            try { controller.error(error); } catch { /* closed */ }
            try { response.destroy(); } catch { /* ignore */ }
            try { req?.destroy(); } catch { /* ignore */ }
          };

          response.setTimeout(inactivityTimeoutMs, () => {
            failBody(new PinnedHttpError("inactivity_timeout", `${context} stalled`));
          });
          response.on("data", (chunk: Buffer | string) => {
            if (bodySettled) return;
            const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            received += buffer.byteLength;
            if (maxBytes !== undefined && received > maxBytes) {
              failBody(new PinnedHttpError("output_byte_limit", `${context} exceeds ${maxBytes} byte cap`));
              return;
            }
            try { controller.enqueue(buffer); } catch { /* closed */ }
          });
          response.on("end", () => {
            if (bodySettled) return;
            bodySettled = true;
            try { controller.close(); } catch { /* closed */ }
          });
          response.on("error", (error: Error) => {
            failBody(error);
          });
        },
        cancel() {
          req?.destroy();
        },
      });

      if (settled) return;
      settled = true;
      const release = () => {
        try { response.destroy(); } catch { /* ignore */ }
        try { req?.destroy(); } catch { /* ignore */ }
      };
      const payload = coding.kind === "decodable"
        ? decodedBody(stream, coding.format, maxBytes, context, release)
        : stream;
      resolve(new Response(payload, { status, headers: responseHeaders }));
    };

    const requestFn = parsed.protocol === "https:" ? https.request : http.request;
    req = requestFn(requestOptions, onResponse);
    if (usesLegacyIdleTimeout) startFirstByteTimer();
    const onAbort = () => fail(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    req.on("socket", (socket) => {
      const connectedEvent = parsed.protocol === "https:" ? "secureConnect" : "connect";
      if (!socket.connecting) {
        if (!usesLegacyIdleTimeout) startFirstByteTimer();
        return;
      }
      if (connectTimeoutMs !== undefined) {
        connectTimer = setTimeout(
          () => fail(new PinnedHttpError("connect_timeout", `${context} connect timed out`)),
          connectTimeoutMs,
        );
      }
      socket.once(connectedEvent, () => {
        clearConnectTimer();
        if (!usesLegacyIdleTimeout) startFirstByteTimer();
      });
      socket.once("error", () => {
        clearConnectTimer();
        clearFirstByteTimer();
      });
      socket.once("close", () => {
        clearConnectTimer();
        clearFirstByteTimer();
      });
    });
    if (usesLegacyIdleTimeout) {
      req.setTimeout(legacyIdleTimeoutMs, () => fail(new Error(`${context} timed out`)));
    }
    req.on("error", error => {
      signal?.removeEventListener("abort", onAbort);
      fail(error);
    });
    req.on("close", () => {
      clearConnectTimer();
      clearFirstByteTimer();
      signal?.removeEventListener("abort", onAbort);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted && !settled) onAbort();
    if (settled) return;
    req.end(body);
  });
}

/**
 * GET a URL through one previously validated address. The original hostname
 * remains authoritative for Host, SNI, and certificate verification.
 */
export function pinnedHttpGet(
  url: string,
  pinned: PinnedAddress,
  signal?: AbortSignal,
  options?: PinnedHttpRequestOptions,
): Promise<Response> {
  return pinnedHttpRequest(url, pinned, "GET", undefined, signal, options);
}

/**
 * POST a string body through one previously validated address. The original
 * hostname remains authoritative for Host, SNI, and certificate verification.
 */
export function pinnedHttpPost(
  url: string,
  pinned: PinnedAddress,
  body: string,
  signal?: AbortSignal,
  options?: PinnedHttpRequestOptions,
): Promise<Response> {
  return pinnedHttpRequest(url, pinned, "POST", body, signal, options);
}
