import type { Server, ServerWebSocket } from "bun";
import { expect } from "bun:test";

/**
 * Observable state of the mock sideband peer, for a case whose only symptom is a deadline.
 *
 * A relay case that exceeds its ceiling reports the ceiling and nothing else: not which leg was
 * slow, and not whether the peer's reply was actually handed to the socket. The second one is
 * knowable. `ServerWebSocket.send` reports what it did with the payload: a positive byte count
 * when it was written, `-1` when it was enqueued behind backpressure, `0` when it was dropped.
 * That separates a reply this peer never handed to the socket from one it did. It is not proof
 * of delivery -- nothing on this side can observe what the client received.
 *
 * Note what the large frame actually is. The 50MiB payload travels client to peer; the reply is
 * a short `bytes:<length>` acknowledgement, so `send=` on the reply says nothing about the big
 * frame. What proves the peer saw all of it is the `recv=` count it recorded.
 * See https://bun.com/docs/runtime/http/websockets.
 *
 * This records; it diagnoses nothing on its own and asserts nothing.
 */
export interface SidebandRelayProbe {
  /**
   * Monotonic count of observable relay events.
   *
   * Handed to `phaseTimer` as its progress probe so a tick can say whether anything moved since
   * the last one. Without it every tick reads "no movement" and a stalled leg looks the same as
   * a slow runner.
   *
   * It counts milestones and nothing finer. A frame is one event whatever its size, so a tick
   * that reports no movement means no further milestone was reached -- not that the transport
   * stalled. A partially delivered frame and a runner busy with CPU work both look like this.
   */
  progress(): number;
  /** Advance from the client side of the relay, which this module cannot observe directly. */
  noteClient(event: string): void;
  /** One line naming what the peer saw, for a failure message. */
  summary(): string;
}

export interface SidebandRelayUpstream {
  readonly server: Server;
  readonly seenPaths: string[];
  readonly seenUpgradeHeaders: Headers[];
  readonly probe: SidebandRelayProbe;
}

/**
 * A mock sideband peer that echoes what it receives and remembers how that went.
 *
 * Behaviorally identical to the inline peer it replaces: same upgrade handling, same echo
 * payloads, same `maxPayloadLength`.
 */
export function sidebandRelayUpstream(maxPayloadLength: number): SidebandRelayUpstream {
  const seenPaths: string[] = [];
  const seenUpgradeHeaders: Headers[] = [];
  const events: string[] = [];
  let ticks = 0;
  const note = (event: string): void => {
    ticks += 1;
    // Bounded: a failure message is evidence, not a transcript.
    if (events.length < 24) events.push(event);
  };
  const probe: SidebandRelayProbe = {
    progress: () => ticks,
    noteClient: event => note("client:" + event),
    summary: () => events.join(" "),
  };
  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        seenPaths.push(url.pathname);
        seenUpgradeHeaders.push(req.headers);
        note("upgrade");
        if (server.upgrade(req, { data: {} })) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      maxPayloadLength,
      message(ws: ServerWebSocket<unknown>, message: string | Buffer) {
        const bytes = typeof message === "string" ? message.length : message.byteLength;
        note("recv=" + bytes);
        const sent = ws.send(typeof message === "string" ? `echo:${message}` : `bytes:${message.byteLength}`);
        // The reply is a short acknowledgement, not an echo of a large frame, and this number is
        // about that reply only: negative is queued behind backpressure, zero is dropped, and a
        // positive count is bytes written to the socket rather than bytes the client received.
        note("send=" + sent);
      },
      drain(ws: ServerWebSocket<unknown>) {
        note("drain=" + ws.getBufferedAmount());
      },
      close(_ws: ServerWebSocket<unknown>, code: number) {
        note("peerclose=" + code);
      },
    },
  });
  return { server, seenPaths, seenUpgradeHeaders, probe };
}

/**
 * What the peer must have received to have been reached as itself.
 *
 * Lives beside the peer because it asserts the peer's own record: the path it was opened on and
 * the headers the relay forwarded, including the caller's authorization.
 */
export function expectSidebandUpgrade(
  upstream: Pick<SidebandRelayUpstream, "seenPaths" | "seenUpgradeHeaders">,
  path: string,
  token: string,
): void {
  expect(upstream.seenPaths).toContain(path);
  expect(upstream.seenUpgradeHeaders).toHaveLength(1);
  expect(upstream.seenUpgradeHeaders[0]?.get("openai-alpha")).toBe("quicksilver=v2");
  expect(upstream.seenUpgradeHeaders[0]?.get("x-session-id")).toBe("rts_side");
  expect(upstream.seenUpgradeHeaders[0]?.get("authorization")).toBe(`Bearer ${token}`);
}

/**
 * Point ChatGPT sideband WebSocket targets at a local mock for the duration of one case.
 *
 * The configuration stays canonical: the relay still resolves api.openai.com, and only the
 * socket the runtime opens on that host is redirected. The untouched constructor comes back
 * with it because the case needs one that is NOT redirected to open its own client against the
 * proxy under test.
 */
export function redirectSidebandWebSocket(port: number): {
  readonly OriginalWebSocket: typeof WebSocket;
  restore(): void;
} {
  const OriginalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends OriginalWebSocket {
    constructor(url: string | URL, protocols?: string | string[] | Record<string, unknown>) {
      const parsed = new URL(String(url));
      const target = parsed.hostname === "api.openai.com" && parsed.pathname.startsWith("/v1/live/")
        ? `ws://127.0.0.1:${port}${parsed.pathname}${parsed.search}`
        : String(url);
      super(target, protocols as string[]);
    }
  } as typeof WebSocket;
  return { OriginalWebSocket, restore: () => { globalThis.WebSocket = OriginalWebSocket; } };
}

/**
 * Open a sideband client against the proxy under test, with the headers the relay must forward.
 *
 * Beside `expectSidebandUpgrade` deliberately: that function asserts these exact values on the
 * peer's side, so the request and the assertion about it cannot drift apart in separate files.
 * The constructor is passed in because it has to be the one that was NOT redirected.
 */
export function openSidebandClient(
  WebSocketCtor: typeof WebSocket,
  serverUrl: string | URL,
  path: string,
  token: string,
): WebSocket {
  const wsUrl = new URL(path, serverUrl);
  wsUrl.protocol = "ws:";
  return new WebSocketCtor(wsUrl.toString(), {
    headers: {
      authorization: `Bearer ${token}`,
      "chatgpt-account-id": "acct-123",
      "openai-alpha": "quicksilver=v2",
      "x-session-id": "rts_side",
    },
  } as unknown as string[]);
}
