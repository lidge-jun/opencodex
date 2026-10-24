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

let fixtureHome = "";
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome | undefined;
let proxy: ReturnType<typeof startServer> | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;
const origin = "http://fixture.example";

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  fixtureHome = mkdtempSync(join(tmpdir(), "ocx-chat-request-id-"));
  process.env.OPENCODEX_HOME = fixtureHome;
  codexHome = installIsolatedCodexHome("ocx-chat-id-codex-");
  resetWorkflowBudgetsForTest();
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

function launch(authenticated = false, status = 200, override: Partial<OcxConfig> = {}, hang = false) {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    if (status !== 200) return Response.json({ error: { message: "fixture refusal" } }, { status });
    const frame = { id: "shared-provider-id", choices: [{ index: 0, delta: { content: "fixture answer" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } } };
    const body = hang ? new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...frame, choices: [{ index: 0, delta: { content: "OPEN" }, finish_reason: null }], usage: undefined })}\n\n`));
    } }, { highWaterMark: 0 }) : `data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`;
    return new Response(body, { headers: {
      "content-type": "text/event-stream", "x-opencodex-request-id": "upstream-controlled",
    } });
  } });
  saveConfig({ port: 0, hostname: authenticated ? "0.0.0.0" : "127.0.0.1", defaultProvider: "mock",
    codexAutoStart: false, codexShimAutoRestore: false, connectTimeoutMs: 1000,
    apiKeys: [{ id: "fixture-key-id", name: "fixture", key: "fixture-data-key", createdAt: "2026-01-01T00:00:00Z" }],
    providers: { mock: { adapter: "openai-chat", baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
      apiKey: "fixture-provider-key", allowPrivateNetwork: true, liveModels: false, models: ["echo"] } },
    corsAllowOrigins: [origin], ...override,
  } as OcxConfig);
  proxy = startServer(0);
}

function send(stream = false, headers: Record<string, string> = {}, invalid = false, signal?: AbortSignal,
  model = "mock/echo", authenticated = true) {
  return fetch(`http://127.0.0.1:${proxy!.port}/v1/chat/completions`, { method: "POST", signal, headers: {
    "content-type": "application/json", ...(authenticated ? { authorization: "Bearer fixture-data-key" } : {}), origin,
    "x-opencodex-request-id": "caller-controlled", ...headers,
  }, body: JSON.stringify({ model, stream, messages: invalid ? null : [{ role: "user", content: "fixture question" }] }) });
}

async function durableRow(response: Response, expectedStatus: number) {
  expect(response.status).toBe(expectedStatus);
  const id = response.headers.get("x-opencodex-request-id");
  expect(id).toMatch(/^ocx-[a-f0-9]{32}$/);
  expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  const exposed = response.headers.get("access-control-expose-headers")!.toLowerCase().split(",").map(name => name.trim());
  expect(exposed.filter(name => name === "x-opencodex-request-id")).toHaveLength(1);
  const text = await response.text();
  let rows = readRecentUsageEntries(100, fixtureHome).filter(row => row.requestId === id);
  for (let i = 0; i < 100 && rows.length === 0; i++) {
    await Bun.sleep(10);
    rows = readRecentUsageEntries(100, fixtureHome).filter(row => row.requestId === id);
  }
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe(expectedStatus);
  expect(rows[0]!.inboundProtocol).toBe("chat");
  return { row: rows[0]!, text, id };
}

for (const authenticated of [false, true]) {
  for (const stream of [false, true]) test(`${authenticated ? "authenticated" : "loopback"} Chat ${stream ? "SSE" : "JSON"} correlates to its history row`, async () => {
    launch(authenticated);
    const { row, text } = await durableRow(await send(stream), 200);
    expect(text).toContain("fixture answer");
    if (stream) expect(text).toContain("[DONE]");
    else expect(JSON.parse(text).choices[0].message.content).toBe("fixture answer");
    expect(row.usage).toEqual({ inputTokens: 11, outputTokens: 5, cachedInputTokens: 3 });
  });
}

test("concurrent replies with identical upstream completion IDs have distinct history IDs", async () => {
  launch();
  const replies = await Promise.all(Array.from({ length: 3 }, () => send()));
  const records = await Promise.all(replies.map(reply => durableRow(reply, 200)));
  expect(new Set(records.map(record => record.id)).size).toBe(3);
});

test("handler-recorded invalid request has a history ID", async () => {
  launch();
  await durableRow(await send(false, {}, true), 400);
});

test("Reserve vision-helper refusal has its history ID", async () => {
  launch(false, 200, { codexDesktopAuthless: true, defaultProvider: "openai", providers: {
    openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward", codexAccountMode: "direct" },
  } });
  await durableRow(await send(false, { "x-opencodex-vision-describe": "1" }, false, undefined, "openai/gpt-reserve", false), 400);
});

test("upstream HTTP error has a history ID", async () => {
  launch(false, 503);
  await durableRow(await send(), 503);
});

test("pre-handler workflow refusal has the logged history ID", async () => {
  launch();
  const admitted = admitWorkflowTurn("fixture-root", "interactive");
  expect(admitted?.admitted).toBe(true);
  if (admitted?.admitted) admitted.lease.release();
  chargeWorkflowSends("fixture-root", DEFAULT_WORKFLOW_BUDGET_POLICY.maxPhysicalSends);
  const response = await send(false, { "x-codex-parent-thread-id": "fixture-root" });
  const { row } = await durableRow(response, 429);
  expect(response.headers.get("access-control-expose-headers")).toContain("x-opencodex-local-refusal");
  expect(row.errorCode).toBe(response.headers.get("x-opencodex-local-refusal"));
});

test("pre-handler body-capacity refusal has a history ID", async () => {
  launch(false, 200, { maxInboundBodyBytes: MAX_CONCURRENT_INBOUND_BODY_BYTES });
  const held = await withRaisedInboundBodyAdmission(new Request("http://localhost/v1/chat/completions", {
    method: "POST", body: "{}",
  }), "/v1/chat/completions", MAX_CONCURRENT_INBOUND_BODY_BYTES,
  async () => new Response(new ReadableStream<Uint8Array>({}, { highWaterMark: 0 })));
  try { await durableRow(await send(), 503); }
  finally { await held.body!.cancel("fixture released"); }
});

test("stream cancellation keeps its eventual history ID", async () => {
  launch(false, 200, {}, true);
  const client = new AbortController();
  try {
    const response = await send(true, {}, false, client.signal);
    const id = response.headers.get("x-opencodex-request-id");
    expect(id).toMatch(/^ocx-[a-f0-9]{32}$/);
    client.abort();
    await response.body!.cancel().catch(() => {});
    let row = readRecentUsageEntries(100, fixtureHome).find(entry => entry.requestId === id);
    for (let i = 0; i < 100 && !row; i++) {
      await Bun.sleep(10);
      row = readRecentUsageEntries(100, fixtureHome).find(entry => entry.requestId === id);
    }
    expect(row?.status).toBe(499);
    expect(row?.inboundProtocol).toBe("chat");
  } finally { client.abort(); }
});

for (const rejection of ["auth", "origin", "active-turn"] as const) test(`${rejection} refusal has no fabricated history ID`, async () => {
  launch(true);
  const leases = rejection === "active-turn" ? Array.from({ length: MAX_ACTIVE_TURNS }, () => tryAdmitTurn()) : [];
  try {
    if (leases.length) expect(leases.every(Boolean)).toBe(true);
    const before = readRecentUsageEntries(100, fixtureHome).length;
    const response = await send(false, rejection === "auth" ? { authorization: "Bearer invalid-fixture-key" }
      : rejection === "origin" ? { origin: "https://untrusted.invalid" } : {});
    expect(response.status).toBe(rejection === "auth" ? 401 : rejection === "origin" ? 403 : 503);
    expect(response.headers.has("x-opencodex-request-id")).toBe(false);
    await response.text();
    expect(readRecentUsageEntries(100, fixtureHome)).toHaveLength(before);
  } finally { for (const lease of leases) lease?.release(); }
});
