import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { startMachineListener } from "../../src/client/machine-listener";
import { probeLinkRelayPreflight } from "../../src/client/link-relay-transport";
import { forgetLinkWebsocketAdvertisementsForTests } from "../../src/client/link-ws-advertisement";
import type { LinkTunnelGate } from "../../src/client/link-relay";
import type { ManagementAuthState } from "../../src/server/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { startStandinHome, standinIdentity, type StandinHome } from "../fixtures/link-ws-standin-home";
import { childConnection, CodexSocket, connectedTunnel, rawUpgrade } from "../helpers/link-ws-child";

// Lane T6, design T4 9.3 and D4: the Child's own link WebSocket counters (opt-in ?transport=1) and the
// Child-local opt-out that keeps one Child on HTTP whatever its Home advertises.

let root = "";
let previousHome: string | undefined;
const homes: StandinHome[] = [];
const children: Server<unknown>[] = [];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-link-ws-child-status-"));
  process.env.OPENCODEX_HOME = root;
  mkdirSync(root, { recursive: true });
});

afterEach(async () => {
  for (const child of children.splice(0)) await child.stop(true);
  for (const home of homes.splice(0)) await home.stop();
  forgetLinkWebsocketAdvertisementsForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (root) removeTreeWithRetry(root);
});

function authState(): ManagementAuthState {
  return { available: true, token: "ocx_admin_" + "a".repeat(43), source: "environment", sessions: new Map(), pairingGrants: new Map() };
}

function meta(html: string, name: string): string {
  const match = new RegExp('<meta name="' + name + '" content="([^"]+)"').exec(html);
  if (!match?.[1]) throw new Error("missing " + name);
  return match[1];
}

async function setup(config: Record<string, unknown> = {}, tunnel: LinkTunnelGate = connectedTunnel, onReleased?: () => void) {
  const identity = standinIdentity();
  const home = await startStandinHome({ identity });
  homes.push(home);
  // The status route answers only while the durable state still names the connection this listener serves.
  writeFileSync(join(root, "config.json"), JSON.stringify({ port: 0, hostname: "127.0.0.1", providers: {}, defaultProvider: "openai",
    runtimeRole: "client", client: childConnection(home.port, identity), ...config }));
  expect(await probeLinkRelayPreflight({ tunnelPort: home.port, admissionKey: identity.secret, linkId: identity.linkId, apiKeyId: identity.keyId })).toBe("ok");
  const before = home.connections();
  const child = startMachineListener(0, {
    state: childConnection(home.port, identity), managementAuthState: authState(), readSidecar: () => null,
    linkKeySource: () => identity.secret, linkTunnel: tunnel, linkWebsocket: { ready: () => true, ...(onReleased ? { onReleased } : {}) },
  });
  children.push(child);
  const html = await (await fetch(new URL("/opencodex-session", child.url))).text();
  const headers = { "X-OpenCodex-API-Key": meta(html, "opencodex-session-token"), "X-OpenCodex-GUI-Origin": meta(html, "opencodex-session-origin") };
  const status = async (query = "") => await (await fetch(new URL("/api/link/status" + query, child.url), { headers })).json() as Record<string, unknown>;
  return { home, child, port: child.port!, status, homeConnections: () => home.connections() - before };
}

describe("the Child's link WebSocket counters", () => {
  test("?transport=1 adds them; without it the status document is unchanged", async () => {
    let released!: () => void;
    const releasedOnce = new Promise<void>(resolve => { released = resolve; });
    const { port, home, status } = await setup({}, connectedTunnel, () => released());
    const plain = await status();
    expect(plain).not.toHaveProperty("websocket");
    const codex = await CodexSocket.open(port);
    codex.ws.send("12345");
    await home.sockets.at(-1)!.until(frame => frame.type === "text");
    home.sockets.at(-1)!.sendText("abc");
    await codex.next(1);
    codex.ws.close(1000);
    const leg = home.sockets.at(-1)!;
    await leg.until(frame => frame.type === "close");
    // The Home answers the close; the Child then ends the connection, which frees the socket's slot.
    leg.sendClose(1000);
    await leg.closed();
    // The Child's own close event of the Home connection frees the slot; wait for it, not the stand-in's view.
    await releasedOnce;
    const refused = rawUpgrade(port, { origin: "http://127.0.0.1:" + port });
    expect((await refused.answer).status).toBe(426);
    refused.socket.destroy();
    const counted = await status("?transport=1");
    expect({ ...counted, websocket: undefined }).toEqual({ ...plain, websocket: undefined });
    expect(counted.websocket).toEqual({
      open: 0, settingUp: 0, upgrades: 1, fallbacks: { origin: 1 }, closes: { client: 1 }, fromCodexBytes: 5, toCodexBytes: 3,
    });
    expect(await status()).toEqual(plain);
  });
});

describe("the Child-local opt-out (D4)", () => {
  test("linkResponsesWebsocketOptOut keeps this Child on HTTP: today's 426 with no network I/O, counted as local_optout", async () => {
    const { port, status, homeConnections } = await setup({ linkResponsesWebsocketOptOut: true });
    const { socket, answer } = rawUpgrade(port);
    const result = await answer;
    socket.destroy();
    expect(result.status).toBe(426);
    expect(homeConnections()).toBe(0);
    expect((await status("?transport=1")).websocket).toMatchObject({ upgrades: 0, fallbacks: { local_optout: 1 } });
  });

  test("an opt-out set to anything but true follows the Home", async () => {
    const { port, homeConnections } = await setup({ linkResponsesWebsocketOptOut: "yes" });
    await CodexSocket.open(port);
    expect(homeConnections()).toBe(1);
  });
});

describe("the counters and the 503 sequence", () => {
  test("each 503 while the tunnel reconnects counts as tunnel_connecting_timeout", async () => {
    const { port, status } = await setup({}, { connected: () => ({ kind: "unavailable" }), pending: () => true, waitForConnected: async () => false });
    for (let i = 0; i < 2; i += 1) {
      const { socket, answer } = rawUpgrade(port);
      expect((await answer).status).toBe(503);
      socket.destroy();
    }
    expect((await status("?transport=1")).websocket).toMatchObject({ upgrades: 0, fallbacks: { tunnel_connecting_timeout: 2 } });
  });
});
