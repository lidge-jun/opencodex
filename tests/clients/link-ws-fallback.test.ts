import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { probeLinkRelayPreflight } from "../../src/client/link-relay-transport";
import { forgetLinkWebsocketAdvertisementsForTests } from "../../src/client/link-ws-advertisement";
import type { LinkTunnelGate } from "../../src/client/link-relay";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { startStandinHome, standinIdentity, type StandinHome, type StandinHomeOptions, type StandinState } from "../fixtures/link-ws-standin-home";
import { codexRequest, startChild } from "../helpers/link-ws-child";

// Lane T6, design T4 3.2, 7.3 and 7.4: every failure ends in what Codex already handles (426, a 503
// while the tunnel reconnects, or a closed socket followed by HTTP), never a hung or duplicated request.
// The client follows codex-rs's policy (helpers/link-ws-child.ts codexRequest).

const COMPLETED = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_http","status":"completed","output":[]}}\n\n';
const WS_COMPLETED = '{"type":"response.completed","response":{"id":"resp_ws","status":"completed","output":[]}}';
const CREATE = JSON.stringify({ type: "response.create", model: "m", input: [{ role: "user", content: "hi" }] });

let root = "";
let previousHome: string | undefined;
const homes: StandinHome[] = [];
const children: Server<unknown>[] = [];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-link-ws-fallback-"));
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

/** A stand-in Home that completes each create it receives on a socket (unless told otherwise) and every HTTP POST. */
async function setup(tunnel: LinkTunnelGate | undefined, home: Partial<StandinHomeOptions> = {}, onCreate?: (socket: StandinHome["sockets"][number], index: number) => void) {
  const identity = standinIdentity();
  const posts: string[] = [];
  const standin = await startStandinHome({
    identity,
    data: request => { posts.push(request.path); return { status: 200, body: COMPLETED }; },
    ...home,
  });
  homes.push(standin);
  expect(await probeLinkRelayPreflight({ tunnelPort: standin.port, admissionKey: identity.secret, linkId: identity.linkId, apiKeyId: identity.keyId })).toBe("ok");
  let creates = 0;
  void (async () => {
    for (;;) {
      const socket = await standin.nextSocket();
      void socket.until(frame => frame.type === "text").then(frame => {
        if (!frame) return;
        const index = creates++;
        if (onCreate) onCreate(socket, index); else socket.sendText(WS_COMPLETED);
      });
    }
  })();
  const child = startChild(standin.port, identity, { tunnel, websocket: { ready: () => true } });
  children.push(child);
  return { standin, port: child.port!, posts, upgrades: () => standin.sockets.length };
}

describe("the 503 sequence while the Child's tunnel reconnects", () => {
  test("it recovers on the WebSocket once the tunnel is back within Codex's retry budget", async () => {
    let attempts = 0, up = false;
    const tunnel: LinkTunnelGate = {
      connected: () => ({ kind: up ? "match" : "unavailable" }),
      pending: () => !up,
      // Each upgrade's 3 s hold ends with the tunnel still down, until the third attempt.
      waitForConnected: async () => { attempts += 1; if (attempts === 3) up = true; return up; },
    };
    const { port, posts, upgrades } = await setup(tunnel);
    const events: string[] = [];
    expect(await codexRequest(port, CREATE, { maxRetries: 5, events })).toBe(WS_COMPLETED);
    expect(events).toEqual(["503", "503", "ws:completed"]);
    expect(upgrades()).toBe(1);
    expect(posts).toEqual([]);
  });

  test("it ends on HTTP, with the same request sent once, when the tunnel stays down past the budget", async () => {
    let up = false;
    const tunnel: LinkTunnelGate = {
      connected: () => ({ kind: up ? "match" : "unavailable" }),
      pending: () => !up,
      // An upgrade holds 3 s and gives up; the HTTP relay's longer hold (15 s) sees the tunnel come back.
      waitForConnected: async ms => { if (ms > 3_000) up = true; return up; },
    };
    const { port, posts, upgrades } = await setup(tunnel);
    const events: string[] = [];
    const body = await codexRequest(port, CREATE, { maxRetries: 3, events });
    expect(body).toBe(COMPLETED);
    expect(events).toEqual(["503", "503", "503", "503", "fallback", "http:200"]);
    expect(upgrades()).toBe(0);
    expect(posts).toEqual(["/v1/responses"]);
  });
});

describe("a Home that stops advertising, restarts or refuses", () => {
  test("a Home that switches off mid-session fences the socket; Codex's retry gets 426 and the request completes over HTTP", async () => {
    let state: StandinState = "on";
    const { port, posts, upgrades } = await setup(undefined, { state: () => state }, socket => {
      // The draining Home refuses the create without running it (design 2.5) and closes the socket.
      state = "none";
      socket.sendClose(1000, "link websocket disabled");
    });
    const events: string[] = [];
    const session = { http: false };
    expect(await codexRequest(port, CREATE, { maxRetries: 5, events, session })).toBe(COMPLETED);
    expect(events).toEqual(["ws:closed:1000", "426", "http:200"]);
    expect(upgrades()).toBe(1);
    expect(posts).toEqual(["/v1/responses"]);
    // The session stays on HTTP, as codex-rs keeps it after a 426 (C1).
    const later: string[] = [];
    expect(await codexRequest(port, CREATE, { maxRetries: 5, events: later, session })).toBe(COMPLETED);
    expect(later).toEqual(["http:200"]);
  });

  test("a Home whose connection drops mid-turn: Codex's retry reconnects and completes on a new socket", async () => {
    const { port, posts, upgrades } = await setup(undefined, {}, (socket, index) => {
      if (index === 0) socket.destroy(); else socket.sendText(WS_COMPLETED);
    });
    const events: string[] = [];
    expect(await codexRequest(port, CREATE, { maxRetries: 5, events })).toBe(WS_COMPLETED);
    expect(events).toEqual(["ws:closed:1011", "ws:completed"]);
    expect(upgrades()).toBe(2);
    expect(posts).toEqual([]);
  });

  test("a Home that refuses the upgrade (an older Home's 404, a full Home's 426) sends the session to HTTP at once", async () => {
    for (const status of [404, 426]) {
      const { port, posts } = await setup(undefined, { upgrade: () => ({ kind: "refuse", status }) });
      const events: string[] = [];
      expect(await codexRequest(port, CREATE, { maxRetries: 5, events })).toBe(COMPLETED);
      expect(events).toEqual(["426", "http:200"]);
      expect(posts).toEqual(["/v1/responses"]);
    }
  });
});
