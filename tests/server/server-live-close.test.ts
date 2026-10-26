import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { createHash } from "node:crypto";
import { createServer, type AddressInfo, type Socket } from "node:net";
import {
  attachLiveSidebandUpstream,
  closeLiveSideband,
  closeLiveSidebandBeforeUpgrade,
} from "../../src/server/index/live-sideband";
import type { WsData } from "../../src/server/ws-bridge";

const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
let savedProxyEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedProxyEnv = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
  for (const key of proxyKeys) delete process.env[key];
});
afterEach(() => {
  for (const key of proxyKeys) {
    if (savedProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedProxyEnv[key];
  }
});

type Phase = "before upgrade" | "attached";
type TerminableSocket = WebSocket & { terminate(): void };

function closingOwner(phase: Phase, upstream: WebSocket) {
  const releasedStates: number[] = [];
  let finishes = 0;
  const released = Promise.withResolvers<void>();
  const release = () => { releasedStates.push(upstream.readyState); released.resolve(); };
  const data: WsData = {
    kind: "live-sideband", liveUpstream: upstream, liveOpened: true,
    liveUpstreamHandoff: { failure: () => undefined, take: () => ({ ok: true, frames: [] }) },
    liveTurnAdmissionLease: { release } as WsData["liveTurnAdmissionLease"],
    liveFinish: () => { finishes++; },
  };
  const downstream = { data, readyState: WebSocket.OPEN, close() {}, send: () => 1 } as unknown as ServerWebSocket<WsData>;
  if (phase === "attached") attachLiveSidebandUpstream(downstream);
  return {
    data, releasedStates, finishes: () => finishes,
    close() {
      if (phase === "attached") closeLiveSideband(downstream, 1001, "client finished");
      else closeLiveSidebandBeforeUpgrade(upstream, release, 1001, "client finished");
    },
    async waitForRelease() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          released.promise,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("sideband lease remained held")), 3_000); }),
        ]);
      } finally { clearTimeout(timer); }
    },
  };
}

/** A real TCP peer that optionally acknowledges Close; Bun.serve always acknowledges it. */
async function withClosePeer(answerClose: boolean, run: (fixture: {
  upstream: TerminableSocket;
  closes: Array<{ code: number; reason: string }>;
  terminations(): number;
  peerClosed: Promise<void>;
}) => Promise<void>) {
  const peers = new Set<Socket>();
  const closes: Array<{ code: number; reason: string }> = [];
  const peerClosed = Promise.withResolvers<void>();
  const server = createServer(peer => {
    peers.add(peer);
    peer.on("error", () => {});
    peer.on("close", () => { peers.delete(peer); peerClosed.resolve(); });
    let handshake = "";
    let opened = false;
    let frames = Buffer.alloc(0);
    peer.on("data", chunk => {
      if (!opened) {
        handshake += chunk.toString();
        if (!handshake.includes("\r\n\r\n")) return;
        const key = /sec-websocket-key:\s*([^\r\n]+)/i.exec(handshake)?.[1];
        const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        opened = true;
        peer.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
          + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
        return;
      }
      frames = Buffer.concat([frames, chunk]);
      if (frames.length < 2) return;
      const length = frames[1]! & 0x7f;
      const masked = (frames[1]! & 0x80) !== 0;
      const offset = masked ? 6 : 2;
      // The fixture only receives a single, short Close control frame.
      if ((frames[0]! & 0x0f) !== 8 || length > 125 || frames.length < offset + length) return;
      const payload = Buffer.from(frames.subarray(offset, offset + length));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ frames[2 + i % 4]!;
      closes.push({ code: payload.readUInt16BE(0), reason: payload.subarray(2).toString() });
      frames = Buffer.alloc(0);
      if (answerClose) peer.end(Buffer.concat([Buffer.from([0x88, payload.length]), payload]));
    });
  });
  let upstream: TerminableSocket | undefined;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    upstream = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`) as TerminableSocket;
    let terminations = 0;
    const terminate = upstream.terminate.bind(upstream);
    upstream.terminate = () => { terminations++; terminate(); };
    await new Promise<void>((resolve, reject) => {
      upstream!.addEventListener("open", () => resolve(), { once: true });
      upstream!.addEventListener("error", () => reject(new Error("fixture websocket failed to open")), { once: true });
    });
    await run({ upstream, closes, terminations: () => terminations, peerClosed: peerClosed.promise });
  } finally {
    upstream?.terminate();
    for (const peer of peers) peer.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe.each(["before upgrade", "attached"] as const)("live sideband close %s", phase => {
  // The pinned 1.4.3 runner reports close before the peer responds. Exercise this
  // transport regression under the bundled runtime as well as the ordinary suite.
  test.skipIf(!Bun.semver.satisfies(Bun.version, ">=1.4.4"))("terminates a silent peer before releasing its lease", async () => {
    await withClosePeer(false, async fixture => {
      const owner = closingOwner(phase, fixture.upstream);
      owner.close();
      expect(owner.releasedStates).toEqual([]);
      expect(fixture.upstream.readyState).toBe(WebSocket.CLOSING);
      await owner.waitForRelease();
      await fixture.peerClosed;
      expect(fixture.terminations()).toBe(1);
      expect(fixture.closes).toEqual([{ code: 1001, reason: "client finished" }]);
      expect(owner.releasedStates).toEqual([WebSocket.CLOSED]);
      if (phase === "attached") {
        expect(owner.data.liveUpstream).toBeUndefined();
        expect(owner.data.liveCloseFallback).toBeUndefined();
        expect(owner.finishes()).toBe(1);
      }
    });
  });

  test("preserves a graceful close and cancels forced termination", async () => {
    await withClosePeer(true, async fixture => {
      const owner = closingOwner(phase, fixture.upstream);
      owner.close();
      await owner.waitForRelease();
      await fixture.peerClosed;
      await Bun.sleep(1_100);
      expect(fixture.closes).toEqual([{ code: 1001, reason: "client finished" }]);
      expect(fixture.terminations()).toBe(0);
      expect(owner.releasedStates).toEqual([WebSocket.CLOSED]);
    });
  });
});

test.each(["missing", "throws", "still closing", "closed"] as const)("termination %s preserves actual-close ownership", async mode => {
  class Upstream extends EventTarget {
    readyState: number = WebSocket.OPEN;
    closes = 0;
    terminations = 0;
    terminate?: () => void;
    close() { this.closes++; this.readyState = WebSocket.CLOSING; }
    finish() { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new CloseEvent("close", { code: 1000 })); }
  }
  const cases = (["before upgrade", "attached"] as const).map(phase => {
    const upstream = new Upstream();
    if (mode !== "missing") upstream.terminate = () => {
      upstream.terminations++;
      if (mode === "throws") throw new Error("fixture termination failed");
      if (mode === "closed") upstream.readyState = WebSocket.CLOSED;
    };
    const owner = closingOwner(phase, upstream as unknown as WebSocket);
    owner.close();
    expect(owner.releasedStates).toEqual([]);
    return { upstream, owner };
  });
  try {
    await Bun.sleep(1_100);
    for (const { upstream, owner } of cases) {
      expect(upstream.closes).toBe(mode === "missing" ? 2 : 1);
      expect(upstream.terminations).toBe(mode === "missing" ? 0 : 1);
      expect(owner.releasedStates).toEqual(mode === "closed" ? [WebSocket.CLOSED] : []);
      upstream.finish();
      upstream.finish();
      expect(owner.releasedStates).toEqual([WebSocket.CLOSED]);
    }
  } finally { for (const { upstream } of cases) upstream.finish(); }
});
