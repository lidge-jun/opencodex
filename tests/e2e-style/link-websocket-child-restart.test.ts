import { afterEach, describe, expect, setDefaultTimeout } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import type { OcxConfig } from "../../src/types";
import { setLinkWebsocketTransportReadyForTests } from "../../src/server/index/link-websocket-limits";
import { observeRequestLogsForTests, type RequestLogEntry } from "../../src/server/request-log";
import { linkStorePath } from "../../src/link/paths";
import { writeLinkStore, type LinkStore } from "../../src/link/store";
import type { LinkDiagnosticRecord } from "../../src/link/diagnostics";
import type { LinkTunnelGate } from "../../src/client/link-relay";
import { startMachineListener } from "../../src/client/machine-listener";
import { probeLinkRelayPreflight } from "../../src/client/link-relay-transport";
import { forgetLinkWebsocketAdvertisementsForTests, linkWebsocketAdvertisement } from "../../src/client/link-ws-advertisement";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { childConnection } from "../helpers/link-ws-child";
import { completed, expectCompleted, gate, runGateCodex, toolCall, untilOrExit } from "../helpers/link-gate-codex";

// Measurement for the link WebSocket release gate (design T4 11.2, a Child restart under a running turn; lane G item
// 3 d-e): the pinned Codex through the real TypeScript Child relay in front of a real Home, while the Child restarts
// between the two requests of a turn. Opt-in and labelled as the gate file (tests/helpers/link-gate-codex.ts).
//
// The restart is modelled in process, in the order the runtime follows since #8658: the tunnel gate's onStopping hook
// drains the relay (open sockets close 1001, every upgrade gets the transient 503), the old listener stays bound for
// the drain phase, it then stops (connections refused), and a replacement listener binds the same port. A restarted
// process remembers no advertisement, so the replacement starts with none and runs no preflight before Codex's next
// attempt. Variants model the two Child changes lane T6 proposed. Since #8682 the product's rule is try-when-unknown;
// the old rule is kept for comparison, and close-at-drain is still only proposed:
//   try-when-unknown: dev's rule since #8682: the replacement tries the Home unless it holds a cached "off", so with no
//     answer seen since start it tries (the relay's default rule, run with no seam);
//   old-rule: the rule before #8682: 503 for the drain phase, then refused, then the replacement answers 426 (not
//     advertised) until a preflight teaches it the advertisement;
//   old-rule+close-at-drain and try-when-unknown+close-at-drain: the listener closes when the drain starts, so the
//     whole restart is refused.
// Each case runs with Codex's stream_max_retries 3 (the gate's setting) and 5 (Codex's default), for a restart of
// about 5.5 s (the supervisor's TERM bound of 5 s plus a bind) and of about 1 s. The cases assert only that the turn
// completes; what they measure (every 503, Codex's retry and fallback notices, the transport that completed the
// turn, and the next session's transport) is printed as one JSON line per case, prefixed "[restart measurement]".
// The restart's phases are wall-clock waits by design: they are the scenario, against an external process.
setDefaultTimeout(180_000);

const KEY_ID = "gate-key"; const SECRET = "gate-secret-0123456789abcdef"; const LINK = "lnk_9c9c9c9c9c9c9c9c";
const identity = { keyId: KEY_ID, linkId: LINK, secret: SECRET };

const previous = { home: process.env.OPENCODEX_HOME };
let dir = "";
let codexHome: IsolatedCodexHome | null = null;
let server: { stop(force?: boolean): Promise<void> } | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
const listeners: Array<Server<unknown>> = [];
let stopObserving: (() => void) | null = null;
const children: Array<ReturnType<typeof Bun.spawn>> = [];

afterEach(async () => {
  setLinkWebsocketTransportReadyForTests(false);
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
  for (const listener of listeners.splice(0)) await listener.stop(true);
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

type Variant = "try-when-unknown" | "old-rule" | "try-when-unknown+close-at-drain" | "old-rule+close-at-drain";
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** A tunnel gate that is connected and lets the test fire its owner's onStopping, as the supervisor's stop() does. */
function stoppableTunnel() {
  const stopping: Array<() => void> = [];
  const tunnel: LinkTunnelGate = {
    connected: () => ({ kind: "match" }), pending: () => false, waitForConnected: async () => true,
    onStopping(listener) { stopping.push(listener); },
  };
  return { tunnel, stop: () => { for (const listener of stopping.splice(0)) listener(); } };
}

async function measureRestart(variant: Variant, retries: number, restartMs: number) {
  const t0 = { at: 0 };
  const timeline: Array<[number, string]> = [];
  const mark = (what: string) => timeline.push([t0.at ? Date.now() - t0.at : -1, what]);
  let restart!: () => void;
  const restarted = new Promise<void>(resolve => { restart = resolve; });
  dir = mkdtempSync(join(tmpdir(), "ocx-link-child-restart-"));
  process.env.OPENCODEX_HOME = join(dir, "home");
  codexHome = installIsolatedCodexHome("ocx-link-child-restart-codex-");
  writeFileSync(join(codexHome.path, "opencodex-catalog.json"), JSON.stringify({ models: [{ slug: "fixture/fixture" }] }));
  let index = 0;
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(req) {
    await req.text();
    const at = index++;
    if (at === 0) return new Response(toolCall("resp_0"), { headers: { "content-type": "text/event-stream" } });
    if (at === 1) {
      // The tool result's request is in flight: the Child restarts under it, and this request never completes.
      restart();
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(completed("resp_" + at), { headers: { "content-type": "text/event-stream" } });
  } });
  writeLinkStore(linkStorePath(), { version: 1, listenerPort: null, links: [{ id: LINK, alias: "gate", direction: "client-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 2222, apiKeyId: KEY_ID, createdAt: "2026-11-13T00:00:00.000Z" }] as LinkStore["links"] });
  const { saveConfig } = await import("../../src/config");
  saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "fixture", websockets: true, linkResponsesWebsocket: true, codexAutoStart: false, clientIntegrations: { codex: false },
    providers: { fixture: { adapter: "openai-responses", baseUrl: "http://127.0.0.1:" + upstream.port + "/v1", authMode: "key", apiKey: "fixture-upstream-key", allowPrivateNetwork: true, models: ["fixture"] } },
    apiKeys: [{ id: KEY_ID, name: KEY_ID, key: SECRET, createdAt: "2026-11-13T00:00:00.000Z" }] } as OcxConfig);
  setLinkWebsocketTransportReadyForTests(true);
  const rows: string[] = [];
  stopObserving = observeRequestLogsForTests((entry: RequestLogEntry) => { const row = (entry.link?.transport ?? "unmarked") + ":" + entry.status; rows.push(row); mark("home row " + row); });
  const { startServer } = await import("../../src/server");
  server = startServer(0);
  const linkPort = JSON.parse(readFileSync(linkStorePath(), "utf8")).listenerPort as number;
  expect(await probeLinkRelayPreflight({ tunnelPort: linkPort, admissionKey: SECRET, linkId: LINK, apiKeyId: KEY_ID })).toBe("ok");

  const child = (name: string, port: number, advertised?: (linkId: string | undefined) => boolean) => {
    const gateA = stoppableTunnel();
    const listener = startMachineListener(port, {
      state: childConnection(linkPort, identity), linkKeySource: () => SECRET, linkTunnel: gateA.tunnel,
      // Every upgrade request this listener answers is marked with its answer (101 when the socket was upgraded), seen
      // around the listener's own fetch handler so the product's code runs unchanged.
      serve: options => Bun.serve({ ...options, fetch: async (req: Request, bunServer: Server<unknown>) => {
        const answer = await (options.fetch as (req: Request, server: Server<unknown>) => Promise<Response | undefined>)(req, bunServer);
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") mark(name + " upgrade answered " + (answer?.status ?? 101));
        return answer;
      } } as Parameters<typeof Bun.serve>[0]),
      linkWebsocket: { ready: () => true, ...(advertised ? { advertised } : {}), diagnostic: (record: LinkDiagnosticRecord) => mark(name + " " + record.event + ":" + record.outcome) },
    });
    listeners.push(listener);
    return { listener, stopTunnel: gateA.stop };
  };
  const old = child("old", 0);
  const port = old.listener.port!;
  const closeAtDrain = variant.endsWith("+close-at-drain");
  const tryWhenUnknown = variant.startsWith("try-when-unknown");
  const bindMs = 500;
  const drainMs = closeAtDrain ? 0 : restartMs - bindMs;

  const run = runGateCodex({ dir, port, prompt: { argument: "say gate-ok" }, children, streamMaxRetries: retries, onStderrLine: line => {
    if (/Reconnecting|Falling back|waiting for network/.test(line)) mark("codex " + line.replace(/^.*?(Reconnecting|warning: Falling back)/, "$1").slice(0, 90));
  },
  // Marked when the Codex process exits (before its output is collected), which can be during the restart: it bounds
  // the first session's counts.
  onExit: code => mark("codex exit " + code) });
  await untilOrExit(restarted, run, "the tool result reached the Home");
  t0.at = Date.now();
  mark("restart: drain starts (onStopping)");
  old.stopTunnel();
  if (!closeAtDrain) { await delay(drainMs); }
  await old.listener.stop(true);
  mark("old listener closed (refused from here)");
  // A restarted process remembers no advertisement.
  forgetLinkWebsocketAdvertisementsForTests();
  await delay(closeAtDrain ? restartMs : bindMs);
  // try-when-unknown is the product's rule since #8682 and runs through the relay's default path, with no seam. Only the
  // old rule is injected (try only on a cached "on"); either way the replacement's answers are marked by the serve wrapper.
  child("new", port, tryWhenUnknown ? undefined : linkId => linkWebsocketAdvertisement(linkId) === "on");
  mark("new listener bound");
  const result = await run;
  expectCompleted(result);
  const completedOn = rows.filter(row => row.endsWith(":200")).at(-1) ?? "none";
  const firstSession = timeline.slice(0, timeline.findIndex(([, what]) => what.startsWith("codex exit")));
  // The next session, through the replacement Child (it has learned the advertisement from any relayed request).
  const nextRows = rows.length;
  expectCompleted(await runGateCodex({ dir, port, prompt: { argument: "say gate-ok" }, children, streamMaxRetries: retries }));
  const nextSession = rows.slice(nextRows).join(",");
  console.info("[restart measurement] " + JSON.stringify({ variant, stream_max_retries: retries, restart_ms: restartMs, drain_503_ms: drainMs,
    refused_ms: closeAtDrain ? restartMs : bindMs, completed_on: completedOn, next_session: nextSession,
    // Counts for the turn under test only: everything marked before its Codex exited.
    draining_503s: firstSession.filter(([, what]) => what === "old link_ws_fallback:draining").length,
    new_426s: firstSession.filter(([, what]) => what === "new upgrade answered 426").length, timeline }));
}

describe("link WebSocket release gate through the real Child: a Child restart under a running turn (measurement)", () => {
  for (const restartMs of [5_500, 1_000])
    for (const retries of [3, 5])
      for (const variant of ["try-when-unknown", "old-rule", "try-when-unknown+close-at-drain", "old-rule+close-at-drain"] as const)
        gate("restart " + restartMs + " ms, stream_max_retries " + retries + ", " + variant + ": the turn completes; the transport it ends on is measured",
          () => measureRestart(variant, retries, restartMs));
});
