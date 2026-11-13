import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { probeLinkRelayPreflight } from "../../src/client/link-relay-transport";
import { forgetLinkWebsocketAdvertisementsForTests } from "../../src/client/link-ws-advertisement";
import { HOME_INITIATED_LINK_TUNNEL, type LinkTunnelGate } from "../../src/client/link-relay";
import { createLinkWebsocketRelay, type LinkWebsocketData, type LinkWebsocketRelayDeps } from "../../src/client/link-websocket";
import { encodeClientClose } from "../../src/client/link-ws-framer";
import { createClientLinkSupervisor } from "../../src/client/link-tunnel";
import type { ClientLinkState } from "../../src/client/link-state";
import type { SshChild, SshRunner } from "../../src/link/ssh-runner";
import { createLinkTrafficBook } from "../../src/link/traffic";
import type { LinkDiagnosticRecord } from "../../src/link/diagnostics";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { startStandinHome, standinIdentity, type StandinHome, type StandinHomeOptions } from "../fixtures/link-ws-standin-home";
import { CodexSocket, connectedTunnel, manualTimers, rawUpgrade, startChild } from "../helpers/link-ws-child";

// Lane T6-5: the Child's link WebSocket around its edges. A restart drains link sockets before the tunnel
// goes (503, never 426), a local upgrade that never opened counts nothing, a Codex socket Bun never opens
// is bounded, and Codex's drop or status-less close reaches the Home as such.

let root = "";
let previousHome: string | undefined;
const homes: StandinHome[] = [];
const children: Server<unknown>[] = [];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-link-ws-edges-"));
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

async function standin(options: Partial<StandinHomeOptions> = {}) {
  const identity = standinIdentity();
  const home = await startStandinHome({ identity, ...options });
  homes.push(home);
  expect(await probeLinkRelayPreflight({ tunnelPort: home.port, admissionKey: identity.secret, linkId: identity.linkId, apiKeyId: identity.keyId })).toBe("ok");
  return { identity, home };
}

async function child(options: { home?: Partial<StandinHomeOptions>; tunnel?: LinkTunnelGate; websocket?: Partial<LinkWebsocketRelayDeps> } = {}) {
  const { identity, home } = await standin(options.home);
  const server = startChild(home.port, identity, { tunnel: options.tunnel, websocket: { ready: () => true, ...options.websocket } });
  children.push(server);
  return { identity, home, port: server.port! };
}

/** A gate whose owner can announce that it is stopping, as the tunnel supervisor does. */
function stoppableGate(): { gate: LinkTunnelGate; stop(): void } {
  const listeners: Array<() => void> = [];
  return { gate: { ...connectedTunnel, onStopping: listener => { listeners.push(listener); } }, stop: () => { for (const listener of listeners) listener(); } };
}

function codexRequest(): Request {
  return new Request("http://127.0.0.1/v1/responses", { headers: {
    host: "127.0.0.1", upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "thread-id": "t",
  } });
}

/** The relay alone, against a stand-in Home, with a local server whose upgrade the test decides. */
async function bareRelay(upgrade: (req: Request, options: { data: LinkWebsocketData }) => boolean, extra: Partial<LinkWebsocketRelayDeps> = {}) {
  const { identity, home } = await standin();
  const records: string[] = [];
  const traffic = createLinkTrafficBook("relayed");
  let released!: () => void;
  const releasedOnce = new Promise<void>(resolve => { released = resolve; });
  const relay = createLinkWebsocketRelay({
    tunnel: HOME_INITIATED_LINK_TUNNEL, ready: () => true, traffic,
    diagnostic: (record: LinkDiagnosticRecord) => records.push(record.event + ":" + record.outcome),
    onReleased: () => released(), ...extra,
  });
  const server = { upgrade } as unknown as Server<unknown>;
  const target = { tunnelPort: home.port, linkId: identity.linkId, apiKeyId: identity.keyId, linkKey: () => identity.secret };
  return { identity, home, relay, records, traffic, releasedOnce, run: () => relay.upgrade(codexRequest(), server, target) };
}

describe("a Child restart drains its link sockets before the tunnel stops", () => {
  test("the supervisor tells its listeners it is stopping before it signals the tunnel, once", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "ocx-link-ws-drain-"));
    const spawned: Array<{ signals: string[] }> = [];
    let tunnelSpawned!: () => void;
    const spawnedOnce = new Promise<void>(resolve => { tunnelSpawned = resolve; });
    const runner: SshRunner = {
      async run() { return { code: 0, stdout: "", stderr: "" }; },
      spawnTunnel(argv) {
        let exit!: (code: number) => void;
        const item = { signals: [] as string[] };
        spawned.push(item);
        tunnelSpawned();
        return { pid: 31_000 + spawned.length, argv: [...argv], exited: new Promise<number>(resolve => { exit = resolve; }), stderr: Promise.resolve(""),
          kill(signal = "SIGTERM") { item.signals.push(signal); if (signal === "SIGTERM") exit(143); } } satisfies SshChild;
      },
    };
    const sidecar: ClientLinkState = { linkId: "lnk_0123456789abcdef", alias: "home.example.test", hubHostKeyFingerprint: "SHA256:abcdefghijklmnop", peerListenerPort: 19001, tunnelPort: 19002 };
    try {
      const supervisor = createClientLinkSupervisor({
        configDir, runner, readSidecar: () => sidecar, connectedLinkId: () => sidecar.linkId,
        setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => {}, now: () => 0, random: () => 0.5,
      });
      const seen: string[][] = [];
      supervisor.onStopping?.(() => seen.push([...(spawned[0]?.signals ?? [])]));
      supervisor.start();
      await spawnedOnce; // milestone: the supervisor spawned its tunnel
      expect(spawned).toHaveLength(1);
      await supervisor.stop();
      await supervisor.stop();
      expect(seen).toEqual([[]]);
      expect(spawned[0]!.signals).toContain("SIGTERM");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("once the gate is stopping, open sockets close with 1001 and every upgrade, new or in setup, gets the 503", async () => {
    const records: string[] = [];
    const tunnel = stoppableGate();
    let hold = false;
    let arrived!: () => void;
    const atHome = new Promise<void>(resolve => { arrived = resolve; });
    const { port, home } = await child({
      tunnel: tunnel.gate, websocket: { diagnostic: record => records.push(record.event + ":" + record.outcome) },
      home: { upgrade: () => { if (hold) { arrived(); return { kind: "hang" }; } return { kind: "accept" }; } },
    });
    const codex = await CodexSocket.open(port);
    const leg = home.sockets.at(-1)!;
    hold = true;
    const inSetup = rawUpgrade(port);
    await atHome;
    tunnel.stop();
    expect((await codex.closed()).code).toBe(1001);
    expect(await leg.until(frame => frame.type === "close")).toMatchObject({ code: 1001 });
    const held = await inSetup.answer;
    inSetup.socket.destroy();
    expect(held.status).toBe(503);
    const fresh = rawUpgrade(port);
    const answer = await fresh.answer;
    fresh.socket.destroy();
    expect(answer.status).toBe(503);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "link_websocket_unavailable" } });
    expect(records.filter(word => word === "link_ws_fallback:draining")).toHaveLength(2);
    expect(records.some(word => word.startsWith("link_ws_fallback:") && !word.endsWith(":draining"))).toBe(false);
  });

  test("a link that ends (sidecar gone) drains too, before the tunnel is signalled", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "ocx-link-ws-drain-"));
    const spawned: Array<{ signals: string[] }> = [];
    let tunnelSpawned!: () => void;
    const spawnedOnce = new Promise<void>(resolve => { tunnelSpawned = resolve; });
    const runner: SshRunner = {
      async run() { return { code: 0, stdout: "", stderr: "" }; },
      spawnTunnel(argv) {
        let exit!: (code: number) => void;
        const item = { signals: [] as string[] };
        spawned.push(item);
        tunnelSpawned();
        return { pid: 32_000 + spawned.length, argv: [...argv], exited: new Promise<number>(resolve => { exit = resolve; }), stderr: Promise.resolve(""),
          kill(signal = "SIGTERM") { item.signals.push(signal); if (signal === "SIGTERM") exit(143); } } satisfies SshChild;
      },
    };
    let current: ClientLinkState | null = { linkId: "lnk_0123456789abcdef", alias: "home.example.test", hubHostKeyFingerprint: "SHA256:abcdefghijklmnop", peerListenerPort: 19001, tunnelPort: 19002 };
    const ticks: Array<() => void> = [];
    let ended = 0;
    let linkEnded!: () => void;
    const endedOnce = new Promise<void>(resolve => { linkEnded = resolve; });
    let initialized!: () => void;
    const initializedOnce = new Promise<void>(resolve => { initialized = resolve; });
    try {
      const supervisor = createClientLinkSupervisor({
        configDir, runner, readSidecar: () => current, connectedLinkId: () => "lnk_0123456789abcdef",
        setTimer: (callback, ms) => { if (ms === 1_000) ticks.push(callback); return ticks.length as unknown as ReturnType<typeof setTimeout>; },
        clearTimer: () => {}, onLinkEnded: () => { ended += 1; linkEnded(); }, onInitialized: () => initialized(), now: () => 0, random: () => 0.5,
      });
      const seen: string[][] = [];
      supervisor.onStopping?.(() => seen.push([...(spawned[0]?.signals ?? [])]));
      supervisor.start();
      await spawnedOnce; // milestone: the supervisor spawned its tunnel...
      await initializedOnce; // ...and finished its start-up check, so its next tick acts
      expect(spawned).toHaveLength(1);
      current = null;
      ticks[0]!();
      await endedOnce; // milestone: the supervisor ended the link (the runtime would recycle now)
      expect(ended).toBe(1);
      expect(seen).toEqual([[]]);
      expect(spawned[0]!.signals).toContain("SIGTERM");
      await supervisor.stop();
      expect(seen).toHaveLength(1);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("a drain still answers 503 after the Home's advertisement turned off", async () => {
    const tunnel = stoppableGate();
    let advertised = true;
    const { port } = await child({ tunnel: tunnel.gate, websocket: { advertised: () => advertised } });
    advertised = false;
    tunnel.stop();
    const late = rawUpgrade(port);
    const answer = await late.answer;
    late.socket.destroy();
    expect(answer.status).toBe(503);
  });

  test("with the Child gate closed, or the Child opted out, a drain keeps today's 426 and touches no network", async () => {
    for (const websocket of [{ ready: () => false }, { optOut: () => true }] satisfies Array<Partial<LinkWebsocketRelayDeps>>) {
      const tunnel = stoppableGate();
      const { port, home } = await child({ tunnel: tunnel.gate, websocket });
      const before = home.connections();
      tunnel.stop();
      const attempt = rawUpgrade(port);
      const answer = await attempt.answer;
      attempt.socket.destroy();
      expect(answer.status).toBe(426);
      expect(home.connections()).toBe(before);
    }
  });
});

describe("a local upgrade that never opened", () => {
  test("server.upgrade returning false answers 426, counts no close and no request, and frees the slot once the Home closed", async () => {
    const { relay, records, traffic, identity, home, releasedOnce, run } = await bareRelay(() => false);
    const response = await run();
    expect(response?.status).toBe(426);
    expect(await home.sockets.at(-1)!.until(frame => frame.type === "close")).toMatchObject({ code: 1001 });
    home.sockets.at(-1)!.sendClose(1001);
    await releasedOnce;
    expect(relay.counters()).toMatchObject({ open: 0, settingUp: 0, upgrades: 0, fallbacks: { handshake: 1 }, closes: {} });
    expect(relay.snapshot()).toEqual({ open: 0, settingUp: 0, reservedBytes: 0 });
    expect(records).toEqual(["link_ws_fallback:handshake"]);
    expect(traffic.snapshot(identity.linkId)).toMatchObject({ requests: 0 });
  });

  test("server.upgrade throwing does the same and leaves no leg behind", async () => {
    const { relay, records, home, releasedOnce, run } = await bareRelay(() => { throw new Error("upgrade refused"); });
    expect((await run())?.status).toBe(426);
    expect(await home.sockets.at(-1)!.until(frame => frame.type === "close")).toMatchObject({ code: 1001 });
    home.sockets.at(-1)!.sendClose(1001);
    await releasedOnce;
    expect(relay.snapshot()).toEqual({ open: 0, settingUp: 0, reservedBytes: 0 });
    expect(relay.closeAll()).toBe(0);
    expect(records).toEqual(["link_ws_fallback:handshake"]);
  });

  test("server.upgrade throwing after Bun opened Codex's socket closes both legs and counts the socket once", async () => {
    const closes: Array<[number | undefined, string | undefined]> = [];
    const local = { send: () => 1, getBufferedAmount: () => 0, close: (code?: number, reason?: string) => { closes.push([code, reason]); } };
    const { relay, records, traffic, identity, home, releasedOnce, run } = await bareRelay((_req, options) => {
      options.data.leg.attach(local);
      throw new Error("upgrade failed after open");
    });
    expect((await run())?.status).toBe(426);
    expect(closes).toEqual([[1001, "link websocket stopping"]]);
    expect(await home.sockets.at(-1)!.until(frame => frame.type === "close")).toMatchObject({ code: 1001 });
    home.sockets.at(-1)!.sendClose(1001);
    await releasedOnce;
    expect(relay.counters()).toMatchObject({ upgrades: 0, fallbacks: { handshake: 1 }, closes: { stopped: 1 } });
    expect(records).toEqual(["link_ws_close:stopped", "link_ws_fallback:handshake"]);
    expect(traffic.snapshot(identity.linkId)).toMatchObject({ requests: 1, incomplete: 0 });
    expect(relay.snapshot()).toEqual({ open: 0, settingUp: 0, reservedBytes: 0 });
  });

  test("a socket Bun upgraded but never opened is stopped after the close bound", async () => {
    const clock = manualTimers();
    const { relay, home, releasedOnce, run } = await bareRelay(() => true, { timers: clock.timers });
    expect(await run()).toBeUndefined();
    expect(relay.counters()).toMatchObject({ open: 1, upgrades: 1 });
    expect(clock.fire(5_000)).toBe(1);
    expect(await home.sockets.at(-1)!.until(frame => frame.type === "close")).toMatchObject({ code: 1001 });
    expect(relay.counters().closes).toEqual({ stopped: 1 });
    // The stand-in never answers the close: the close bound ends the Home connection too.
    expect(clock.fire(5_000)).toBe(1);
    await releasedOnce;
    expect(relay.snapshot()).toEqual({ open: 0, settingUp: 0, reservedBytes: 0 });
  });

  test("a socket Bun opens clears that bound at once", async () => {
    const clock = manualTimers();
    const { port } = await child({ websocket: { timers: clock.timers } });
    await CodexSocket.open(port);
    expect(clock.pending(5_000)).toBe(0);
  });
});

describe("Codex's own end of a socket reaches the Home as it happened", () => {
  test("a close without a status becomes an empty close frame; a dropped Codex ends the Home connection without one", async () => {
    const traffic = createLinkTrafficBook("relayed");
    const { port, home, identity } = await child({ websocket: { traffic } });
    const quiet = rawUpgrade(port);
    expect((await quiet.answer).status).toBe(101);
    const leg = home.sockets.at(-1)!;
    quiet.socket.write(encodeClientClose());
    expect(await leg.until(frame => frame.type === "close")).toEqual({ type: "close", code: null, reason: "" });
    // A close frame ended it: a complete request.
    expect(traffic.snapshot(identity.linkId)).toMatchObject({ requests: 1, incomplete: 0 });
    quiet.socket.destroy();

    const dropped = rawUpgrade(port);
    expect((await dropped.answer).status).toBe(101);
    const second = home.sockets.at(-1)!;
    dropped.socket.destroy();
    await second.closed();
    expect(second.frames.some(frame => frame.type === "close")).toBe(false);
    // No close frame ended it on either leg: incomplete, as the Home counts the same socket.
    expect(traffic.snapshot(identity.linkId)).toMatchObject({ requests: 2, incomplete: 1 });
  });
});
