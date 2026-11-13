import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { probeLinkRelayPreflight } from "../../src/client/link-relay-transport";
import { forgetLinkWebsocketAdvertisementsForTests, linkWebsocketAdvertised } from "../../src/client/link-ws-advertisement";
import { HOME_INITIATED_LINK_TUNNEL, type LinkTunnelGate } from "../../src/client/link-relay";
import { createLinkTrafficBook } from "../../src/link/traffic";
import type { LinkDiagnosticRecord } from "../../src/link/diagnostics";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { startStandinHome, standinIdentity, type StandinHome, type StandinHomeOptions } from "../fixtures/link-ws-standin-home";
import { CodexSocket, manualTimers, RawCodex, rawUpgrade, startChild } from "../helpers/link-ws-child";
import { connect, createServer, type Socket } from "node:net";
import { HomeLeg } from "../../src/client/link-websocket";
import { LINK_CHILD_WS_LIMITS } from "../../src/client/link-websocket-limits";

// Lane T6, design T4 3.2 and 3.3: a Child carries Codex's Responses WebSocket over its link when the
// Home advertises it, and answers today's 426 otherwise. The Home is a raw-TCP stand-in, so every byte
// it sends and receives is the test's.

const TODAY_426_BODY = JSON.stringify({ error: { message: "Responses WebSocket transport is disabled; use HTTP", type: "upgrade_required", code: "upgrade_required" } });

let root = "";
let previousHome: string | undefined;
const homes: StandinHome[] = [];
const children: Server<unknown>[] = [];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-link-ws-child-"));
  process.env.OPENCODEX_HOME = root;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "config.json"), JSON.stringify({ port: 0, hostname: "127.0.0.1", providers: {}, defaultProvider: "openai" }));
});

afterEach(async () => {
  for (const child of children.splice(0)) await child.stop(true);
  for (const home of homes.splice(0)) await home.stop();
  forgetLinkWebsocketAdvertisementsForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (root) removeTreeWithRetry(root);
});

/** A stand-in Home, and a Child that learned the Home's state from one readiness probe, as ordinary traffic would teach it. */
async function setup(options: {
  home?: Partial<StandinHomeOptions>; tunnel?: LinkTunnelGate; websocket?: Parameters<typeof startChild>[2]["websocket"]; learn?: boolean;
} = {}) {
  const identity = standinIdentity();
  const home = await startStandinHome({ identity, ...options.home });
  homes.push(home);
  if (options.learn !== false) {
    expect(await probeLinkRelayPreflight({ tunnelPort: home.port, admissionKey: identity.secret, linkId: identity.linkId, apiKeyId: identity.keyId })).toBe("ok");
  }
  const connectionsBefore = home.connections();
  const child = startChild(home.port, identity, { tunnel: options.tunnel, websocket: { ready: () => true, ...options.websocket } });
  children.push(child);
  return { identity, home, child, port: child.port!, homeConnections: () => home.connections() - connectionsBefore };
}

async function expectToday426(port: number, extra: Record<string, string> = {}): Promise<void> {
  const { socket, answer } = rawUpgrade(port, extra);
  const result = await answer;
  socket.destroy();
  expect(result.status).toBe(426);
  expect(result.headers.get("content-type")).toBe("application/json");
  expect(result.body).toBe(TODAY_426_BODY);
}

describe("link WebSocket on the Child: inert until the gate is open and the Home advertises", () => {
  test("a closed Child gate, or a Home that never advertised, answers today's 426 byte for byte and touches no network", async () => {
    const closed = await setup({ websocket: { ready: () => false } });
    await expectToday426(closed.port);
    expect(closed.homeConnections()).toBe(0);
    const quiet = await setup({ home: { state: () => "none" } });
    expect(linkWebsocketAdvertised(quiet.identity.linkId)).toBe(false);
    await expectToday426(quiet.port);
    expect(quiet.homeConnections()).toBe(0);
  });

  test("a non-local Origin is still refused 403 before anything else", async () => {
    const { port, homeConnections } = await setup();
    const { socket, answer } = rawUpgrade(port, { origin: "https://evil.example" });
    expect((await answer).status).toBe(403);
    socket.destroy();
    expect(homeConnections()).toBe(0);
  });
});

describe("link WebSocket on the Child: an advertising Home", () => {
  test("Codex's upgrade is accepted with the 8 MiB message header, and text flows both ways unchanged", async () => {
    const { port, home, homeConnections, identity } = await setup();
    const { socket, answer } = rawUpgrade(port);
    const result = await answer;
    expect(result.status).toBe(101);
    expect(result.headers.get("x-codex-websocket-max-message-bytes")).toBe("8388608");
    socket.destroy();
    expect(homeConnections()).toBe(1);

    const codex = await CodexSocket.open(port);
    const leg = home.sockets.at(-1)!;
    // The Home leg carried the link key and the session nonce, never Codex's own credential.
    expect(leg.request.headers.get("authorization")).toBe("Bearer " + identity.secret);
    expect(leg.request.headers.get("thread-id")).toBe("thread-codex");
    const create = JSON.stringify({ type: "response.create", model: "m", input: [{ role: "user", content: "h\u00e9llo" }] });
    codex.ws.send(create);
    expect(await leg.until(frame => frame.type === "text")).toEqual({ type: "text", data: create });
    leg.sendText('{"type":"response.created"}');
    leg.sendText('{"type":"response.completed"}');
    expect(await codex.next(2)).toEqual(['{"type":"response.created"}', '{"type":"response.completed"}']);
  });

  test("a local Origin, a Home refusal, a broken 101 and a Home that stopped advertising all answer today's 426", async () => {
    const origin = await setup();
    await expectToday426(origin.port, { origin: "http://127.0.0.1:" + origin.port });
    expect(origin.homeConnections()).toBe(0);
    for (const status of [401, 426, 503]) {
      const refused = await setup({ home: { upgrade: () => ({ kind: "refuse", status }) } });
      await expectToday426(refused.port);
      await refused.home.whenClosed(2);
    }
    const broken = await setup({ home: { upgrade: () => ({ kind: "accept", wrongAccept: true }) } });
    await expectToday426(broken.port);
    await broken.home.whenClosed(2);
    // The probe saw on; the Home switched off before this upgrade's own preflight: that answer decides.
    let state: "on" | "none" = "on";
    const switched = await setup({ home: { state: () => state } });
    state = "none";
    await expectToday426(switched.port);
    expect(linkWebsocketAdvertised(switched.identity.linkId)).toBe(false);
    expect(switched.home.requests.some(request => request.path === "/v1/responses")).toBe(false);
  });

  test("close codes are relayed both ways; a Home close without a code or a dropped Home becomes 1011", async () => {
    const { port, home } = await setup();
    for (const code of [1012, 1013, 1014]) {
      const registered = await CodexSocket.open(port);
      home.sockets.at(-1)!.sendClose(code, "registered");
      expect(await registered.closed()).toEqual({ code, reason: "registered" });
    }
    const revoked = await CodexSocket.open(port);
    home.sockets.at(-1)!.sendClose(4401, "link revoked");
    expect(await revoked.closed()).toEqual({ code: 4401, reason: "link revoked" });
    const empty = await CodexSocket.open(port);
    home.sockets.at(-1)!.sendClose();
    expect((await empty.closed()).code).toBe(1011);
    const dropped = await CodexSocket.open(port);
    home.sockets.at(-1)!.destroy();
    expect((await dropped.closed()).code).toBe(1011);
    const leaving = await CodexSocket.open(port);
    const leg = home.sockets.at(-1)!;
    leaving.ws.close(1000, "bye");
    expect(await leg.until(frame => frame.type === "close")).toMatchObject({ type: "close", code: 1000 });
  });

  test("the Child ends a close it started once the Home answers it, or after the bound when it does not", async () => {
    const clock = manualTimers();
    const { port, home } = await setup({ websocket: { timers: clock.timers } });
    const codex = await CodexSocket.open(port);
    const leg = home.sockets.at(-1)!;
    codex.ws.close(1000);
    await leg.until(frame => frame.type === "close");
    expect(leg.ended).toBe(false);
    expect(clock.fire(5_000)).toBe(1);
    await leg.closed();
  });

  test("a binary message from Codex closes both legs with 1003 and is never forwarded", async () => {
    const { port, home } = await setup();
    const codex = await CodexSocket.open(port);
    const leg = home.sockets.at(-1)!;
    codex.ws.send(new Uint8Array([1, 2, 3]));
    expect((await codex.closed()).code).toBe(1003);
    expect(await leg.until(frame => frame.type === "close")).toMatchObject({ code: 1003 });
    expect(leg.frames.some(frame => frame.type === "binary")).toBe(false);
  });

  test("a Codex message over 8 MiB is refused with 1009 before any of it reaches the Home", async () => {
    const { port, home } = await setup();
    const codex = await CodexSocket.open(port);
    const leg = home.sockets.at(-1)!;
    codex.ws.send("x".repeat(8 * 1024 * 1024 + 1));
    expect((await codex.closed()).code).toBe(1009);
    // Bun refuses it before the handler; the Home leg then closes like any other socket Codex lost.
    expect(await leg.until(frame => frame.type === "close")).toMatchObject({ type: "close" });
    expect(leg.frames.some(frame => frame.type === "text")).toBe(false);
  });

  test("a Home message over 4 MiB + 64 KiB closes Codex with 1011 and the Home with 1009", async () => {
    const { port, home } = await setup();
    const codex = await CodexSocket.open(port);
    const leg = home.sockets.at(-1)!;
    leg.sendText("y".repeat(4 * 1024 * 1024 + 64 * 1024 + 1));
    expect((await codex.closed()).code).toBe(1011);
    expect(await leg.until(frame => frame.type === "close")).toMatchObject({ code: 1009 });
    expect(codex.messages).toEqual([]);
  });

  test("a message completed in the same chunk before a refused frame is delivered first", async () => {
    const { port, home } = await setup();
    const codex = await CodexSocket.open(port);
    const leg = home.sockets.at(-1)!;
    const completed = Buffer.from('{"type":"response.completed"}');
    // One write: a whole text frame, then a frame with an RSV bit set, which no server may send.
    leg.raw(Buffer.concat([Buffer.from([0x81, completed.length]), completed, Buffer.from([0xc1, 1, 0x78])]));
    expect((await codex.closed()).code).toBe(1011);
    expect(codex.messages).toEqual(['{"type":"response.completed"}']);
    expect(await leg.until(frame => frame.type === "close")).toMatchObject({ code: 1002 });
  });

  test("the same, fed to the relay in one piece: the bytes the Home sent with its 101", async () => {
    const completed = Buffer.from('{"type":"response.completed"}');
    const head = Buffer.concat([Buffer.from([0x81, completed.length]), completed, Buffer.from([0xc1, 1, 0x78])]);
    const { port, home } = await setup({ home: { upgrade: () => ({ kind: "accept", head }) } });
    const codex = await CodexSocket.open(port);
    expect((await codex.closed()).code).toBe(1011);
    expect(codex.messages).toEqual(['{"type":"response.completed"}']);
    expect(await home.sockets.at(-1)!.until(frame => frame.type === "close")).toMatchObject({ code: 1002 });
  });

  test("a second Codex message while the first is still unflushed toward the Home closes both legs (1013, 1001)", async () => {
    const { port, home } = await setup();
    const codex = await CodexSocket.open(port);
    const leg = home.sockets.at(-1)!;
    leg.socket.pause(); // the Home stops reading: the first message cannot flush
    codex.ws.send("a".repeat(8 * 1024 * 1024 - 64));
    codex.ws.send("second");
    expect((await codex.closed()).code).toBe(1013);
    leg.socket.resume();
    expect(await leg.until(frame => frame.type === "close")).toMatchObject({ code: 1001 });
    expect(leg.frames.filter(frame => frame.type === "text").map(frame => frame.type === "text" ? frame.data.length : 0)).toEqual([8 * 1024 * 1024 - 64]);
  });

  test("toward a stalled Codex the Child stops reading the Home above 1 MiB and resumes on drain, dropping nothing", async () => {
    const pauses: boolean[] = [];
    let paused!: () => void;
    const pausedOnce = new Promise<void>(resolve => { paused = resolve; });
    const { port, home } = await setup({ websocket: { onDownlinkPause: value => { pauses.push(value); if (value) paused(); } } });
    const { socket, answer } = rawUpgrade(port);
    const result = await answer;
    expect(result.status).toBe(101);
    socket.pause(); // Codex stops reading
    const leg = home.sockets.at(-1)!;
    const chunk = "z".repeat(512 * 1024);
    for (let i = 0; i < 40; i += 1) leg.sendText(chunk + i);
    await pausedOnce;
    const raw = new RawCodex(socket, result.rest);
    socket.resume();
    await raw.count("text", 40);
    expect(raw.events.filter(event => event.type === "text").map(event => event.type === "text" ? event.data.slice(chunk.length) : "")).toEqual(Array.from({ length: 40 }, (_, i) => String(i)));
    expect(pauses[0]).toBe(true);
    expect(pauses.at(-1)).toBe(false);
    socket.destroy();
  });

  test("the Home's pings are answered on its leg; Codex sees none of them", async () => {
    const { port, home } = await setup();
    const codex = await CodexSocket.open(port);
    const leg = home.sockets.at(-1)!;
    leg.sendFrame(9, Buffer.from("hi"));
    expect(await leg.until(frame => frame.type === "pong")).toEqual({ type: "pong", payload: Buffer.from("hi") });
    leg.sendText("after");
    expect(await codex.next(1)).toEqual(["after"]);
  });

  test("a runtime stop closes Codex's socket and the Home leg with 1001", async () => {
    const { port, home, child } = await setup();
    const codex = await CodexSocket.open(port);
    const leg = home.sockets.at(-1)!;
    await child.stop(true);
    children.splice(children.indexOf(child), 1);
    expect((await codex.closed()).code).toBe(1001);
    expect(await leg.until(frame => frame.type === "close")).toMatchObject({ code: 1001 });
  });
});

describe("link WebSocket on the Child: limits and setup", () => {
  test("a closing socket keeps its slot until the Home connection has actually closed", async () => {
    const clock = manualTimers();
    const { port, home } = await setup({ websocket: { timers: clock.timers, limits: { openSockets: 1 } } });
    const first = await CodexSocket.open(port);
    const leg = home.sockets.at(-1)!;
    first.ws.close(1000);
    await leg.until(frame => frame.type === "close"); // the stand-in never answers the close
    await expectToday426(port);
    expect(clock.fire(5_000)).toBe(1);
    await leg.closed();
    // Released only by the close event of the Home connection, which follows the destroy.
    for (;;) {
      const { socket, answer } = rawUpgrade(port);
      const result = await answer;
      socket.destroy();
      if (result.status === 101) break;
      expect(result.status).toBe(426);
    }
  });

  test("a stop aborts upgrades still in setup, in the tunnel hold and at the Home, and keeps none of them", async () => {
    let entered!: () => void;
    const inHold = new Promise<void>(resolve => { entered = resolve; });
    const holding: LinkTunnelGate = {
      connected: () => ({ kind: "unavailable" }), pending: () => true,
      waitForConnected: (_ms, signal) => new Promise<boolean>(resolve => { entered(); signal?.addEventListener("abort", () => resolve(false), { once: true }); }),
    };
    const hold = await setup({ tunnel: holding });
    const waiting = rawUpgrade(hold.port);
    await inHold;
    await hold.child.stop(false);
    children.splice(children.indexOf(hold.child), 1);
    expect([426, 503]).toContain((await waiting.answer.catch(() => ({ status: 426 }))).status);
    expect(hold.homeConnections()).toBe(0);

    let arrived!: () => void;
    const atHome = new Promise<void>(resolve => { arrived = resolve; });
    const hang = await setup({ home: { upgrade: () => { arrived(); return { kind: "hang" }; } } });
    const pending = rawUpgrade(hang.port);
    await atHome;
    await hang.child.stop(false);
    children.splice(children.indexOf(hang.child), 1);
    await hang.home.whenClosed(2);
    pending.socket.destroy();
  });

  test("an ownership check that never answers is bounded by the setup budget, and its slot is freed", async () => {
    const clock = manualTimers();
    let calls = 0;
    let asked!: () => void;
    const firstAsked = new Promise<void>(resolve => { asked = resolve; });
    const stalled: LinkTunnelGate = {
      connected: () => { if (++calls === 1) { asked(); return new Promise(() => {}); } return { kind: "match" }; },
      pending: () => false, waitForConnected: async () => false,
    };
    const { port } = await setup({ tunnel: stalled, websocket: { timers: clock.timers, limits: { settingUp: 1 } } });
    const { socket, answer } = rawUpgrade(port);
    await firstAsked; // the budget timer is armed before the first ownership check
    expect(clock.fire(8_000)).toBe(1);
    expect((await answer).status).toBe(426);
    socket.destroy();
    const codex = await CodexSocket.open(port);
    expect(codex.ws.readyState).toBe(WebSocket.OPEN);
  });

  test("open sockets past the cap, sockets in setup past their cap, and a refused memory reservation answer 426", async () => {
    const capped = await setup({ websocket: { limits: { openSockets: 2 } } });
    const first = await CodexSocket.open(capped.port), second = await CodexSocket.open(capped.port);
    await expectToday426(capped.port);
    expect(capped.homeConnections()).toBe(2);
    first.ws.close(); second.ws.close();
    let arrived!: () => void;
    const held = new Promise<void>(resolve => { arrived = resolve; });
    const setupCap = await setup({ websocket: { limits: { settingUp: 1 } }, home: { upgrade: () => { arrived(); return { kind: "hang" }; } } });
    const hanging = rawUpgrade(setupCap.port);
    await held;
    await expectToday426(setupCap.port);
    hanging.socket.destroy();
    const memory = await setup({ websocket: { limits: { memoryBudgetBytes: 0 } } });
    await expectToday426(memory.port);
    expect(memory.homeConnections()).toBe(0);
  });

  test("Codex leaving during setup closes the Home connection and frees the slot", async () => {
    let arrived!: () => void;
    const held = new Promise<void>(resolve => { arrived = resolve; });
    const { port, home } = await setup({ websocket: { limits: { openSockets: 1 } }, home: { upgrade: request => { if (request.connection === 2) { arrived(); return { kind: "hang" }; } return { kind: "accept" }; } } });
    const leaving = rawUpgrade(port);
    await held;
    leaving.socket.destroy();
    await home.whenClosed(2);
    const codex = await CodexSocket.open(port);
    expect(codex.ws.readyState).toBe(WebSocket.OPEN);
  });

  test("the 8 s setup budget ends a stalled setup with 426 and closes the Home connection", async () => {
    const clock = manualTimers();
    let arrived!: () => void;
    const held = new Promise<void>(resolve => { arrived = resolve; });
    const { port, home } = await setup({ websocket: { timers: clock.timers }, home: { upgrade: () => { arrived(); return { kind: "hang" }; } } });
    const { socket, answer } = rawUpgrade(port);
    await held;
    // The relay's setup budget and the transport's own upgrade bound are both 8 s.
    expect(clock.fire(8_000)).toBeGreaterThanOrEqual(1);
    const result = await answer;
    socket.destroy();
    expect(result.status).toBe(426);
    await home.whenClosed(2);
  });
});

describe("link WebSocket on the Child: the tunnel gate", () => {
  test("a reconnecting tunnel that comes back within the hold proceeds; one still reconnecting gets 503, never a terminal code", async () => {
    let up = false;
    const tunnel: LinkTunnelGate = { connected: () => ({ kind: up ? "match" : "unavailable" }), pending: () => !up, waitForConnected: async () => { up = true; return true; } };
    const back = await setup({ tunnel });
    await CodexSocket.open(back.port);
    expect(back.homeConnections()).toBe(1);
    const holds: number[] = [];
    const stuck: LinkTunnelGate = { connected: () => ({ kind: "unavailable" }), pending: () => true, waitForConnected: async ms => { holds.push(ms); return false; } };
    const down = await setup({ tunnel: stuck });
    const { socket, answer } = rawUpgrade(down.port);
    const result = await answer;
    socket.destroy();
    expect(result.status).toBe(503);
    expect(result.headers.has("retry-after")).toBe(false);
    expect(JSON.parse(result.body)).toEqual({ error: { type: "server_error", code: "link_websocket_unavailable", message: "The link to the Home is reconnecting; retry." } });
    expect(holds).toEqual([3_000]);
    expect(down.homeConnections()).toBe(0);
  });

  test("a failed tunnel answers 426 at once; a Home-initiated link has no tunnel state and goes straight to the preflight", async () => {
    const failed: LinkTunnelGate = { connected: () => ({ kind: "unavailable" }), pending: () => false, waitForConnected: async () => false };
    const broken = await setup({ tunnel: failed });
    await expectToday426(broken.port);
    expect(broken.homeConnections()).toBe(0);
    const homeInitiated = await setup({ tunnel: HOME_INITIATED_LINK_TUNNEL });
    await CodexSocket.open(homeInitiated.port);
    expect(homeInitiated.homeConnections()).toBe(1);
  });

  test("an ownership proof that hit its deadline gets one fresh proof, as an HTTP request does", async () => {
    let calls = 0;
    const tunnel: LinkTunnelGate = { connected: () => ({ kind: ++calls === 1 ? "deadline" : "match" }), pending: () => false, waitForConnected: async () => false };
    const { port, homeConnections } = await setup({ tunnel });
    await CodexSocket.open(port);
    expect(calls).toBe(2);
    expect(homeConnections()).toBe(1);
  });
});

describe("link WebSocket on the Child: accounting and diagnostics", () => {
  test("a Home that is gone before Bun opens Codex's socket still closes it (1011) once it opens", async () => {
    const server = createServer(() => {});
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    const socket: Socket = connect({ host: "127.0.0.1", port: (server.address() as { port: number }).port });
    await new Promise<void>(resolve => socket.once("connect", () => resolve()));
    let released!: () => void;
    const gone = new Promise<void>(resolve => { released = resolve; });
    const ends: string[] = [];
    const leg = new HomeLeg(socket, Buffer.alloc(0), LINK_CHILD_WS_LIMITS, manualTimers().timers,
      { toHome() {}, fromHome() {}, uncounted() {}, end() {} }, reason => ends.push(reason), () => released());
    // The connection fails (a reset, an error) after the upgrade and before Bun runs open().
    socket.destroy();
    await gone;
    const closes: Array<[number, string]> = [];
    leg.attach({ send: () => 1, getBufferedAmount: () => 0, close: (code?: number, reason?: string) => { closes.push([code!, reason!]); } });
    expect(ends).toEqual(["home_dropped"]);
    expect(closes).toEqual([[1011, "home connection ended"]]);
    server.close();
  });

  test("a message completed before a refused frame in one call to the relay is delivered first (HomeLeg, head bytes)", async () => {
    const server = createServer(() => {});
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    const socket: Socket = connect({ host: "127.0.0.1", port: (server.address() as { port: number }).port });
    await new Promise<void>(resolve => socket.once("connect", () => resolve()));
    const completed = Buffer.from('{"type":"response.completed"}');
    const head = Buffer.concat([Buffer.from([0x81, completed.length]), completed, Buffer.from([0xc1, 1, 0x78])]);
    const ends: string[] = [];
    const leg = new HomeLeg(socket, head, LINK_CHILD_WS_LIMITS, manualTimers().timers,
      { toHome() {}, fromHome() {}, uncounted() {}, end() {} }, reason => ends.push(reason), () => {});
    const calls: string[] = [];
    // attach() feeds the whole head to the relay in one call.
    leg.attach({ send: (data: string | Bun.BufferSource) => { calls.push("send:" + String(data)); return 1; }, getBufferedAmount: () => 0,
      close: (code?: number) => { calls.push("close:" + code); } });
    expect(calls).toEqual(['send:{"type":"response.completed"}', "close:1011"]);
    expect(ends).toEqual(["protocol"]);
    socket.destroy();
    server.close();
  });

  test("one socket counts as one request with its message payloads; a close ends it complete", async () => {
    const traffic = createLinkTrafficBook("relayed");
    const { port, home, identity } = await setup({ websocket: { traffic } });
    const codex = await CodexSocket.open(port);
    const leg = home.sockets.at(-1)!;
    codex.ws.send("12345");
    await leg.until(frame => frame.type === "text");
    leg.sendText("abc");
    await codex.next(1);
    leg.sendClose(1000);
    await codex.closed();
    expect(traffic.snapshot(identity.linkId)).toMatchObject({ requests: 1, incomplete: 0, toHomeBytes: 5, fromHomeBytes: 3 });
  });

  test("diagnostics carry fixed words only: no key, no content, no address", async () => {
    const records: LinkDiagnosticRecord[] = [];
    const { port, home, identity } = await setup({ websocket: { diagnostic: record => records.push(record) } });
    const codex = await CodexSocket.open(port);
    codex.ws.send("secret-content");
    await home.sockets.at(-1)!.until(frame => frame.type === "text");
    codex.ws.close(1000);
    await home.sockets.at(-1)!.until(frame => frame.type === "close");
    await expectToday426(port, { origin: "http://127.0.0.1:" + port });
    expect(records).toEqual([
      { event: "link_ws_open", outcome: "connected" },
      { event: "link_ws_close", outcome: "client" },
      { event: "link_ws_fallback", outcome: "origin" },
    ]);
    const text = JSON.stringify(records);
    for (const secret of [identity.secret, "secret-content", String(home.port), identity.linkId]) expect(text).not.toContain(secret);
  });
});
