import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { MAX_ACTIVE_TURNS, tryAdmitTurn } from "../../src/server/lifecycle";
import { MAX_CONCURRENT_INBOUND_BODY_BYTES, withRaisedInboundBodyAdmission } from "../../src/server/inbound-body-admission";
import { readRecentUsageEntries } from "../../src/usage/log";
import { admitWorkflowTurn, chargeWorkflowSends, DEFAULT_WORKFLOW_BUDGET_POLICY, resetWorkflowBudgetsForTest } from "../../src/lib/workflow-budget";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";
import type { OcxConfig } from "../../src/types";

type Mode = "caller-forward" | "managed-native" | "translated";
let fixtureHome = "";
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome | undefined;
let proxy: ReturnType<typeof startServer> | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let upstreamCancelled = false;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  fixtureHome = mkdtempSync(join(tmpdir(), "ocx-messages-request-id-"));
  process.env.OPENCODEX_HOME = fixtureHome;
  codexHome = installIsolatedCodexHome("ocx-messages-id-codex-");
  resetWorkflowBudgetsForTest();
  upstreamCancelled = false;
});

afterEach(async () => {
  await proxy?.stop(true);
  proxy = undefined;
  await upstream?.stop(true);
  upstream = undefined;
  resetWorkflowBudgetsForTest();
  await drainAndRemoveFixtureRoots({
    roots: [{ path: fixtureHome }, ...(codexHome ? [{ path: codexHome.path }] : [])],
    restoreEnvironment() {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      codexHome?.restoreEnvironment();
    },
  });
  codexHome = undefined;
});

const message = { id: "msg_fixture", type: "message", role: "assistant", model: "claude-x",
  content: [{ type: "text", text: "fixture answer" }], stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 4, output_tokens: 2 } };
const messageSse = [
  ["message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 4, output_tokens: 0 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture answer" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
  ["message_stop", { type: "message_stop" }],
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
const chatSse = [
  { id: "chat_fixture", choices: [{ index: 0, delta: { role: "assistant", content: "fixture answer" } }] },
  { id: "chat_fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2 } },
].map(data => `data: ${JSON.stringify(data)}\n\n`).join("") + "data: [DONE]\n\n";

function launch(mode: Mode, wire: "json" | "sse", status = 200, override: Partial<OcxConfig> = {}, hang = false) {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    if (new URL(req.url).pathname.endsWith("count_tokens")) return Response.json({ input_tokens: 4 });
    const body = status !== 200 ? JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "fixture refusal" } })
      : mode === "translated" ? chatSse : wire === "sse" ? messageSse : JSON.stringify(message);
    const partial = body.split("\n\n").slice(0, mode === "translated" ? 1 : 3).join("\n\n") + "\n\n";
    const delivered = hang ? new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(partial)); },
      cancel() { upstreamCancelled = true; },
    }, { highWaterMark: 0 }) : body;
    return new Response(delivered, { status, headers: {
      "content-type": status !== 200 || (mode !== "translated" && wire === "json") ? "application/json" : "text/event-stream",
      "request-id": "req_fixture", "x-opencodex-request-id": "upstream-controlled", "set-cookie": "fixture",
    } });
  } });
  const baseUrl = upstream.url.toString().replace(/\/$/, "");
  saveConfig({ port: 0, defaultProvider: "mock", connectTimeoutMs: 1000,
    providers: { mock: { adapter: mode === "translated" ? "openai-chat" : "anthropic",
      baseUrl: mode === "translated" ? `${baseUrl}/v1` : baseUrl, apiKey: "fixture-key",
      allowPrivateNetwork: true, liveModels: false, models: ["claude-x"] } },
    claudeCode: { anthropicBaseUrl: baseUrl },
    ...(mode === "managed-native" ? { protocols: { rollout: { managedMessagesNative: true } } } : {}),
    ...override,
  } as OcxConfig);
  proxy = startServer(0);
}

function send(mode: Mode, stream: boolean, extraHeaders: Record<string, string> = {}, path = "/v1/messages?beta=true", signal?: AbortSignal) {
  return fetch(new URL(path, proxy!.url), { method: "POST", signal, headers: {
    "content-type": "application/json",
    ...(mode === "caller-forward" ? { authorization: "Bearer sk-ant-oat01-fixture" } : {}),
    "request-id": "caller-controlled", "x-opencodex-request-id": "caller-controlled", ...extraHeaders,
  }, body: JSON.stringify({ model: mode === "caller-forward" ? "claude-x" : "mock/claude-x",
    max_tokens: 16, stream, messages: [{ role: "user", content: "fixture question" }] }) });
}

async function expectDurableId(response: Response) {
  const requestId = response.headers.get("request-id");
  expect(requestId).toMatch(/^ocx-[a-f0-9]{32}$/);
  expect(response.headers.get("x-opencodex-request-id")).toBe(requestId);
  await response.text();
  return durableRowFor(requestId!);
}

async function durableRowFor(requestId: string) {
  let rows = readRecentUsageEntries(100, fixtureHome).filter(row => row.requestId === requestId);
  for (let i = 0; i < 100 && rows.length === 0; i++) {
    await Bun.sleep(10);
    rows = readRecentUsageEntries(100, fixtureHome).filter(row => row.requestId === requestId);
  }
  expect(rows).toHaveLength(1);
  expect(rows[0]!.inboundProtocol).toBe("messages");
  return rows[0]!;
}

for (const mode of ["caller-forward", "managed-native", "translated"] as const) {
  for (const stream of [false, true]) {
    test(`${mode} ${stream ? "SSE" : "JSON"} has the same standard/custom/durable request id`, async () => {
      launch(mode, stream ? "sse" : "json");
      const response = await send(mode, stream);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-opencodex-upstream-request-id")).toBe(mode === "translated" ? null : "req_fixture");
      expect(response.headers.get("set-cookie")).toBeNull();
      await expectDurableId(response);
    });
  }
}

for (const [stream, wire] of [[false, "sse"], [true, "json"]] as const) {
  test(`managed native converts ${wire} and retains its upstream id`, async () => {
    launch("managed-native", wire);
    const response = await send("managed-native", stream);
    expect(response.headers.get("x-opencodex-upstream-request-id")).toBe("req_fixture");
    await expectDurableId(response);
  });
}

for (const mode of ["caller-forward", "managed-native"] as const) {
  test(`${mode} logged upstream refusal has both ids`, async () => {
    launch(mode, "json", 400);
    const response = await send(mode, false);
    expect(response.status).toBe(400);
    expect(response.headers.get("x-opencodex-upstream-request-id")).toBe("req_fixture");
    await expectDurableId(response);
  });
}

test("disabled Messages is a logged refusal", async () => {
  launch("translated", "json", 200, { apiSurfaces: { messages: { enabled: false } } });
  const response = await send("translated", false);
  expect(response.status).toBe(403);
  expect(response.headers.has("x-opencodex-upstream-request-id")).toBe(false);
  await expectDurableId(response);
});

test("pre-handler workflow refusal is logged and receives the correlation id", async () => {
  launch("translated", "json");
  const admitted = admitWorkflowTurn("fixture-root", "interactive");
  expect(admitted?.admitted).toBe(true);
  if (admitted?.admitted) admitted.lease.release();
  chargeWorkflowSends("fixture-root", DEFAULT_WORKFLOW_BUDGET_POLICY.maxPhysicalSends);
  const response = await send("translated", false, { "x-codex-parent-thread-id": "fixture-root" });
  expect(response.status).toBe(429);
  await expectDurableId(response);
});

test("active-turn refusal has no fabricated ledger association", async () => {
  launch("translated", "json");
  const leases = Array.from({ length: MAX_ACTIVE_TURNS }, () => tryAdmitTurn());
  try {
    expect(leases.every(Boolean)).toBe(true);
    const before = readRecentUsageEntries(100, fixtureHome).length;
    const response = await send("translated", false);
    expect(response.status).toBe(503);
    expect(response.headers.has("request-id")).toBe(false);
    expect(response.headers.has("x-opencodex-request-id")).toBe(false);
    await response.text();
    expect(readRecentUsageEntries(100, fixtureHome)).toHaveLength(before);
  } finally { for (const lease of leases) lease?.release(); }
});

test("count_tokens has no OCX ledger id", async () => {
  launch("caller-forward", "json");
  const response = await send("caller-forward", false, {}, "/v1/messages/count_tokens");
  expect(response.headers.has("x-opencodex-request-id")).toBe(false);
  expect(response.headers.has("request-id")).toBe(false);
  expect(await response.json()).toEqual({ input_tokens: 4 });
});

for (const mode of ["caller-forward", "managed-native", "translated"] as const) {
  test(`${mode} client cancellation retains the same durable id and releases the turn`, async () => {
    launch(mode, "sse", 200, {}, true);
    const client = new AbortController();
    const response = await send(mode, true, {}, "/v1/messages?beta=true", client.signal);
    const requestId = response.headers.get("request-id")!;
    expect(requestId).toMatch(/^ocx-[a-f0-9]{32}$/);
    expect(response.headers.get("x-opencodex-request-id")).toBe(requestId);
    expect(readRecentUsageEntries(100, fixtureHome).some(row => row.requestId === requestId)).toBe(false);
    const reader = response.body!.getReader();
    try {
      expect((await reader.read()).done).toBe(false);
      client.abort(new DOMException("fixture client left", "AbortError"));
      try { while (!(await reader.read()).done) {} } catch { /* expected fetch cancellation */ }
      const row = await durableRowFor(requestId);
      // The translated bridge's disconnect classification depends on the Bun runtime
      // (terminal 502 on 1.4.0, client_cancel 499 on 1.4.2). This change only owns the
      // header-to-row correlation, so either existing classification is accepted there.
      if (mode === "translated") {
        expect([[502, "terminal"], [499, "client_cancel"]]).toContainEqual([row.status, row.closeReason]);
      } else {
        expect(row.status).toBe(499);
        expect(row.closeReason).toBe("client_cancel");
      }
      for (let i = 0; i < 100 && !upstreamCancelled; i++) await Bun.sleep(10);
      expect(upstreamCancelled).toBe(true);
      // No transferred turn remains: all admission slots are available again.
      const leases = Array.from({ length: MAX_ACTIVE_TURNS }, () => tryAdmitTurn());
      try { expect(leases.every(Boolean)).toBe(true); }
      finally { for (const lease of leases) lease?.release(); }
    } finally {
      client.abort();
      try { await reader.cancel(); } catch { /* aborted reader */ }
      reader.releaseLock();
    }
  });
}

test("pre-handler body-capacity refusal receives the persisted OCX id and releases capacity", async () => {
  launch("translated", "json", 200, { maxInboundBodyBytes: MAX_CONCURRENT_INBOUND_BODY_BYTES });
  const held = await withRaisedInboundBodyAdmission(new Request("http://localhost/v1/messages", {
    method: "POST", body: "{}",
  }), "/v1/messages", MAX_CONCURRENT_INBOUND_BODY_BYTES,
  async () => new Response(new ReadableStream<Uint8Array>({}, { highWaterMark: 0 })));
  try {
    const response = await send("translated", false);
    expect(response.status).toBe(503);
    expect(response.headers.has("x-opencodex-upstream-request-id")).toBe(false);
    const row = await expectDurableId(response);
    expect(row.status).toBe(503);
    expect(row.errorCode).toBe("server_busy");
  } finally { await held.body!.cancel("fixture released"); }
  const admitted = await withRaisedInboundBodyAdmission(new Request("http://localhost/v1/messages", {
    method: "POST", body: "{}",
  }), "/v1/messages", MAX_CONCURRENT_INBOUND_BODY_BYTES, async () => new Response(null, { status: 204 }));
  expect(admitted.status).toBe(204);
});

const allowedOrigin = "http://fixture.example";
function expectCors(response: Response, hasUpstream: boolean) {
  expect(response.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
  const names = response.headers.get("access-control-expose-headers")!.toLowerCase().split(",").map(value => value.trim());
  for (const name of ["request-id", "x-opencodex-request-id"]) {
    expect(names.filter(value => value === name)).toHaveLength(1);
  }
  expect(names.includes("x-opencodex-upstream-request-id")).toBe(hasUpstream);
}

for (const mode of ["caller-forward", "managed-native", "translated"] as const) {
  for (const stream of [false, true]) {
    test(`${mode} ${stream ? "SSE" : "JSON"} exposes correlation headers on the real listener`, async () => {
      launch(mode, stream ? "sse" : "json", 200, { corsAllowOrigins: [allowedOrigin] });
      const response = await send(mode, stream, { origin: allowedOrigin });
      expect(response.status).toBe(200);
      expectCors(response, mode !== "translated");
      await expectDurableId(response);
    });
  }
}

for (const mode of ["caller-forward", "managed-native"] as const) {
  test(`${mode} upstream refusal exposes correlation headers on the real listener`, async () => {
    launch(mode, "json", 400, { corsAllowOrigins: [allowedOrigin] });
    const response = await send(mode, false, { origin: allowedOrigin });
    expect(response.status).toBe(400);
    expectCors(response, true);
    await expectDurableId(response);
  });
}

test("real-listener workflow CORS retains its existing exposed refusal header", async () => {
  launch("translated", "json", 200, { corsAllowOrigins: [allowedOrigin] });
  const admitted = admitWorkflowTurn("fixture-root", "interactive");
  expect(admitted?.admitted).toBe(true);
  if (admitted?.admitted) admitted.lease.release();
  chargeWorkflowSends("fixture-root", DEFAULT_WORKFLOW_BUDGET_POLICY.maxPhysicalSends);
  const response = await send("translated", false, { origin: allowedOrigin, "x-codex-parent-thread-id": "fixture-root" });
  expect(response.status).toBe(429);
  expectCors(response, false);
  expect(response.headers.get("access-control-expose-headers")).toContain("x-opencodex-local-refusal");
  await expectDurableId(response);
});
