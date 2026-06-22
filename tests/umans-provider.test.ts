import { afterEach, describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { providerConfigFromKeyLoginProvider } from "../src/oauth/login-cli";
import { enrichProviderFromCatalog, KEY_LOGIN_PROVIDERS, validateApiKey } from "../src/oauth/key-providers";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";

function umansProvider(apiKey = "sk-umans"): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://api.code.umans.ai/v1",
    apiKey,
    defaultModel: "umans-coder",
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

  test("catalog enrichment preserves OpenAI-compatible runtime metadata", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.code.umans.ai/v1",
      apiKey: "sk-umans",
    };

    enrichProviderFromCatalog("umans", provider);

    expect(provider.defaultModel).toBe("umans-coder");
    expect(provider.models).toContain("umans-kimi-k2.7");
    expect(provider.modelContextWindows?.["umans-glm-5.2"]).toBe(405_504);
    expect(provider.modelInputModalities?.["umans-glm-5.2"]).toEqual(["text", "image"]);
    expect(provider.modelReasoningEfforts?.["umans-glm-5.2"]).toEqual(["high", "xhigh"]);
    expect(provider.escapeBuiltinToolNames).toBeUndefined();
  });

  test("CLI key-login save payload preserves Umans runtime metadata", () => {
    const provider = providerConfigFromKeyLoginProvider(KEY_LOGIN_PROVIDERS.umans, "sk-umans");

    expect(provider).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://api.code.umans.ai/v1",
      apiKey: "sk-umans",
      defaultModel: "umans-coder",
    });
    expect(provider.models).toContain("umans-kimi-k2.7");
    expect(provider.modelReasoningEfforts?.["umans-glm-5.2"]).toEqual(["high", "xhigh"]);
    expect(provider.modelReasoningEffortMap?.["umans-glm-5.2"]?.xhigh).toBe("max");
    expect(provider.modelContextWindows?.["umans-glm-5.2"]).toBe(405_504);
    expect(provider.modelInputModalities?.["umans-glm-5.2"]).toEqual(["text", "image"]);
  });

  test("OpenAI chat adapter posts Umans requests to /v1/chat/completions with bearer auth", () => {
    const req = createOpenAIChatAdapter(umansProvider()).buildRequest(parsedWithWebSearchTool());
    const body = JSON.parse(req.body as string) as {
      tools: Array<{ function: { name: string } }>;
      tool_choice: { type: string; function: { name: string } };
    };

    expect(req.url).toBe("https://api.code.umans.ai/v1/chat/completions");
    expect(req.method).toBe("POST");
    expect(req.headers.Authorization).toBe("Bearer sk-umans");
    expect(req.headers["x-api-key"]).toBeUndefined();
    expect(body.tools[0].function.name).toBe("web_search");
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "web_search" } });
  });

  test("OpenAI chat adapter parses streamed Umans tool calls", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"web_search","arguments":"{\\"query\\":\\"umans\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n` +
          `data: [DONE]\n\n`,
        ));
        controller.close();
      },
    });

    const events = await collect(createOpenAIChatAdapter(umansProvider()).parseStream(new Response(stream)));

    expect(events[0]).toEqual({ type: "tool_call_start", id: "call_1", name: "web_search" });
    expect(events[1]).toEqual({ type: "tool_call_delta", arguments: "{\"query\":\"umans\"}" });
    expect(events[2]).toEqual({ type: "tool_call_end" });
    expect(events[3].type).toBe("done");
  });

  test("OpenAI chat adapter parses non-streaming Umans tool calls", async () => {
    const response = new Response(JSON.stringify({
      choices: [{
        message: {
          tool_calls: [{
            id: "call_1",
            function: { name: "web_search", arguments: "{\"query\":\"umans\"}" },
          }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    }));

    const events = await createOpenAIChatAdapter(umansProvider()).parseResponse(response);

    expect(events[0]).toEqual({ type: "tool_call_start", id: "call_1", name: "web_search" });
    expect(events[1]).toEqual({ type: "tool_call_delta", arguments: "{\"query\":\"umans\"}" });
    expect(events[2]).toEqual({ type: "tool_call_end" });
    expect(events[3].type).toBe("done");
  });

  test("Umans API-key validation uses OpenAI-compatible models endpoint", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const valid = await validateApiKey(KEY_LOGIN_PROVIDERS.umans, "sk-umans-valid");
    const headers = new Headers(seenInit?.headers);

    expect(valid).toBe(true);
    expect(seenUrl).toBe("https://api.code.umans.ai/v1/models");
    expect(headers.get("authorization")).toBe("Bearer sk-umans-valid");
    expect(headers.get("x-api-key")).toBeNull();
  });
});
