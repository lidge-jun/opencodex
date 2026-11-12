import type { Server, ServerWebSocket } from "bun";
import { LINK_RELAY_SESSION_HEADER } from "../../src/link/relay-auth";
import { LinkWireClient } from "../helpers/link-ws-client";

/**
 * A test-only stand-in for the Child's part of design T4 section 3.2, used by the link WebSocket release gate. Codex
 * talks to it as its provider. Per request it runs the relay challenge against the Home's link listener. HTTP is relayed
 * with the session header. A WebSocket upgrade is sent with the key, and Codex's upgrade is answered with this server's
 * own 101 carrying the 8 MiB message limit (C7); messages are piped both ways. A Home refusal of the upgrade becomes 426
 * (C1), which makes Codex use HTTP for the session.
 *
 * It is not lane T6's relay and claims nothing about it: no tunnel, no 503 sequence, no backpressure handling.
 */

export const STANDIN_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

const HOP_BY_HOP = new Set(["host", "connection", "upgrade", "content-length", "transfer-encoding", "authorization", "keep-alive",
  "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol", LINK_RELAY_SESSION_HEADER]);

interface Data { home: LinkWireClient }

export interface RelayStandin {
  port: number;
  /**
   * In order: "upgrade" for an admitted link socket, "upgrade-refused:<status>", "ws-create:<bytes>" for each
   * response.create Codex sent on a link socket, "ws-oversize:<bytes>" for a Codex message over the limit (closed 1009),
   * "home-close:<code>" when the Home closes a link socket, and "http:<status>" for each relayed HTTP request.
   */
  events: string[];
  stop(): Promise<void>;
}

export function startRelayStandin(options: {
  linkPort: () => number;
  identity: { keyId: string; linkId: string; fingerprint: string };
  bearer: string;
  /** Called once the Home answered an upgrade with 101, before Codex's own 101 is sent. */
  onUpgrade?: () => void;
  /** Advertise the 8 MiB limit in Codex's 101 (default). Off only for the control run that shows the header matters. */
  advertiseLimit?: boolean;
}): RelayStandin {
  const events: string[] = [];
  const homes = new Set<LinkWireClient>();
  const forward = (req: Request): Record<string, string> => {
    const out: Record<string, string> = {};
    req.headers.forEach((value, name) => { if (!HOP_BY_HOP.has(name.toLowerCase())) out[name] = value; });
    return out;
  };
  const session = async () => {
    const home = await LinkWireClient.open(options.linkPort());
    homes.add(home);
    const challenge = await home.challenge(options.identity);
    if (challenge.head.status !== 204) throw new Error("relay challenge refused: " + challenge.head.status);
    return { home, nonce: challenge.nonce };
  };
  const server: Server<Data> = Bun.serve<Data>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== "/v1/responses") return new Response(null, { status: 404 });
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const { home, nonce } = await session();
        const head = await home.upgrade({ nonce, bearer: options.bearer, headers: forward(req) });
        if (head.status !== 101) {
          events.push("upgrade-refused:" + head.status);
          home.destroy();
          return new Response("link websocket unavailable; use HTTP", { status: 426 });
        }
        events.push("upgrade");
        options.onUpgrade?.();
        const headers = options.advertiseLimit === false ? {} : { "x-codex-websocket-max-message-bytes": String(STANDIN_MAX_MESSAGE_BYTES) };
        if (srv.upgrade(req, { data: { home }, headers })) return undefined;
        home.destroy();
        return new Response(null, { status: 426 });
      }
      const body = await req.text();
      const { home, nonce } = await session();
      home.sendRequest("POST /v1/responses HTTP/1.1", { host: "127.0.0.1", "content-type": "application/json", ...forward(req),
        authorization: "Bearer " + options.bearer, [LINK_RELAY_SESSION_HEADER]: nonce }, body);
      const head = await home.readHead();
      home.destroy();
      events.push("http:" + head.status);
      return new Response(head.body, { status: head.status, headers: { "content-type": head.headers.get("content-type") ?? "text/event-stream" } });
    },
    websocket: {
      // Accepts more than the limit so an oversized message is observed and closed here (1009), never forwarded.
      maxPayloadLength: 4 * STANDIN_MAX_MESSAGE_BYTES,
      open(ws: ServerWebSocket<Data>) {
        void (async () => {
          for (;;) {
            const message = await ws.data.home.nextMessage();
            if (message.type === "text") { ws.send(message.data); continue; }
            if (message.type === "close") events.push("home-close:" + (message.code ?? "none"));
            try { ws.close(message.type === "close" ? message.code ?? 1000 : 1011, message.type === "close" ? message.reason : "home connection ended"); } catch { /* already closed */ }
            return;
          }
        })();
      },
      message(ws: ServerWebSocket<Data>, raw) {
        const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
        const bytes = Buffer.byteLength(text);
        if (bytes > STANDIN_MAX_MESSAGE_BYTES) { events.push("ws-oversize:" + bytes); ws.close(1009, "message too large"); return; }
        if (text.includes('"response.create"')) events.push("ws-create:" + bytes);
        ws.data.home.sendText(text);
      },
      close(ws: ServerWebSocket<Data>) { ws.data.home.destroy(); },
    },
  });
  return {
    port: server.port!,
    events,
    async stop() {
      for (const home of homes) home.destroy();
      await server.stop(true);
    },
  };
}
