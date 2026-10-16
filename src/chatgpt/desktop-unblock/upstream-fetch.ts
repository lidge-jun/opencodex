import { Agent, request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { Readable, Transform } from "node:stream";
import type { TLSSocket } from "node:tls";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { RuntimePacPolicy } from "./pac-policy";
import { CHATGPT_UPSTREAM_HOST, dialUpstreamTunnel } from "./ws-upstream";
import type { DialUpstreamOptions } from "./ws-upstream";

const NULL_BODY_STATUSES = new Set([204, 205, 304]);
const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;

/** This agent can hand out only the socket whose route and TLS peer were already verified. */
class BoundSocketAgent extends Agent {
  private used = false;
  constructor(private readonly socket: TLSSocket) { super({ keepAlive: false, maxSockets: 1 }); }
  override createConnection(): TLSSocket {
    if (this.used || this.socket.destroyed) throw new Error("upstream connection is no longer available");
    this.used = true;
    return this.socket;
  }
}

/**
 * Fetch-shaped, streaming HTTP transport for the intercept's fixed origin. Redirects are
 * always returned to the caller. Every invocation evaluates the runtime's PAC once, then
 * writes exactly one request on the chosen verified socket; response failures never retry.
 */
export function createPolicyFetch(policy: RuntimePacPolicy, options: DialUpstreamOptions = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.hostname !== CHATGPT_UPSTREAM_HOST || url.port || url.username || url.password) {
      throw new Error("desktop upstream must be https://chatgpt.com");
    }
    const signal = options.signal ? AbortSignal.any([options.signal, request.signal]) : request.signal;
    signal.throwIfAborted();
    const tunnel = await dialUpstreamTunnel({ ...options, policy, requestUrl: url.href, signal });
    if (!tunnel) throw new Error("desktop upstream connection failed");
    if (signal.aborted) { tunnel.socket.destroy(); signal.throwIfAborted(); }
    return fetchOnSocket(request, url, tunnel.socket, signal, options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS);
  }) as typeof fetch;
}

function fetchOnSocket(request: Request, url: URL, socket: TLSSocket, signal: AbortSignal, headersTimeoutMs: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const agent = new BoundSocketAgent(socket);
    let outgoing: ClientRequest | undefined;
    let incoming: IncomingMessage | undefined;
    let upload: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const decoders: Transform[] = [];
    let closed = false;
    let responded = false;
    const timer = setTimeout(() => fail(new Error("desktop upstream headers timed out")), headersTimeoutMs);
    const release = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      void upload?.cancel().catch(() => {});
      for (const decoder of decoders) decoder.destroy();
      incoming?.destroy();
      outgoing?.destroy();
      agent.destroy();
      socket.destroy();
    };
    const fail = (error: Error) => {
      if (closed) return;
      // Destroy with the error before release so an already-returned body rejects too.
      incoming?.destroy(error);
      for (const decoder of decoders) decoder.destroy(error);
      release();
      reject(error);
    };
    const onAbort = () => fail(new Error("desktop upstream request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const headers = new Headers(request.headers);
      headers.set("host", CHATGPT_UPSTREAM_HOST);
      headers.set("connection", "close");
      // Prefer identity, but decode ordinary content codings if the server sends them anyway.
      headers.set("accept-encoding", "identity");
      const rawHeaders: string[] = [];
      headers.forEach((value, name) => rawHeaders.push(name, value));
      outgoing = httpsRequest(url, {
        method: request.method, headers: rawHeaders, agent, maxHeaderSize: 64 * 1024,
      }, response => {
        incoming = response;
        response.on("error", fail);
        if (closed || signal.aborted) { release(); response.destroy(); return; }
        responded = true;
        clearTimeout(timer);
        const responseHeaders = new Headers();
        for (let i = 0; i < response.rawHeaders.length; i += 2) {
          responseHeaders.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
        }
        const status = response.statusCode ?? 502;
        try {
          let body: ReadableStream<Uint8Array> | null = null;
          if (request.method === "HEAD" || NULL_BODY_STATUSES.has(status)) {
            response.resume();
            response.once("end", release);
          } else {
            let source: Readable = response;
            const encodings = (responseHeaders.get("content-encoding") ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
            for (const encoding of encodings.reverse()) {
              if (encoding === "identity") continue;
              const decoder = encoding === "gzip" || encoding === "x-gzip" ? createGunzip()
                : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : null;
              if (!decoder) throw new Error("desktop upstream returned an unsupported content encoding");
              decoder.on("error", fail);
              decoders.push(decoder);
              source = source.pipe(decoder);
            }
            if (decoders.length) {
              responseHeaders.delete("content-encoding");
              responseHeaders.delete("content-length");
            }
            // An async iterator pulls only when the Web stream has capacity, preserving
            // backpressure for SSE and arbitrarily large pass-through response bodies.
            const iterator = source[Symbol.asyncIterator]();
            body = new ReadableStream<Uint8Array>({
              async pull(controller) {
                try {
                  const next = await iterator.next();
                  if (next.done) { controller.close(); release(); }
                  else controller.enqueue(new Uint8Array(next.value));
                } catch (error) { controller.error(error); release(); }
              },
              cancel() { release(); },
            });
          }
          const result = new Response(body, { status, statusText: response.statusMessage ?? "", headers: responseHeaders });
          Object.defineProperty(result, "url", { value: url.href });
          resolve(result);
        } catch (error) { fail(error instanceof Error ? error : new Error("desktop upstream response failed")); }
      });
      outgoing.on("error", fail);
      outgoing.on("upgrade", (_response, upgraded) => { upgraded.destroy(); fail(new Error("unexpected upstream upgrade")); });
      outgoing.on("close", () => {
        if (!responded && !closed) fail(new Error("desktop upstream closed before headers"));
      });
      if (signal.aborted) { onAbort(); return; }
      const client = outgoing;
      if (request.body) {
        upload = request.body.getReader();
        const reader = upload;
        void (async () => {
          for (;;) {
            const next = await reader.read();
            if (closed) return;
            if (next.done) { client.end(); return; }
            if (!client.write(next.value)) await waitForDrain(client);
          }
        })().catch(error => fail(error instanceof Error ? error : new Error("desktop upstream upload failed")));
      } else client.end();
    } catch (error) { fail(error instanceof Error ? error : new Error("desktop upstream request failed")); }
  });
}

function waitForDrain(request: ClientRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      request.removeListener("drain", onDrain);
      request.removeListener("error", onError);
      request.removeListener("close", onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => onError(new Error("desktop upstream upload closed"));
    request.once("drain", onDrain);
    request.once("error", onError);
    request.once("close", onClose);
    if (request.destroyed) onClose();
  });
}
