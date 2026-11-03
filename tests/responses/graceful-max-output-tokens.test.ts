import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTER_REGISTRY } from "../../src/adapters/registry";
import { waitForNativeMainStartupGate } from "../../src/codex/native-profile-startup";
import { saveConfig } from "../../src/config";
import * as configModule from "../../src/config";
import { configSchema } from "../../src/config/schema/config-schema";
import { startServer } from "../../src/server";
import { codexWsExchange } from "../../src/server/responses/codex-ws-exchange";
import { CODEX_RESPONSES_HTTP_URL, prepareCodexWsRequest } from "../../src/server/responses/codex-ws-request";
import { CodexWsSession } from "../../src/server/responses/codex-ws-session";
import { codexWsUpstreamFetch } from "../../src/server/responses/ws-upstream";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { installCompactionRoutingAclFixture } from "../helpers/compaction-routing-fixtures";

installCompactionRoutingAclFixture();

const TEXT = "Partial code\n```ts\nconst x =";
const oldHome = process.env.OPENCODEX_HOME;
const originalCreate = ADAPTER_REGISTRY.anthropic.create;
let home: string;
let isolated: IsolatedCodexHome;
let upstream: ReturnType<typeof Bun.serve>;
let server: ReturnType<typeof startServer>;
let runTurnCalls = 0;

function frames(body: string): { name?: string; data: Record<string, any> }[] {
  return body.split("\n\n").flatMap(block => {
    const lines = block.split("\n");
    const data = lines.find(line => line.startsWith("data: "))?.slice(6);
    return !data || data === "[DONE]" ? [] : [{
      name: lines.find(line => line.startsWith("event: "))?.slice(7), data: JSON.parse(data),
    }];
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-graceful-output-"));
  isolated = installIsolatedCodexHome("ocx-graceful-output-codex-");
  process.env.OPENCODEX_HOME = home;
  upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as { stream?: boolean };
      if (!body.stream) return Response.json({
        id: "msg_fixture", type: "message", role: "assistant", model: "fixture-model",
        content: [{ type: "text", text: TEXT }], stop_reason: "max_tokens",
        usage: { input_tokens: 5, output_tokens: 20 },
      });
      const frame = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      return new Response([
        frame("message_start", { message: { id: "msg_fixture", model: "fixture-model", usage: { input_tokens: 5, output_tokens: 0 } } }),
        frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: TEXT } }),
        frame("content_block_stop", { index: 0 }),
        frame("message_delta", { delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 20 } }),
        frame("message_stop", {}),
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  ADAPTER_REGISTRY.anthropic.create = (provider, context) => {
    const adapter = originalCreate(provider, context);
    if (provider.defaultModel !== "runturn-model") return adapter;
    return { ...adapter, async runTurn(_parsed, _incoming, emit) {
      runTurnCalls++;
      emit({ type: "text_delta", text: TEXT });
      emit({ type: "incomplete", reason: "max_output_tokens", usage: { inputTokens: 5, outputTokens: 20 } });
    } };
  };
  const provider = (model: string) => ({
    adapter: "anthropic", baseUrl: `http://127.0.0.1:${upstream.port}`, apiKey: "sk-test",
    allowPrivateNetwork: true, liveModels: false, defaultModel: model, models: [model],
  });
  saveConfig({
    hostname: "127.0.0.1", port: 0, defaultProvider: "fixture", completeOnMaxOutputTokens: true,
    providers: { fixture: provider("fixture-model"), runturn: provider("runturn-model") },
  } as OcxConfig);
  server = startServer(0);
  await waitForNativeMainStartupGate();
});

afterAll(async () => {
  await server?.stop(true);
  await upstream?.stop(true);
  ADAPTER_REGISTRY.anthropic.create = originalCreate;
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = oldHome;
  isolated?.restore();
  if (home) removeTreeWithRetry(home);
});

async function post(path: string, body: Record<string, unknown>) {
  const response = await fetch(new URL(path, server.url), {
    method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response;
}

describe("opt-in delivery stays on Responses text only", () => {
  for (const model of ["fixture/fixture-model", "runturn/runturn-model"]) {
    for (const stream of [false, true]) {
      test(`${model} ${stream ? "SSE" : "JSON"} completes text`, async () => {
        const before = runTurnCalls;
        const response = await post("/v1/responses", { model, input: "hi", stream });
        const result = stream ? frames(await response.text()).find(frame => frame.name === "response.completed")?.data.response : await response.json();
        expect(result?.status).toBe("completed");
        expect(result.output[0].content[0].text).toBe(TEXT);
        if (model.startsWith("runturn/")) expect(runTurnCalls - before).toBe(1);
      });
      for (const type of ["json_schema", "json_object"]) {
        test(`${model} ${stream ? "SSE" : "JSON"} excludes text.format ${type}`, async () => {
          const response = await post("/v1/responses", {
            model, input: "hi", stream, text: { format: { type, name: "fixture", schema: { type: "object" } } },
          });
          const result = stream ? frames(await response.text()).find(frame => frame.name === "response.incomplete")?.data.response : await response.json();
          expect(result?.status).toBe("incomplete");
          expect(result.incomplete_details.reason).toBe("max_output_tokens");
        });
      }
      test(`${model} ${stream ? "SSE" : "JSON"} Chat preserves length`, async () => {
        const response = await post("/v1/chat/completions", { model, stream, messages: [{ role: "user", content: "hi" }] });
        const result = stream ? frames(await response.text()).find(frame => frame.data.choices?.[0]?.finish_reason)?.data : await response.json();
        expect(result.choices[0].finish_reason).toBe("length");
      });
      test(`${model} ${stream ? "SSE" : "JSON"} Messages preserves max_tokens`, async () => {
        const response = await post("/v1/messages", { model, stream, max_tokens: 20, messages: [{ role: "user", content: "hi" }] });
        const result = stream ? frames(await response.text()).find(frame => frame.data.delta?.stop_reason)?.data.delta : await response.json();
        expect(result.stop_reason).toBe("max_tokens");
      });
    }
  }
  test("missing, false, and malformed settings do not enable the policy", () => {
    const base = { defaultProvider: "fixture", providers: { fixture: {
      adapter: "anthropic", baseUrl: "http://127.0.0.1:1", allowPrivateNetwork: true, defaultModel: "fixture-model", models: ["fixture-model"],
    } } };
    for (const value of [undefined, false, "true", 1, null]) {
      const parsed = configSchema.parse({ ...base, completeOnMaxOutputTokens: value });
      expect(parsed.completeOnMaxOutputTokens === true).toBe(false);
    }
    expect(configSchema.parse({ ...base, completeOnMaxOutputTokens: true }).completeOnMaxOutputTokens).toBe(true);
  });
});

test("native WebSocket preserves incomplete framing with global opt-in enabled", async () => {
  const payload = { type: "response.incomplete", response: {
    id: "resp_fixture", status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" },
  } };
  const listener = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, server) { if (!server.upgrade(req)) return new Response(null, { status: 400 }); },
    websocket: { message(socket) { socket.send(JSON.stringify(payload)); } },
  });
  const init: RequestInit = { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture-model", stream: true, input: [] }) };
  const prepared = prepareCodexWsRequest(CODEX_RESPONSES_HTTP_URL, init)!;
  const session = new CodexWsSession(`ws://127.0.0.1:${listener.port}`, prepared.headers);
  try {
    expect(session.reserve()).toBe(true);
    const response = await codexWsExchange({ session, prepared, init, url: CODEX_RESPONSES_HTTP_URL,
      sseFallback: (async () => { throw new Error("unexpected fallback"); }) as typeof fetch });
    const all = frames(await response.text());
    expect(all).toEqual([{ name: "response.incomplete", data: payload }]);
  } finally { session.dispose(); await listener.stop(true); }
});

test("WS upstream does not reload config after reserving its session", async () => {
  const realSocket = globalThis.WebSocket;
  const realLoad = configModule.loadConfig;
  const reserve = CodexWsSession.prototype.reserve;
  const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
  const proxyEnv = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
  let reserved = false;
  let lateLoads = 0;
  const loadSpy = spyOn(configModule, "loadConfig").mockImplementation((...args) => {
    if (reserved) lateLoads++;
    return realLoad(...args);
  });
  const reserveSpy = spyOn(CodexWsSession.prototype, "reserve").mockImplementation(function (this: CodexWsSession) {
    const result = reserve.call(this);
    if (result) reserved = true;
    return result;
  });
  class Socket extends EventTarget {
    readyState = 1;
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    send() { queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
      type: "response.incomplete", response: { id: "r_no_reload", status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" } },
    }) }))); }
    close() { this.dispatchEvent(new Event("close")); }
  }
  try {
    for (const key of proxyKeys) delete process.env[key];
    globalThis.WebSocket = Socket as unknown as typeof WebSocket;
    const response = await codexWsUpstreamFetch(CODEX_RESPONSES_HTTP_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture-model", stream: true, input: [] }),
    }, (async () => { throw new Error("unexpected HTTP fallback"); }) as typeof fetch, "1.4.0");
    const all = frames(await response.text());
    expect(reserved).toBe(true);
    expect(lateLoads).toBe(0);
    expect(all.map(frame => frame.name)).toEqual(["response.incomplete"]);
  } finally {
    loadSpy.mockRestore(); reserveSpy.mockRestore(); globalThis.WebSocket = realSocket;
    for (const key of proxyKeys) {
      if (proxyEnv[key] === undefined) delete process.env[key];
      else process.env[key] = proxyEnv[key];
    }
  }
});
