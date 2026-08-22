import http, { type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import https from "node:https";

export type PinnedAddress = { address: string; family: number };

export type PinnedHttpErrorCode =
  | "connect_timeout"
  | "first_byte_timeout"
  | "inactivity_timeout"
  | "output_byte_limit";

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
      resolve(new Response(stream, { status, headers: responseHeaders }));
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
