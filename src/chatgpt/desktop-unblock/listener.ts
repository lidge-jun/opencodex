import type { Server } from "bun";
import type { PemKeyPair } from "../../claude/intercept/local-ca";
import { forwardHeadersForUpstream } from "../../claude/intercept/listener";
import { rewriteSurfaceFor, stripSendBlocksFromJson, stripSendBlocksFromSseLine } from "./rewrite";
import type { PreservedSendBlock, RewriteSurface } from "./rewrite";
import { handleWebSocketUpgrade, isRelayableUpgrade } from "./ws-relay";
import type { WsRelaySocketData } from "./ws-relay";
import type { DialUpstreamOptions } from "./ws-upstream";

/**
 * TLS listener for the ChatGPT desktop send-unblock intercept.
 *
 * Launched with `--host-resolver-rules="MAP chatgpt.com 127.0.0.1:<port>"`, the desktop app
 * dialls this listener believing it reached chatgpt.com. Requests are relayed verbatim to the
 * real upstream with the caller's own auth headers; responses pass through untouched except
 * that conversation payloads lose their client-side send-lock entries. Nothing is logged and
 * no credential is persisted -- the listener is a pipe, not a store.
 *
 * Only the exact host `chatgpt.com` is ever presented here. Subdomains (`ab.chatgpt.com`,
 * `codex-cloud-backend.chatgpt.com`) and `auth.openai.com` are not mapped by the launcher, so
 * login, telemetry and cloud sessions stay native.
 */

export const CHATGPT_UNBLOCK_UPSTREAM = "https://chatgpt.com";
export const CHATGPT_INTERCEPT_HOST = "chatgpt.com";

// fetch() transparently decodes the body, so the encoding headers would describe bytes the
// client never sees. `alt-svc` is dropped so the app never tries HTTP/3: QUIC is UDP, which
// the TCP listener cannot answer, and a stray attempt only costs the app a fallback delay.
const RESPONSE_STRIP_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "alt-svc",
]);

/** Statuses that carry no body; constructing a Response with one throws. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Local-only path the listener answers itself, never relayed. The launch watcher and
 * `ocx chatgpt status` use it to tell this listener apart from any other process that happens
 * to hold the port, and it reports the send blocks the rewrite deliberately preserved.
 */
export const CHATGPT_UNBLOCK_IDENTITY_PATH = "/__opencodex/chatgpt-unblock";
export const CHATGPT_UNBLOCK_SERVICE_ID = "opencodex-chatgpt-unblock";

/** How many distinct preserved send blocks the listener remembers for status output. */
const PRESERVED_BLOCKS_KEPT = 8;

/**
 * In-memory record of send blocks the rewrite left in place: feature name and reason only, no
 * payload, account or request data. Nothing is written to disk.
 */
export class ChatgptUnblockDiagnostics {
  private readonly preserved = new Map<string, PreservedSendBlock & { lastSeen: string }>();

  record(blocks: readonly PreservedSendBlock[]): void {
    for (const block of blocks) {
      const key = `${block.name}\u0000${block.reason}`;
      this.preserved.delete(key);
      this.preserved.set(key, { ...block, lastSeen: new Date().toISOString() });
      if (this.preserved.size > PRESERVED_BLOCKS_KEPT) this.preserved.delete(this.preserved.keys().next().value!);
    }
  }

  snapshot(): { service: string; preservedSendBlocks: (PreservedSendBlock & { lastSeen: string })[] } {
    return { service: CHATGPT_UNBLOCK_SERVICE_ID, preservedSendBlocks: [...this.preserved.values()] };
  }
}

export interface ChatgptUnblockListenerOptions {
  leaf: PemKeyPair;
  upstreamBase?: string;
  idleTimeout?: number;
  fetchImpl?: typeof fetch;
  /** Test seam: bind a fixed port instead of an ephemeral one. */
  port?: number;
  /** Test seam: where WebSocket upgrades dial instead of chatgpt.com through the configured proxy. */
  wsUpstream?: DialUpstreamOptions;
  diagnostics?: ChatgptUnblockDiagnostics;
}

function responseHeaders(source: Response): Headers {
  const headers = new Headers();
  source.headers.forEach((value, name) => {
    if (!RESPONSE_STRIP_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  });
  return headers;
}

/**
 * Line-oriented SSE rewriter. Complete lines are checked one at a time so an untouched stream
 * keeps its exact chunking and line endings; only `data:` lines whose JSON loses an entry are
 * re-serialized.
 */
export function sseRewriteStream(options: {
  surface?: RewriteSurface;
  diagnostics?: ChatgptUnblockDiagnostics;
} = {}): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const rewriteLine = (line: string): string | null => {
    const preserved: PreservedSendBlock[] = [];
    const rewritten = stripSendBlocksFromSseLine(line, options.surface, preserved);
    options.diagnostics?.record(preserved);
    return rewritten;
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      let index: number;
      while ((index = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        const rewritten = rewriteLine(line);
        controller.enqueue(encoder.encode(`${rewritten ?? line}\n`));
      }
    },
    flush(controller) {
      if (pending.length === 0) return;
      const rewritten = rewriteLine(pending);
      controller.enqueue(encoder.encode(rewritten ?? pending));
      pending = "";
    },
  });
}

function isJsonContentType(contentType: string): boolean {
  return contentType.includes("application/json") || contentType.endsWith("+json");
}

function isEventStreamContentType(contentType: string): boolean {
  return contentType.includes("text/event-stream");
}

export async function relayWithSendUnblock(
  req: Request,
  upstreamBase: string,
  fetchImpl: typeof fetch = fetch,
  diagnostics?: ChatgptUnblockDiagnostics,
): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === CHATGPT_UNBLOCK_IDENTITY_PATH) {
    return Response.json((diagnostics ?? new ChatgptUnblockDiagnostics()).snapshot(), { headers: { "cache-control": "no-store" } });
  }
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
      { error: { message: `chatgpt unblock relay failed: ${error instanceof Error ? error.message : String(error)}` } },
      { status: 502 },
    );
  }
  const headers = responseHeaders(upstream);
  const init = { status: upstream.status, statusText: upstream.statusText, headers };
  if (NULL_BODY_STATUSES.has(upstream.status) || req.method === "HEAD") return new Response(null, init);
  // Everything but the composer's conversation and usage endpoints passes through untouched.
  const surface = rewriteSurfaceFor(url.pathname);
  if (surface === null) return new Response(upstream.body, init);
  const contentType = upstream.headers.get("content-type") ?? "";
  if (isJsonContentType(contentType)) {
    let text: string;
    try {
      text = await upstream.text();
    } catch {
      return new Response(JSON.stringify({ error: { message: "chatgpt unblock upstream read failed" } }), { status: 502, headers });
    }
    const preserved: PreservedSendBlock[] = [];
    const rewritten = stripSendBlocksFromJson(text, surface, preserved);
    diagnostics?.record(preserved);
    return new Response(rewritten ?? text, init);
  }
  if (isEventStreamContentType(contentType) && upstream.body) {
    return new Response(upstream.body.pipeThrough(sseRewriteStream({ surface, diagnostics })), init);
  }
  return new Response(upstream.body, init);
}

/**
 * Bind the intercept TLS listener on an ephemeral loopback port. WebSocket upgrades are
 * relayed by `handleWebSocketUpgrade` (voice/dictation and every other WS endpoint on the
 * intercepted host); everything else keeps going through the fetch-based relay untouched.
 */
export function startChatgptUnblockListener(options: ChatgptUnblockListenerOptions): Server<WsRelaySocketData> {
  const upstreamBase = options.upstreamBase ?? CHATGPT_UNBLOCK_UPSTREAM;
  const diagnostics = options.diagnostics ?? new ChatgptUnblockDiagnostics();
  return Bun.serve<WsRelaySocketData>({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    tls: { cert: options.leaf.certPem, key: options.leaf.keyPem },
    idleTimeout: options.idleTimeout ?? 255,
    websocket: {
      // Frames both directions once Bun finished the client-side upgrade; see WsRelay.
      open(ws) {
        ws.data.relay.attach(ws);
      },
      message(ws, message) {
        ws.data.relay.clientMessage(message);
      },
      close(ws, code, reason) {
        ws.data.relay.clientClose(code, reason);
      },
    },
    async fetch(req, server) {
      if (isRelayableUpgrade(req)) return handleWebSocketUpgrade(req, server, options.wsUpstream);
      return relayWithSendUnblock(req, upstreamBase, options.fetchImpl, diagnostics);
    },
  });
}
