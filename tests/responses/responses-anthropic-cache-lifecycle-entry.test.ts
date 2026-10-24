import { test, expect, mock, afterAll, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import { Clock } from "../helpers/anthropic-renewal-clock";
import { repoRoot } from "../helpers/repo-root";
import { randomUUID } from "node:crypto";

const savedEnv = { ...process.env };
const scratch = join(repoRoot(), ".tmp");
mkdirSync(scratch, { recursive: true });
const root = mkdtempSync(join(scratch, "anthropic-cache-entry-"));
for (const name of ["home", "codex", "temp"]) mkdirSync(join(root, name), { recursive: true });
process.env.OPENCODEX_HOME = join(root, "home"); process.env.CODEX_HOME = join(root, "codex");
process.env.TEMP = process.env.TMP = join(root, "temp");
writeFileSync(join(root, "home/auth.json"), JSON.stringify({ anthropic: { access: "offline-only-not-a-key", refresh: "offline-only-not-a-key", expires: Date.now() + 86400000 } }));
const source = pathToFileURL(repoRoot()).href;
const diagnosticRows: any[] = [];
const originRows: any[] = [];
const originalInfo = console.info;
console.info = (...args: any[]) => {
  if (args[0] === "[opencodex-request-origin]") { originRows.push(JSON.parse(args[1])); return; }
  if (args[0] === "[anthropic-cache-renewal]") { diagnosticRows.push(JSON.parse(args[1])); return; }
  originalInfo(...args);
};
afterAll(() => { console.info = originalInfo; });
beforeEach(() => { diagnosticRows.length = 0; originRows.length = 0; });
const clock = new Clock();
let denied = 0;
function deny(): never { denied++; throw new Error("离线验证禁止真实连接"); }
const savedNetwork = [net.connect, net.createConnection, tls.connect, http.request, http.get, https.request, https.get, http2.connect, Bun.connect, globalThis.WebSocket, globalThis.fetch] as const;
net.connect = net.createConnection = tls.connect = http.request = http.get = https.request = https.get = http2.connect = Bun.connect = deny as any;
globalThis.WebSocket = class { constructor() { deny(); } } as any;
const listeners = new Map<string, (state: any) => void>();
const originalRuntime = { ...await import(`${source}/src/codex/cache-runtime-state.ts`) };
mock.module(`${source}/src/codex/cache-runtime-state.ts`, () => ({ ...originalRuntime, CodexCacheRuntime: class {
  watch(thread: string, update: (state: any) => void, expectedTurn: string) {
    expect(expectedTurn).toBe("22222222-2222-4222-8222-222222222222");
    listeners.set(thread, update); update({ running: true, turn: null }); return () => { listeners.delete(thread); };
  }
  async active(thread: string) { return listeners.has(thread); }
} }));
const original = { ...await import(`${source}/src/anthropic/cache-renewal.ts`) };
mock.module(`${source}/src/anthropic/cache-renewal.ts`, () => ({ ...original,
  AnthropicCacheRenewal: class extends original.AnthropicCacheRenewal {
    constructor(deps: any) { super({ ...deps, now: () => clock.now, later: clock.later, clear: clock.clear }); }
  },
}));
const sent: any[] = [];
const cache = new Map<string, number>();
let hold = false, finishStream: (() => void) | undefined, coldWarm = false;
let hangRenewal = false, deferNatural = false, releaseNatural: (() => void) | undefined;
let emptyNatural = false, terminalNatural = false, refuseContinuation = false;
let refuseImages: "once" | "always" | undefined;
let cancelImageRefusal: AbortController | undefined, invalidImageSummary = false;
const encoder = new TextEncoder();
function frame(event: string, data: any) { return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
globalThis.fetch = (async (url: any, init: any) => {
  if (String(url) !== "https://api.anthropic.com/v1/messages") deny();
  const body = JSON.parse(String(init.body)); const key = JSON.stringify({ ...body, max_tokens: undefined, stream: undefined });
  const hit = (cache.get(key) ?? -1) > clock.now && !(body.max_tokens === 0 && coldWarm);
  const usage = { input_tokens: 4, cache_read_input_tokens: hit ? 5000 : 0, cache_creation_input_tokens: hit ? 0 : 5000, output_tokens: 0 };
  sent.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body, at: clock.now });
  cache.set(key, clock.now + 300000);
  if (body.max_tokens === 0) {
    if (hangRenewal) return new Promise<Response>(() => {});
    expect(body.stream).toBe(false);
    return Response.json({ id: "msg_warm", type: "message", model: body.model, content: [], stop_reason: "max_tokens", usage });
  }
  if (refuseContinuation && !emptyNatural) return new Response("request too large", { status: 413 });
  if (invalidImageSummary && JSON.stringify(body.messages.at(-1)).includes("Return only the handoff summary")) {
    return Response.json({ content: [], stop_reason: "end_turn", usage });
  }
  if (refuseImages && JSON.stringify(body.messages).includes('"type":"image"')
    && !JSON.stringify(body.messages.at(-1)).includes("Return only the handoff summary")) {
    if (refuseImages === "once") refuseImages = undefined;
    cancelImageRefusal?.abort();
    return Response.json({ error: { type: "request_too_large", message: "image fixture exceeds request limit" } }, { status: 413 });
  }
  if (emptyNatural) {
    emptyNatural = false;
    const empty = { id: "msg_empty", type: "message", model: body.model, content: [], stop_reason: "end_turn", usage };
    if (!body.stream) return Response.json(empty);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(frame("message_start", { type: "message_start", message: empty }));
      controller.enqueue(frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage }));
      controller.enqueue(frame("message_stop", { type: "message_stop" })); controller.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  }
  if (deferNatural) await new Promise<void>(resolve => { releaseNatural = resolve; });
  const text = terminalNatural ? "I will inspect the file now." : "Fixture summary."; terminalNatural = false;
  const result = { id: "msg_natural", type: "message", model: body.model, content: [{ type: "text", text }], stop_reason: "end_turn", usage: { ...usage, output_tokens: 3 } };
  if (!body.stream) return Response.json(result);
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(frame("message_start", { type: "message_start", message: { ...result, content: [], usage } }));
    const finish = () => {
      controller.enqueue(frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
      controller.enqueue(frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }));
      controller.enqueue(frame("content_block_stop", { type: "content_block_stop", index: 0 }));
      controller.enqueue(frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: result.usage }));
      controller.enqueue(frame("message_stop", { type: "message_stop" })); controller.close();
    };
    if (hold) finishStream = finish; else finish();
  } }), { headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;

const { handleResponses } = await import(`${source}/src/server/responses/core.ts`);
const { handleResponsesCompact } = await import(`${source}/src/server/responses/compact.ts`);
const { observeCacheDiagnosticInbound, addFinalRequestLog, addRequestLog, getRequestLogEntries } = await import(`${source}/src/server/request-log.ts`);
const { stopAnthropicCacheRenewal, naturalCacheScope } = await import(`${source}/src/anthropic/cache-renewal-runtime.ts`);
const { acquireSpendLedgerServerLifecycle } = await import(`${source}/src/server/index/spend-ledger-lifecycle.ts`);
const ledger = acquireSpendLedgerServerLifecycle(process.env.OPENCODEX_HOME!); ledger.configure(undefined);
afterAll(() => {
  stopAnthropicCacheRenewal(); ledger.release();
  mock.module(`${source}/src/codex/cache-runtime-state.ts`, () => originalRuntime);
  mock.module(`${source}/src/anthropic/cache-renewal.ts`, () => original);
  [net.connect, net.createConnection, tls.connect, http.request, http.get, https.request, https.get, http2.connect, Bun.connect, globalThis.WebSocket, globalThis.fetch] = savedNetwork as any;
  for (const key of ["OPENCODEX_HOME", "CODEX_HOME", "TEMP", "TMP"]) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => { stopAnthropicCacheRenewal(); clock.jobs.clear(); clock.now = 0; sent.length = 0; cache.clear(); hold = false; finishStream = undefined; coldWarm = false;
  hangRenewal = deferNatural = emptyNatural = terminalNatural = refuseContinuation = false; releaseNatural = undefined; });
beforeEach(() => { refuseImages = undefined; cancelImageRefusal = undefined; invalidImageSummary = false; });

function config(retention = "short"): any { return { defaultProvider: "anthropic", cacheRetention: retention,
  anthropicCacheRenewal: true, multiAgentGuidanceEnabled: false,
  webSearchSidecar: { enabled: true, backend: "exa", exaApiKey: "offline-only-not-a-key" },
  providers: { anthropic: { baseUrl: "https://api.anthropic.com", apiKey: "offline-only-not-a-key", adapter: "anthropic", authMode: "oauth", models: ["claude-opus-5-5"] } } }; }

for (const enabled of [undefined, false, true]) for (const retention of [undefined, "short", "long", "none"]) {
  if (enabled === true && retention === "short") continue;
  test(`renewal preserves the opt-in and configured TTL: enabled=${enabled}, retention=${retention}`, async () => {
    const cfg = config(retention); cfg.anthropicCacheRenewal = enabled;
    if (retention === undefined) delete cfg.cacheRetention;
    const { response } = await invoke("main", "http", false, cfg); await response.text();
    await clock.advance(900000);
    expect(sent).toHaveLength(1); expect(listeners.size).toBe(0);
    expect(sent[0].body.cache_control?.ttl).toBe(retention === undefined || retention === "long" ? "1h" : undefined);
  });
}
function request(role = "main", entry = "http", stream = false) {
  const child = role === "child", ws = entry.endsWith("ws"), compact = entry.startsWith("compact");
  const own = child ? "11111111-1111-4111-8111-111111111112" : "11111111-1111-4111-8111-111111111111";
  const metadata = { request_kind: compact ? "compaction" : "turn", thread_source: child ? "subagent" : role === "helper" ? "memory_consolidation" : "user", ...(child ? { subagent_kind: "thread_spawn" } : {}) };
  const headers: any = { "content-type": "application/json", "thread-id": own, "session-id": "parent",
    ...(child ? { "x-codex-parent-thread-id": "parent", "x-openai-subagent": "collab_spawn" } : {}),
    ...(!ws ? { "x-codex-turn-metadata": JSON.stringify(metadata) } : {}) };
  const body: any = { model: "anthropic/claude-opus-5-5", stream, input: [{ role: "user", content: [{ type: "input_text", text: "Fixture request." }] }],
    tools: [{ type: "function", name: "fixture_tool", parameters: { type: "object", properties: {} } }, { type: "web_search" }],
    reasoning: { effort: "max" }, client_metadata: { thread_id: own, turn_id: "22222222-2222-4222-8222-222222222222", ...(ws ? { "x-codex-turn-metadata": JSON.stringify(metadata) } : {}) } };
  if (compact && entry !== "compact-v1") body.input.push({ type: "compaction_trigger" });
  return { req: new Request(`http://localhost/v1/responses${entry === "compact-v1" ? "/compact" : ""}`, { method: "POST", headers, body: JSON.stringify(body) }),
    options: { recordTerminalOutcomes: false, ...(ws ? { inboundTransport: "websocket" } : {}) }, own };
}
async function invoke(role: string, entry: string, stream: boolean, cfg = config()) {
  const r = request(role, entry, stream);
  const logCtx: any = { model: "", provider: "" };
  const response = await (entry === "compact-v1" ? handleResponsesCompact : handleResponses)(r.req, cfg, logCtx, entry === "compact-v1" ? undefined : r.options,
    ...(entry === "compact-v1" ? [undefined, r.options] : []));
  if (!response.ok) throw new Error(await response.text());
  return { ...r, response, logCtx };
}

for (const enabled of [false, true]) for (const trigger of ["empty", "terminal"]) test(`non-stream ${trigger} continuation follows the actual wire: renewal=${enabled}`, async () => {
  emptyNatural = trigger === "empty"; terminalNatural = trigger === "terminal";
  const cfg = config(); cfg.emptyCompletionRetry = true; cfg.webSearchSidecar.enabled = false;
  cfg.anthropicCacheRenewal = enabled;
  const r = request("main", "http", false), raw = await r.req.json() as any;
  raw.input[0].content[0].text = "Inspect the file with fixture_tool and continue.";
  const response = await handleResponses(new Request(r.req.url, { method: "POST", headers: r.req.headers, body: JSON.stringify(raw) }), cfg, { model: "", provider: "" } as any, r.options);
  const result = await response.json();
  expect(result.status).toBe("completed"); expect(JSON.stringify(result.output)).toContain("Fixture summary.");
  expect(sent).toHaveLength(2);
});

test("an Anthropic 413 continuation is not resent with identical historical images", async () => {
  emptyNatural = refuseContinuation = true;
  const r = request("main", "http", false);
  const raw = await r.req.json() as any;
  raw.input[0].content.push({ type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHe8AAAAASUVORK5CYII=" });
  const cfg = config(); cfg.emptyCompletionRetry = true; cfg.webSearchSidecar.enabled = false;
  const response = await handleResponses(new Request(r.req.url, { method: "POST", headers: r.req.headers, body: JSON.stringify(raw) }), cfg, { model: "", provider: "" } as any, r.options);
  const text = await response.text();
  expect(text).toContain("empty_completion_retry_failed");
  expect(sent).toHaveLength(2);
});

for (const scope of ["root", "identity", "pool"]) test(`renewal cannot bypass a configured ${scope} spend ceiling`, async () => {
  const cfg = config(); cfg.spend = { [scope]: { maxTokens: 1000000 } };
  const { response } = await invoke("main", "http", false, cfg); await response.text();
  await clock.advance(270000);
  expect(sent).toHaveLength(1); expect(listeners.size).toBe(0);
});

test("a spend ceiling added after confirmation stops subsequent renewal", async () => {
  const cfg = config();
  const { response } = await invoke("main", "http", false, cfg); await response.text();
  cfg.spend = { root: { maxTokens: 1000000 } };
  await clock.advance(270000);
  expect(sent).toHaveLength(1);
});

for (const enabled of [false, true]) test(`image-count pressure preserves prefixes and latest tool pair independently of renewal: enabled=${enabled}`, async () => {
  const beforeLogs = new Set(getRequestLogEntries().map(row => row.requestId));
  const cfg = config(); cfg.anthropicCacheRenewal = enabled;
  const baseline = await invoke("main", "http", false, cfg); await baseline.response.text();
  const prefix = sent[0].body;
  const r = request("main", "http", false), raw = await r.req.json() as any;
  const own = randomUUID(), headers = new Headers(r.req.headers); headers.set("thread-id", own);
  raw.client_metadata.thread_id = own;
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHe8AAAAASUVORK5CYII=";
  raw.input = [{ role: "user", content: "Inspect the images and continue the task." },
    ...Array.from({ length: 101 }, (_, i) => [
      { type: "function_call", call_id: `image_${i}`, name: "fixture_tool", arguments: "{}" },
      { type: "function_call_output", call_id: `image_${i}`, output: [{ type: "input_image", image_url: image }] },
    ]).flat()];
  const send = async () => {
    const response = await handleResponses(new Request(r.req.url, { method: "POST", headers, body: JSON.stringify(raw) }),
      cfg, { model: "", provider: "" } as any, r.options);
    const text = await response.text(); expect(response.ok).toBe(true); expect(text).toContain("response.completed");
  };
  const summaries = () => sent.filter(item => JSON.stringify(item.body.messages.at(-1)).includes("CONTEXT CHECKPOINT COMPACTION"));
  await send();
  expect(summaries().length).toBeGreaterThan(0);
  for (const item of summaries()) {
    expect(item.body.tool_choice).toEqual(prefix.tool_choice);
    expect(item.body.tools).toEqual(prefix.tools);
    expect(item.body.system).toEqual(prefix.system);
  }
  const final = sent.at(-1).body;
  const { collectImageRefs } = await import(`${source}/src/adapters/anthropic-image-guard.ts`);
  expect(collectImageRefs(final.messages).length).toBeLessThanOrEqual(100);
  expect(JSON.stringify(final.messages)).toContain("image_100");
  const count = summaries().length;
  await send(); expect(summaries()).toHaveLength(count); expect(denied).toBe(0);
  const summaryLogs = getRequestLogEntries().filter(row => !beforeLogs.has(row.requestId));
  expect(summaryLogs.length).toBeGreaterThan(0);
  expect(summaryLogs.every(row => row.status === 200 && !row.errorCode)).toBe(true);
  if (!enabled) {
    await clock.advance(270000);
    expect(sent.some(item => item.body.max_tokens === 0)).toBe(false);
    expect(listeners.size).toBe(0);
  }
});

for (const role of ["main", "child"]) for (const entry of ["http", "ws"]) {
  test(`续期超时后在途自然请求仍能接替 ${role} ${entry}`, async () => {
    const first = await invoke(role, entry, false); await first.response.text();
    await clock.advance(249000); hangRenewal = deferNatural = true;
    const pending = invoke(role, entry, false);
    for (let n = 0; n < 200 && !releaseNatural; n++) await Bun.sleep(5);
    expect(releaseNatural).toBeDefined();
    await clock.advance(300000); expect(diagnosticRows[0].outcome).toBe("timeout");
    await clock.advance(313000); deferNatural = false; releaseNatural!();
    const second = await pending; await second.response.text();
    expect(listeners.has(second.own)).toBe(true);
    hangRenewal = false;
    await clock.advance(518999); expect(sent.filter(x => x.body.max_tokens === 0)).toHaveLength(1);
    await clock.advance(519000); expect(sent.filter(x => x.body.max_tokens === 0)).toHaveLength(2);
    expect(diagnosticRows[1].outcome).toBe("hit");
    expect(denied).toBe(0);
  });
}

for (const role of ["main", "child"]) for (const entry of ["http", "ws", "compact-v1", "compact-v2-http", "compact-v2-ws"]) {
  test(`${entry} ${role} 经实际入口续同一前缀`, async () => {
    const { response, own } = await invoke(role, entry, false);
    const text = await response.text(); expect(response.ok).toBe(true); expect(text.length).toBeGreaterThan(0);
    expect(response.headers.get("content-type")).toContain(entry.startsWith("compact") ? "application/json" : "text/event-stream");
    if (entry.startsWith("compact")) expect(() => JSON.parse(text)).not.toThrow();
    expect(sent[0].body.tools.some((tool: any) => tool.name === "web_search")).toBe(true);
    expect(sent).toHaveLength(1); expect(sent[0].body.stream).toBe(true); expect(listeners.has(own)).toBe(true);
    await clock.advance(270000);
    expect(sent).toHaveLength(2); expect(sent[1].body).toEqual({ ...sent[0].body, max_tokens: 0, stream: false });
    expect(sent[1].headers["x-api-key"]).toBe(sent[0].headers["x-api-key"]);
    expect(sent[1].body.cache_control.ttl ?? "5m").toBe("5m");
    expect(diagnosticRows).toHaveLength(1);
    expect(diagnosticRows[0]).toMatchObject({ threadId: own, turnId: "22222222-2222-4222-8222-222222222222",
      role: role === "child" ? "subagent" : "main", sent: true, outcome: "hit", attempt: 1, cacheAgeMs: 270000 });
    const persisted = readFileSync(join(root, "home", "usage.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(persisted.some(row => row.requestId === diagnosticRows[0].requestId && row.errorCode === "cache_renewal_hit")).toBe(true);
    expect(JSON.stringify(diagnosticRows[0])).not.toContain("offline-only-not-a-key");
  });
}

for (const role of ["main", "child"]) for (const entry of ["http", "ws"]) {
  test(`实际发送保留已确认断点，续期接替修改后的完整请求 ${role} ${entry}`, async () => {
    const r = request(role, entry, false), body = await r.req.json() as any;
    body.input = [{ role: "user", content: "old user" }, { role: "assistant", content: "old assistant" },
      { role: "user", content: "confirmed tail" }];
    const send = async () => {
      const response = await handleResponses(new Request(r.req.url, { method: "POST", headers: r.req.headers, body: JSON.stringify(body) }),
        config(), { model: "", provider: "" } as any, r.options);
      expect(response.ok).toBe(true); await response.text();
    };
    await send();
    const oldCount = sent[0].body.messages.length;
    for (let i = 0; i < 22; i++) body.input.push({ role: "user", content: `notification ${i}` });
    await send();
    expect(sent).toHaveLength(2);
    expect(sent[1].body.messages[oldCount - 1].content.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(sent[1].body.messages.length - oldCount).toBe(22);
    await clock.advance(270000);
    expect(sent).toHaveLength(3);
    expect(sent[2].body).toEqual({ ...sent[1].body, max_tokens: 0, stream: false });
    expect(diagnosticRows.at(-1).outcome).toBe("hit");
    expect(denied).toBe(0);
  });
}

for (const clientStream of [true, false]) test(`长生成未结束时真实流解析已触发续期，客户端 stream=${clientStream}`, async () => {
  hold = true;
  let response: Response | undefined;
  const pending = invoke("main", "http", clientStream).then(value => { response = value.response; return value.response.text(); });
  for (let n = 0; n < 100 && !finishStream; n++) await Bun.sleep(10);
  expect(finishStream).toBeDefined(); await Bun.sleep(20);
  await clock.advance(540000); expect(sent.filter(x => x.body.max_tokens === 0)).toHaveLength(2);
  finishStream!(); expect(await pending).toContain(clientStream ? "response.completed" : "Fixture summary.");
  expect(response!.ok).toBe(true);
});

test("真正发生冷写后不再循环，续期费用独立记入用量", async () => {
  const { response } = await invoke("main", "http", false); await response.text(); coldWarm = true;
  await clock.advance(900000); expect(sent).toHaveLength(2);
  const logs = readFileSync(join(root, "home/usage.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const warm = logs.filter(row => row.errorCode?.startsWith("cache_renewal_"));
  expect(warm.some(row => row.errorCode === "cache_renewal_unexpected-write" && row.usage.cacheCreationInputTokens === 5000)).toBe(true);
});

test("助手与全局关闭缓存不会发送后台请求", async () => {
  for (const [role, retention] of [["helper", "short"], ["main", "none"]]) {
    const { response } = await invoke(role, "http", false, config(retention)); await response.text();
  }
  await clock.advance(900000); expect(sent).toHaveLength(2); expect(listeners.size).toBe(0);
});

test("运行状态结束时停止，恢复网络或读取状态不自动重建缓存", async () => {
  const { response, own } = await invoke("child", "http", false); await response.text();
  listeners.get(own)!({ running: false, turn: `turn-${own}` });
  await clock.advance(900000); expect(sent).toHaveLength(1);
});

test("缓存策略仅统一明确主子代理，其他适配器没有续期上下文", () => {
  const r = request();
  expect(naturalCacheScope({ parsed: { _codexOwnThreadId: r.own } as any, req: r.req, config: config(), options: {}, adapterName: "openai-responses", providerName: "openai", oauth: false })).toBeUndefined();
  expect(denied).toBe(0);
});

test("自身轮次只读当前正文，拒绝错配对话和预热，WS忽略旧握手元数据", async () => {
  const { codexRequestTurn } = await import(`${source}/src/codex/request-provenance.ts`);
  const r = request("child", "ws");
  const body = await r.req.json();
  expect(codexRequestTurn(body, r.req.headers)).toEqual({ threadId: r.own, turnId: "22222222-2222-4222-8222-222222222222" });
  expect(codexRequestTurn({ ...body, generate: false }, r.req.headers)).toBeUndefined();
  expect(codexRequestTurn({ ...body, client_metadata: { ...body.client_metadata, turn_id: "" } }, r.req.headers)).toBeUndefined();
  expect(codexRequestTurn({ ...body, client_metadata: { ...body.client_metadata, thread_id: "parent" } }, r.req.headers)).toBeUndefined();
  const headers = new Headers(r.req.headers); headers.set("x-codex-turn-metadata", JSON.stringify({ request_kind: "helper" }));
  const scope = naturalCacheScope({ parsed: { _rawBody: body, _codexOwnThreadId: r.own } as any, req: new Request(r.req.url, { headers }),
    options: { inboundTransport: "websocket" }, config: config(), adapterName: "anthropic", providerName: "anthropic", oauth: true });
  expect(scope?.turnId).toBe("22222222-2222-4222-8222-222222222222");
});

for (const cap of [1, 2]) test(`长生成遵守账号并发限制 maxConcurrentRequests=${cap}`, async () => {
  hold = true;
  const cfg = config(); cfg.providers.anthropic.requestPacing = { enabled: true, maxConcurrentRequests: cap };
  const pending = invoke("main", "http", false, cfg).then(value => value.response.text());
  for (let n = 0; n < 100 && !finishStream; n++) await Bun.sleep(10);
  expect(finishStream).toBeDefined(); await Bun.sleep(20);
  await clock.advance(285000);
  expect(sent.filter(x => x.body.max_tokens === 0)).toHaveLength(cap === 2 ? 1 : 0);
  finishStream!(); expect(await pending).toContain("Fixture summary.");
});


test("联网路径自然请求接替旧前缀和计时，不再续第一笔请求", async () => {
  const initial = request("main", "http", true); const initialBody = await initial.req.json();
  initialBody.tools = initialBody.tools.filter((tool: any) => tool.type !== "web_search");
  const initialReq = new Request(initial.req.url, { method: "POST", headers: initial.req.headers, body: JSON.stringify(initialBody) });
  const first = await handleResponses(initialReq, config(), { model: "", provider: "" } as any, initial.options);
  await first.text();
  expect(sent).toHaveLength(1);
  await clock.advance(200000);
  const next = request("main", "ws"); const raw = await next.req.json();
  raw.input.push({ role: "user", content: [{ type: "input_text", text: "Latest natural prefix." }] });
  const req = new Request(next.req.url, { method: "POST", headers: next.req.headers, body: JSON.stringify(raw) });
  const response = await handleResponses(req, config(), { model: "", provider: "" } as any, next.options);
  expect(response.ok).toBe(true); await response.text();
  expect(sent).toHaveLength(2);
  await clock.advance(270000); expect(sent).toHaveLength(2);
  await clock.advance(470000); expect(sent).toHaveLength(3);
  expect(sent[2].body).toEqual({ ...sent[1].body, max_tokens: 0, stream: false });
  expect(JSON.stringify(sent[2].body)).toContain("Latest natural prefix.");
  expect(denied).toBe(0);
});

const ownA = "11111111-1111-4111-8111-111111111111";
const ownB = "11111111-1111-4111-8111-111111111112";
const turnA = "22222222-2222-4222-8222-222222222222";
const logId = "ocx-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
function finish(logCtx: any, id = logId) {
  const emitted: any[] = [];
  addFinalRequestLog(id, 1792304678673, logCtx, 200, undefined, (row: any) => { emitted.push(row); addRequestLog(row); });
  expect(emitted).toHaveLength(1);
  return originRows.at(-1);
}

for (const role of ["main", "child"]) for (const entry of ["http", "ws", "compact-v1"]) {
  test(`来源关联经实际入口到最终原请求编号 ${role} ${entry}`, async () => {
    const r = await invoke(role, entry, false); await r.response.text();
    const result = finish(r.logCtx);
    expect(result).toMatchObject({ requestId: logId, captured: true, identity: "matched", threadId: r.own, turnId: turnA,
      role: role === "child" ? "subagent" : "main", purpose: entry === "compact-v1" ? "compaction" : "turn",
      endpoint: entry === "compact-v1" ? "responses-compact" : "responses", transport: entry === "ws" ? "websocket" : "http" });
    expect(result.pid).toBe(process.pid);
    expect(result.tools).toBe(2);
    expect(denied).toBe(0);
  });
}

test("两笔同父子任务与不同轮次的日志不串绑", async () => {
  const ctxA: any = { model: "claude-opus-5-5", provider: "anthropic" }, ctxB: any = { ...ctxA };
  const parent = "33333333-3333-4333-8333-333333333333";
  for (const [ctx, own, turn] of [[ctxA, ownA, turnA], [ctxB, ownB, parent]]) {
    observeCacheDiagnosticInbound(ctx, { client_metadata: { thread_id: own, turn_id: turn }, input: [] },
      new Headers({ "thread-id": own, "x-codex-parent-thread-id": parent, "x-openai-subagent": "collab_spawn" }), "caller");
    finish(ctx);
  }
  expect(originRows.map(x => x.threadId)).toEqual([ownA, ownB]);
  expect(originRows.map(x => x.turnId)).toEqual([turnA, parent]);
  expect(originRows.every(x => x.parentThreadId === parent && x.role === "subagent")).toBe(true);
});

test("WS切换只读取本帧用途，不借握手中的旧主代理元数据", async () => {
  const r = request("child", "ws"), raw = await r.req.json();
  r.req.headers.set("x-codex-turn-metadata", JSON.stringify({ request_kind: "turn", thread_source: "user" }));
  const logCtx: any = { model: "", provider: "" };
  const response = await handleResponses(new Request(r.req.url, { method: "POST", headers: r.req.headers, body: JSON.stringify(raw) }), config(), logCtx, r.options);
  await response.text(); expect(finish(logCtx)).toMatchObject({ role: "subagent", transport: "websocket", threadId: ownB });
});

test("缺少本帧元数据时，WS握手不能提供用途", () => {
  const ctx: any = { model: "claude-opus-5-5", provider: "anthropic" };
  observeCacheDiagnosticInbound(ctx, { client_metadata: { thread_id: ownA, turn_id: turnA } },
    new Headers({ "thread-id": ownA, "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_source: "user" }) }), "caller", { transport: "websocket" });
  expect(finish(ctx)).toMatchObject({ purpose: "unknown", role: "unknown", identity: "matched" });
});

test("自身身份冲突明确标记，不能绑定到任意一方", () => {
  const ctx: any = { model: "claude-opus-5-5", provider: "anthropic" };
  observeCacheDiagnosticInbound(ctx, { client_metadata: { thread_id: ownB, turn_id: turnA } }, new Headers({ "thread-id": ownA }), "caller");
  const result = finish(ctx); expect(result).toMatchObject({ identity: "conflict", headerThreadId: ownA, metadataThreadId: ownB, role: "unknown" });
  expect(result.threadId).toBeUndefined(); expect(result.turnId).toBeUndefined();
});

test("缺少自身身份不能使用父ID或session ID冒充", () => {
  const ctx: any = { model: "claude-opus-5-5", provider: "anthropic" };
  observeCacheDiagnosticInbound(ctx, { input: [] }, new Headers({ "x-codex-parent-thread-id": ownA, "session-id": ownA }), "caller");
  const result = finish(ctx); expect(result).toMatchObject({ identity: "missing", parentThreadId: ownA, captured: true });
  expect(result.threadId).toBeUndefined(); expect(result.turnId).toBeUndefined();
});

test("只提供自身header时保留对话线索，明确轮次未确认", () => {
  const ctx: any = { model: "claude-opus-5-5", provider: "anthropic" };
  observeCacheDiagnosticInbound(ctx, {}, new Headers({ "thread-id": ownA }), "caller");
  expect(finish(ctx)).toMatchObject({ identity: "header-only", threadId: ownA }); expect(originRows.at(-1).turnId).toBeUndefined();
});

test("内部辅助请求带用途及store/generate形状，不继承主代理角色", () => {
  const ctx: any = { model: "claude-opus-5-5", provider: "anthropic" };
  observeCacheDiagnosticInbound(ctx, { store: false, generate: false, stream: false, client_metadata: { thread_id: ownA, turn_id: turnA } },
    new Headers({ "thread-id": ownA }), "caller", { internalHelper: true });
  expect(finish(ctx)).toMatchObject({ purpose: "helper", role: "unknown", store: false, generate: false, stream: false });
});

test("缺少调用用途时不根据提示词猜后台类型", () => {
  const ctx: any = { model: "claude-opus-5-5", provider: "anthropic" };
  observeCacheDiagnosticInbound(ctx, { input: "Generate a title or extract memories", client_metadata: { thread_id: ownA, turn_id: turnA } }, new Headers({ "thread-id": ownA }), "caller");
  expect(finish(ctx)).toMatchObject({ role: "unknown", purpose: "unknown", inputItems: 1 });
});

test("重试及压缩重放保留原入口快照，正文对象后改不改变日志", () => {
  const ctx: any = { model: "claude-opus-5-5", provider: "anthropic" };
  const body: any = { input: [{ role: "user", content: "private" }], tools: [{}], stream: true, client_metadata: { thread_id: ownA, turn_id: turnA } };
  observeCacheDiagnosticInbound(ctx, body, new Headers({ "thread-id": ownA }), "caller"); body.input.push({}); body.tools.push({}); body.client_metadata.thread_id = ownB;
  observeCacheDiagnosticInbound(ctx, body, new Headers({ "thread-id": ownB }), "caller", { internalHelper: true });
  expect(finish(ctx)).toMatchObject({ threadId: ownA, inputItems: 1, tools: 1, stream: true, identity: "matched" });
});

test("正文、图片、工具参数、凭据和非法身份都不进入关联日志", () => {
  const secret = "PRIVATE_CANARY_DO_NOT_LOG", ctx: any = { model: "claude-opus-5-5", provider: "anthropic" };
  observeCacheDiagnosticInbound(ctx, { input: [{ content: [{ type: "input_text", text: secret }, { type: "input_image", image_url: secret }] }], tools: [{ parameters: { secret } }], client_metadata: { thread_id: secret, turn_id: secret } },
    new Headers({ authorization: secret, "thread-id": secret, "x-codex-parent-thread-id": secret, "session-id": secret }), "caller");
  const result = finish(ctx); expect(result.identity).toBe("invalid"); expect(JSON.stringify(result)).not.toContain(secret);
  expect(Object.keys(result).sort()).toEqual(["version", "pid", "requestId", "startedAt", "status", "captured", "endpoint", "transport", "identity", "role", "purpose", "inputItems", "tools"].sort());
});

test("最终边界再次白名单过滤被污染的上下文", () => {
  const secret = "PRIVATE_CANARY_DO_NOT_LOG", ctx: any = { model: "claude-opus-5-5", provider: "anthropic", requestOrigin: {
    threadId: secret, turnId: secret, endpoint: secret, role: secret, purpose: secret, transport: secret, identity: secret, extra: secret, stream: secret, inputItems: secret,
  } };
  const result = finish(ctx); expect(JSON.stringify(result)).not.toContain(secret); expect(result.role).toBe("unknown"); expect(result.endpoint).toBe("unknown");
});

test("旧零命中缺入口记录时保留原requestId并明确未知，不补造历史身份", () => {
  const ctx: any = { model: "claude-opus-5-5", provider: "anthropic", usage: { inputTokens: 164333, cacheReadInputTokens: 0, cacheCreationInputTokens: 164329, outputTokens: 62 } };
  expect(finish(ctx)).toMatchObject({ requestId: logId, captured: false, identity: "missing", role: "unknown", purpose: "unknown" });
});

test("自定义Anthropic provider按适配器识别；其他provider不新增日志", () => {
  const ctx: any = { model: "model", provider: "custom", providerAdapter: "anthropic" };
  finish(ctx); expect(originRows).toHaveLength(1); finish({ model: "gpt", provider: "other" }); expect(originRows).toHaveLength(1);
});

test("关联日志写入失败不改变正常请求完成", () => {
  const saved = console.info; console.info = () => { throw new Error("offline-log-failure"); };
  try { expect(() => finish({ model: "model", provider: "anthropic" })).not.toThrow(); } finally { console.info = saved; }
});

test("直接用量写入路径同样输出原编号且不伪造身份", () => {
  addRequestLog({ requestId: logId, timestamp: 1792304678673, model: "claude-opus-5-5", provider: "anthropic", status: 200, durationMs: 10013,
    usage: { inputTokens: 164333, cacheReadInputTokens: 0, cacheCreationInputTokens: 164329, outputTokens: 62 }, totalTokens: 164395 });
  expect(originRows).toHaveLength(1);
  expect(originRows[0]).toMatchObject({ requestId: logId, captured: false, role: "unknown", purpose: "unknown" });
});

test("来源对象不写入用量JSONL，单个请求只有一条关联记录", () => {
  const ctx: any = { provider: "anthropic", model: "claude-opus-5-5" };
  observeCacheDiagnosticInbound(ctx, { input: [] }, new Headers({ "thread-id": ownA }), "caller"); finish(ctx);
  expect(originRows).toHaveLength(1);
  const disk = readFileSync(join(root, "home/usage.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(disk.at(-1).requestOriginDiagnostic).toBeUndefined();
  expect(getRequestLogEntries().at(-1).requestOriginDiagnostic).toBeUndefined();
  expect(disk.at(-1).requestId).toBe(logId);
});

async function imageRecoveryRequest(stream = false) {
  const r = request("main", "http", stream), raw = await r.req.json();
  const own = randomUUID(); r.req.headers.set("thread-id", own); raw.client_metadata.thread_id = own;
  const image = { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2G0AAAAAASUVORK5CYII=" };
  raw.input = [{ role: "user", content: [{ type: "input_text", text: "Old image." }, image] },
    { role: "assistant", content: "Old image inspected." }, { role: "user", content: [{ type: "input_text", text: "Inspect newest image." }, image] }];
  return { r, raw };
}

for (const enabled of [false, true]) for (const stream of [false, true]) for (const search of [false, true, "media"] as const) {
  if (search === "media" && !stream) continue;
  test(`上游图片413在同轮压缩后继续，renewal=${enabled}, stream=${stream}, search=${search}`, async () => {
    refuseImages = "once";
    const cfg = config(); cfg.anthropicCacheRenewal = enabled; cfg.webSearchSidecar.enabled = search === true;
    cfg.providers.anthropic.requestPacing = { enabled: true, maxConcurrentRequests: 1 };
    const { r, raw } = await imageRecoveryRequest(stream);
    if (search !== true) raw.tools = raw.tools.filter((tool: any) => tool.type !== "web_search");
    if (search === "media") {
      raw.tools.push({ type: "image_generation" }); cfg.images = { bridgeEnabled: true };
      cfg.providers.xai = { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "key", apiKey: "offline-only-not-a-key", proxy: "direct" };
    }
    const response = await handleResponses(new Request(r.req.url, { method: "POST", headers: r.req.headers, body: JSON.stringify(raw) }), cfg,
      { model: "", provider: "" } as any, { ...r.options, abortSignal: AbortSignal.timeout(5000) });
    const text = await response.text();
    expect(response.ok).toBe(true); expect(text).toContain("Fixture summary."); expect(text).not.toContain("response.failed");
    expect(sent).toHaveLength(3);
    expect(sent[2].body.tools).toEqual(sent[0].body.tools); expect(sent[2].body.system).toEqual(sent[0].body.system);
    expect(JSON.stringify(sent[2].body.messages)).toContain("Inspect newest image.");
    expect(sent[2].body.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).filter((p: any) => p.type === "image")).toHaveLength(1);
    expect(denied).toBe(0);
  });
}

for (const scenario of ["second-413", "text-only", "budget", "cancelled", "invalid-summary", "checkpoint-replay"] as const) {
  test(`上游图片413恢复边界 ${scenario}`, async () => {
    refuseImages = scenario === "second-413" ? "always" : "once";
    const cfg = config(); cfg.anthropicCacheRenewal = false; cfg.webSearchSidecar.enabled = false; cfg.emptyCompletionRetry = false;
    const { r, raw } = await imageRecoveryRequest(); raw.tools = raw.tools.filter((tool: any) => tool.type !== "web_search");
    const options: any = { ...r.options, abortSignal: AbortSignal.timeout(5000) };
    if (scenario === "text-only") { refuseContinuation = true; raw.input = [{ role: "user", content: "Only text." }]; }
    if (scenario === "budget") {
      const { createRequestExecutionBudget, CODEX_TEXT_GUARDED_BUDGET_POLICY } = await import(`${source}/src/lib/request-execution-budget.ts`);
      options.sendBudget = createRequestExecutionBudget({ ...CODEX_TEXT_GUARDED_BUDGET_POLICY, maxTotalModelSends: 1, baseSendAllowance: 1, finalRecoveryAllowance: 0 });
    }
    if (scenario === "cancelled") { cancelImageRefusal = new AbortController(); options.abortSignal = cancelImageRefusal.signal; }
    if (scenario === "invalid-summary") invalidImageSummary = true;
    const send = () => handleResponses(new Request(r.req.url, { method: "POST", headers: r.req.headers, body: JSON.stringify(raw) }), cfg,
      { model: "", provider: "" } as any, options);
    const response = await send(); await response.text();
    expect(response.status).toBe(scenario === "cancelled" ? 499 : scenario === "invalid-summary" ? 502 : scenario === "checkpoint-replay" ? 200 : 413);
    expect(sent).toHaveLength(scenario === "second-413" || scenario === "checkpoint-replay" ? 3 : scenario === "invalid-summary" ? 2 : 1);
    if (scenario === "checkpoint-replay") {
      const previous = sent.at(-1).body; const next = await send(); await next.text();
      expect(next.status).toBe(200); expect(sent).toHaveLength(4); expect(sent.at(-1).body).toEqual(previous);
    }
    expect(denied).toBe(0);
  });
}
