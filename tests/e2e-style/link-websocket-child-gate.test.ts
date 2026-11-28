import { afterEach, describe, expect, setDefaultTimeout } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer, type Server as NetServer } from "node:net";
import type { Server } from "bun";
import type { OcxConfig } from "../../src/types";
import { setLinkWebsocketLimitsForTests, setLinkWebsocketTransportReadyForTests } from "../../src/server/index/link-websocket-limits";
import { observeRequestLogsForTests, type RequestLogEntry } from "../../src/server/request-log";
import { linkStorePath } from "../../src/link/paths";
import { writeLinkStore, type LinkStore } from "../../src/link/store";
import type { LinkDiagnosticRecord } from "../../src/link/diagnostics";
import { probeLinkRelayPreflight } from "../../src/client/link-relay-transport";
import { forgetLinkWebsocketAdvertisementsForTests } from "../../src/client/link-ws-advertisement";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { startChild } from "../helpers/link-ws-child";
import { completed, expectCompleted, gate, runGateCodex, toolCall, untilOrExit } from "../helpers/link-gate-codex";

// The release-gate scenarios of design T4 11.1 item 13 and 11.2-8 (a), driven by the pinned Codex binary through the
// real TypeScript Child (lane T6: src/client/machine-listener.ts, src/client/link-websocket.ts) in front of a real Home,
// instead of the test-only relay stand-in the gate file uses. Opt-in and labelled exactly as the gate file
// (tests/helpers/link-gate-codex.ts): skipped without OCX_LINK_GATE_CODEX, release evidence only for the reviewed digest.
// What each scenario observes: the Child's own diagnostics (link_ws_open, link_ws_close and link_ws_fallback records)
// and the Home's request log. While the Home's link WebSocket is on, a link row carries the transport its request arrived
// on (design 9.1); once a scenario has switched it off, the Home writes no link field, so such a row is "unmarked" and,
// with no new link socket opened by the Child, it is a request relayed over HTTP. The Child's release gate and the
// Home's are opened for these tests only.
// Codex is an external process with no clock to inject: the bound is this file's default, not a per-test timeout.
setDefaultTimeout(180_000);

// Design T4 6.1: the Child advertises 8 MiB to Codex on its 101 (C7). Fixed here, independently of the Child's constant.
const DESIGN_MESSAGE_LIMIT = 8 * 1024 * 1024;

const KEY_ID = "gate-key"; const SECRET = "gate-secret-0123456789abcdef"; const LINK = "lnk_9b9b9b9b9b9b9b9b";

const previous = { home: process.env.OPENCODEX_HOME };
let dir = "";
let codexHome: IsolatedCodexHome | null = null;
let server: { stop(force?: boolean): Promise<void> } | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
let childListener: Server<unknown> | null = null;
let stopObserving: (() => void) | null = null;
let tap: NetServer | null = null;
const children: Array<ReturnType<typeof Bun.spawn>> = [];

afterEach(async () => {
  setLinkWebsocketTransportReadyForTests(false);
  setLinkWebsocketLimitsForTests(null);
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
  if (tap) await new Promise<void>(resolve => tap!.close(() => resolve()));
  tap = null;
  if (childListener) await childListener.stop(true);
  childListener = null;
  forgetLinkWebsocketAdvertisementsForTests();
  stopObserving?.(); stopObserving = null;
  if (server) await server.stop(true);
  server = null;
  if (upstream) await upstream.stop(true);
  upstream = null;
  codexHome?.restore(); codexHome = null;
  if (previous.home === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous.home;
  if (dir) removeTreeWithRetry(dir);
  dir = "";
});

/**
 * A scratch Home with the link WebSocket on, one client-initiated link and a fixture upstream answered by `answer`, and
 * the real Child listener in front of it. `rows` collects the Home's request-log rows ("websocket:<status>",
 * "http:<status>", or "unmarked:<status>" once the switch is off), `records` the Child's link WebSocket diagnostics
 * ("<event>:<outcome>").
 */
async function linkPair(answer: (body: string, index: number) => Response | Promise<Response>) {
  dir = mkdtempSync(join(tmpdir(), "ocx-link-child-gate-"));
  process.env.OPENCODEX_HOME = join(dir, "home");
  codexHome = installIsolatedCodexHome("ocx-link-child-gate-codex-");
  writeFileSync(join(codexHome.path, "opencodex-catalog.json"), JSON.stringify({ models: [{ slug: "fixture/fixture" }] }));
  let index = 0;
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { const body = await req.text(); return answer(body, index++); } });
  writeLinkStore(linkStorePath(), { version: 1, listenerPort: null, links: [{ id: LINK, alias: "gate", direction: "client-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 2222, apiKeyId: KEY_ID, createdAt: "2026-11-13T00:00:00.000Z" }] as LinkStore["links"] });
  const { saveConfig } = await import("../../src/config");
  saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "fixture", websockets: true, linkResponsesWebsocket: true, codexAutoStart: false, clientIntegrations: { codex: false },
    providers: { fixture: { adapter: "openai-responses", baseUrl: "http://127.0.0.1:" + upstream.port + "/v1", authMode: "key", apiKey: "fixture-upstream-key", allowPrivateNetwork: true, models: ["fixture"] } },
    apiKeys: [{ id: KEY_ID, name: KEY_ID, key: SECRET, createdAt: "2026-11-13T00:00:00.000Z" }] } as OcxConfig);
  setLinkWebsocketTransportReadyForTests(true);
  const rows: string[] = [];
  stopObserving = observeRequestLogsForTests((entry: RequestLogEntry) => { rows.push((entry.link?.transport ?? "unmarked") + ":" + entry.status); });
  const start = async () => { const { startServer } = await import("../../src/server"); server = startServer(0); };
  await start();
  const linkPort = JSON.parse(readFileSync(linkStorePath(), "utf8")).listenerPort as number;
  // The Child learns the Home's advertisement from one relay preflight, as it does from any request.
  expect(await probeLinkRelayPreflight({ tunnelPort: linkPort, admissionKey: SECRET, linkId: LINK, apiKeyId: KEY_ID })).toBe("ok");
  const records: string[] = [];
  childListener = startChild(linkPort, { keyId: KEY_ID, linkId: LINK, secret: SECRET },
    { websocket: { ready: () => true, diagnostic: (record: LinkDiagnosticRecord) => records.push(record.event + ":" + record.outcome) } });
  const run = (options: { instructionsBytes?: number; port?: number } = {}) =>
    runGateCodex({ dir, port: options.port ?? childListener!.port!, prompt: { argument: "say gate-ok" }, children, instructionsBytes: options.instructionsBytes });
  return { rows, records, run, start, linkPort, restartHome: async () => { await server!.stop(true); await start(); } };
}

interface TappedConnection { request: string; answer: string; sentAfterHead: number }

/**
 * A TCP tap in front of the Child's listener: for every connection Codex opens, the head of its request, the head of
 * the Child's answer, and how many bytes Codex sent after its request head (on an upgraded connection: every WebSocket
 * frame it wrote, whatever the Child then did with them).
 */
async function tapChild(childPort: number): Promise<{ port: number; connections: TappedConnection[] }> {
  const connections: TappedConnection[] = [];
  tap = createServer(client => {
    const entry: TappedConnection = { request: "", answer: "", sentAfterHead: 0 };
    connections.push(entry);
    const upstream = connect({ host: "127.0.0.1", port: childPort });
    let requestHead = Buffer.alloc(0); let answerHead = Buffer.alloc(0);
    client.on("data", (chunk: Buffer) => {
      if (!entry.request) {
        requestHead = Buffer.concat([requestHead, chunk]);
        const end = requestHead.indexOf("\r\n\r\n");
        if (end >= 0) { entry.request = requestHead.subarray(0, end).toString("latin1"); entry.sentAfterHead += requestHead.length - end - 4; }
      } else entry.sentAfterHead += chunk.length;
      upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => {
      if (!entry.answer) {
        answerHead = Buffer.concat([answerHead, chunk]);
        const end = answerHead.indexOf("\r\n\r\n");
        if (end >= 0) entry.answer = answerHead.subarray(0, end).toString("latin1");
      }
      client.write(chunk);
    });
    client.on("close", () => upstream.destroy()); upstream.on("close", () => client.destroy());
    client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy());
  });
  await new Promise<void>(resolve => tap!.listen(0, "127.0.0.1", () => resolve()));
  return { port: (tap.address() as { port: number }).port, connections };
}

const sseResponse = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });

describe("link WebSocket release gate through the real Child (design 11.1 item 13, 11.2-8 (a))", () => {
  gate("real Child, drain: the switch goes off under a running turn; it finishes on the socket with its tool result, the socket then closes (from either side), and the next session ends on HTTP", async () => {
    const bodies: string[] = [];
    const pair = await linkPair((body, index) => {
      bodies.push(body);
      if (index === 0) { setLinkWebsocketTransportReadyForTests(false); return sseResponse(toolCall("resp_" + index)); }
      return sseResponse(completed("resp_" + index));
    });
    expectCompleted(await pair.run());
    // Both requests of the turn ran on the one socket the Child opened, the tool result included, and the socket then
    // closed. The close is recorded as "home" or "client" (Codex closed first where it was printed); this file does not
    // establish that the Home fenced the socket. The stand-in scenario in the gate file shows the fence itself.
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("call_gate_goal");
    expect(pair.rows).toEqual(["websocket:200", "websocket:200"]);
    expect(pair.records[0]).toBe("link_ws_open:connected");
    expect(["link_ws_close:home", "link_ws_close:client"]).toContain(pair.records[1]!);
    expect(pair.records).toHaveLength(2);
    // The next session's upgrade: the Child's preflight for it learns that the Home no longer advertises the link
    // WebSocket, so the Child answers 426 without forwarding the upgrade to the Home, and Codex sends the request over HTTP.
    expectCompleted(await pair.run());
    expect(pair.rows.slice(2)).toEqual(["unmarked:200"]);
    expect(pair.records.slice(2)).toEqual(["link_ws_fallback:not_advertised"]);
  });

  gate("real Child, drain past its deadline: the tool result never reaches the upstream over the socket, the socket closes (from either side), and the same request completes over HTTP", async () => {
    setLinkWebsocketLimitsForTests({ drainDeadlineMs: 0 });
    const bodies: string[] = [];
    const pair = await linkPair((body, index) => {
      bodies.push(body);
      if (index === 0) { setLinkWebsocketTransportReadyForTests(false); return sseResponse(toolCall("resp_" + index)); }
      return sseResponse(completed("resp_" + index));
    });
    expectCompleted(await pair.run());
    // The tool result never reached the upstream over the socket: the first request on the socket, then one over HTTP only.
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("call_gate_goal");
    expect(pair.rows).toEqual(["websocket:200", "unmarked:200"]);
    // One socket, then a close recorded as "home" or "client"; this file does not establish which side ended the tool
    // result's create (the stand-in scenario in the gate file shows the Home's fence). Codex's reconnect then found the
    // Home no longer advertising: the Child answered 426 without forwarding the upgrade to it, and the request went over HTTP.
    expect(pair.records[0]).toBe("link_ws_open:connected");
    expect(["link_ws_close:home", "link_ws_close:client"]).toContain(pair.records[1]!);
    expect(pair.records.slice(2)).toEqual(["link_ws_fallback:not_advertised"]);
  });

  gate("real Child, 11.2-8 (a): with the Child's 8 MiB header on its 101, a larger request goes over HTTP and never on the socket", async () => {
    const sizes: number[] = [];
    const pair = await linkPair((body, index) => { sizes.push(body.length); return sseResponse(completed("resp_" + index)); });
    const tapped = await tapChild(childListener!.port!);
    expectCompleted(await pair.run({ instructionsBytes: DESIGN_MESSAGE_LIMIT + 1024, port: tapped.port }));
    expect(Math.max(...sizes)).toBeGreaterThan(DESIGN_MESSAGE_LIMIT);
    // The Child answered Codex's upgrade with its own 101 carrying the 8 MiB limit (C7).
    const upgraded = tapped.connections.filter(connection => connection.answer.startsWith("HTTP/1.1 101"));
    // Exactly one socket: Codex did not open, overrun and retry its way onto HTTP.
    expect(upgraded.length).toBe(1);
    expect(pair.records.filter(record => record === "link_ws_open:connected")).toHaveLength(1);
    for (const connection of upgraded) {
      const advertised = connection.answer.split("\r\n").filter(line => line.toLowerCase().startsWith("x-codex-websocket-max-message-bytes:"));
      expect(advertised.map(line => line.slice(line.indexOf(":") + 1).trim())).toEqual(["8388608"]);
      // Everything Codex wrote on the upgraded connection is smaller than the limit: the request never went on the socket.
      expect(connection.sentAfterHead).toBeLessThan(DESIGN_MESSAGE_LIMIT);
    }
    // It went over HTTP on a connection of its own, which carried the whole body.
    const posts = tapped.connections.filter(connection => connection.request.startsWith("POST /v1/responses"));
    expect(posts.map(connection => connection.sentAfterHead > DESIGN_MESSAGE_LIMIT)).toEqual([true]);
    expect(pair.records[0]).toBe("link_ws_open:connected");
    expect(pair.records.some(record => record.startsWith("link_ws_fallback:"))).toBe(false);
    expect(pair.rows).toEqual(["http:200"]);
  });

  gate("real Child, a Home restart mid-turn: the turn completes after Codex reconnects", async () => {
    let firstSeen!: () => void;
    const first = new Promise<void>(resolve => { firstSeen = resolve; });
    const pair = await linkPair((_body, index) => {
      if (index === 0) {
        firstSeen();
        // The first request starts and never finishes: the Home restarts under it.
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode("event: response.created\ndata: " + JSON.stringify({ type: "response.created", response: { id: "resp_cut", status: "in_progress", output: [] } }) + "\n\n"));
        } }), { headers: { "content-type": "text/event-stream" } });
      }
      return sseResponse(completed("resp_" + index));
    });
    const result = pair.run();
    await untilOrExit(first, result, "the first request reached the Home");
    const beforeRestart = [...pair.records];
    await pair.restartHome();
    // The restarted Home reuses its link listener port, so the running Child reaches it again.
    expect(JSON.parse(readFileSync(linkStorePath(), "utf8")).listenerPort).toBe(pair.linkPort);
    expectCompleted(await result);
    // The stalled request was on the socket the Child opened; nothing had gone over HTTP.
    expect(beforeRestart).toEqual(["link_ws_open:connected"]);
    // The completing request came after the restart; which transport Codex used for it is its own retry policy (C4, C5).
    const after = pair.rows.filter(row => row.endsWith(":200"));
    expect(after.length).toBeGreaterThanOrEqual(1);
    console.info("[real Child, Home restart] Home rows " + JSON.stringify(pair.rows) + ", Child records " + JSON.stringify(pair.records));
  });
});
