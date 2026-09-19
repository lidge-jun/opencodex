import type { Server, ServerWebSocket } from "bun";
import { expect } from "bun:test";

/**
 * Observable state of the mock sideband peer, for a case whose only symptom is a deadline.
 *
 * A relay case that exceeds its ceiling reports the ceiling and nothing else: not which leg was
 * slow, and not whether the peer's reply was actually handed to the socket. Both are knowable.
 * `ServerWebSocket.send` reports what it did with the payload — a positive byte count when it
 * went out, `-1` when it was enqueued behind backpressure, `0` when it was dropped — so a
 * 50MiB echo that never left is distinguishable from one still in flight, which is exactly the
 * ambiguity at a frame ceiling. See https://bun.com/docs/runtime/http/websockets.
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
        // Negative means queued behind backpressure and zero means dropped; neither is delivery.
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
