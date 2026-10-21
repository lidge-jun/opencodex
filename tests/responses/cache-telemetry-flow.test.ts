import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import type { OcxConfig } from "../../src/types";
import { createServeOptions, type ServeOptionsContext } from "../../src/server/index/serve-options";
import { createWebsocketHandler } from "../../src/server/index/websocket-handler";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import type { WsData } from "../../src/server/ws-bridge";
import { addFinalRequestLog, applyResponseLogMetadata, beginRequestAttempt, finishRequestAttempt,
  getRequestLogEntries, clearRequestLogsForTests, noteAttemptSend, type RequestLogContext } from "../../src/server/request-log";
import { cacheDiagnosticPath } from "../../src/usage/cache-diagnostic";
import { readUsageEntries } from "../../src/usage/log";
import { summarizeUsage } from "../../src/usage/summary";
import { responsesUsage } from "../../src/bridge/internal";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
const ENV = [...PROXY_ENV, "OPENCODEX_HOME", "OPENCODEX_CACHE_DEBUG"];
let saved: Record<string, string | undefined>;
let home: string;
let release: () => void;
const realWs = globalThis.WebSocket;
const realFetch = globalThis.fetch;
let rawUsage: unknown;
let terminal = "completed";
let upstreamSends = 0;
let interimUsage: unknown;
const settings = (): OcxConfig => ({ port: 0, bind: "127.0.0.1", defaultProvider: "openai", websockets: true,
  providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
    authMode: "forward", codexAccountMode: "direct" } } } as OcxConfig);

/** The real WS transport and parsers run; only the external socket is replaced. */
class UpstreamSocket extends EventTarget {
  readyState = 0;
  constructor(..._args: unknown[]) { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }); }
  send(text: string) {
    const frame = JSON.parse(text);
    if (frame.type !== "response.create") return;
    upstreamSends++;
    const usage = rawUsage;
    queueMicrotask(() => {
      this.emit({ type: "response.created", response: { id: "fixture-response", status: "in_progress", output: [],
        ...(interimUsage === undefined ? {} : { usage: interimUsage }) } });
      this.emit({ type: "response.done", response: { id: "fixture-response", status: terminal, output: [],
        ...(usage === undefined ? {} : { usage }) } });
    });
  }
  emit(value: object) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
  ping() { this.dispatchEvent(new Event("pong")); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
}

beforeEach(() => {
  saved = Object.fromEntries(ENV.map(name => [name, process.env[name]]));
  for (const name of PROXY_ENV) delete process.env[name];
  home = mkdtempSync(join(tmpdir(), "cache-origin-flow-"));
  process.env.OPENCODEX_HOME = home;
  process.env.OPENCODEX_CACHE_DEBUG = "1";
  globalThis.WebSocket = UpstreamSocket as unknown as typeof WebSocket;
  globalThis.fetch = (async () => { throw new Error("unexpected HTTP fallback: no real network allowed"); }) as typeof fetch;
  rawUsage = undefined; interimUsage = undefined; terminal = "completed"; upstreamSends = 0;
  clearRequestLogsForTests();
  release = acquireOwnedSpendHome();
});
afterEach(() => {
  release();
  globalThis.WebSocket = realWs; globalThis.fetch = realFetch;
  clearRequestLogsForTests();
  for (const name of ENV) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  removeTreeWithRetry(home);
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 1000; index++) { if (condition()) return; await Bun.sleep(2); }
  throw new Error("cache telemetry final log did not settle");
}

async function runEntry(transport: "http" | "websocket", config = settings()): Promise<string> {
  const headers = new Headers({ authorization: "Bearer fixture-credential", "session-id": "fixture-session", "thread-id": "fixture-thread" });
  const frame = { model: config.defaultProvider === "openai" ? "gpt-5.6-sol" : `${config.defaultProvider}/gpt-5.6-sol`,
    input: "prompt-content-sentinel", reasoning: { effort: "high" }, stream: true };
  if (transport === "http") {
    const context = { config, deps: {}, ingressForServer: () => "public", packageTreeIntegrity: { status: () => ({ ok: true }) },
      runAdmittedHttpTurn: async (_req: Request, _policy: unknown, work: (lease: NonNullable<ReturnType<typeof tryAdmitTurn>>) => Promise<Response>) => {
        const lease = tryAdmitTurn();
        if (!lease) throw new Error("test turn admission refused");
        try { return await work(lease); } finally { lease.release(); }
      },
    } as unknown as ServeOptionsContext;
    const options = createServeOptions(context);
    const response = await options.fetch(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", headers: new Headers([...headers, ["content-type", "application/json"]]), body: JSON.stringify(frame),
    }), { timeout() {}, requestIP: () => ({ address: "127.0.0.1" }) } as never);
    expect(response.status).toBe(200);
    const text = await response.text();
    await waitFor(() => getRequestLogEntries().length > 0);
    return text;
  }
  const handler = createWebsocketHandler({ config, deps: {} } as ServeOptionsContext);
  const sent: string[] = [];
  const ws = { readyState: 1, data: { headers } as WsData,
    send(text: string) { sent.push(text); return 1; }, close() {},
  } as unknown as ServerWebSocket<WsData>;
  handler.message(ws, JSON.stringify({ type: "response.create", ...frame }));
  await waitFor(() => getRequestLogEntries().length > 0 && ws.data.cancel === undefined);
  handler.close(ws, 1000, "fixture completed");
  return sent.join("\n");
}

function diagnostic() {
  return JSON.parse(readFileSync(cacheDiagnosticPath(), "utf8").trim().split("\n").at(-1)!);
}

describe("cache telemetry reaches final logs from both real ingress owners", () => {
  for (const transport of ["http", "websocket"] as const) {
    for (const cached of [0, undefined, 40] as const) {
      test(`${transport}: upstream cache ${cached === undefined ? "absent" : cached} is not guessed from client zeros`, async () => {
        rawUsage = { input_tokens: 100, output_tokens: 5, ...(cached === undefined ? {} : { input_tokens_details: { cached_tokens: cached } }) };
        const client = await runEntry(transport);
        expect(upstreamSends).toBe(1);
        expect(client).not.toContain("cacheTelemetry");
        const row = getRequestLogEntries().at(-1)!;
        expect(row.cacheProvenance).toBe(cached === undefined ? "unknown" : "observed");
        expect(row.usage?.cacheTelemetry).toMatchObject({ source: "upstream", usagePresent: true });
        expect(row.usage?.cacheTelemetry?.read).toBe(cached);
        const persisted = readUsageEntries().at(-1)!;
        expect(persisted.cacheProvenance).toBe(row.cacheProvenance);
        expect(persisted.attempts?.at(-1)?.cacheProvenance).toBe(row.cacheProvenance);
        const raw = diagnostic().cache.rawUpstream;
        expect(raw.observed).toBe(true);
        expect(raw.present).toBe(cached !== undefined);
        expect(raw.value).toBe(cached);
        const summary = summarizeUsage([persisted], "all", Date.now());
        expect(summary.summary.cacheObservedRequests).toBe(cached === undefined ? 0 : 1);
        expect(summary.summary.cacheUnknownRequests).toBe(cached === undefined ? 1 : 0);
        const debug = readFileSync(cacheDiagnosticPath(), "utf8");
        expect(debug).not.toContain("prompt-content-sentinel");
        expect(debug).not.toContain("fixture-credential");
      });
    }
    test(`${transport}: a terminal without any usage stays unknown`, async () => {
      await runEntry(transport);
      expect(getRequestLogEntries().at(-1)!.cacheProvenance).toBe("unknown");
      expect(diagnostic().cache.rawUpstream.present).toBe(false);
    });
    for (const status of ["incomplete", "failed"]) test(`${transport}: ${status} terminals preserve a real zero`, async () => {
      terminal = status;
      rawUsage = { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } };
      await runEntry(transport);
      expect(getRequestLogEntries().at(-1)!.cacheProvenance).toBe("observed");
      expect(getRequestLogEntries().at(-1)!.terminalStatus).toBe(status);
    });
    test(`${transport}: final missing usage does not inherit an earlier frame's cache reading`, async () => {
      interimUsage = { input_tokens: 100, output_tokens: 0, input_tokens_details: { cached_tokens: 50 } };
      await runEntry(transport);
      const row = getRequestLogEntries().at(-1)!;
      expect(row.cacheProvenance).toBe("unknown");
      expect(row.usage?.cachedInputTokens).toBeUndefined();
      expect(row.usage?.cacheReadInputTokens).toBeUndefined();
      expect(diagnostic().cache.rawUpstream).toMatchObject({ observed: true, usagePresent: false, present: false });
    });
  }
});

for (const transport of ["http", "websocket"] as const) for (const cached of [0, undefined, 40]) test(`${transport}: real adapter bridge retains ${cached === undefined ? "absent cache detail" : cached} before client defaulting`, async () => {
  const config = { port: 0, bind: "127.0.0.1", defaultProvider: "bridge", providers: {
    bridge: { adapter: "openai-chat", baseUrl: "https://upstream.invalid/v1", apiKey: "fixture-key" },
  } } as OcxConfig;
  globalThis.fetch = (async () => new Response([
    { id: "chat-fixture", choices: [{ index: 0, delta: { content: "fixture output" }, finish_reason: null }] },
    { id: "chat-fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: {
      prompt_tokens: 100, completion_tokens: 5, ...(cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached } }),
    } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;
  const client = await runEntry(transport, config);
  expect(client).toContain("cached_tokens"); // The real Responses encoder emits strict-client defaults.
  expect(client).not.toContain("cacheTelemetry");
  const row = readUsageEntries().at(-1)!;
  expect(row.cacheProvenance).toBe(cached === undefined ? "unknown" : "observed");
  expect(row.usage?.cacheTelemetry?.read).toBe(cached);
  // Adapter-reported canonical counts are not a raw upstream payload observation.
  expect(diagnostic().cache.rawUpstream).toMatchObject({ observed: false, present: false });
});

test("client zero defaults cannot overwrite absent raw counters; unobserved client-only zeros are unknown", () => {
  const ctx: RequestLogContext = { provider: "test", model: "test" };
  const usage = { input_tokens: 100, output_tokens: 1 };
  applyResponseLogMetadata(ctx, { usage }, "upstream");
  const encoded = responsesUsage(ctx.usage);
  expect(encoded.input_tokens_details).toEqual({ cached_tokens: 0 });
  applyResponseLogMetadata(ctx, { usage: encoded });
  addFinalRequestLog("defaulted", Date.now(), ctx, 200);
  expect(getRequestLogEntries().at(-1)!.cacheProvenance).toBe("unknown");
  expect(diagnostic().cache.rawUpstream).toMatchObject({ observed: true, present: false });
  const clientOnly: RequestLogContext = { provider: "test", model: "test" };
  applyResponseLogMetadata(clientOnly, { usage: encoded });
  addFinalRequestLog("client-only", Date.now(), clientOnly, 200);
  expect(getRequestLogEntries().at(-1)!.cacheProvenance).toBe("unknown");
  expect(diagnostic().cache.rawUpstream).toMatchObject({ observed: false, present: false });
});

test("a type-only terminal without usage clears prior evidence even when response.status is absent", () => {
  const ctx: RequestLogContext = { provider: "test", model: "test" };
  applyResponseLogMetadata(ctx, { type: "response.created", response: {
    usage: { input_tokens: 100, output_tokens: 1, input_tokens_details: { cached_tokens: 50 } },
  } }, "upstream");
  applyResponseLogMetadata(ctx, { type: "response.completed", response: {} }, "upstream");
  addFinalRequestLog("type-only-terminal", Date.now(), ctx, 200);
  expect(readUsageEntries().at(-1)!.cacheProvenance).toBe("unknown");
  expect(diagnostic().cache.rawUpstream).toMatchObject({ observed: true, usagePresent: false, present: false });
});

test("an unresolved final attempt cannot borrow usage or raw cache evidence from an earlier send", () => {
  const first = beginRequestAttempt(1, "one", "test", "openai-responses");
  const last = beginRequestAttempt(2, "two", "test", "openai-responses");
  noteAttemptSend(first, undefined); noteAttemptSend(last, undefined);
  const ctx: RequestLogContext = { provider: "two", model: "test", attempts: [first, last], activeAttempt: first };
  applyResponseLogMetadata(ctx, { usage: { input_tokens: 100, output_tokens: 1, input_tokens_details: { cached_tokens: 50 } } }, "upstream");
  finishRequestAttempt(first, 200, 1, ctx.usage);
  ctx.activeAttempt = last; // Deliberately keep the context's old usage reference.
  addFinalRequestLog("unresolved-final-send", Date.now(), ctx, 502);
  const row = readUsageEntries().at(-1)!;
  expect(row.cacheProvenance).toBe("unknown");
  // Some runtime baselines retain non-combo multi-attempt totals. Those real earlier-send
  // costs may remain on the parent, but are not a cache observation of the unresolved send.
  if (row.usage !== undefined) expect(row.usage).toMatchObject({
    inputTokens: 100, outputTokens: 1, cacheReadInputTokens: 50,
    cacheTelemetry: { source: "aggregate", complete: false, read: 50 },
  });
  expect(row.attempts?.[1].usage).toBeUndefined();
  expect(row.attempts?.[1].cacheProvenance).toBe("unknown");
  expect(row.attempts?.[0].cacheProvenance).toBe("observed");
  expect(diagnostic().cache.rawUpstream).toMatchObject({ observed: false, present: false });
});

test("physical attempts own their evidence; aggregate and final raw are not sibling projections", () => {
  const first = beginRequestAttempt(1, "one", "test", "openai-responses");
  const second = beginRequestAttempt(2, "two", "test", "openai-responses");
  const ctx: RequestLogContext = { provider: "two", model: "test", comboId: "combo", attempts: [first, second], activeAttempt: first };
  applyResponseLogMetadata(ctx, { usage: { input_tokens: 100, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } }, "upstream");
  finishRequestAttempt(first, 200, 1, ctx.usage);
  ctx.activeAttempt = second; delete ctx.usage;
  applyResponseLogMetadata(ctx, { usage: { input_tokens: 100, output_tokens: 1 } }, "upstream");
  addFinalRequestLog("two-attempts", Date.now(), ctx, 200);
  const row = readUsageEntries().at(-1)!;
  expect(row.attempts?.map(attempt => attempt.cacheProvenance)).toEqual(["observed", "unknown"]);
  expect(row.cacheProvenance).toBe("unknown");
  expect(row.usage).toMatchObject({ inputTokens: 200, outputTokens: 2,
    cacheTelemetry: { source: "aggregate", complete: false, read: 0 } });
  expect(diagnostic().cache.rawUpstream).toMatchObject({ observed: true, present: false });
  const summary = summarizeUsage([row], "all", Date.now());
  expect(summary.providers.find(provider => provider.provider === "one")?.cacheObservedInputTokens).toBe(100);
  expect(summary.providers.find(provider => provider.provider === "two")?.cacheObservedInputTokens).toBe(0);
});
