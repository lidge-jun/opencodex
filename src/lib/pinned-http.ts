import http, { type IncomingMessage, type RequestOptions } from "node:http";
import https from "node:https";

export type PinnedAddress = { address: string; family: number };

export interface PinnedHttpGetOptions {
  headers?: HeadersInit;
  maxBytes?: number;
  idleTimeoutMs?: number;
  rejectUnauthorized?: boolean;
  context?: string;
}

/**
 * GET a URL through one previously validated address. The original hostname
 * remains authoritative for Host, SNI, and certificate verification.
 */
export function pinnedHttpGet(
  url: string,
  pinned: PinnedAddress,
  signal?: AbortSignal,
  options?: PinnedHttpGetOptions,
): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${options?.context ?? "request"} must use HTTP or HTTPS, got ${parsed.protocol}`);
  }
  const context = options?.context ?? "request";
  const idleTimeoutMs = options?.idleTimeoutMs ?? 60_000;
  const maxBytes = options?.maxBytes;
  const headers = new Headers(options?.headers);
  headers.set("host", parsed.host);
  const requestHeaders: Record<string, string> = {};
  headers.forEach((value, key) => { requestHeaders[key] = value; });

  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }

    let settled = false;
    const fail = (error: unknown) => {
      try { req.destroy(); } catch { /* ignore */ }
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const requestOptions: RequestOptions & { servername?: string } = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: "GET",
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
        try { req.destroy(); } catch { /* ignore */ }
        if (settled) return;
        settled = true;
        resolve(new Response(null, { status, headers: responseHeaders }));
        return;
      }

      let received = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          response.setTimeout(idleTimeoutMs, () => {
            const error = new Error(`${context} stalled`);
            fail(error);
            try { controller.error(error); } catch { /* closed */ }
          });
          response.on("data", (chunk: Buffer | string) => {
            const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            received += buffer.byteLength;
            if (maxBytes !== undefined && received > maxBytes) {
              const error = new Error(`${context} exceeds ${maxBytes} byte cap`);
              fail(error);
              try { controller.error(error); } catch { /* closed */ }
              return;
            }
            try { controller.enqueue(buffer); } catch { /* closed */ }
          });
          response.on("end", () => {
            try { controller.close(); } catch { /* closed */ }
          });
          response.on("error", (error: Error) => {
            fail(error);
            try { controller.error(error); } catch { /* closed */ }
          });
        },
        cancel() {
          req.destroy();
        },
      });

      if (settled) return;
      settled = true;
      resolve(new Response(stream, { status, headers: responseHeaders }));
    };

    const requestFn = parsed.protocol === "https:" ? https.request : http.request;
    const req = requestFn(requestOptions, onResponse);
    const onAbort = () => fail(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.setTimeout(idleTimeoutMs, () => fail(new Error(`${context} timed out`)));
    req.on("error", error => {
      signal?.removeEventListener("abort", onAbort);
      fail(error);
    });
    req.on("close", () => signal?.removeEventListener("abort", onAbort));
    req.end();
  });
}
