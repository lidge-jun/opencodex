import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import {
  EAGER_CODEX_MCP_TOOL_WARNING_THRESHOLD,
  WARNED_SESSION_LIMIT,
  eagerCodexMcpToolCount,
  warnEagerCodexToolCatalog,
} from "../../src/server/responses/codex-tool-catalog";
import type { OcxConfig } from "../../src/types";
import { clearResponseStateForTests, rememberResponseState } from "../../src/responses/state";
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

function message(role: string, text: string): Record<string, unknown> {
  return { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] };
}

/**
 * A Responses Lite first turn as codex-rs sends it (incremental_tools / responses_lite): the tool
 * catalog, two developer messages, a user-role environment context, then the user's prompt.
 */
function liteFirstTurn(tools: unknown[]): unknown[] {
  return [
    { type: "additional_tools", role: "developer", tools },
    message("developer", "<permissions instructions>fixture</permissions instructions>"),
    message("developer", "<collaboration_mode>fixture</collaboration_mode>"),
    message("user", "<environment_context><cwd>/fixture</cwd></environment_context>"),
    message("user", "hello"),
  ];
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
    combos: { catalog: { strategy: "failover", targets: [{ provider: "fixture", model: "model" }] } },
  } as OcxConfig);
  server = startServer(0, { inspectNativeCodexOwnership });
});

afterEach(async () => {
  warn.mockRestore();
  await server?.stop(true);
  upstream?.stop(true);
  clearResponseStateForTests();
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

  test.each([
    ["directly ahead of the prompt", [{ type: "additional_tools", role: "developer", tools: mcpTools() }, { role: "user", content: "hello" }]],
    ["in the codex-rs first-turn layout", liteFirstTurn(mcpTools())],
  ])("current Responses Lite additional_tools declarations are diagnosed (%s)", async (_label, input) => {
    const result = await send("/v1/responses", [], codexHeaders(), { input });
    expect(result.status, result.text).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(catalogWarnings()).toHaveLength(1);
  });

  test("a resumed codex-rs window's client-sent catalog is counted, not treated as history", async () => {
    // Codex resends the window's base catalog when its input diverges, and the request pays for
    // every definition it carries. The client's own resend is this request's catalog.
    const result = await send("/v1/responses", [], codexHeaders(), {
      input: [...liteFirstTurn(mcpTools()), message("assistant", "Earlier response"), message("user", "Current request")],
    });
    expect(result.status, result.text).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(catalogWarnings()).toHaveLength(1);
  });

  test("a combo-routed Codex turn is diagnosed once for the logical request", async () => {
    const result = await send("/v1/responses", mcpTools(), codexHeaders(), { model: "combo/catalog" });
    expect(result.status, result.text).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(catalogWarnings()).toHaveLength(1);
  });

  test("history the proxy restores from previous_response_id is not re-counted", async () => {
    // The client sends only its new input; the proxy prepends the stored entry, whose request held
    // the eager catalog. That restored prefix is history this request did not send.
    const storedInput = liteFirstTurn(mcpTools());
    rememberResponseState(
      { model: "fixture/model", input: storedInput },
      { id: "resp_catalog_restored", status: "completed",
        output: [{ type: "message", id: "msg_catalog_restored", role: "assistant", content: "Earlier response" }] },
    );
    const result = await send("/v1/responses", [], codexHeaders(), {
      previous_response_id: "resp_catalog_restored",
      input: [message("user", "Current request")],
    });
    expect(result.status, result.text).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(catalogWarnings()).toHaveLength(0);
  });

  test("a client that resends its stored window under previous_response_id is counted", async () => {
    // Codex carries its own history on every turn. When it resends the stored window verbatim the
    // proxy prepends nothing (overlap skip), so every additional_tools item on the wire came from
    // the client this turn and the eager catalog it carries is this request's cost.
    const storedInput = liteFirstTurn(mcpTools());
    rememberResponseState(
      { model: "fixture/model", input: storedInput },
      { id: "resp_catalog_replay", status: "completed",
        output: [{ type: "message", id: "msg_catalog_replay", role: "assistant", content: "Earlier response" }] },
    );
    const result = await send("/v1/responses", [], codexHeaders(), {
      previous_response_id: "resp_catalog_replay",
      input: [...storedInput,
        { type: "message", id: "msg_catalog_replay", role: "assistant", content: "Earlier response" },
        message("user", "Current request")],
    });
    expect(result.status, result.text).toBe(200);
    expect(catalogWarnings()).toHaveLength(1);
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

  test.each([
    ["bare", false],
    ["inside the Responses Lite functions namespace", true],
  ])("an expanded code-mode exec description is diagnosed (%s)", async (_label, namespaced) => {
    const names = Array.from({ length: EAGER_CODEX_MCP_TOOL_WARNING_THRESHOLD }, (_value, index) => `mcp__fixture__tool_${index}`);
    const exec = renderedExec(names);
    const tools = namespaced ? [{ type: "namespace", name: "functions", description: "", tools: [exec] }] : [exec];
    const result = await send("/v1/responses", tools, codexHeaders());
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
      socket.send(JSON.stringify({ type: "response.create", model: "fixture/model", input: liteFirstTurn(mcpTools()) }));
      expect(await terminal).toBe("response.completed");
      expect(upstreamCalls).toBe(1);
      expect(catalogWarnings()).toHaveLength(1);
    } finally {
      socket.close();
    }
  });
});

describe("the eager catalog count stays a bounded, side-effect-free diagnostic", () => {
  const headers = new Headers({ originator: "codex_cli_rs" });

  test.each([
    ["a tool call and its output", [
      { type: "function_call", call_id: "call_1", name: "mcp__fixture__tool_0", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ]],
    ["an assistant message", [message("assistant", "Earlier response")]],
    ["reasoning", [{ type: "reasoning", summary: [] }]],
    ["a compaction", [{ type: "compaction", encrypted_content: "opaque" }]],
  ])("a trailing %s neither adds nor removes declarations", (_label, tail) => {
    // The client resends this window's catalog on every request, so the definitions it carries are
    // this request's cost no matter what the model produced afterwards.
    expect(eagerCodexMcpToolCount({ input: [...liteFirstTurn(mcpTools()), ...tail] }, headers))
      .toBe(EAGER_CODEX_MCP_TOOL_WARNING_THRESHOLD);
  });

  test("a continuation's fresh additional_tools catalog ahead of replayed calls is counted", () => {
    // A resumed Codex turn resends the window's base catalog, then its own tool calls. The catalog
    // precedes those calls, so a scan that starts after the last model output reads only history
    // and misses the definitions this request actually carries.
    const input = [
      ...liteFirstTurn(mcpTools()),
      message("assistant", "Earlier response"),
      { type: "function_call", call_id: "call_1", name: "wait", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
      message("user", "Current request"),
    ];
    expect(eagerCodexMcpToolCount({ input }, headers)).toBe(EAGER_CODEX_MCP_TOOL_WARNING_THRESHOLD);
  });

  test("an incremental additional_tools update after a replayed step is counted", () => {
    const input = [
      ...liteFirstTurn([{ type: "tool_search", execution: "client" }]),
      { type: "reasoning", summary: [] },
      { type: "additional_tools", role: "developer", tools: mcpTools() },
      message("user", "Current request"),
    ];
    expect(eagerCodexMcpToolCount({ input }, headers)).toBe(EAGER_CODEX_MCP_TOOL_WARNING_THRESHOLD);
  });

  test("input restored from stored continuation state is history, not this request's catalog", () => {
    const stored = liteFirstTurn(mcpTools());
    const clientTools = [{ type: "namespace", name: "mcp__current", tools: mcpTools(false, 3)[0]!.tools }];
    const client = [{ type: "additional_tools", role: "developer", tools: clientTools }];
    const body = { input: [...stored, ...client] };
    expect(eagerCodexMcpToolCount(body, headers, "responses", stored.length)).toBe(3);
    expect(eagerCodexMcpToolCount(body, headers)).toBe(EAGER_CODEX_MCP_TOOL_WARNING_THRESHOLD + 3);
  });

  test("an active session is not evicted before an idle one", () => {
    const capacity = WARNED_SESSION_LIMIT;
    const session = (index: number) => new Headers({ originator: "codex_cli_rs", session_id: `catalog-lru-${index}` });
    const eager = { input: "hello", tools: mcpTools() };
    for (let index = 0; index < capacity; index += 1) warnEagerCodexToolCatalog(eager, session(index));
    expect(catalogWarnings()).toHaveLength(capacity);
    // The first session sends again, which must refresh its recency...
    warnEagerCodexToolCatalog(eager, session(0));
    expect(catalogWarnings()).toHaveLength(capacity);
    // ...so filling the bound again evicts the next idlest session, not this one.
    warnEagerCodexToolCatalog(eager, session(capacity));
    warnEagerCodexToolCatalog(eager, session(0));
    expect(catalogWarnings()).toHaveLength(capacity + 1);
  });

  test("a warned session stays resident while it sends only below-threshold traffic", () => {
    const capacity = WARNED_SESSION_LIMIT;
    const session = (index: number) => new Headers({ originator: "codex_cli_rs", session_id: `catalog-lru-small-${index}` });
    const eager = { input: "hello", tools: mcpTools() };
    const small = { input: "hello", tools: mcpTools(false, EAGER_CODEX_MCP_TOOL_WARNING_THRESHOLD - 1) };
    for (let index = 0; index < capacity; index += 1) warnEagerCodexToolCatalog(eager, session(index));
    // Session 0 keeps working with a smaller catalog; that traffic still refreshes its recency...
    warnEagerCodexToolCatalog(small, session(0));
    warnEagerCodexToolCatalog(eager, session(capacity));
    expect(catalogWarnings()).toHaveLength(capacity + 1);
    // ...so the next eager request from it is still deduplicated.
    warnEagerCodexToolCatalog(eager, session(0));
    expect(catalogWarnings()).toHaveLength(capacity + 1);
  });

  test("MCP tools declared inside the reserved functions group are counted under their own names", () => {
    const tools = [{ type: "namespace", name: "functions", tools: Array.from({ length: EAGER_CODEX_MCP_TOOL_WARNING_THRESHOLD }, (_value, index) => ({
      type: "function", name: `mcp__fixture__tool_${index}`, description: "Fixture tool", parameters: { type: "object", properties: {} },
    })) }];
    expect(eagerCodexMcpToolCount({ input: "hello", tools }, headers)).toBe(EAGER_CODEX_MCP_TOOL_WARNING_THRESHOLD);
    // The same tools carried both inside `functions` and as a top-level group count once.
    expect(eagerCodexMcpToolCount({ input: "hello", tools: [...tools, ...mcpTools()] }, headers))
      .toBe(EAGER_CODEX_MCP_TOOL_WARNING_THRESHOLD);
  });

  test("each sessionless logical request is warned, and one request is warned once", () => {
    const eager = { input: "hello", tools: mcpTools() };
    const anonymous = new Headers({ originator: "codex_cli_rs" });
    const first = {};
    const second = {};
    warnEagerCodexToolCatalog(eager, anonymous, { logicalRequest: first });
    // A retry or compaction handoff of the same request shares its scope, so it stays silent.
    warnEagerCodexToolCatalog(eager, anonymous, { logicalRequest: first });
    expect(catalogWarnings()).toHaveLength(1);
    warnEagerCodexToolCatalog(eager, anonymous, { logicalRequest: second });
    expect(catalogWarnings()).toHaveLength(2);
  });

  test("a sessionless caller does not suppress a later anonymous caller's warning", async () => {
    const anonymous = { "x-codex-turn-metadata": "{}" };
    for (const _ of [0, 1]) {
      const result = await send("/v1/responses", mcpTools(), anonymous);
      expect(result.status, result.text).toBe(200);
    }
    expect(upstreamCalls).toBe(2);
    expect(catalogWarnings()).toHaveLength(2);
  });

  test("a deeply nested namespace body neither throws nor counts", () => {
    let tools: unknown[] = mcpTools();
    for (let depth = 0; depth < 25_000; depth += 1) tools = [{ type: "namespace", name: `mcp__nest_${depth % 7}`, tools }];
    const body = { model: "fixture/model", input: "hello", tools };
    expect(() => warnEagerCodexToolCatalog(body, headers)).not.toThrow();
    expect(eagerCodexMcpToolCount(body, headers)).toBe(0);
  });

  test("a namespace nested inside a namespace is not a Codex declaration", () => {
    const body = { input: "hello", tools: [{ type: "namespace", name: "mcp__outer", tools: mcpTools() }] };
    expect(eagerCodexMcpToolCount(body, headers)).toBe(0);
  });
});
