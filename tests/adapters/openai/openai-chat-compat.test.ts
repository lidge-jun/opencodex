import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "../../../src/adapters/openai-responses";
import { PROVIDER_REGISTRY } from "../../../src/providers/registry";
import { routeModel } from "../../../src/router";
import { buildNonOpenAIToolCatalogNudgeForTools } from "../../../src/adapters/tool-catalog-nudge";
import type { OcxParsedRequest, OcxProviderConfig, OcxTool } from "../../../src/types";

const KIMI_PROVIDER: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://api.kimi.com/coding/v1",
  apiKey: "sk-test",
  authMode: "key",
};

const k3Tools: OcxTool[] = [
  {
    name: "exec",
    description: "Run JavaScript in a V8 isolate. declare const tools: { apply_patch(input: string): Promise<unknown> };",
    freeform: true,
  },
  {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "web_search",
    description: "Search the web",
    namespace: "hosted",
    parameters: { type: "object", properties: { query: { type: "string" } } },
  },
];

function k3Parsed(overrides: Partial<OcxParsedRequest["options"]> = {}, tools: OcxTool[] = k3Tools): OcxParsedRequest {
  return {
    modelId: "k3",
    context: {
      systemPrompt: ["You are Codex, a coding agent."],
      messages: [{ role: "user", content: "fix the bug", timestamp: 0 }],
      tools,
    },
    stream: true,
    options: { ...overrides },
  };
}

function systemMessages(body: Record<string, unknown>): string[] {
  return (body.messages as { role: string; content?: unknown }[])
    .filter(m => m.role === "system")
    .map(m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
}

describe("K3 Codex compatibility benchmark (Phase 1)", () => {
  describe("catalog/instruction surface", () => {
    test("registry kimi provider opts into parallel tool calls", () => {
      const kimi = PROVIDER_REGISTRY.find(p => p.id === "kimi");
      expect(kimi).toBeDefined();
      expect(kimi!.parallelToolCalls).toBe(true);
    });

    test("stale persisted kimi config inherits registry parallelToolCalls:true", () => {
      const config = {
        port: 10100,
        defaultProvider: "kimi",
        providers: {
          kimi: {
            adapter: "openai-chat" as const,
            baseUrl: "https://api.kimi.com/coding/v1",
            apiKey: "k",
            defaultModel: "k3",
            models: ["k3"],
          },
        },
      };
      const route = routeModel(config, "kimi/k3");
      expect(route.provider.parallelToolCalls).toBe(true);
    });

    test("K3 request appends the compatibility appendix after original instructions", () => {
      const body = JSON.parse(createOpenAIChatAdapter(KIMI_PROVIDER).buildRequest(k3Parsed()).body) as Record<string, unknown>;
      const systems = systemMessages(body);
      expect(systems.length).toBe(1);
      const sys = systems[0];
      // Original Codex instructions are preserved verbatim at the head.
      expect(sys.startsWith("You are Codex, a coding agent.")).toBe(true);
      // The shared tool-catalog nudge stays present.
      expect(sys).toContain("Tool contract: use the current tool catalog as ground truth.");
      // The K3 appendix is appended last.
      expect(sys).toContain("Kimi K3 compatibility notes");
      expect(sys.indexOf("Kimi K3 compatibility notes")).toBeGreaterThan(sys.indexOf("Tool contract:"));
      // Freeform lowering guidance is present.
      expect(sys).toContain("single argument is a string field named input");
      // Neighbor-agent tools are not advertised for this turn.
      expect(sys).toContain("Do not use neighboring-agent tool names");
    });

    test("non-K3 kimi model (k2.7-code) does NOT get the K3 appendix", () => {
      const parsed = { ...k3Parsed({}, []), modelId: "kimi-k2.7-code" };
      const body = JSON.parse(createOpenAIChatAdapter(KIMI_PROVIDER).buildRequest(parsed).body) as Record<string, unknown>;
      expect(JSON.stringify(body)).not.toContain("Kimi K3 compatibility notes");
    });

    test("freeform input-schema reaches the wire as a single-string function", () => {
      // pushCustom in src/responses/parser-tools.ts lowers freeform tools to a
      // single-string input BEFORE the adapter sees them; the wire shape below is
      // what K3 actually receives for code-mode exec.
      const execAsParsed: OcxTool = {
        name: "exec",
        description: "Run JavaScript in a V8 isolate.",
        parameters: {
          type: "object",
          properties: { input: { type: "string", description: "Raw freeform input for this tool." } },
          required: ["input"],
        },
        freeform: true,
      };
      const body = JSON.parse(
        createOpenAIChatAdapter(KIMI_PROVIDER).buildRequest(k3Parsed({}, [execAsParsed])).body,
      ) as Record<string, unknown>;
      const tools = body.tools as { type: string; function: { name: string; parameters: { properties?: Record<string, unknown> } } }[];
      const execTool = tools.find(t => t.function.name === "exec");
      expect(execTool).toBeDefined();
      expect(execTool!.type).toBe("function");
      expect(Object.keys(execTool!.function.parameters.properties ?? {})).toEqual(["input"]);
    });

    test("non-kimi host does NOT get the K3 appendix", () => {
      const other: OcxProviderConfig = { ...KIMI_PROVIDER, baseUrl: "https://api.moonshot.ai/v1" };
      const body = JSON.parse(createOpenAIChatAdapter(other).buildRequest(k3Parsed()).body) as Record<string, unknown>;
      expect(JSON.stringify(body)).not.toContain("Kimi K3 compatibility notes");
    });

    test("k3[1m] selector also receives the appendix (bracket strip)", () => {
      const parsed = { ...k3Parsed(), modelId: "k3[1m]" };
      const body = JSON.parse(createOpenAIChatAdapter({ ...KIMI_PROVIDER, modelSuffixBracketStrip: true }).buildRequest(parsed).body) as Record<string, unknown>;
      expect(JSON.stringify(body)).toContain("Kimi K3 compatibility notes");
      // Wire model is stripped to k3.
      expect(body.model).toBe("k3");
    });

    test("appendix token budget stays within 800 tokens (~600 words)", () => {
      const body = JSON.parse(createOpenAIChatAdapter(KIMI_PROVIDER).buildRequest(k3Parsed()).body) as Record<string, unknown>;
      const sys = systemMessages(body)[0];
      const appendix = sys.slice(sys.indexOf("Kimi K3 compatibility notes"));
      const words = appendix.split(/\s+/).length;
      expect(words).toBeGreaterThan(100);
      expect(words).toBeLessThan(800);
    });
  });

  describe("tool wire shape", () => {
    test("hosted web_search is dropped from wire tools (sidecar re-injects)", () => {
      const body = JSON.parse(createOpenAIChatAdapter(KIMI_PROVIDER).buildRequest(k3Parsed()).body) as Record<string, unknown>;
      const tools = body.tools as { function: { name: string } }[];
      expect(tools.some(t => t.function.name === "web_search")).toBe(false);
    });

    test("k3 with tools sends parallel_tool_calls:true (registry opt-in)", () => {
      const provider: OcxProviderConfig = { ...KIMI_PROVIDER, parallelToolCalls: true };
      const body = JSON.parse(createOpenAIChatAdapter(provider).buildRequest(k3Parsed()).body) as Record<string, unknown>;
      expect(body.parallel_tool_calls).toBe(true);
    });

    test("k3 honors request-level parallel_tool_calls:false", () => {
      const provider: OcxProviderConfig = { ...KIMI_PROVIDER, parallelToolCalls: true };
      const body = JSON.parse(createOpenAIChatAdapter(provider).buildRequest(k3Parsed({ parallelToolCalls: false })).body) as Record<string, unknown>;
      expect(body.parallel_tool_calls).toBe(false);
    });
  });

  describe("image input", () => {
    test("input image becomes image_url part on the user message", () => {
      const parsed: OcxParsedRequest = {
        modelId: "k3",
        context: {
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image", imageUrl: "data:image/png;base64,AAAA", detail: "high" },
            ],
            timestamp: 0,
          }],
        },
        stream: true,
        options: {},
      };
      const body = JSON.parse(createOpenAIChatAdapter(KIMI_PROVIDER).buildRequest(parsed).body) as Record<string, unknown>;
      const userMsg = (body.messages as { role: string; content: unknown }[]).find(m => m.role === "user");
      const parts = userMsg!.content as { type: string; image_url?: { url: string; detail?: string } }[];
      const img = parts.find(p => p.type === "image_url");
      expect(img).toBeDefined();
      expect(img!.image_url!.url).toContain("data:image/png;base64");
      expect(img!.image_url!.detail).toBe("high");
    });
  });

  describe("multi-turn tool loop", () => {
    test("tool result returns as role:tool; premature-termination guidance stays in system", () => {
      const parsed: OcxParsedRequest = {
        modelId: "k3",
        context: {
          systemPrompt: ["You are Codex."],
          messages: [
            { role: "user", content: "run tests", timestamp: 0 },
            {
              role: "assistant",
              content: [{
                type: "toolCall",
                id: "call_1",
                name: "exec",
                arguments: { input: "1+1" },
              }],
              timestamp: 1,
            },
            { role: "toolResult", toolCallId: "call_1", toolName: "exec", content: "2", isError: false, timestamp: 2 },
          ],
          tools: k3Tools,
        },
        stream: true,
        options: {},
      };
      const body = JSON.parse(createOpenAIChatAdapter(KIMI_PROVIDER).buildRequest(parsed).body) as Record<string, unknown>;
      const msgs = body.messages as { role: string; tool_call_id?: string; content?: unknown }[];
      const toolMsg = msgs.find(m => m.role === "tool");
      expect(toolMsg).toBeDefined();
      // The wire id is minted to a canonical form when the echoed id is not already
      // in the chat wire namespace; the result stays bound to its call through the
      // minted id (existing openai-chat behavior, not K3-specific).
      expect(typeof toolMsg!.tool_call_id).toBe("string");
      expect(toolMsg!.content).toBe("2");
      // The appendix's keep-going-after-tool-result rule is visible to the model.
      const sys = systemMessages(body)[0];
      expect(sys).toContain("A tool result is new information to act on, not the end of the task");
    });
  });

  describe("benchmark guard: nudge + appendix are complementary, not duplicated", () => {
    test("tool catalog nudge alone does not teach freeform input shape", () => {
      const nudge = buildNonOpenAIToolCatalogNudgeForTools(k3Tools);
      expect(nudge).toBeDefined();
      expect(nudge!).not.toContain("single argument is a string field named input");
    });
  });
});
  describe("Moonshot Responses API endpoint (China .cn)", () => {
    const MOONSHOT_CN_PROVIDER: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "sk-moonshot-test",
      authMode: "key",
      statelessResponses: true,
      preserveResponsesReasoningContent: true,
    };

    test("routes to https://api.moonshot.cn/v1/responses with Bearer token", () => {
      const adapter = createResponsesPassthroughAdapter(MOONSHOT_CN_PROVIDER);
      const req = adapter.buildRequest({
        modelId: "kimi-k3",
        context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
        stream: true,
        options: {},
        _rawBody: {
          model: "kimi-k3",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
          previous_response_id: "resp_stale_123",
        },
      }, { translatorBudget: { observeExternallyCapped: () => () => {} } as never });

      expect(req.url).toBe("https://api.moonshot.cn/v1/responses");
      expect(req.headers["Authorization"]).toBe("Bearer sk-moonshot-test");
      expect(req.headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(req.body) as Record<string, unknown>;
      expect(body.model).toBe("kimi-k3");
      // statelessResponses drops previous_response_id and pins store: false
      expect(body.previous_response_id).toBeUndefined();
      expect(body.store).toBe(false);
    });

    test("registry moonshot provider uses openai-responses and has China .cn choice", () => {
      const entry = PROVIDER_REGISTRY.find(p => p.id === "moonshot");
      expect(entry).toBeDefined();
      expect(entry!.adapter).toBe("openai-responses");
      expect(entry!.statelessResponses).toBe(true);
      expect(entry!.baseUrlChoices?.find(c => c.id === "china")?.baseUrl).toBe("https://api.moonshot.cn/v1");
      expect(entry!.models).toContain("kimi-k3");
    });
  });
