import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResponsesEffects } from "../../src/server/responses/response-effects";
import { prepareResponsesSidecarAuth } from "../../src/server/responses/request-sidecar-auth";
import type { HandleResponsesOptions } from "../../src/server/responses/core-options";
import { createAnthropicAdapter } from "../../src/adapters/anthropic";
import { createTranslatorBudget, releaseTranslatedEvent, retainTranslatedEvent } from "../../src/lib/translator-budget";
import { guardCompactionSummary } from "../../src/responses/compaction-summary";
import { handleResponses } from "../../src/server/responses/core";
import { decodeCompactionSummary } from "../../src/responses/compaction";
import type { AdapterEvent, OcxConfig, OcxParsedRequest } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { drainCompactionResponseState, installCompactionRoutingAclFixture, removeCompactionFixture } from "../helpers/compaction-routing-fixtures";

const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }];
function applyEffects(preserveCompactionPrefix: boolean, hosted = false, toolChoice: unknown = "auto") {
  const parsed = {
    options: { toolChoice, parallelToolCalls: false },
    context: { tools: structuredClone(tools), systemPrompt: ["stable system"], messages: [] },
    _webSearch: { type: "web_search" },
    ...(hosted ? { _anthropicServerTools: [{ type: "web_search_20250305", name: "web_search" }] } : {}),
  } as unknown as OcxParsedRequest;
  type Args = Parameters<typeof createResponsesEffects>;
  createResponsesEffects(
    { options: {}, req: new Request("http://localhost/v1/responses"), config: {} } as Args[0],
    {} as Args[1], { parsed, route: { provider: {} } } as Args[2],
    { routedCompaction: true, preserveCompactionPrefix } as Args[3],
  );
  return parsed;
}

test("Anthropic compaction preserves client tool and system cache prefixes and tool choice", () => {
  const parsed = applyEffects(true);
  expect(parsed.context.tools).toEqual(tools);
  expect(parsed.context.systemPrompt).toEqual(["stable system"]);
  expect(parsed.options.toolChoice).toBe("auto");
  expect(parsed.options.parallelToolCalls).toBe(false);
  expect(parsed._webSearch).toBeUndefined();
  expect(parsed.context.messages.at(-1)?.content).toContain("Do not call tools");
});

test("hosted server declarations stay cacheable but their execution is explicitly prohibited", () => {
  const parsed = applyEffects(true, true);
  expect(parsed._anthropicServerTools).toEqual([{ type: "web_search_20250305", name: "web_search" }]);
  expect(parsed._summaryProhibitsToolCalls).toBe(true);
  expect(parsed._webSearch).toBeUndefined();
});

for (const choice of ["required", { type: "function", name: "read" }]) test(`a mandatory tool choice cannot force the summary into a tool call: ${JSON.stringify(choice)}`, () => {
  const parsed = applyEffects(true, false, choice);
  expect(parsed.context.tools).toEqual(tools);
  expect(parsed._summaryProhibitsToolCalls).toBe(true);
});

test("other adapters retain the existing compaction deletion behavior", () => {
  const parsed = applyEffects(false, true);
  expect(parsed.context.tools).toBeUndefined();
  expect(parsed.options.toolChoice).toBeUndefined();
  expect(parsed.options.parallelToolCalls).toBeUndefined();
  expect(parsed._anthropicServerTools).toBeUndefined();
  expect(parsed._webSearch).toBeUndefined();
});

test("summary preservation follows the resolved adapter rather than the provider label", async () => {
  type Args = Parameters<typeof prepareResponsesSidecarAuth>;
  for (const name of ["anthropic", "openai-chat"]) {
    const budget = createTranslatorBudget();
    try {
      const parsed = { modelId: "fixture", _compactionRequest: true,
        context: { tools, messages: [], systemPrompt: [] }, options: {} } as unknown as OcxParsedRequest;
      const provider = { adapter: name === "anthropic" ? "openai-chat" : "anthropic", baseUrl: "https://fixture.invalid", authMode: "key" };
      const state = await prepareResponsesSidecarAuth({ options: {}, req: new Request("http://localhost/v1/responses"),
        config: { providers: { custom: provider } } } as Args[0],
        { parsed, route: { providerName: "custom", modelId: "fixture", provider }, translatorBudget: budget } as Args[1],
        { adapter: { name }, isPassthrough: false } as Args[2]);
      expect(state.routedCompaction).toBe(true);
      expect(state.preserveCompactionPrefix).toBe(name === "anthropic");
    } finally { budget.dispose(); }
  }
});

test("hosted tools keep the wire prefix with tool_choice none, prohibiting upstream execution", async () => {
  const provider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key" as const, apiKey: "synthetic-test-key" };
  const adapter = withTestTranslatorBudget(createAnthropicAdapter(provider, "short"));
  const parsed = applyEffects(true, true);
  parsed.modelId = "claude-sonnet-4-6";
  parsed.context.messages.unshift({ role: "user", content: "earlier turn", timestamp: 1 });
  const ordinary = structuredClone(parsed);
  ordinary.options.toolChoice = "auto";
  const before = JSON.parse((await adapter.buildRequest(ordinary)).body as string);
  const after = JSON.parse((await adapter.buildRequest(parsed)).body as string);
  expect(after.tools).toEqual(before.tools);
  expect(after.system).toEqual(before.system);
  expect(after.tools).toContainEqual(expect.objectContaining({ type: "web_search_20250305", name: "web_search" }));
  expect(after.tool_choice).toEqual({ type: "none" });
});

for (const [label, modelId, choice] of [
  ["required allowed tools", "claude-sonnet-4-6", { allowedTools: ["read"], mode: "required" }],
  ["named tool on a model that rejects forced choice", "claude-opus-5-5", { type: "function", name: "read" }],
] as const) test(`a narrowed catalog keeps the same tools and system after prohibiting calls: ${label}`, async () => {
  const provider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key" as const, apiKey: "synthetic-test-key" };
  const adapter = withTestTranslatorBudget(createAnthropicAdapter(provider, "short"));
  const catalog = [...tools, { name: "write", description: "Write a file", parameters: { type: "object", properties: {} } }];
  const ordinary = { modelId, options: { toolChoice: structuredClone(choice), parallelToolCalls: false },
    context: { tools: structuredClone(catalog), systemPrompt: ["stable system"],
      messages: [{ role: "user", content: "earlier turn", timestamp: 1 }] } } as unknown as OcxParsedRequest;
  const summary = structuredClone(ordinary);
  type Args = Parameters<typeof createResponsesEffects>;
  createResponsesEffects(
    { options: {}, req: new Request("http://localhost/v1/responses"), config: {} } as Args[0],
    {} as Args[1], { parsed: summary, route: { provider: {} } } as Args[2],
    { routedCompaction: true, preserveCompactionPrefix: true } as Args[3],
  );
  expect(summary._summaryProhibitsToolCalls).toBe(true);
  const before = JSON.parse((await adapter.buildRequest(ordinary)).body as string);
  const after = JSON.parse((await adapter.buildRequest(summary)).body as string);
  expect(before.tools.map((tool: { name: string }) => tool.name)).toEqual(["read"]);
  expect(after.tools).toEqual(before.tools);
  expect(after.system).toEqual(before.system);
});

for (const [label, modelId, functions, choice] of [
  ["an excluded same-named function still suppresses the hosted tool", "claude-sonnet-4-6", ["read", "web_search"], { allowedTools: ["read"], mode: "auto" }],
  ["a forced-choice downgrade still drops the hosted tool", "claude-opus-5-5", ["read", "write"], { type: "function", name: "read" }],
] as const) test(`hosted declarations keep the ordinary tool prefix: ${label}`, async () => {
  const provider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key" as const, apiKey: "synthetic-test-key" };
  const adapter = withTestTranslatorBudget(createAnthropicAdapter(provider, "short"));
  const ordinary = { modelId, options: { toolChoice: structuredClone(choice), parallelToolCalls: false },
    _anthropicServerTools: [{ type: "web_search_20250305", name: "web_search" }],
    context: { tools: functions.map(name => ({ name, description: name, parameters: { type: "object", properties: {} } })),
      systemPrompt: ["stable system"], messages: [{ role: "user", content: "earlier turn", timestamp: 1 }] } } as unknown as OcxParsedRequest;
  const summary = structuredClone(ordinary);
  type Args = Parameters<typeof createResponsesEffects>;
  createResponsesEffects(
    { options: {}, req: new Request("http://localhost/v1/responses"), config: {} } as Args[0],
    {} as Args[1], { parsed: summary, route: { provider: {} } } as Args[2],
    { routedCompaction: true, preserveCompactionPrefix: true } as Args[3],
  );
  expect(summary._summaryProhibitsToolCalls).toBe(true);
  const before = JSON.parse((await adapter.buildRequest(ordinary)).body as string);
  const after = JSON.parse((await adapter.buildRequest(summary)).body as string);
  expect(before.tools.map((tool: { name: string }) => tool.name)).toEqual(["read"]);
  expect(after.tools).toEqual(before.tools);
  expect(after.system).toEqual(before.system);
  expect(after.tool_choice).toEqual({ type: "none" });
});

for (const [label, auth, escape, hosted] of [
  ["OAuth renames a hosted web_fetch selector", "oauth", false, { type: "web_fetch_20250910", name: "web_fetch" }],
  ["escaped built-in names rename a hosted web_search selector", "key", true, { type: "web_search_20250305", name: "web_search" }],
] as const) test(`provider wire-name transforms keep the ordinary tool prefix: ${label}`, async () => {
  const provider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: auth, apiKey: "synthetic-test-key",
    ...(auth === "oauth" ? { oauthToken: "synthetic-oauth-token" } : {}), ...(escape ? { escapeBuiltinToolNames: true } : {}) };
  const adapter = withTestTranslatorBudget(createAnthropicAdapter(provider as never, "short"));
  const ordinary = { modelId: "claude-opus-5-5", options: { toolChoice: { type: "function", name: hosted.name }, parallelToolCalls: false },
    _anthropicServerTools: [hosted],
    context: { tools: structuredClone(tools), systemPrompt: ["stable system"], messages: [{ role: "user", content: "earlier turn", timestamp: 1 }] } } as unknown as OcxParsedRequest;
  const summary = structuredClone(ordinary);
  type Args = Parameters<typeof createResponsesEffects>;
  createResponsesEffects(
    { options: {}, req: new Request("http://localhost/v1/responses"), config: {} } as Args[0],
    {} as Args[1], { parsed: summary, route: { provider: {} } } as Args[2],
    { routedCompaction: true, preserveCompactionPrefix: true } as Args[3],
  );
  const before = JSON.parse((await adapter.buildRequest(ordinary)).body as string);
  const after = JSON.parse((await adapter.buildRequest(summary)).body as string);
  expect(after.tools).toEqual(before.tools);
  expect(after.system).toEqual(before.system);
  expect(after.tool_choice).toEqual({ type: "none" });
});

for (const kind of ["text", "tool", "search", "empty", "progress", "abnormal", "eof", "truncated", "error", "incomplete"] as const) {
  test(`summary guard validates completion and releases discarded event leases: ${kind}`, async () => {
    const budget = createTranslatorBudget();
    budget.chargeRetained(17, { kind: "retained_collectors" });
    const input: AdapterEvent[] = [];
    if (kind === "tool") input.push({ type: "tool_call_start", id: "call-summary", name: "read" },
      { type: "tool_call_delta", arguments: "{}" }, { type: "tool_call_end" });
    if (kind === "search") input.push({ type: "web_search_call_begin", id: "srvtoolu-summary" },
      { type: "web_search_call_end", id: "srvtoolu-summary", queries: ["synthetic"] });
    if (kind !== "empty") input.push({ type: "text_delta", text: "summary",
      ...(kind === "progress" ? { anthropicThinkingSignature: "synthetic-signature", phase: "commentary" as const } : {}) });
    input.push(kind === "error" ? { type: "error", message: "upstream refused" }
      : kind === "incomplete" ? { type: "incomplete", reason: "content_filter", retryable: false }
      : { type: "done", stopReason: kind === "eof" ? undefined : kind === "abnormal" ? "unexpected_stop" : kind === "truncated" ? "max_tokens" : "end_turn", endTurn: true });
    try {
      const output: AdapterEvent[] = [];
      async function* source() {
        for (const event of input) { retainTranslatedEvent(event, budget); yield event; }
      }
      for await (const event of guardCompactionSummary(source(), budget)) {
        output.push(event);
        releaseTranslatedEvent(event, budget);
      }
      expect(output.some(event => event.type.startsWith("tool_call") || event.type.startsWith("web_search_call"))).toBe(false);
      if (["text", "eof", "truncated", "error", "incomplete"].includes(kind)) expect(output.at(-1)?.type).toBe(input.at(-1)?.type);
      else expect(output.at(-1)).toMatchObject({ type: "error", code: "compaction_invalid_summary", retryable: false });
      if (kind === "progress") expect(output.some(event => event.type === "text_delta")).toBe(false);
      expect(budget.snapshot().currentBytes).toBe(17);
    } finally { budget.dispose(); }
  });
}

describe("Anthropic compaction through Responses delivery", () => {
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.OPENCODEX_HOME;
  let home: string;
  let releaseSpendHome: () => void;
  installCompactionRoutingAclFixture();
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-compaction-prefix-"));
    process.env.OPENCODEX_HOME = home;
    releaseSpendHome = acquireOwnedSpendHome();
  });
  afterEach(async () => {
    await drainCompactionResponseState();
    releaseSpendHome();
    await removeCompactionFixture(home);
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalHome;
  });

  function config(adapter = "anthropic", modelAdapter?: string): OcxConfig {
    return { defaultProvider: "custom", cacheRetention: "short", providers: {
      custom: { adapter, baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: "synthetic-test-key",
        ...(modelAdapter ? { modelAdapters: { "claude-sonnet-4-6": modelAdapter } } : {}),
      },
    } } as OcxConfig;
  }
  function body(stream: boolean, compact = true) {
    return { model: "custom/claude-sonnet-4-6", stream, store: false, instructions: "stable system",
      tools: [{ type: "function", ...tools[0] }], tool_choice: "auto", parallel_tool_calls: false,
      input: [{ type: "message", role: "user", content: "earlier turn" }, ...(compact ? [{ type: "compaction_trigger" }] : [])],
    };
  }
  async function send(input: ReturnType<typeof body>, cfg = config(), options: HandleResponsesOptions = {}) {
    return handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    }), cfg, { model: "", provider: "" }, options);
  }
  function upstream(stream: boolean, tool = false): Response {
    if (!stream) return Response.json({ id: "msg-summary", type: "message", role: "assistant", model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "handoff summary" }, ...(tool ? [{ type: "tool_use", id: "call-summary", name: "read", input: {} }] : [])],
      stop_reason: tool ? "tool_use" : "end_turn", usage: { input_tokens: 10, output_tokens: 5 },
    });
    const events = [
      { type: "message_start", message: { id: "msg-summary", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "handoff summary" } },
      { type: "content_block_stop", index: 0 },
      ...(tool ? [
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call-summary", name: "read", input: {} } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
        { type: "content_block_stop", index: 1 },
      ] : []),
      { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  }

  for (const stream of [false, true]) {
    test(`ordinary and summary requests keep identical tools/system/options (stream=${stream})`, async () => {
      const seen: Record<string, unknown>[] = [];
      globalThis.fetch = (async (_input, init) => {
        seen.push(JSON.parse(String(init?.body)));
        return upstream(stream);
      }) as typeof fetch;
      await (await send(body(stream, false))).text();
      const response = await send(body(stream));
      const text = await response.text();
      expect(seen).toHaveLength(2);
      for (const key of ["tools", "system", "tool_choice"]) {
        expect(seen[1]?.[key]).toEqual(seen[0]?.[key]);
        expect(seen[1]?.[key]).toBeDefined();
      }
      const json = stream
        ? JSON.parse(text.split("\n").find(line => line.startsWith("data: ") && line.includes('"type":"response.completed"'))!.slice(6)).response
        : JSON.parse(text);
      expect(json.status).toBe("completed");
      expect(json.output).toHaveLength(1);
      expect(json.output[0].type).toBe("compaction");
      expect(decodeCompactionSummary(json.output[0].encrypted_content)).toBe("handoff summary");
    });

    test(`summary client tool output is rejected before publication or execution (stream=${stream})`, async () => {
      let sends = 0;
      globalThis.fetch = (async () => { sends++; return upstream(stream, true); }) as typeof fetch;
      const response = await send(body(stream));
      const text = await response.text();
      expect(sends).toBe(1);
      expect(text).not.toContain('"type":"function_call"');
      expect(text).not.toContain('"type":"compaction"');
      expect(text).toContain("compaction_invalid_summary");
      if (stream) expect(text).toContain('"type":"response.failed"');
      else expect(JSON.parse(text).status).toBe("failed");
    });
  }

  test("hosted search is prohibited upstream and the configured search sidecar never executes", async () => {
    const cfg = config();
    cfg.webSearchSidecar = { backend: "exa", exaApiKey: "synthetic-search-key" };
    let primarySends = 0;
    let hostedExecutions = 0;
    let sidecarSends = 0;
    globalThis.fetch = (async (input, init) => {
      if (!String(input).startsWith("https://api.anthropic.com/")) {
        sidecarSends++;
        throw new Error("Summary must not dispatch a search sidecar");
      }
      primarySends++;
      const wire = JSON.parse(String(init?.body));
      expect(wire.tools).toContainEqual(expect.objectContaining({ type: "web_search_20250305", name: "web_search" }));
      if (wire.tool_choice?.type !== "none") hostedExecutions++;
      return upstream(false);
    }) as typeof fetch;
    const request = { ...body(false), tools: [...body(false).tools, { type: "web_search", name: "web_search", description: "Search", parameters: {} }] };
    const response = await send(request, cfg, { inboundWire: "anthropic",
      anthropicServerTools: [{ type: "web_search_20250305", name: "web_search" }] });
    const result = await response.json();
    expect(result).toMatchObject({ status: "completed" });
    expect(result.output).toHaveLength(1);
    expect(result.output[0].type).toBe("compaction");
    expect(primarySends).toBe(1);
    expect(hostedExecutions).toBe(0);
    expect(sidecarSends).toBe(0);
  });

  test("an Anthropic provider resolved onto Chat still deletes the compaction tool catalog", async () => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_input, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { role: "assistant", content: "handoff summary" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 } });
    }) as typeof fetch;
    const response = await send(body(false), config("anthropic", "openai-chat"));
    expect((await response.json()).output).toHaveLength(1);
    expect(sent.tools).toBeUndefined();
    expect(sent.tool_choice).toBeUndefined();
    expect(sent.parallel_tool_calls).toBeUndefined();
  });
});
