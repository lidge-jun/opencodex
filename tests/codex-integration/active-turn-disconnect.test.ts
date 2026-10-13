/** Admission follows the client lifetime even when upstream work stays pending. */
import { expect, test, spyOn, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import {
  abortAndReleaseAllTurns, getActiveTurnCount, sessionLaneMetrics,
  tryAdmitTurn, unregisterTurn, activeRegistryMetrics, getNativeMainProfileRequestCount,
} from "../../src/server/lifecycle";
import { createJevModelInvoker } from "../../src/server/responses/jev-model-invoke";
import { workflowBudgetSnapshot } from "../../src/lib/workflow-budget";
import * as live from "../../src/server/live";
import * as transport from "../../src/server/responses/request-transport";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

afterEach(() => abortAndReleaseAllTurns(new Error("fixture cleanup")));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}; turns=${getActiveTurnCount()} lanes=${sessionLaneMetrics().active}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const responsePrefix = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_fixture","status":"in_progress","output":[]}}\n\n';
const messagePrefix = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_fixture","type":"message","role":"assistant","model":"fixture","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n';

type Protocol = "responses-http" | "responses-ws" | "messages" | "compact";
type Phase = "stream" | "silent" | "retry" | "selection";

async function disconnectedTurn(protocol: Protocol, phase: Phase) {
  const previousHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-turn-disconnect-"));
  process.env.OPENCODEX_HOME = home;
  const entered = deferred<void>();
  const unblock = deferred<void>();
  let upstreamRequests = 0;
  let capturedSignal: AbortSignal | undefined;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    upstreamRequests += 1;
    await req.text();
    entered.resolve();
    if (phase === "silent") {
      await unblock.promise;
      return Response.json({ id: "resp_fixture", output: [] });
    }
    if (phase === "retry") return new Response("temporary fixture failure", { status: 503, headers: { "retry-after": "2" } });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(protocol === "messages" ? messagePrefix : responsePrefix));
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const originalPrepare = transport.prepareResponsesTransport;
  const prepare = spyOn(transport, "prepareResponsesTransport").mockImplementation(async (...args) => {
    capturedSignal = args[0].options.abortSignal ?? args[0].req.signal;
    if (phase === "selection") { entered.resolve(); await unblock.promise; }
    return originalPrepare(...args);
  });
  saveConfig({
    port: 0, hostname: "127.0.0.1", websockets: true, defaultProvider: "fixture",
    connectTimeoutMs: 10_000, stallTimeoutSec: 10,
    codexAutoStart: false, integrations: { codex: { enabled: false }, claudeCode: { enabled: false } },
    protocols: { rollout: { managedMessagesNative: true } },
    providers: { fixture: {
      adapter: protocol === "messages" ? "anthropic" : "openai-responses",
      baseUrl: `http://127.0.0.1:${upstream.port}${protocol === "messages" ? "" : "/v1"}`,
      authMode: "key", apiKey: "fixture-key", allowPrivateNetwork: true, models: ["fixture"],
    } },
  } as OcxConfig);
  const server = startServer(0);
  const before = { turns: getActiveTurnCount(), lanes: sessionLaneMetrics().active };
  const thread = `fixture-${protocol}-${phase}`;
  const root = `parent-${thread}`;
  const headers = { "content-type": "application/json", "thread-id": thread, "x-codex-parent-thread-id": root };
  let closeClient: (() => void) | undefined;
  try {
    if (protocol === "responses-ws") {
      const socket = new WebSocket(new URL("/v1/responses", server.url).href.replace("http:", "ws:"), { headers });
      closeClient = () => socket.close();
      await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("fixture websocket failed")); });
      const received = deferred<void>();
      socket.onmessage = () => received.resolve();
      socket.send(JSON.stringify({ type: "response.create", model: "fixture/fixture", input: "fixture", stream: true }));
      await entered.promise;
      if (phase === "stream") await received.promise;
      await until(() => getActiveTurnCount() === before.turns + 1, "websocket admitted");
      socket.close();
      await new Promise<void>(resolve => { if (socket.readyState === WebSocket.CLOSED) resolve(); else socket.onclose = () => resolve(); });
    } else {
      const path = protocol === "messages" ? "/v1/messages" : protocol === "compact" ? "/v1/responses/compact" : "/v1/responses";
      const body = protocol === "messages"
        ? { model: "fixture/fixture", max_tokens: 64, messages: [{ role: "user", content: "fixture" }], stream: true }
        : { model: "fixture/fixture", input: "fixture", ...(protocol === "compact" ? {} : { stream: true }) };
      const received = deferred<void>();
      const client = request(new URL(path, server.url), { method: "POST", headers }, response => {
        response.on("data", () => received.resolve());
        response.on("error", () => {});
      });
      client.on("error", () => {});
      closeClient = () => client.destroy();
      client.end(JSON.stringify(body));
      await entered.promise;
      if (phase === "stream") await received.promise;
      await until(() => getActiveTurnCount() === before.turns + 1, "HTTP admitted");
      client.destroy();
    }
    if (phase === "selection") {
      await until(() => capturedSignal?.aborted === true, `${protocol}/${phase} cancelled`);
      expect(getActiveTurnCount()).toBe(before.turns + 1);
      expect(sessionLaneMetrics().active).toBe(before.lanes + 1);
      if (protocol === "responses-http") expect(workflowBudgetSnapshot(root)?.active ?? 0).toBeGreaterThan(0);
      expect(upstreamRequests).toBe(0);
    } else {
      await until(() => getActiveTurnCount() === before.turns && sessionLaneMetrics().active === before.lanes, `${protocol}/${phase} released`);
    }
    console.log(JSON.stringify({ protocol, phase, before, after: { turns: getActiveTurnCount(), lanes: sessionLaneMetrics().active }, upstreamRequests, clientSignalAborted: capturedSignal?.aborted }));
    if (phase === "selection") {
      expect(getActiveTurnCount()).toBe(before.turns + 1);
      expect(sessionLaneMetrics().active).toBe(before.lanes + 1);
      if (protocol === "responses-http") expect(workflowBudgetSnapshot(root)?.active ?? 0).toBeGreaterThan(0);
    } else {
      expect(getActiveTurnCount()).toBe(before.turns);
      expect(sessionLaneMetrics().active).toBe(before.lanes);
      if (protocol !== "responses-ws") expect(workflowBudgetSnapshot(root)?.active ?? 0).toBe(0);
    }
  } catch (error) {
    console.log(JSON.stringify({ protocol, phase, before, after: { turns: getActiveTurnCount(), lanes: sessionLaneMetrics().active }, upstreamRequests, clientSignalAborted: capturedSignal?.aborted }));
    throw error;
  } finally {
    closeClient?.();
    unblock.resolve();
    try {
      if (phase === "selection") {
        await until(() => getActiveTurnCount() === before.turns && sessionLaneMetrics().active === before.lanes, `${protocol}/${phase} finalized`);
      }
    } finally {
      prepare.mockRestore();
      abortAndReleaseAllTurns(new Error("fixture teardown"));
      await server.stop(true);
      await upstream.stop(true);
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  }
}

for (const protocol of ["responses-http", "responses-ws", "messages"] as const) {
  for (const phase of ["stream", "silent", "retry"] as const) {
    test(`${protocol} releases its lane after disconnect during ${phase}`, () => disconnectedTurn(protocol, phase), 15_000);
  }
}
for (const protocol of ["responses-http", "responses-ws"] as const) {
  test(`${protocol} retains admission while account selection stays pending`, () => disconnectedTurn(protocol, "selection"), 15_000);
}
test("compact releases its lane after disconnect before upstream headers", () => disconnectedTurn("compact", "silent"), 15_000);

test("an aborted registered controller retains ownership while its work stays pending", () => {
  const before = activeRegistryMetrics().activeTurns;
  const laneBefore = sessionLaneMetrics().active;
  const lease = tryAdmitTurn("fixture-controller")!;
  let released = 0;
  lease.attach({ release() { released += 1; } });
  const ac = new AbortController();
  lease.bindAbortController(ac);
  try {
    ac.abort(new Error("fixture client closed"));
    expect(getActiveTurnCount()).toBe(before.active + 1);
    expect(sessionLaneMetrics().active).toBe(laneBefore + 1);
    expect(released).toBe(0);
    unregisterTurn(ac);
    lease.release();
    expect(getActiveTurnCount()).toBe(before.active);
    expect(sessionLaneMetrics().active).toBe(laneBefore);
    expect(released).toBe(1);
    expect(activeRegistryMetrics().activeTurns.releaseMisses).toBe(before.releaseMisses);
  } finally { lease.release(); }
});


test("ingress cancellation retains admission until pending selection unwinds", () => {
  const before = getActiveTurnCount();
  const nativeBefore = getNativeMainProfileRequestCount();
  const client = new AbortController();
  const lease = tryAdmitTurn("fixture-selection", client.signal)!;
  const selection = lease.beginCodexAccountSelection();
  const duringSelection = getNativeMainProfileRequestCount();
  const first = new AbortController();
  const second = new AbortController();
  lease.bindAbortController(first);
  lease.bindAbortController(second);
  lease.bindAbortController(first);
  const reason = new Error("fixture ingress closed");
  client.abort(reason);
  expect(getActiveTurnCount()).toBe(before + 1);
  expect(getNativeMainProfileRequestCount()).toBe(duringSelection);
  expect(first.signal.reason).toBe(reason);
  expect(second.signal.reason).toBe(reason);
  expect(selection.claimMainProfile()).toBe(false);
  selection.release();
  lease.release();
  expect(getNativeMainProfileRequestCount()).toBe(nativeBefore);
  const late = new AbortController();
  lease.bindAbortController(late);
  expect(late.signal.reason).toBe(reason);
  let released = 0;
  lease.attach({ release() { released += 1; } });
  expect(released).toBe(1);
});

test("already aborted ingress cannot acquire admission or selection", () => {
  const before = getActiveTurnCount();
  const nativeBefore = getNativeMainProfileRequestCount();
  const client = new AbortController();
  client.abort(new Error("fixture already closed"));
  const lease = tryAdmitTurn("fixture-pre-aborted", client.signal);
  expect(getActiveTurnCount()).toBe(before);
  expect(lease).toBeNull();
  expect(getNativeMainProfileRequestCount()).toBe(nativeBefore);
});

test("normal completion detaches cancellation listeners", () => {
  const client = new AbortController();
  const remove = spyOn(client.signal, "removeEventListener");
  const lease = tryAdmitTurn("fixture-complete", client.signal)!;
  const upstream = new AbortController();
  lease.bindAbortController(upstream);
  lease.release();
  expect(remove).toHaveBeenCalledTimes(1);
  client.abort(new Error("fixture request disposed"));
  expect(upstream.signal.aborted).toBe(false);
  remove.mockRestore();
});


test("internal decision cancellation retains admission while dispatch remains pending", async () => {
  const before = getActiveTurnCount();
  const entered = deferred<void>();
  const unblock = deferred<Response>();
  const client = new AbortController();
  const invoke = createJevModelInvoker({
    req: { headers: new Headers() },
    config: { port: 0, defaultProvider: "fixture", providers: {} } as OcxConfig,
    options: {},
    async handleResponses() { entered.resolve(); return unblock.promise; },
  });
  const pending = invoke({ model: "fixture", instructions: "fixture", input: "fixture", signal: client.signal });
  const settled = pending.catch(() => undefined);
  await entered.promise;
  expect(getActiveTurnCount()).toBe(before + 1);
  try {
    client.abort(new Error("fixture decision closed"));
    expect(getActiveTurnCount()).toBe(before + 1);
  } finally {
    unblock.resolve(new Response(null, { status: 499 }));
    await settled;
  }
});


test("Live upgrade disconnect retains admission while resolution remains pending", async () => {
  const previousHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-upgrade-disconnect-"));
  process.env.OPENCODEX_HOME = home;
  const entered = deferred<void>();
  const unblock = deferred<Response>();
  const resolve = spyOn(live, "resolveLiveSidebandUpgrade").mockImplementation(async () => {
    entered.resolve();
    return unblock.promise;
  });
  saveConfig({ port: 0, hostname: "127.0.0.1", websockets: true, defaultProvider: "fixture",
    codexAutoStart: false, integrations: { codex: { enabled: false }, claudeCode: { enabled: false } },
    providers: { fixture: { adapter: "openai-responses", baseUrl: "http://127.0.0.1:1/v1", authMode: "key", apiKey: "fixture-key", allowPrivateNetwork: true, models: ["fixture"] } },
  } as OcxConfig);
  const server = startServer(0);
  const before = getActiveTurnCount();
  const socket = new WebSocket(new URL("/v1/live/fixture", server.url).href.replace("http:", "ws:"));
  socket.onerror = () => {};
  try {
    await entered.promise;
    expect(getActiveTurnCount()).toBe(before + 1);
    socket.close();
    expect(getActiveTurnCount()).toBe(before + 1);
    unblock.resolve(new Response(null, { status: 499 }));
    await until(() => getActiveTurnCount() === before, "Live upgrade admission finalized");
  } finally {
    unblock.resolve(new Response(null, { status: 499 }));
    resolve.mockRestore();
    socket.close();
    abortAndReleaseAllTurns(new Error("fixture teardown"));
    await server.stop(true);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  }
}, 15_000);


test("upgrade transfer detaches ingress cancellation and keeps connection ownership", () => {
  const before = getActiveTurnCount();
  const ingress = new AbortController();
  const connection = new AbortController();
  const lease = tryAdmitTurn("fixture-upgrade-transfer")!;
  lease.bindAbortController(connection);
  const detach = lease.bindAbortSignal(ingress.signal);
  detach();
  detach();
  ingress.abort(new Error("fixture handshake disposed"));
  expect(getActiveTurnCount()).toBe(before + 1);
  expect(connection.signal.aborted).toBe(false);
  connection.abort(new Error("fixture socket closed"));
  expect(getActiveTurnCount()).toBe(before + 1);
  lease.release();
  expect(getActiveTurnCount()).toBe(before);
});

test("retains saturated admission until stalled work settles without aborting sibling work", () => {
  const leases = [];
  try {
    for (let index = 0; index < 512; index += 1) {
      const lease = tryAdmitTurn();
      if (!lease) break;
      leases.push(lease);
    }
    expect(leases.length).toBeGreaterThan(1);
    const cancelled = leases[0]!;
    const sibling = leases[1]!;
    const cancellation = new AbortController();
    const work = new AbortController();
    const siblingWork = new AbortController();
    cancelled.bindAbortSignal(cancellation.signal);
    cancelled.bindAbortController(work);
    sibling.bindAbortController(siblingWork);

    cancellation.abort(new Error("client disconnected"));

    expect(work.signal.aborted).toBe(true);
    expect(siblingWork.signal.aborted).toBe(false);
    expect(getActiveTurnCount()).toBe(leases.length);
    expect(tryAdmitTurn()).toBeNull();

    const lateWork = new AbortController();
    cancelled.bindAbortController(lateWork);
    expect(lateWork.signal.aborted).toBe(true);
    const selection = cancelled.beginCodexAccountSelection();
    expect(selection.claimMainProfile()).toBe(false);
    selection.release();
  } finally {
    for (const lease of leases) lease.release();
  }
});

test("cancellation aborts all controllers when an abort listener releases the lease", () => {
  const before = getActiveTurnCount();
  const cancellation = new AbortController();
  const lease = tryAdmitTurn("fixture-reentrant-release", cancellation.signal)!;
  const first = new AbortController();
  const second = new AbortController();
  const reason = new Error("fixture reentrant cancellation");
  lease.bindAbortController(first);
  lease.bindAbortController(second);
  first.signal.addEventListener("abort", () => lease.release(), { once: true });
  try {
    cancellation.abort(reason);
    expect(first.signal.reason).toBe(reason);
    expect(second.signal.reason).toBe(reason);
    expect(getActiveTurnCount()).toBe(before);
  } finally { lease.release(); }
});

test.each([false, true])("late cancelled controller unregister preserves its owner's admission (transferred=%s)", transferred => {
  const before = activeRegistryMetrics().activeTurns;
  const lanes = sessionLaneMetrics().active;
  const nativeBefore = getNativeMainProfileRequestCount();
  const ingress = new AbortController();
  const lease = tryAdmitTurn(`fixture-late-controller-${transferred}`, ingress.signal)!;
  const selection = lease.beginCodexAccountSelection();
  const duringSelection = getNativeMainProfileRequestCount();
  let released = 0;
  lease.attach({ release() { released += 1; } });
  if (transferred) lease.bindAbortController(new AbortController());
  const reason = new Error("fixture cancelled before late binding");
  ingress.abort(reason);
  const late = new AbortController();
  late.signal.addEventListener("abort", () => unregisterTurn(late), { once: true });
  try {
    lease.bindAbortController(late);
    expect(late.signal.reason).toBe(reason);
    expect(getActiveTurnCount()).toBe(before.active + 1);
    expect(sessionLaneMetrics().active).toBe(lanes + 1);
    expect(getNativeMainProfileRequestCount()).toBe(duringSelection);
    expect(selection.claimMainProfile()).toBe(false);
    expect(released).toBe(0);
    expect(lease.isTransferred()).toBe(transferred);
    unregisterTurn(late);
    expect(getActiveTurnCount()).toBe(before.active + 1);
    expect(activeRegistryMetrics().activeTurns.releaseMisses).toBe(before.releaseMisses);
    lease.release();
    expect(getActiveTurnCount()).toBe(before.active);
    expect(sessionLaneMetrics().active).toBe(lanes);
    expect(getNativeMainProfileRequestCount()).toBe(nativeBefore);
    expect(released).toBe(1);
  } finally { lease.release(); }
});
