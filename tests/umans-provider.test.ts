import { afterEach, describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { providerConfigFromKeyLoginProvider } from "../src/oauth/login-cli";
import { enrichProviderFromCatalog, KEY_LOGIN_PROVIDERS, validateApiKey } from "../src/oauth/key-providers";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";

function umansProvider(apiKey = "sk-umans"): OcxProviderConfig {
  return {
    adapter: "anthropic",
    baseUrl: "https://api.code.umans.ai",
    apiKey,
    defaultModel: "umans-coder",
    escapeBuiltinToolNames: true,
  };
}

function parsedWithWebSearchTool(): OcxParsedRequest {
  return {
    modelId: "umans-coder",
    context: {
      messages: [{ role: "user", content: "search docs", timestamp: 0 }],
      tools: [{
        name: "web_search",
        description: "Search the web",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      }],
    },
    stream: true,
    options: { toolChoice: { name: "web_search" } },
  };
}

async function collect(events: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("Umans provider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("catalog enrichment preserves Anthropic Messages runtime metadata", () => {
    const provider: OcxProviderConfig = {
      adapter: "anthropic",
      baseUrl: "https://api.code.umans.ai",
      apiKey: "sk-umans",
    };

    enrichProviderFromCatalog("umans", provider);

    expect(provider.defaultModel).toBe("umans-coder");
    expect(provider.models).toContain("umans-kimi-k2.7");
    expect(provider.noVisionModels).toContain("umans-glm-5.2");
    expect(provider.modelContextWindows?.["umans-coder"]).toBe(262_144);
    expect(provider.modelContextWindows?.["umans-glm-5.2"]).toBe(405_504);
    expect(provider.modelInputModalities?.["umans-coder"]).toEqual(["text", "image"]);
    expect(provider.modelInputModalities?.["umans-glm-5.2"]).toEqual(["text"]);
    expect(provider.escapeBuiltinToolNames).toBe(true);
  });

  test("CLI key-login save payload preserves Umans runtime metadata", () => {
    const provider = providerConfigFromKeyLoginProvider(KEY_LOGIN_PROVIDERS.umans, "sk-umans");

    expect(provider).toMatchObject({
      adapter: "anthropic",
      baseUrl: "https://api.code.umans.ai",
      apiKey: "sk-umans",
      defaultModel: "umans-coder",
      escapeBuiltinToolNames: true,
    });
    expect(provider.models).toContain("umans-kimi-k2.7");
    expect(provider.modelReasoningEfforts?.["umans-glm-5.2"]).toEqual(["high", "xhigh"]);
    expect(provider.modelReasoningEffortMap?.["umans-glm-5.2"]?.xhigh).toBe("max");
    expect(provider.noVisionModels).toContain("umans-glm-5.1");
    expect(provider.modelContextWindows?.["umans-glm-5.1"]).toBe(202_752);
    expect(provider.modelInputModalities?.["umans-glm-5.1"]).toEqual(["text"]);
    expect(provider.modelInputModalities?.["umans-kimi-k2.7"]).toEqual(["text", "image"]);
  });

  test("Anthropic adapter posts Umans requests to /v1/messages with x-api-key", () => {
    const req = createAnthropicAdapter(umansProvider()).buildRequest(parsedWithWebSearchTool());
    const body = JSON.parse(req.body as string) as {
      tools: Array<{ name: string }>;
      tool_choice: { type: string; name: string };
      system?: unknown;
    };

    expect(req.url).toBe("https://api.code.umans.ai/v1/messages");
    expect(req.method).toBe("POST");
    expect(req.headers.Authorization).toBeUndefined();
    expect(req.headers["x-api-key"]).toBe("sk-umans");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.headers["anthropic-beta"]).toBeUndefined();
    expect(body.system).toBeUndefined();
    expect(body.tools[0].name).toBe("cx_web_search");
    expect(body.tool_choice).toEqual({ type: "tool", name: "cx_web_search" });
  });

  test("Anthropic adapter filters Umans tools for Responses allowed_tools choices", () => {
    const req = createAnthropicAdapter(umansProvider()).buildRequest({
      modelId: "umans-kimi-k2.7",
      context: {
        messages: [{ role: "user", content: "search docs", timestamp: 0 }],
        tools: [
          {
            name: "web_search",
            description: "Search the web",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          },
          {
            name: "run_tests",
            description: "Run tests",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      stream: true,
      options: { toolChoice: { allowedTools: ["web_search"], mode: "required" } },
    });
    const body = JSON.parse(req.body as string) as {
      tools: Array<{ name: string }>;
      tool_choice: { type: string };
    };

    expect(body.tools.map(t => t.name)).toEqual(["cx_web_search"]);
    expect(body.tool_choice).toEqual({ type: "any" });
  });

  test("Anthropic adapter strips Umans compatibility prefix from streamed tool calls", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `event: content_block_start\n` +
          `data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_1","name":"cx_web_search"}}\n\n` +
          `event: content_block_delta\n` +
          `data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"umans\\"}"}}\n\n` +
          `event: content_block_stop\n` +
          `data: {"type":"content_block_stop"}\n\n`,
        ));
        controller.close();
      },
    });

    const events = await collect(createAnthropicAdapter(umansProvider()).parseStream(new Response(stream)));

    expect(events[0]).toEqual({ type: "tool_call_start", id: "toolu_1", name: "web_search" });
    expect(events[1]).toEqual({ type: "tool_call_delta", arguments: "{\"query\":\"umans\"}" });
    expect(events[2]).toEqual({ type: "tool_call_end" });
  });

  test("Anthropic adapter strips Umans compatibility prefix from non-streaming tool calls", async () => {
    const response = new Response(JSON.stringify({
      content: [{
        type: "tool_use",
        id: "toolu_1",
        name: "cx_web_search",
        input: { query: "umans" },
      }],
      usage: { input_tokens: 10, output_tokens: 3 },
    }));

    const events = await createAnthropicAdapter(umansProvider()).parseResponse(response);

    expect(events[0]).toEqual({ type: "tool_call_start", id: "toolu_1", name: "web_search" });
    expect(events[1]).toEqual({ type: "tool_call_delta", arguments: "{\"query\":\"umans\"}" });
    expect(events[2]).toEqual({ type: "tool_call_end" });
    expect(events[3].type).toBe("done");
  });

  test("Umans API-key validation uses Anthropic Messages shape", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const valid = await validateApiKey(KEY_LOGIN_PROVIDERS.umans, "sk-umans-valid");
    const headers = new Headers(seenInit?.headers);
    const body = JSON.parse(String(seenInit?.body)) as Record<string, unknown>;

    expect(valid).toBe(true);
    expect(seenUrl).toBe("https://api.code.umans.ai/v1/messages");
    expect(seenInit?.method).toBe("POST");
    expect(headers.get("x-api-key")).toBe("sk-umans-valid");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(body.model).toBe("umans-coder");
    expect(body.max_tokens).toBe(1);
  });
});
