import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { applyChatToolDispatch, CHAT_TOOL_DISPATCH_NAME } from "../../src/claude/chat-tool-dispatch";
import { anthropicToResponsesTranslation } from "../../src/claude/inbound";
import { parseRequest } from "../../src/responses/parser";
import type { ProviderAdapter } from "../../src/adapters/base";
import { configSchema } from "../../src/config/schema/config-schema";
import { salvageConfigCandidate } from "../../src/config/salvage";
import { rewriteProviderReferences } from "../../src/providers/provider-id-rewrite";
import { noteSubagentModelFailure, resetSubagentModelFallbackStateForTests } from "../../src/codex/subagent-model-fallback";
import type { AdapterEvent, OcxConfig, OcxParsedRequest } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

// Routing boundaries of claudeCode.chatToolDispatchModels: the projection applies only on the
// physical direct openai-chat adapter that the selector names, and is byte-identical when off.
const chatProvider = { adapter: "openai-chat", baseUrl: "https://chat.example.com/v1", apiKey: "synthetic-fixture", models: ["test-model"] };
const responsesProvider = { ...chatProvider, adapter: "openai-responses", baseUrl: "https://responses.example.com/v1" };
const tool = (name: string, deferred = false) => ({
  name, description: `${name} tool`, input_schema: { type: "object", properties: { q: { type: "string" } } },
  ...(deferred ? { defer_loading: true } : {}),
});
const loadedRequest = (model: string, extra: Record<string, unknown> = {}) => ({
  model, metadata: { user_id: "synthetic-cache-test" }, system: "Synthetic test instructions", max_tokens: 100,
  tools: [tool("ToolSearch"), tool("Bash"), tool("WebFetch", true)],
  messages: [
    { role: "user", content: "Use the available tools." },
    { role: "assistant", content: [{ type: "tool_use", id: "call_search", name: "ToolSearch", input: { query: "WebFetch" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_search", content: [{ type: "tool_reference", tool_name: "WebFetch" }] }] },
  ],
  ...extra,
});
const chatSse = (text = "ok") => `data: ${JSON.stringify({ id: "chat_route", object: "chat.completion.chunk", model: "test-model",
  choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
const responsesJson = () => Response.json({ id: "resp_route", object: "response", status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
  usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } });
const toolNames = (body: any): string[] => body.tools.map((t: any) => t.function?.name ?? t.name);

async function send(config: unknown, raw: unknown, headers: Record<string, string> = {}, log = { model: "", provider: "" }) {
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(raw),
  }), config as OcxConfig, log);
  return { status: response.status, text: await response.text() };
}

const originalFetch = globalThis.fetch;
let home: TempHome;
let release: () => void;
beforeEach(() => {
  home = createTempHome("ocx-chat-dispatch-routes-");
  release = acquireOwnedSpendHome();
  resetSubagentModelFallbackStateForTests();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  release();
  home.remove();
});

describe("chatToolDispatchModels configuration", () => {
  test("invalid selectors are rejected and salvage drops only that key", () => {
    const base = { defaultProvider: "chatgw", providers: { chatgw: chatProvider } };
    for (const value of [true, "chatgw/test-model", [1], ["*"], ["chatgw/te*st"], [" chatgw/test-model"]]) {
      expect(configSchema.safeParse({ ...base, claudeCode: { chatToolDispatchModels: value } }).success).toBe(false);
    }
    for (const value of [undefined, [], ["chatgw/test-model"], ["chatgw/test-*"]]) {
      expect(configSchema.safeParse({ ...base, claudeCode: { chatToolDispatchModels: value } }).success).toBe(true);
    }
    const config = { ...base, claudeCode: { enabled: true, chatToolDispatchModels: [false] } };
    const result = configSchema.safeParse(config);
    if (result.success) throw new Error("Expected malformed configuration rejection");
    const salvaged = salvageConfigCandidate(config, result.error, config);
    expect(salvaged?.parsed.claudeCode).toEqual({ enabled: true });
    expect(salvaged?.dropped).toEqual(["claudeCode.chatToolDispatchModels"]);
  });

  test("provider rename carries exact and wildcard selectors without widening them", () => {
    const config: OcxConfig = { port: 0, defaultProvider: "other", providers: {}, claudeCode: {
      chatToolDispatchModels: ["old/m-one", "old/m-*", "older/m-*", "other/m-one"],
    } };
    expect(rewriteProviderReferences(config, "old", "new").changed).toBe(2);
    expect(config.claudeCode!.chatToolDispatchModels).toEqual(["new/m-one", "new/m-*", "older/m-*", "other/m-one"]);
  });
});

describe("chatToolDispatchModels routing boundaries", () => {
  test("off, empty and unlisted configurations send byte-identical upstream requests", async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(chatSse(), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const raw = loadedRequest("chatgw/test-model", { stream: true });
    for (const claudeCode of [undefined, {}, { chatToolDispatchModels: [] }, { chatToolDispatchModels: ["chatgw/other-model"] }]) {
      const config = { defaultProvider: "chatgw", providers: { chatgw: chatProvider }, ...(claudeCode ? { claudeCode } : {}) };
      expect((await send(config, raw)).status).toBe(200);
    }
    expect(bodies).toHaveLength(4);
    for (const body of bodies) expect(body).toBe(bodies[0]);
    expect(toolNames(JSON.parse(bodies[0]))).toEqual(["ToolSearch", "Bash", "WebFetch"]);
  });

  test("a selector on a Responses route never applies the Chat dispatcher", async () => {
    const captured: any[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)));
      return responsesJson();
    }) as typeof fetch;
    const config = { defaultProvider: "respgw", providers: { respgw: responsesProvider },
      claudeCode: { chatToolDispatchModels: ["respgw/test-model"] } };
    expect((await send(config, loadedRequest("respgw/test-model", { stream: false }))).status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(toolNames(captured[0])).toEqual(["ToolSearch", "Bash", "WebFetch"]);
  });

  test("a selected combo route keeps the original catalog even when its target is opted-in Chat", async () => {
    const captured: any[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)));
      return new Response(chatSse(), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const config = { defaultProvider: "chatgw", providers: { chatgw: chatProvider },
      combos: { pick: { strategy: "failover", targets: [{ provider: "chatgw", model: "test-model" }] } },
      claudeCode: { chatToolDispatchModels: ["combo/pick", "chatgw/test-model"] } };
    expect((await send(config, loadedRequest("combo/pick", { stream: true }))).status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(toolNames(captured[0])).toEqual(["ToolSearch", "Bash", "WebFetch"]);
  });

  for (const [primary, fallback, expectDispatch] of [
    [chatProvider, responsesProvider, false],
    [responsesProvider, chatProvider, true],
  ] as const) {
    test(`late fallback from ${primary.adapter} to ${fallback.adapter} follows only the physical adapter`, async () => {
      const captured: Array<{ url: string; body: any }> = [];
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        captured.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return fallback.adapter === "openai-chat"
          ? new Response(chatSse(), { headers: { "content-type": "text/event-stream" } })
          : responsesJson();
      }) as typeof fetch;
      const config = {
        defaultProvider: "primary", providers: {
          primary: { ...primary, baseUrl: "https://primary.example/v1" },
          fallback: { ...fallback, baseUrl: "https://fallback.example/v1" },
        }, subagentModelFallback: ["fallback/test-model"],
        claudeCode: { chatToolDispatchModels: ["primary/test-model", "fallback/test-model"] },
      };
      noteSubagentModelFailure("primary/test-model", "429", config as unknown as OcxConfig);
      const log = { model: "", provider: "" };
      const result = await send(config, loadedRequest("primary/test-model", { stream: true }), { "x-openai-subagent": "collab_spawn" }, log);
      expect(result.status).toBe(200);
      expect(log).toMatchObject({ subagentModelFallbackTo: "fallback/test-model" });
      expect(captured).toHaveLength(1);
      expect(captured[0].url.startsWith("https://fallback.example/v1")).toBe(true);
      expect(toolNames(captured[0].body)).toEqual(expectDispatch
        ? ["ToolSearch", "Bash", CHAT_TOOL_DISPATCH_NAME]
        : ["ToolSearch", "Bash", "WebFetch"]);
    });
  }

  test("a non-streaming client response carries the client tool, never the dispatcher", async () => {
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "chat_json", object: "chat.completion.chunk", model: "test-model",
        choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    globalThis.fetch = (async () => new Response(
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_json", type: "function", function: { name: CHAT_TOOL_DISPATCH_NAME, arguments: "" } }] })
        + chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ name: "WebFetch", arguments: { q: "https://x" } }) } }] })
        + chunk({}, "tool_calls") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
    const config = { defaultProvider: "chatgw", providers: { chatgw: chatProvider },
      claudeCode: { chatToolDispatchModels: ["chatgw/test-model"] } };
    const result = await send(config, loadedRequest("chatgw/test-model", { stream: false }));
    expect(result.status).toBe(200);
    const toolUse = JSON.parse(result.text).content.find((block: any) => block.type === "tool_use");
    expect(toolUse).toMatchObject({ id: "call_json", name: "WebFetch", input: { q: "https://x" } });
    expect(result.text).not.toContain(CHAT_TOOL_DISPATCH_NAME);
  });
});

describe("applyChatToolDispatch adapter wrapping", () => {
  const event = (name: string, args: string): AdapterEvent[] => [
    { type: "tool_call_start", id: "call_x", name }, { type: "tool_call_delta", arguments: args }, { type: "tool_call_end" },
  ];
  const dispatched = event(CHAT_TOOL_DISPATCH_NAME, JSON.stringify({ name: "WebFetch", arguments: { q: "u" } }));
  const stubAdapter = () => {
    const built: OcxParsedRequest[] = [];
    const adapter = {
      name: "stub",
      buildRequest: (parsed: OcxParsedRequest) => { built.push(parsed); return { url: "https://chat.example.com/v1/chat/completions", headers: {}, body: "{}" }; },
      async *parseStream() { yield* dispatched; },
      parseResponse: async () => [...dispatched],
    } as unknown as ProviderAdapter;
    return { adapter, built };
  };
  const parsedOf = (raw: Record<string, unknown>) => parseRequest(anthropicToResponsesTranslation(raw, {}).body as any);

  test("both parse paths are rewritten after a projected build", async () => {
    const raw = loadedRequest("chatgw/test-model");
    const { adapter, built } = stubAdapter();
    applyChatToolDispatch(adapter, raw);
    await adapter.buildRequest(parsedOf(raw), { headers: new Headers() } as any);
    expect(built[0].context.tools!.map(t => t.name)).toEqual(["ToolSearch", "Bash", CHAT_TOOL_DISPATCH_NAME]);
    const streamed: AdapterEvent[] = [];
    for await (const e of adapter.parseStream(new Response(""), {} as any)) streamed.push(e);
    const listed = await adapter.parseResponse!(new Response(""), {} as any);
    for (const out of [streamed, listed]) expect(out).toEqual(event("WebFetch", '{"q":"u"}'));
  });

  test("a build that bails out sends the request unchanged and leaves responses untouched", async () => {
    const raw = { ...loadedRequest("chatgw/test-model"), tool_choice: { type: "tool", name: "WebFetch" } };
    const { adapter, built } = stubAdapter();
    applyChatToolDispatch(adapter, raw);
    const parsed = parsedOf(raw);
    await adapter.buildRequest(parsed, { headers: new Headers() } as any);
    expect(built[0]).toBe(parsed);
    expect(await adapter.parseResponse!(new Response(""), {} as any)).toEqual(dispatched);
  });
});
