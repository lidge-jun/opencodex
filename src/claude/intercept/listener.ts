import type { Server } from "bun";
import type { PemKeyPair } from "./local-ca";

/**
 * TLS listener that terminates intercepted `api.anthropic.com` tunnels.
 *
 * The CONNECT proxy splices a Claude Code tunnel onto this socket; the client then speaks
 * HTTPS believing it reached Anthropic. Messages traffic is rewritten to a loopback URL and
 * handed to the router's own request handler, which already knows how to route mapped models
 * to providers and pass genuine Claude models through with the caller's subscription
 * credential. Every other path (usage, feedback, model listings, …) is relayed verbatim to
 * the real upstream so the client keeps behaving like a first-party install.
 */

export const CLAUDE_INTERCEPT_UPSTREAM = "https://api.anthropic.com";

const INTERCEPTED_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer",
  "proxy-authenticate", "proxy-authorization", "proxy-connection", "host", "content-length",
  "accept-encoding",
]);

// fetch() transparently decodes the body, so the encoding headers would describe bytes the
// client never sees.
const RESPONSE_STRIP_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length",
]);

export function isClaudeInterceptedPath(pathname: string, method: string): boolean {
  return method === "POST" && INTERCEPTED_PATHS.has(pathname);
}

/**
 * Rebuild the request as if the client had dialled the router directly on loopback: the
 * admission and Host checks then take the same path a plain loopback bind always has.
 */
export function rewriteInterceptedRequest(req: Request, loopbackOrigin: string): Request {
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  headers.set("host", loopbackOrigin.replace(/^https?:\/\//, ""));
  return new Request(`${loopbackOrigin}${url.pathname}${url.search}`, {
    method: req.method,
    headers,
    body: req.body,
    signal: req.signal,
    redirect: "manual",
    // @ts-expect-error -- streaming request bodies require half duplex under the fetch spec.
    duplex: "half",
  });
}

export function forwardHeadersForUpstream(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, name) => {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  });
  return headers;
}

export async function relayToUpstream(req: Request, upstreamBase: string, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const url = new URL(req.url);
  const target = `${upstreamBase.replace(/\/$/, "")}${url.pathname}${url.search}`;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetchImpl(target, {
      method: req.method,
      headers: forwardHeadersForUpstream(req.headers),
      body: hasBody ? req.body : undefined,
      signal: req.signal,
      redirect: "manual",
      // @ts-expect-error -- streaming request bodies require half duplex under the fetch spec.
      duplex: "half",
    });
  } catch (error) {
    return Response.json(
      { type: "error", error: { type: "api_error", message: `intercept relay failed: ${error instanceof Error ? error.message : String(error)}` } },
      { status: 502 },
    );
  }
  const headers = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!RESPONSE_STRIP_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  });
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

export interface ClaudeInterceptListenerOptions<T = undefined> {
  leaf: PemKeyPair;
  /** Router request handler; receives the loopback-rewritten request and the intercept server. */
  dispatch: (req: Request, server: Server<T>) => Promise<Response>;
  upstreamBase?: string;
  maxRequestBodySize?: number;
  idleTimeout?: number;
  fetchImpl?: typeof fetch;
  /** Test seam: bind a fixed port instead of an ephemeral one. */
  port?: number;
}

/** Bind the intercept TLS listener on an ephemeral loopback port. */
export function startClaudeInterceptListener<T = undefined>(options: ClaudeInterceptListenerOptions<T>): Server<T> {
  const upstreamBase = options.upstreamBase ?? CLAUDE_INTERCEPT_UPSTREAM;
  let loopbackOrigin = "";
  const server = Bun.serve<T>({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    tls: { cert: options.leaf.certPem, key: options.leaf.keyPem },
    idleTimeout: options.idleTimeout ?? 255,
    ...(options.maxRequestBodySize !== undefined ? { maxRequestBodySize: options.maxRequestBodySize } : {}),
    async fetch(req, requestServer) {
      const url = new URL(req.url);
      if (isClaudeInterceptedPath(url.pathname, req.method)) {
        return options.dispatch(rewriteInterceptedRequest(req, loopbackOrigin), requestServer);
      }
      return relayToUpstream(req, upstreamBase, options.fetchImpl);
    },
  });
  loopbackOrigin = `http://127.0.0.1:${server.port}`;
  return server;
}
