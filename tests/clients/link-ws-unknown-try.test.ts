import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import * as advertisement from "../../src/client/link-ws-advertisement";
import type { LinkTunnelGate } from "../../src/client/link-relay";
import type { LinkDiagnosticRecord } from "../../src/link/diagnostics";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { startStandinHome, standinIdentity, type StandinHome, type StandinHomeOptions } from "../fixtures/link-ws-standin-home";
import { CodexSocket, rawUpgrade, startChild } from "../helpers/link-ws-child";
import type { LinkWebsocketRelayDeps } from "../../src/client/link-websocket";

// Lane T6 (T6-7a): a Child that has applied no answer from its Home since it started (a restart, a new link) treats
// the Home's advertisement as unknown and tries: the upgrade's own preflight decides. A closed Child gate, the
// Child-local opt-out and a cached "off" keep today's 426 without touching the network.

const TODAY_426_BODY = JSON.stringify({ error: { message: "Responses WebSocket transport is disabled; use HTTP", type: "upgrade_required", code: "upgrade_required" } });

let root = "";
let previousHome: string | undefined;
const homes: StandinHome[] = [];
const children: Server<unknown>[] = [];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-link-ws-unknown-"));
  process.env.OPENCODEX_HOME = root;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "config.json"), JSON.stringify({ port: 0, hostname: "127.0.0.1", providers: {}, defaultProvider: "openai" }));
  advertisement.forgetLinkWebsocketAdvertisementsForTests();
});

afterEach(async () => {
  for (const child of children.splice(0)) await child.stop(true);
  for (const home of homes.splice(0)) await home.stop();
  advertisement.forgetLinkWebsocketAdvertisementsForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (root) removeTreeWithRetry(root);
});

/** A stand-in Home and a Child that has learned nothing from it: no probe, no relayed request, as right after a start. */
async function freshChild(options: { home?: Partial<StandinHomeOptions>; tunnel?: LinkTunnelGate; websocket?: Partial<LinkWebsocketRelayDeps> } = {}) {
  const identity = standinIdentity();
  const home = await startStandinHome({ identity, ...options.home });
  homes.push(home);
  const diagnostics: string[] = [];
  const child = startChild(home.port, identity, { tunnel: options.tunnel, websocket: {
    ready: () => true, diagnostic: (record: LinkDiagnosticRecord) => { diagnostics.push(record.event + ":" + record.outcome); }, ...options.websocket,
  } });
  children.push(child);
  return { identity, home, port: child.port!, diagnostics };
}

async function upgradeStatus(port: number): Promise<{ status: number; body: string; contentType: string | undefined }> {
  const { socket, answer } = rawUpgrade(port);
  const result = await answer;
  socket.destroy();
  return { status: result.status, body: result.body, contentType: result.headers.get("content-type") };
}

describe("a Child that has no answer from its Home yet tries the upgrade", () => {
  test("an advertising Home: the upgrade's own preflight says on, Codex's socket opens and frames flow both ways", async () => {
    const { identity, home, port } = await freshChild();
    expect(advertisement.linkWebsocketAdvertisement(identity.linkId)).toBe("unknown");
    const codex = await CodexSocket.open(port);
    const leg = home.sockets.at(-1)!;
    const create = JSON.stringify({ type: "response.create", model: "m", input: [] });
    codex.ws.send(create);
    expect(await leg.until(frame => frame.type === "text")).toEqual({ type: "text", data: create });
    leg.sendText('{"type":"response.completed"}');
    expect(await codex.next(1)).toEqual(['{"type":"response.completed"}']);
    // The upgrade's own answer taught the cache.
    expect(advertisement.linkWebsocketAdvertisement(identity.linkId)).toBe("on");
  });

  test("an old Home (no state pair): one preflight, today's 426 byte for byte, and no traffic for the next upgrade", async () => {
    const { identity, home, port, diagnostics } = await freshChild({ home: { state: () => "none" } });
    expect(await upgradeStatus(port)).toEqual({ status: 426, body: TODAY_426_BODY, contentType: "application/json" });
    expect(home.connections()).toBe(1);
    expect(home.requests.some(request => request.path === "/v1/responses")).toBe(false);
    expect(advertisement.linkWebsocketAdvertisement(identity.linkId)).toBe("off");
    expect(diagnostics).toEqual(["link_ws_fallback:not_advertised"]);
    // The answer is cached: the next upgrade is today's immediate 426.
    expect(await upgradeStatus(port)).toEqual({ status: 426, body: TODAY_426_BODY, contentType: "application/json" });
    expect(home.connections()).toBe(1);
    expect(diagnostics).toEqual(["link_ws_fallback:not_advertised"]);
  });

  test("a tunnel still connecting after a restart: the upgrade waits at the gate and goes on to the WebSocket", async () => {
    let up = false;
    const tunnel: LinkTunnelGate = {
      connected: () => ({ kind: up ? "match" : "unavailable" }),
      pending: () => !up,
      waitForConnected: async () => { up = true; return true; },
    };
    const { home, port } = await freshChild({ tunnel });
    expect((await upgradeStatus(port)).status).toBe(101);
    expect(home.sockets).toHaveLength(1);
  });

  test("a tunnel still connecting when the hold ends: the transient 503, so Codex retries on the WebSocket", async () => {
    const tunnel: LinkTunnelGate = { connected: () => ({ kind: "unavailable" }), pending: () => true, waitForConnected: async () => false };
    const { home, port, diagnostics } = await freshChild({ tunnel });
    expect((await upgradeStatus(port)).status).toBe(503);
    expect(home.connections()).toBe(0);
    expect(diagnostics).toEqual(["link_ws_fallback:tunnel_connecting_timeout"]);
  });
});

describe("controls: what keeps today's immediate 426 with no network traffic", () => {
  test("a closed Child gate", async () => {
    const { identity, home, port, diagnostics } = await freshChild({ websocket: { ready: () => false } });
    expect(advertisement.linkWebsocketAdvertisement(identity.linkId)).toBe("unknown");
    expect(await upgradeStatus(port)).toEqual({ status: 426, body: TODAY_426_BODY, contentType: "application/json" });
    expect(home.connections()).toBe(0);
    expect(diagnostics).toEqual([]);
  });

  test("the Child-local opt-out", async () => {
    const { home, port, diagnostics } = await freshChild({ websocket: { optOut: () => true } });
    expect(await upgradeStatus(port)).toEqual({ status: 426, body: TODAY_426_BODY, contentType: "application/json" });
    expect(home.connections()).toBe(0);
    expect(diagnostics).toEqual([]);
  });

  test("a cached off", async () => {
    const { identity, home, port } = await freshChild();
    expect(advertisement.applyLinkWebsocketAnswer(identity.linkId, advertisement.nextLinkPreflightSequence(), "off")).toBe(true);
    expect(await upgradeStatus(port)).toEqual({ status: 426, body: TODAY_426_BODY, contentType: "application/json" });
    expect(home.connections()).toBe(0);
  });
});
