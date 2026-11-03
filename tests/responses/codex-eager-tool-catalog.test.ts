import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { createTempHome } from "../helpers/temp-home";
import { ownedServiceHomeInspection } from "../helpers/owned-service-home-inspection";

const inspectNativeCodexOwnership = ownedServiceHomeInspection("Codex tool catalog reload test");
let home: ReturnType<typeof createTempHome>;
let upstream: ReturnType<typeof Bun.serve>;
let server: ReturnType<typeof startServer>;
let upstreamCalls = 0;

function mcpTools(deferred = false) {
  return [{
    type: "namespace", name: "mcp__fixture",
    tools: Array.from({ length: 64 }, (_value, index) => ({
      type: "function", name: `tool_${index}`, description: "Fixture tool",
      parameters: { type: "object", properties: {} },
      ...(deferred ? { defer_loading: true } : {}),
    })),
  }];
}

beforeEach(() => {
  home = createTempHome("ocx-codex-tool-catalog-");
  upstreamCalls = 0;
  upstream = Bun.serve({
    port: 0,
    async fetch() {
      upstreamCalls += 1;
      return Response.json({
        id: "chatcmpl_fixture", object: "chat.completion", model: "model",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      });
    },
  });
  saveConfig({
    port: 0, defaultProvider: "fixture",
    providers: { fixture: { adapter: "openai-chat", baseUrl: new URL("/v1", upstream.url).href, apiKey: "fixture-key", liveModels: false, allowPrivateNetwork: true } },
  } as OcxConfig);
  server = startServer(0, { inspectNativeCodexOwnership });
});

afterEach(async () => {
  await server?.stop(true);
  upstream?.stop(true);
  home.remove();
});

function post(path: string, tools: unknown[], codex = true, extra: Record<string, unknown> = {}) {
  return fetch(new URL(path, server.url), {
    method: "POST",
    headers: {
      "content-type": "application/json", authorization: "Bearer fixture-client",
      ...(codex ? { originator: "codex_cli_rs", "user-agent": "codex_cli_rs/0.166.0" } : {}),
    },
    body: JSON.stringify({ model: "fixture/model", input: "hello", stream: false, tools, ...extra }),
  });
}

describe("Codex stale metadata cannot spend an eagerly expanded MCP catalog", () => {
  test.each(["/v1/responses", "/backend-api/codex/responses", "/v1/responses/compact"])("%s refuses before contacting a provider", async path => {
    const response = await post(path, mcpTools());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "codex_catalog_reload_required" } });
    expect(upstreamCalls).toBe(0);
  });

  test("flattened MCP declarations are refused with Codex turn metadata alone", async () => {
    const tools = mcpTools()[0]!.tools.map(tool => ({ ...tool, name: `mcp__fixture__${tool.name}` }));
    const response = await fetch(new URL("/v1/responses", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fixture-client", "x-codex-turn-metadata": "{}" },
      body: JSON.stringify({ model: "fixture/model", input: "hello", stream: false, tools }),
    });
    expect(response.status).toBe(400);
    expect(upstreamCalls).toBe(0);
  });

  test("Responses Lite additional_tools declarations are checked before dispatch", async () => {
    const response = await post("/v1/responses", [], true, {
      input: [{ type: "additional_tools", role: "developer", tools: mcpTools() }, { role: "user", content: "hello" }],
    });
    expect(response.status).toBe(400);
    expect(upstreamCalls).toBe(0);
  });

  test("a small explicitly loaded MCP subset is not rejected", async () => {
    const declarations = mcpTools();
    declarations[0]!.tools.length = 3;
    const response = await post("/v1/responses", declarations);
    expect(response.status).toBe(200);
    await response.text();
    expect(upstreamCalls).toBe(1);
  });

  test("deferred MCP definitions with tool search remain usable", async () => {
    const response = await post("/v1/responses", [...mcpTools(true), { type: "tool_search", execution: "client" }]);
    expect(response.status).toBe(200);
    await response.text();
    expect(upstreamCalls).toBe(1);
  });

  test("ordinary clients can explicitly choose an eager MCP catalog", async () => {
    const response = await post("/v1/responses", mcpTools(), false);
    expect(response.status).toBe(200);
    await response.text();
    expect(upstreamCalls).toBe(1);
  });

  test("code-mode discovery does not count examples or historical text as declarations", async () => {
    const response = await post("/v1/responses", [{
      type: "custom", name: "exec", description: "JavaScript in a V8 isolate. Discover helpers from ALL_TOOLS; example mcp__fixture__read.",
    }], true, { input: [{ role: "user", content: JSON.stringify(mcpTools()) }] });
    expect(response.status).toBe(200);
    await response.text();
    expect(upstreamCalls).toBe(1);
  });

  test("an expanded code-mode description is refused too", async () => {
    const description = "JavaScript in a V8 isolate. ALL_TOOLS\n" + Array.from({ length: 64 }, (_value, index) =>
      `declare const tools: { mcp__fixture__tool_${index}(args: {}): Promise<unknown>; };`,
    ).join("\n");
    const response = await post("/v1/responses", [{ type: "custom", name: "exec", description }]);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "codex_catalog_reload_required" } });
    expect(upstreamCalls).toBe(0);
  });
});
