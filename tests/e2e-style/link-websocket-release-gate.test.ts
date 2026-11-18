import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { setLinkWebsocketLimitsForTests, setLinkWebsocketTransportReadyForTests } from "../../src/server/index/link-websocket-limits";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { linkStorePath } from "../../src/link/paths";
import { writeLinkStore, type LinkStore } from "../../src/link/store";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { STANDIN_MAX_MESSAGE_BYTES, startRelayStandin, type RelayStandin } from "../fixtures/link-child-relay-standin";
import { completed, expectCompleted, gate, GATE_PIN as PIN, runGateCodex, toolCall, untilOrExit } from "../helpers/link-gate-codex";
import { startChild } from "../helpers/link-ws-child";
import { probeLinkRelayPreflight } from "../../src/client/link-relay-transport";
import { forgetLinkWebsocketAdvertisementsForTests } from "../../src/client/link-ws-advertisement";
import type { LinkTunnelGate } from "../../src/client/link-relay";
import type { LinkDiagnosticRecord } from "../../src/link/diagnostics";
import type { Server } from "bun";

// Lane T5f: the link WebSocket release gate of design T4 11.1 item 13, with the pinned Codex binary as the client (U13).
// The pinned binary is codex-rs built at openai/codex 88c5856 (design section 0). The Codex scenarios run only when
// OCX_LINK_GATE_CODEX names an executable file; otherwise every Codex scenario is skipped with that reason, and the pin
// test always runs. A run is release evidence only
// when the binary's sha256 equals the digest recorded for that revision in tests/fixtures/link-gate-codex.json, a file
// that changes only through review; any other executable runs as a smoke check, and each Codex scenario's title says which. Codex reaches the Home through a test-only
// stand-in for the Child's relay (tests/fixtures/link-child-relay-standin.ts), except in the 503 sequence, which needs the
// Child's own relay and tunnel gate (lane T6, src/client/link-websocket.ts) and runs the real Child listener.
// Codex is an external process with no clock to inject, so each test carries a per-test bound instead of sleeps.
// The labels, the Codex runner and the fixture turns are shared with the real-Child scenarios (tests/helpers/link-gate-codex.ts).

// Codex is an external process: the bound is this file's default, not a per-test timeout.
setDefaultTimeout(180_000);

const KEY_ID = "gate-key"; const SECRET = "gate-secret-0123456789abcdef"; const LINK = "lnk_9a9a9a9a9a9a9a9a";
const identity = { keyId: KEY_ID, linkId: LINK, fingerprint: serviceApiTokenFingerprint(SECRET) };

const previous = { home: process.env.OPENCODEX_HOME };
let dir = "";
let codexHome: IsolatedCodexHome | null = null;
let server: { stop(force?: boolean): Promise<void> } | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
let standin: RelayStandin | null = null;
let childListener: Server<unknown> | null = null;
const children: Array<ReturnType<typeof Bun.spawn>> = [];

afterEach(async () => {
  setLinkWebsocketTransportReadyForTests(false);
  setLinkWebsocketLimitsForTests(null);
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
  await standin?.stop(); standin = null;
  if (childListener) await childListener.stop(true);
  childListener = null;
  forgetLinkWebsocketAdvertisementsForTests();
  if (server) await server.stop(true);
  server = null;
  if (upstream) await upstream.stop(true);
  upstream = null;
  codexHome?.restore(); codexHome = null;
  if (previous.home === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous.home;
  if (dir) removeTreeWithRetry(dir);
  dir = "";
});

/** A scratch Home with the link WebSocket on, one client-initiated link, and a fixture upstream answered by `answer`. */
async function home(answer: (body: string, index: number) => Response | Promise<Response>) {
  dir = mkdtempSync(join(tmpdir(), "ocx-link-gate-"));
  process.env.OPENCODEX_HOME = join(dir, "home");
  codexHome = installIsolatedCodexHome("ocx-link-gate-codex-");
  writeFileSync(join(codexHome.path, "opencodex-catalog.json"), JSON.stringify({ models: [{ slug: "fixture/fixture" }] }));
  let index = 0;
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { const body = await req.text(); return answer(body, index++); } });
  writeLinkStore(linkStorePath(), { version: 1, listenerPort: null, links: [{ id: LINK, alias: "gate", direction: "client-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 2222, apiKeyId: KEY_ID, createdAt: "2026-11-12T00:00:00.000Z" }] as LinkStore["links"] });
  const { saveConfig } = await import("../../src/config");
  saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "fixture", websockets: true, linkResponsesWebsocket: true, codexAutoStart: false, clientIntegrations: { codex: false },
    providers: { fixture: { adapter: "openai-responses", baseUrl: "http://127.0.0.1:" + upstream.port + "/v1", authMode: "key", apiKey: "fixture-upstream-key", allowPrivateNetwork: true, models: ["fixture"] } },
    apiKeys: [{ id: KEY_ID, name: KEY_ID, key: SECRET, createdAt: "2026-11-12T00:00:00.000Z" }] } as OcxConfig);
  setLinkWebsocketTransportReadyForTests(true);
  const start = async () => { const { startServer } = await import("../../src/server"); server = startServer(0); };
  await start();
  const linkPort = () => JSON.parse(readFileSync(linkStorePath(), "utf8")).listenerPort as number;
  return { start, linkPort };
}

/** Runs one `codex exec` turn against the stand-in (tests/helpers/link-gate-codex.ts). */
function runCodex(port: number, prompt: { argument: string } | { stdin: string }, options: { instructionsBytes?: number } = {}) {
  return runGateCodex({ dir, port, prompt, children, ...options });
}

describe("link WebSocket release gate (design 11.1 item 13)", () => {
  test("the reviewed pin names the design's Codex revision and a digest of the right shape, or none yet", () => {
    expect(PIN.revision).toBe("88c58562580aa4abe2da6ce4d7676bf171682230");
    expect(PIN.sha256 === null || /^[0-9a-f]{64}$/.test(PIN.sha256)).toBe(true);
  });

  gate("drain: the switch goes off under a running turn; it finishes and its tool result is admitted, the idle socket is fenced, and the next session ends on HTTP", async () => {
    let atFirst: string[] = [];
    const bodies: string[] = [];
    const h = await home((body, index) => {
      bodies.push(body);
      if (index === 0) {
        atFirst = [...(standin?.events ?? [])];
        // The first request is running on the link socket: the Home's switch goes off under it (design 2.5).
        setLinkWebsocketTransportReadyForTests(false);
        // The turn asks for a read-only tool Codex declares, so Codex returns its result in a second request.
        return new Response(toolCall("resp_" + index), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(completed("resp_" + index), { headers: { "content-type": "text/event-stream" } });
    });
    standin = startRelayStandin({ linkPort: h.linkPort, identity, bearer: SECRET });
    expectCompleted(await runCodex(standin.port, { argument: "say gate-ok" }));
    // The first request ran on the admitted socket, before any HTTP.
    expect(atFirst[0]).toBe("upgrade");
    expect(atFirst.some(event => event.startsWith("ws-create:"))).toBe(true);
    expect(atFirst.some(event => event.startsWith("http:"))).toBe(false);
    // The running turn was not cancelled: Codex ran its tool and returned the result, which the draining socket
    // admits because it returns a pending result (design 2.5); then the idle socket was fenced with 1000.
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("call_gate_goal");
    const firstRun = [...standin.events];
    expect(firstRun.some(event => event.startsWith("http:"))).toBe(false);
    expect(firstRun.indexOf("home-close:1000")).toBeGreaterThan(firstRun.lastIndexOf(firstRun.filter(event => event.startsWith("ws-create:")).at(-1)!));
    // The next session's upgrade is refused while the switch is off, and its request completes over HTTP.
    expectCompleted(await runCodex(standin.port, { argument: "say gate-ok" }));
    const secondRun = standin.events.slice(firstRun.length);
    expect(secondRun.some(event => event.startsWith("upgrade-refused:"))).toBe(true);
    expect(secondRun).not.toContain("upgrade");
    expect(secondRun.at(-1)).toBe("http:200");
    // U11: Codex's WebSocket client sends no Origin. Every upgrade of both sessions arrived without one, so the
    // Home's shape check (which refuses an Origin) is not what sent the second session to HTTP.
    expect(standin.upgradeOrigins.length).toBeGreaterThanOrEqual(2);
    expect(standin.upgradeOrigins.every(origin => origin === null)).toBe(true);
  });

  gate("drain past its deadline: the session's next create is fenced on the socket, costs one retry, and the same request completes over HTTP", async () => {
    // Design 2.5: at or after t0 + 60 min a draining socket admits no create, even one returning a pending result.
    // A zero deadline puts this Home there as soon as the switch goes off, without waiting an hour.
    setLinkWebsocketLimitsForTests({ drainDeadlineMs: 0 });
    const bodies: string[] = [];
    const h = await home((body, index) => {
      bodies.push(body);
      if (index === 0) {
        setLinkWebsocketTransportReadyForTests(false);
        return new Response(toolCall("resp_" + index), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(completed("resp_" + index), { headers: { "content-type": "text/event-stream" } });
    });
    standin = startRelayStandin({ linkPort: h.linkPort, identity, bearer: SECRET });
    // One codex exec: one session, one request budget.
    expectCompleted(await runCodex(standin.port, { argument: "say gate-ok" }));
    const events = standin.events;
    const creates = events.flatMap((event, index) => event.startsWith("ws-create:") ? [index] : []);
    // The first request ran on the socket (after a warmup create, for a Codex that sends one); the tool result's
    // create was the last one sent on it, and the Home fenced the socket with 1000 after it.
    expect(events[0]).toBe("upgrade");
    expect(creates.length).toBeGreaterThanOrEqual(2);
    const fenced = events.indexOf("home-close:1000");
    expect(fenced).toBeGreaterThan(creates.at(-1)!);
    // The fenced frame never reached the upstream: the Home saw the first request and then the HTTP retry only.
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("call_gate_goal");
    // Codex retried: its reconnect was refused, and the same request (carrying the tool result) completed over HTTP.
    const after = events.slice(fenced + 1);
    expect(after.some(event => event.startsWith("upgrade-refused:"))).toBe(true);
    expect(after).not.toContain("upgrade");
    expect(after.at(-1)).toBe("http:200");
  });

  gate("a request over the 8 MiB message limit goes over HTTP", async () => {
    const sizes: number[] = [];
    const h = await home((body, index) => { sizes.push(body.length); return new Response(completed("resp_" + index), { headers: { "content-type": "text/event-stream" } }); });
    standin = startRelayStandin({ linkPort: h.linkPort, identity, bearer: SECRET });
    const result = await runCodex(standin.port, { argument: "say gate-ok" }, { instructionsBytes: STANDIN_MAX_MESSAGE_BYTES + 1024 });
    expectCompleted(result);
    expect(Math.max(...sizes)).toBeGreaterThan(STANDIN_MAX_MESSAGE_BYTES);
    // The socket was admitted first, then the oversized request went over HTTP: Codex never sent it on the socket (C7).
    const events = standin.events;
    expect(events.indexOf("upgrade")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("upgrade")).toBeLessThan(events.findIndex(event => event.startsWith("http:")));
    expect(events.some(event => event.startsWith("ws-oversize:"))).toBe(false);
    expect(events.filter(event => event.startsWith("ws-create:")).every(event => Number(event.split(":")[1]) <= STANDIN_MAX_MESSAGE_BYTES)).toBe(true);
    expect(events.at(-1)).toBe("http:200");
  });

  gate("control: without the advertised limit, Codex does send the oversized request on the socket", async () => {
    const h = await home((_body, index) => new Response(completed("resp_" + index), { headers: { "content-type": "text/event-stream" } }));
    standin = startRelayStandin({ linkPort: h.linkPort, identity, bearer: SECRET, advertiseLimit: false });
    await runCodex(standin.port, { argument: "say gate-ok" }, { instructionsBytes: STANDIN_MAX_MESSAGE_BYTES + 1024 });
    // What Codex does after the 1009 is not claimed (design 6.1); only that the header is what kept it off the socket above.
    expect(standin.events.some(event => event.startsWith("ws-oversize:"))).toBe(true);
  });

  gate("a Home restart mid-turn: the turn completes after Codex reconnects", async () => {
    let firstSeen!: () => void;
    const first = new Promise<void>(resolve => { firstSeen = resolve; });
    let atFirst: string[] = [];
    const h = await home((_body, index) => {
      if (index === 0) {
        atFirst = [...(standin?.events ?? [])];
        firstSeen();
        // The first request starts and never finishes: the Home restarts under it.
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode("event: response.created\ndata: " + JSON.stringify({ type: "response.created", response: { id: "resp_cut", status: "in_progress", output: [] } }) + "\n\n"));
        } }), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(completed("resp_" + index), { headers: { "content-type": "text/event-stream" } });
    });
    standin = startRelayStandin({ linkPort: h.linkPort, identity, bearer: SECRET });
    const result = runCodex(standin.port, { argument: "say gate-ok" });
    await untilOrExit(first, result, "the first request reached the Home");
    await server!.stop(true);
    standin.events.push("restart");
    await h.start();
    const done = await result;
    expectCompleted(done);
    // The stalled request was the one Codex sent on the admitted link socket: nothing had gone over HTTP yet.
    expect(atFirst[0]).toBe("upgrade");
    expect(atFirst.some(event => event.startsWith("ws-create:"))).toBe(true);
    expect(atFirst.some(event => event.startsWith("http:"))).toBe(false);
    // Completion came from a request after the restart; which transport Codex used for it is its own retry policy (C4, C5).
    const after = standin.events.slice(standin.events.indexOf("restart") + 1);
    expect(after.some(event => event.startsWith("ws-create:") || event === "http:200")).toBe(true);
  });

  /** The real Child listener in front of the scratch Home, with a tunnel gate the test drives; it learned the Home's advertisement from one probe. */
  async function realChild(linkPort: number, tunnel: LinkTunnelGate, records: LinkDiagnosticRecord[]): Promise<number> {
    const target = { tunnelPort: linkPort, admissionKey: SECRET, linkId: LINK, apiKeyId: KEY_ID };
    expect(await probeLinkRelayPreflight(target)).toBe("ok");
    childListener = startChild(linkPort, { keyId: KEY_ID, linkId: LINK, secret: SECRET },
      { tunnel, websocket: { ready: () => true, diagnostic: record => records.push(record) } });
    return childListener.port!;
  }

  const words = (records: LinkDiagnosticRecord[]) => records.map(record => record.event + ":" + record.outcome);

  gate("the 503 sequence while the Child's tunnel reconnects recovers on the WebSocket once the tunnel is back", async () => {
    const bodies: string[] = [];
    const h = await home((body, index) => { bodies.push(body); return new Response(completed("resp_" + index), { headers: { "content-type": "text/event-stream" } }); });
    // The first two upgrades find the tunnel reconnecting through their 3 s hold (503 each); the third finds it back.
    let holds = 0, up = false;
    const tunnel: LinkTunnelGate = {
      connected: () => ({ kind: up ? "match" : "unavailable" }), pending: () => !up,
      waitForConnected: async () => { holds += 1; if (holds === 3) up = true; return up; },
    };
    const records: LinkDiagnosticRecord[] = [];
    const port = await realChild(h.linkPort(), tunnel, records);
    expectCompleted(await runCodex(port, { argument: "say gate-ok" }));
    expect(holds).toBe(3);
    // Two 503s, then the socket opened, and the session never fell back to HTTP (no 426 was ever answered).
    expect(words(records).slice(0, 3)).toEqual(["link_ws_fallback:tunnel_connecting_timeout", "link_ws_fallback:tunnel_connecting_timeout", "link_ws_open:connected"]);
    expect(words(records).some(word => word.startsWith("link_ws_fallback:") && !word.endsWith("tunnel_connecting_timeout"))).toBe(false);
    expect(bodies.length).toBeGreaterThanOrEqual(1);
  });

  gate("the 503 sequence while the Child's tunnel reconnects ends on HTTP when the tunnel stays down past Codex's retry budget", async () => {
    const bodies: string[] = [];
    const h = await home((body, index) => { bodies.push(body); return new Response(completed("resp_" + index), { headers: { "content-type": "text/event-stream" } }); });
    // Every upgrade's 3 s hold ends with the tunnel still reconnecting; the HTTP relay's 15 s hold sees it come back.
    let upgradeHolds = 0, up = false;
    const tunnel: LinkTunnelGate = {
      connected: () => ({ kind: up ? "match" : "unavailable" }), pending: () => !up,
      waitForConnected: async ms => { if (ms > 3_000) up = true; else upgradeHolds += 1; return up; },
    };
    const records: LinkDiagnosticRecord[] = [];
    const port = await realChild(h.linkPort(), tunnel, records);
    expectCompleted(await runCodex(port, { argument: "say gate-ok" }));
    // Every upgrade Codex tried within its budget (how many is its own policy, C5/C6) was answered 503 and never
    // reached the Home; then the same request went over HTTP, once.
    expect(upgradeHolds).toBeGreaterThanOrEqual(2);
    expect(words(records)).toEqual(Array.from({ length: upgradeHolds }, () => "link_ws_fallback:tunnel_connecting_timeout"));
    expect(bodies).toHaveLength(1);
  });
});
