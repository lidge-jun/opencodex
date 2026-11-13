import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import type { OcxConfig } from "../../src/types";
import { linkStorePath } from "../../src/link/paths";
import { writeLinkStore, type LinkStore } from "../../src/link/store";
import { setLinkWebsocketTransportReadyForTests } from "../../src/server/index/link-websocket-limits";
import { probeLinkRelayPreflight } from "../../src/client/link-relay-transport";
import { forgetLinkWebsocketAdvertisementsForTests } from "../../src/client/link-ws-advertisement";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { CodexSocket, rawUpgrade, startChild } from "../helpers/link-ws-child";

// Lane T6 with a real Home (lane T5, #8593): a turn the Child relays on the link WebSocket counts as
// that link's activity on the Home, so activity-gated syncs and restarts wait for it, and a Codex socket
// lost mid-turn leaves the Home's durable activity hold (design T4 section 5).

const KEY_ID = "child-ws-key";
const SECRET = "child-ws-secret-0123456789abcdef";
const LINK = "lnk_c6c6c6c6c6c6c6c6";
const ADMIN = "child-ws-admin-token-0123456789";
const identity = { keyId: KEY_ID, linkId: LINK, secret: SECRET };

const previous = { home: process.env.OPENCODEX_HOME, admin: process.env.OPENCODEX_ADMIN_AUTH_TOKEN };
let dir = "";
let codexHome: IsolatedCodexHome | null = null;
let home: { stop(force?: boolean): Promise<void>; url: URL } | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
const children: Server<unknown>[] = [];
let held: { release(): void; aborted: Promise<void> } | null = null;
let heldWaiters: Array<() => void> = [];

/** Resolves once the upstream holds a request. */
async function upstreamHolding(): Promise<{ release(): void; aborted: Promise<void> }> {
  while (!held) await new Promise<void>(resolve => heldWaiters.push(resolve));
  return held;
}

function sse(id: string, events: Array<Record<string, unknown>>): string {
  return events.map(event => "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n").join("").replaceAll("RESP", id);
}

beforeEach(async () => {
  setLinkWebsocketTransportReadyForTests(true);
  dir = mkdtempSync(join(tmpdir(), "ocx-link-ws-child-home-"));
  process.env.OPENCODEX_HOME = join(dir, "home");
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ADMIN;
  codexHome = installIsolatedCodexHome("ocx-link-ws-child-home-codex-");
  writeFileSync(join(codexHome.path, "opencodex-catalog.json"), JSON.stringify({ models: [{ slug: "fixture/fixture" }] }));
  upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      await req.text();
      // The upstream answers response.created at once and holds the rest until the test releases it.
      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      let aborted!: () => void;
      const abortedPromise = new Promise<void>(resolve => { aborted = resolve; });
      req.signal.addEventListener("abort", () => aborted(), { once: true });
      held = { release, aborted: abortedPromise };
      for (const wake of heldWaiters.splice(0)) wake();
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(sse("resp_child", [{ type: "response.created", response: { id: "RESP", status: "in_progress", output: [] } }])));
          await released;
          controller.enqueue(encoder.encode(sse("resp_child", [{ type: "response.completed", response: { id: "RESP", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }])));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  writeLinkStore(linkStorePath(), { version: 1, listenerPort: null, links: [{ id: LINK, alias: "child-ws", direction: "client-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 2222, apiKeyId: KEY_ID, createdAt: "2026-11-13T00:00:00.000Z" }] as LinkStore["links"] });
  const { saveConfig } = await import("../../src/config");
  saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "fixture", websockets: true, linkResponsesWebsocket: true, codexAutoStart: false, clientIntegrations: { codex: false },
    providers: { fixture: { adapter: "openai-responses", baseUrl: "http://127.0.0.1:" + upstream.port + "/v1", authMode: "key", apiKey: "fixture-upstream-key", allowPrivateNetwork: true, models: ["fixture"] } },
    apiKeys: [{ id: KEY_ID, name: KEY_ID, key: SECRET, createdAt: "2026-11-13T00:00:00.000Z" }] } as OcxConfig);
  const { startServer } = await import("../../src/server");
  home = startServer(0);
});

afterEach(async () => {
  held?.release();
  held = null;
  for (const child of children.splice(0)) await child.stop(true);
  if (home) await home.stop(true);
  home = null;
  if (upstream) await upstream.stop(true);
  upstream = null;
  setLinkWebsocketTransportReadyForTests(false);
  forgetLinkWebsocketAdvertisementsForTests();
  codexHome?.restore(); codexHome = null;
  if (previous.home === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous.home;
  if (previous.admin === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN; else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previous.admin;
  if (dir) removeTreeWithRetry(dir);
  dir = "";
});

async function child(): Promise<number> {
  const linkPort = JSON.parse(readFileSync(linkStorePath(), "utf8")).listenerPort as number;
  // Ordinary relay traffic teaches the Child that its Home advertises the link WebSocket.
  expect(await probeLinkRelayPreflight({ tunnelPort: linkPort, admissionKey: SECRET, linkId: LINK, apiKeyId: KEY_ID })).toBe("ok");
  const server = startChild(linkPort, identity, { websocket: { ready: () => true } });
  children.push(server);
  return server.port!;
}

async function linkRow(): Promise<{ inFlight: number; holds: unknown }> {
  const response = await fetch(new URL("/api/link/status?children=1", home!.url), { headers: { authorization: "Bearer " + ADMIN } });
  const body = await response.json() as { links: Array<{ id: string; child?: { activity?: { inFlight: number }; holds?: unknown } }> };
  const row = body.links.find(link => link.id === LINK)!;
  return { inFlight: row.child?.activity?.inFlight ?? -1, holds: row.child?.holds };
}

const CREATE = JSON.stringify({ type: "response.create", model: "fixture/fixture", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], stream: true, client_metadata: { thread_id: "thread-child", turn_id: "turn-1" } });

describe("a Child-relayed link WebSocket turn on a real Home", () => {
  test("counts as the link's activity while it runs, and not after it completed", async () => {
    const port = await child();
    const codex = await CodexSocket.open(port);
    expect((await linkRow()).inFlight).toBe(0);
    codex.ws.send(CREATE);
    const [created] = await codex.next(1);
    expect(JSON.parse(created!).type).toBe("response.created");
    expect((await linkRow()).inFlight).toBeGreaterThanOrEqual(1);
    held!.release();
    const messages = await codex.next(2);
    expect(JSON.parse(messages[1]!).type).toBe("response.completed");
    expect((await linkRow()).inFlight).toBe(0);
  });

  test("a Codex socket lost mid-turn leaves the Home's activity hold, so a restart still waits", async () => {
    const port = await child();
    const { socket, answer } = rawUpgrade(port, { "thread-id": "thread-child" });
    expect((await answer).status).toBe(101);
    const { encodeClientText } = await import("../../src/client/link-ws-framer");
    socket.write(encodeClientText(CREATE));
    const { aborted } = await upstreamHolding();
    socket.destroy(); // Codex is gone without a close frame
    await aborted;    // the Home cancelled the cut turn after it recorded the hold (close handler order)
    const row = await linkRow();
    expect(row.inFlight).toBeGreaterThanOrEqual(1);
    expect(row.holds).toBeDefined();
  });
});
