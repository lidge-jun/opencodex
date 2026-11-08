import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { EAGER_CODEX_MCP_TOOL_WARNING_THRESHOLD } from "../../src/server/responses/codex-tool-catalog";
import type { OcxConfig } from "../../src/types";
import { createTempHome } from "../helpers/temp-home";
import { ownedServiceHomeInspection } from "../helpers/owned-service-home-inspection";

/**
 * An eagerly expanded Codex MCP catalog is a diagnostic, never a refusal (#8133, ADR-0022): every
 * request below must still reach the provider. Only the current request's declarations count, and
 * the warning names the count and threshold once per session without tool names.
 */
const inspectNativeCodexOwnership = ownedServiceHomeInspection("Codex tool catalog diagnostic test");
const TICK = "`";
const FENCE = TICK.repeat(3);
let home: ReturnType<typeof createTempHome>;
let upstream: ReturnType<typeof Bun.serve>;
let server: ReturnType<typeof startServer>;
let upstreamCalls = 0;
let warn: ReturnType<typeof spyOn<Console, "warn">>;
let sessionCounter = 0;

function mcpTools(deferred = false, length = EAGER_CODEX_MCP_TOOL_WARNING_THRESHOLD) {
  return [{
    type: "namespace", name: "mcp__fixture",
    tools: Array.from({ length }, (_value, index) => ({
      type: "function", name: `tool_${index}`, description: "Fixture tool",
      parameters: { type: "object", properties: {} },
      ...(deferred ? { defer_loading: true } : {}),
    })),
  }];
}

/** codex-rs build_exec_tool_description: a heading, the description, then a ts declaration fence. */
function renderedExec(names: string[], preface = ""): Record<string, unknown> {
  const sections = names.map(name => [
    "### " + TICK + name + TICK, "Fixture tool", "", "exec tool declaration:", FENCE + "ts",
    "declare const tools: { " + name + "(args: {}): Promise<unknown>; };", FENCE,
  ].join("\n"));
  return { type: "custom", name: "exec",
    description: ["Run JavaScript code to orchestrate/compose tool calls", preface, ...sections].join("\n\n") };
}

function catalogWarnings(): string[] {
  return warn.mock.calls.map(call => String(call[0])).filter(text => text.startsWith("[codex-catalog]"));
}

beforeEach(() => {
  home = createTempHome("ocx-codex-tool-catalog-");
  upstreamCalls = 0;
  warn = spyOn(console, "warn");
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      upstreamCalls += 1;
      const streamed = (await req.json() as { stream?: unknown }).stream === true;
      if (streamed) {
        const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({
          id: "chatcmpl_fixture", object: "chat.completion.chunk", model: "model",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
        return new Response(chunk({ role: "assistant", content: "ok" }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({
        id: "chatcmpl_fixture", object: "chat.completion", model: "model",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      });
    },
  });
  saveConfig({
    port: 0, hostname: "127.0.0.1", websockets: true, defaultProvider: "fixture",
    providers: { fixture: { adapter: "openai-chat", baseUrl: new URL("/v1", upstream.url).href, apiKey: "fixture-key", liveModels: false, allowPrivateNetwork: true } },
  } as OcxConfig);
  server = startServer(0, { inspectNativeCodexOwnership });
});

afterEach(async () => {
  warn.mockRestore();
  await server?.stop(true);
  upstream?.stop(true);
  home.remove();
});

function codexHeaders(session = `catalog-session-${++sessionCounter}`): Record<string, string> {
  return { originator: "codex_cli_rs", "user-agent": "codex_cli_rs/0.166.0", session_id: session };
}

async function send(path: string, tools: unknown[], headers: Record<string, string>, extra: Record<string, unknown> = {}) {
  const response = await fetch(new URL(path, server.url), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer fixture-client", ...headers },
    body: JSON.stringify({ model: "fixture/model", input: "hello", stream: false, tools, ...extra }),
  });
  const text = await response.text();
  return { status: response.status, text };
}

describe("an eagerly expanded Codex MCP catalog is forwarded with a one-time diagnostic", () => {
  test.each(["/v1/responses", "/backend-api/codex/responses", "/v1/responses/compact"])("%s forwards the request and warns", async path => {
    const result = await send(path, mcpTools(), codexHeaders());
    expect(result.status, result.text).toBe(200);
    expect(upstreamCalls).toBe(1);
    const warnings = catalogWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`Codex sent ${EAGER_CODEX_MCP_TOOL_WARNING_THRESHOLD} eager MCP tool definitions`);
    expect(warnings[0]).toContain(`warning threshold ${EAGER_CODEX_MCP_TOOL_WARNING_THRESHOLD}`);
    expect(warnings[0]).not.toContain("mcp__fixture");
    expect(warnings[0]).not.toContain("tool_0");
    expect(warnings[0]).not.toContain("catalog-session");
  });

  test("the warning is shown once per session", async () => {
    const first = codexHeaders();
    for (const headers of [first, first, codexHeaders()]) {
      const result = await send("/v1/responses", mcpTools(), headers);
      expect(result.status, result.text).toBe(200);
    }
    expect(upstreamCalls).toBe(3);
    expect(catalogWarnings()).toHaveLength(2);
  });

  test("flattened MCP declarations are diagnosed with Codex turn metadata alone", async () => {
    const tools = mcpTools()[0]!.tools.map(tool => ({ ...tool, name: `mcp__fixture__${tool.name}` }));
    const result = await send("/v1/responses", tools, { "x-codex-turn-metadata": "{}", session_id: "catalog-metadata-only" });
    expect(result.status, result.text).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(catalogWarnings()).toHaveLength(1);
  });

  test.each([
    ["originator", "codex_cli_rs"],
    ["user-agent", "codex_cli_rs/0.166.0"],
  ])("the canonical Codex %s alone is enough for the diagnostic", async (header, value) => {
    const result = await send("/v1/responses", mcpTools(), { [header]: value, session_id: `catalog-${header}-only` });
    expect(result.status, result.text).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(catalogWarnings()).toHaveLength(1);
  });

  test.each([
    ["originator", "my-codex-wrapper/1"],
    ["user-agent", "my-codex-wrapper/1"],
  ])("a generic %s containing codex is not diagnosed", async (header, value) => {
    const result = await send("/v1/responses", mcpTools(), { [header]: value, session_id: `catalog-generic-${header}` });
    expect(result.status, result.text).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(catalogWarnings()).toHaveLength(0);
  });

  test("current Responses Lite additional_tools declarations are diagnosed", async () => {
    const result = await send("/v1/responses", [], codexHeaders(), {
      input: [{ type: "additional_tools", role: "developer", tools: mcpTools() }, { role: "user", content: "hello" }],
    });
    expect(result.status, result.text).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(catalogWarnings()).toHaveLength(1);
  });

  test.each([
    ["with a small current declaration", true],
    ["without a current declaration", false],
  ])("a resumed thread's historical eager additional_tools are not counted (%s)", async (_label, currentDeclaration) => {
    const result = await send("/v1/responses", [], codexHeaders(), {
      input: [
        { type: "additional_tools", role: "developer", tools: mcpTools() },
        { role: "user", content: "Earlier request" },
        { role: "assistant", content: "Earlier response" },
        ...(currentDeclaration ? [{ type: "additional_tools", role: "developer", tools: mcpTools(false, 3) }] : []),
        { role: "user", content: "Current request" },
      ],
    });
    expect(result.status, result.text).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(catalogWarnings()).toHaveLength(0);
  });

  test.each(["/v1/responses/compact", "/v1/responses"])("%s compaction history is not diagnosed", async path => {
    const result = await send(path, [], codexHeaders(), {
      input: [
        { type: "additional_tools", role: "developer", tools: mcpTools() },
        { role: "user", content: "Earlier request" },
        { role: "assistant", content: "Earlier response" },
        ...(path === "/v1/responses" ? [{ type: "compaction_trigger" }] : []),
      ],
    });
    expect(result.status, result.text).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(catalogWarnings()).toHaveLength(0);
  });

  test.each([
    ["a small explicitly loaded MCP subset", mcpTools(false, 3)],
    ["deferred MCP definitions with tool search", [...mcpTools(true), { type: "tool_search", execution: "client" }]],
  ])("%s is not diagnosed", async (_label, tools) => {
    const result = await send("/v1/responses", tools, codexHeaders());
    expect(result.status, result.text).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(catalogWarnings()).toHaveLength(0);
  });

  test("ordinary clients choosing an eager MCP catalog are not diagnosed", async () => {
    const result = await send("/v1/responses", mcpTools(), { session_id: "catalog-ordinary" });
    expect(result.status, result.text).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(catalogWarnings()).toHaveLength(0);
  });

  test("code-mode examples and historical text are not counted as declarations", async () => {
    const example = "Example: declare const tools: { mcp__fixture__read(args: {}): Promise<unknown>; };";
    const result = await send("/v1/responses", [renderedExec([], example)], codexHeaders(),
      { input: [{ role: "user", content: JSON.stringify(mcpTools()) }] });
    expect(result.status, result.text).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(catalogWarnings()).toHaveLength(0);
  });

  test("an expanded code-mode exec description is diagnosed", async () => {
    const names = Array.from({ length: EAGER_CODEX_MCP_TOOL_WARNING_THRESHOLD }, (_value, index) => `mcp__fixture__tool_${index}`);
    const result = await send("/v1/responses", [renderedExec(names)], codexHeaders());
    expect(result.status, result.text).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(catalogWarnings()).toHaveLength(1);
  });

  test("a Codex WebSocket turn is diagnosed from its handshake identity and still served", async () => {
    const url = new URL("/v1/responses", server.url);
    url.protocol = "ws:";
    const socket = new WebSocket(url, { headers: { authorization: "Bearer fixture-client", ...codexHeaders() } } as unknown as string[]);
    try {
      const terminal = new Promise<string>((resolve, reject) => {
        socket.addEventListener("message", event => {
          const frame = JSON.parse(String(event.data)) as { type?: string };
          if (frame.type === "response.completed" || frame.type === "response.failed" || frame.type === "error") resolve(frame.type);
        });
        socket.addEventListener("close", () => reject(new Error("socket closed before a terminal frame")), { once: true });
      });
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("socket handshake failed")), { once: true });
      });
      socket.send(JSON.stringify({ type: "response.create", model: "fixture/model", input: [
        { type: "additional_tools", role: "developer", tools: mcpTools() },
        { type: "message", role: "user", content: "hello" },
      ] }));
      expect(await terminal).toBe("response.completed");
      expect(upstreamCalls).toBe(1);
      expect(catalogWarnings()).toHaveLength(1);
    } finally {
      socket.close();
    }
  });
});
