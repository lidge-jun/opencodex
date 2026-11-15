import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openLinkWebsocket, type LinkWebsocketSetup } from "../../src/client/link-ws-transport";
import { setLinkWebsocketChildReadyForTests } from "../../src/client/link-websocket-limits";
import { manualTimers } from "../helpers/link-ws-child";
import { forgetLinkWebsocketAdvertisementsForTests, linkWebsocketAdvertised } from "../../src/client/link-ws-advertisement";
import { encodeClientText, LinkWsFrameReader } from "../../src/client/link-ws-framer";
import { startStandinHome, standinIdentity, type StandinHome, type StandinHomeOptions, type StandinUpgrade } from "../fixtures/link-ws-standin-home";

// Lane T6, design T4 3.2 steps 6 to 9: the Home leg of a link WebSocket is one preflight and one
// upgrade on one physical connection, and its own preflight answer decides.

const homes: StandinHome[] = [];
const opened: LinkWebsocketSetup[] = [];
beforeEach(() => setLinkWebsocketChildReadyForTests(true));
afterEach(async () => {
  setLinkWebsocketChildReadyForTests(false);
  for (const setup of opened.splice(0)) if (setup.ok) setup.socket.destroy();
  forgetLinkWebsocketAdvertisementsForTests();
  for (const home of homes.splice(0)) await home.stop();
});

async function home(options: Partial<StandinHomeOptions> = {}) {
  const identity = standinIdentity();
  const started = await startStandinHome({ identity, ...options });
  homes.push(started);
  return { home: started, identity, target: { tunnelPort: started.port, admissionKey: identity.secret, linkId: identity.linkId, apiKeyId: identity.keyId } };
}

function forwarded(secret: string, extra: Record<string, string> = {}): Headers {
  return new Headers({ authorization: "Bearer " + secret, "thread-id": "thread-1", ...extra });
}

async function open(target: Parameters<typeof openLinkWebsocket>[0], headers: Headers, signal = new AbortController().signal, extra: Partial<Parameters<typeof openLinkWebsocket>[2]> = {}) {
  const setup = await openLinkWebsocket(target, headers, { signal, ...extra });
  opened.push(setup);
  return setup;
}

describe("openLinkWebsocket", () => {
  test("an advertising Home: the upgrade runs on the authenticated connection, with the key, the nonce and a clean header set", async () => {
    const { home: standin, target, identity } = await home();
    const setup = await open(target, forwarded(identity.secret, {
      origin: "http://127.0.0.1:1", "sec-websocket-extensions": "permessage-deflate", "sec-websocket-protocol": "x", "sec-websocket-key": "codex-own-key",
    }));
    expect(setup.ok).toBe(true);
    expect(standin.connections()).toBe(1);
    const upgrade = standin.requests.at(-1)!;
    expect(upgrade.path).toBe("/v1/responses");
    expect(upgrade.connection).toBe(1);
    expect(upgrade.headers.get("authorization")).toBe("Bearer " + identity.secret);
    expect(upgrade.headers.get("thread-id")).toBe("thread-1");
    expect(upgrade.headers.get("sec-websocket-version")).toBe("13");
    expect(upgrade.headers.get("sec-websocket-key")).not.toBe("codex-own-key");
    for (const name of ["origin", "sec-websocket-extensions", "sec-websocket-protocol"]) expect(upgrade.headers.has(name)).toBe(false);
    expect(linkWebsocketAdvertised(identity.linkId)).toBe(true);
  });

  test("frames flow both ways on the returned socket, and bytes the Home sent with its 101 come first", async () => {
    const first = Buffer.from([0x81, 5, ...Buffer.from("first")]);
    const { home: standin, target, identity } = await home({ upgrade: () => ({ kind: "accept", head: first }) });
    const setup = await open(target, forwarded(identity.secret));
    if (!setup.ok) throw new Error(setup.reason);
    const reader = new LinkWsFrameReader({ maxMessageBytes: 1 << 20, maxFragments: 16 });
    const received: string[] = [];
    const next = () => new Promise<void>(resolve => setup.socket.once("data", chunk => { for (const e of reader.push(chunk)) if (e.type === "text") received.push(e.data); resolve(); }));
    for (const e of reader.push(setup.head)) if (e.type === "text") received.push(e.data);
    const socket = standin.sockets[0]!;
    setup.socket.write(encodeClientText('{"type":"response.create"}'));
    expect(await socket.until(frame => frame.type === "text")).toEqual({ type: "text", data: '{"type":"response.create"}' });
    expect(socket.frames.some(frame => frame.type === "unmasked")).toBe(false);
    const arrived = next();
    socket.sendText("second");
    await arrived;
    expect(received).toEqual(["first", "second"]);
  });

  test("a Home that does not advertise on this very answer gets no upgrade: off, no pair, or a pair whose proof fails", async () => {
    for (const state of ["off", "none", "bad-proof"] as const) {
      const { home: standin, target, identity } = await home({ state: () => state });
      const setup = await open(target, forwarded(identity.secret));
      expect(setup).toEqual({ ok: false, reason: "not_advertised" });
      expect(standin.requests.map(request => request.path.split("?")[0])).toEqual(["/.well-known/opencodex/link-relay-auth"]);
      expect(linkWebsocketAdvertised(identity.linkId)).toBe(false);
    }
  });

  test("a refused or unreachable preflight is a preflight failure", async () => {
    const { target, identity } = await home({ challengeStatus: () => 503 });
    expect(await open(target, forwarded(identity.secret))).toMatchObject({ ok: false, reason: "preflight", status: 503 });
    const { target: closed, home: gone, identity: other } = await home();
    await gone.stop();
    expect(await open(closed, forwarded(other.secret))).toEqual({ ok: false, reason: "preflight" });
  });

  test("a Home refusal of the upgrade itself is home_refused, with its status", async () => {
    const { target, identity } = await home({ upgrade: () => ({ kind: "refuse", status: 426 }) });
    expect(await open(target, forwarded(identity.secret))).toEqual({ ok: false, reason: "home_refused", status: 426 });
  });

  test("an invalid 101 destroys the socket: wrong or missing accept, an extension, a subprotocol, no Upgrade or Connection", async () => {
    const shapes: StandinUpgrade[] = [
      { kind: "accept", wrongAccept: true },
      { kind: "accept", omitAccept: true },
      { kind: "accept", extraHeaders: ["sec-websocket-extensions: permessage-deflate"] },
      { kind: "accept", extraHeaders: ["sec-websocket-protocol: x"] },
      { kind: "raw", bytes: "HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\n\r\n" },
      { kind: "raw", bytes: "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\n\r\n" },
    ];
    for (const shape of shapes) {
      const { home: standin, target, identity } = await home({ upgrade: () => shape });
      expect(await open(target, forwarded(identity.secret))).toEqual({ ok: false, reason: "handshake" });
      expect(standin.connections()).toBe(1);
      await standin.whenClosed(1);
    }
  });

  test("an abort while the Home holds the upgrade destroys the connection and opens nothing", async () => {
    let arrived!: () => void;
    const seen = new Promise<void>(resolve => { arrived = resolve; });
    const { home: standin, target, identity } = await home({ upgrade: () => { arrived(); return { kind: "hang" }; } });
    const controller = new AbortController();
    const pending = open(target, forwarded(identity.secret), controller.signal);
    await seen;
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: "aborted" });
    expect(standin.connections()).toBe(1);
    await standin.whenClosed(1);
  });

  test("an abort before anything is sent opens no upgrade", async () => {
    const { home: standin, target, identity } = await home();
    const controller = new AbortController();
    controller.abort();
    expect(await open(target, forwarded(identity.secret), controller.signal)).toEqual({ ok: false, reason: "aborted" });
    expect(standin.requests.some(request => request.path === "/v1/responses")).toBe(false);
  });

  test("a target without its identity sends nothing", async () => {
    const { home: standin, identity } = await home();
    expect(await open({ tunnelPort: standin.port, admissionKey: identity.secret }, forwarded(identity.secret))).toEqual({ ok: false, reason: "credential" });
    expect(standin.connections()).toBe(0);
  });

  test("the Child's closed release gate refuses before any I/O, whatever the caller does", async () => {
    setLinkWebsocketChildReadyForTests(false);
    const { home: standin, target, identity } = await home();
    expect(await open(target, forwarded(identity.secret))).toEqual({ ok: false, reason: "disabled" });
    expect(standin.connections()).toBe(0);
  });

  test("an upgrade the Home never answers ends at the setup budget and closes the connection", async () => {
    const clock = manualTimers();
    let arrived!: () => void;
    const seen = new Promise<void>(resolve => { arrived = resolve; });
    const { home: standin, target, identity } = await home({ upgrade: () => { arrived(); return { kind: "hang" }; } });
    const pending = open(target, forwarded(identity.secret), undefined, { timers: clock.timers });
    await seen;
    expect(clock.fire(8_000)).toBe(1);
    expect(await pending).toEqual({ ok: false, reason: "timeout" });
    await standin.whenClosed(1);
  });

  test("an error on the handed-off socket before its owner listens is recorded, never unhandled", async () => {
    const { target, identity } = await home();
    const setup = await open(target, forwarded(identity.secret));
    if (!setup.ok) throw new Error(setup.reason);
    expect(() => setup.socket.emit("error", new Error("reset"))).not.toThrow();
  });
});
