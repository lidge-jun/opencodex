import { afterEach, describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../../src/adapters/google";
import { providerConfigSeed } from "../../src/providers/derive";
import { resolveFastPolicy } from "../../src/providers/fastwire";
import { getProviderRegistryEntry, providerMatchesRegistryTransport } from "../../src/providers/registry";
import { resolveModelPolicy } from "../../src/providers/resolved-model-policy";
import { captureFastPolicyAuthority, fastPolicyForModel, serviceTierSupportForModel } from "../../src/providers/service-tier";
import { parseRequest } from "../../src/responses/parser";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { captureWireAdapterHardPinPrefixes, isWirePinnedModel, pinnedWireAdapter } from "../../src/types/wire";
import { openCodeZenBaseUrl, openCodeZenGeminiEndpoint } from "../../src/types/opencode-zen";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const BASES = ["https://opencode.ai/zen/v1", "https://opencode.ai/inference/v1"];
const MODELS = ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash", "gemini-4-argon", "Gemini-future"];
const INBOUNDS = ["responses", "chat", "anthropic"] as const;

function zen(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { ...providerConfigSeed(getProviderRegistryEntry("opencode-zen")!), apiKey: "synthetic-zen-key", ...overrides };
}

function staticPolicy(providerName: string, provider: OcxProviderConfig, modelId: string, inboundWire: typeof INBOUNDS[number]) {
  return resolveModelPolicy({
    providerName, provider, modelId, inboundWire,
    registryEntry: getProviderRegistryEntry(providerName),
    transportMatchedRegistry: providerMatchesRegistryTransport(providerName, provider),
  });
}

function expectWire(providerName: string, provider: OcxProviderConfig, modelId: string, adapter: string) {
  for (const inbound of INBOUNDS) {
    const runtime = resolveWireProtocolOverride(providerName, modelId, provider, inbound);
    const policy = staticPolicy(providerName, provider, modelId, inbound);
    expect(runtime.adapter).toBe(adapter);
    expect(resolveWireProtocolOverride(providerName, modelId, runtime, inbound).adapter).toBe(adapter);
    expect(policy.model.adapter).toBe(adapter);
    expect(resolveWireProtocolOverride(providerName, modelId, provider, inbound, policy).adapter).toBe(adapter);
    expect(fastPolicyForModel(provider, modelId, providerName, inbound).adapter).toBe(adapter);
    const authority = captureFastPolicyAuthority(providerName, provider, providerMatchesRegistryTransport(providerName, provider));
    expect(resolveFastPolicy(authority, modelId, inbound).adapter).toBe(adapter);
  }
}

describe("OpenCode Zen Gemini destination and wire policy", () => {
  test("Claude uses Messages across runtime, static and Fast policy", () => {
    for (const baseUrl of BASES) for (const model of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "Claude-future"]) {
      for (const googleMode of [undefined, "ai-studio", "vertex", "cloud-code-assist"] as const) for (const adapter of ["openai-chat", "openai-responses"] as const) {
        expectWire("opencode-zen", zen({ baseUrl, googleMode, modelAdapters: { [model]: adapter } }), model, "anthropic");
      }
      expectWire("renamed-zen", zen({ baseUrl }), model, "openai-chat");
      expectWire("opencode-zen", zen({ baseUrl: "https://custom.example.test/v1" }), model, "openai-chat");
      expectWire("opencode-zen", zen({ baseUrl, authMode: "oauth" }), model, "openai-chat");
    }
  });
  test.each(BASES)("pins Gemini models at %s across runtime, static and Fast policy", baseUrl => {
    for (const model of MODELS) for (const override of ["openai-chat", "openai-responses"]) {
      const provider = zen({ baseUrl, modelAdapters: { [model]: override }, supportsServiceTier: true });
      expectWire("opencode-zen", provider, model, "google");
      expect(isWirePinnedModel("opencode-zen", model, provider)).toBe(true);
      expect(pinnedWireAdapter("opencode-zen", model, provider)).toBe("google");
      expect(staticPolicy("opencode-zen", provider, model, "responses").provenance.model.adapter).toBe("hard-pin");
      expect(serviceTierSupportForModel(provider, model, "opencode-zen")).toBe(false);
      expect(fastPolicyForModel(provider, model, "opencode-zen").fastWire).toBeNull();
    }
  });

  test.each(BASES)("normalizes official URL %s with omitted or explicit key/AI Studio mode", baseUrl => {
    for (const explicit of [false, true]) {
      const provider = zen({ baseUrl: `  ${baseUrl}///  `, authMode: explicit ? "key" : undefined,
        googleMode: explicit ? "ai-studio" : undefined });
      expect(openCodeZenBaseUrl(provider)).toBe(baseUrl);
      expect(openCodeZenGeminiEndpoint(provider, "gemini-future/preview")).toBe(`${baseUrl}/models/gemini-future%2Fpreview`);
      expectWire("opencode-zen", provider, "gemini-3.7-flash", "google");
    }
  });

  const unrelatedDestinations = [
    "https://custom.example.test/v1", "http://opencode.ai/zen/v1", "https://opencode.ai.evil.test/zen/v1",
    "https://opencode.ai:8443/zen/v1", "https://opencode.ai/zen/go/v1", "https://opencode.ai/zen/v1/extra",
    "https://opencode.ai/ZEN/v1", "https://opencode.ai/zen/v1?route=other", "https://opencode.ai/zen/v1#other",
    "https://user:pass" + "@opencode.ai/zen/v1", "https://opencode.ai@evil.test/zen/v1", "not a URL",
  ];
  test.each(unrelatedDestinations)("does not impose the native wire on %s", baseUrl => {
    const model = "gemini-3.7-flash";
    const provider = zen({ baseUrl, modelAdapters: { [model]: "openai-responses" } });
    expect(openCodeZenBaseUrl(provider)).toBeUndefined();
    expect(openCodeZenGeminiEndpoint(provider, model)).toBeUndefined();
    expect(captureWireAdapterHardPinPrefixes("opencode-zen", provider)).toEqual({});
    expect(isWirePinnedModel("opencode-zen", model, provider)).toBe(false);
    expectWire("opencode-zen", provider, model, "openai-responses");
  });

  test("non-key auth and non-AI Studio modes do not acquire a Zen pin", () => {
    for (const changes of [
      { authMode: "oauth" }, { authMode: "forward" }, { authMode: "local" },
      { googleMode: "vertex" }, { googleMode: "cloud-code-assist" },
    ] as Partial<OcxProviderConfig>[]) {
      const provider = zen({ ...changes, modelAdapters: { "gemini-3.7-flash": "openai-responses" } });
      expect(openCodeZenBaseUrl(provider)).toBeUndefined();
      expect(openCodeZenGeminiEndpoint(provider, "gemini-3.7-flash")).toBeUndefined();
      expectWire("opencode-zen", provider, "gemini-3.7-flash", "openai-responses");
    }
    expect(openCodeZenBaseUrl(undefined)).toBeUndefined();
    expect(openCodeZenBaseUrl({ baseUrl: 123 })).toBeUndefined();
  });

  test("captured prefix authority is detached from later destination changes", () => {
    const provider = zen({ modelAdapters: { "gemini-3.7-flash": "openai-responses" } });
    const prefixes = captureWireAdapterHardPinPrefixes("opencode-zen", provider);
    const authority = captureFastPolicyAuthority("opencode-zen", provider, true);
    provider.baseUrl = "https://custom.example.test/v1";
    expect(Object.isFrozen(prefixes)).toBe(true);
    expect(prefixes).toEqual({ "gemini-": "google", "claude-": "anthropic" });
    expect(resolveFastPolicy(authority, "gemini-3.7-flash").adapter).toBe("google");
    expect(fastPolicyForModel(provider, "gemini-3.7-flash", "opencode-zen").adapter).toBe("openai-responses");
  });

  test("Zen siblings and other provider identities retain their existing wires", () => {
    for (const model of ["gpt-6.1-sol", "deepseek-v4-flash", "not-gemini-3.7-flash"]) {
      expect(openCodeZenGeminiEndpoint(zen(), model)).toBeUndefined();
      expectWire("opencode-zen", zen(), model, "openai-chat");
      expectWire("opencode-zen", zen({ modelAdapters: { [model]: "openai-responses" } }), model, "openai-responses");
    }
    for (const name of ["my-zen", "opencode-go"]) {
      expectWire(name, zen({ modelAdapters: { "gemini-3.7-flash": "openai-chat" } }), "gemini-3.7-flash", "openai-chat");
    }
    const go = providerConfigSeed(getProviderRegistryEntry("opencode-go")!);
    expectWire("opencode-go", go, "gemini-3.7-flash", "openai-chat");
    for (const model of ["claude-haiku-5-5", "minimax-m2.7", "union-alpha"]) {
      expectWire("opencode-go", { ...go, modelAdapters: { [model]: "openai-responses" } }, model, "anthropic");
    }
  });
});

describe("OpenCode Zen Gemini native request", () => {
  for (const baseUrl of BASES) for (const model of MODELS) for (const stream of [false, true]) {
    test(`${baseUrl} preserves ${model} in ${stream ? "streaming" : "buffered"} native requests`, async () => {
      const provider = resolveWireProtocolOverride("opencode-zen", model, zen({ baseUrl, apiKey: "  synthetic-zen-key  " }));
      const adapter = withTestTranslatorBudget(createGoogleAdapter(provider));
      const request = await adapter.buildRequest(parseRequest({ model, input: "hello", stream, service_tier: "priority" }));
      expect(request.url).toBe(`${baseUrl}/models/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`);
      expect(request.method).toBe("POST");
      const headers = new Headers(request.headers);
      expect(headers.get("x-goog-api-key")).toBe("synthetic-zen-key");
      expect(headers.has("authorization")).toBe(false);
      const body = JSON.parse(request.body);
      expect(body.contents).toContainEqual({ role: "user", parts: [{ text: "hello" }] });
      for (const key of ["messages", "input", "model", "stream", "service_tier"]) expect(body[key]).toBeUndefined();
    });
  }

  test("rejects an empty Zen key before any send", async () => {
    const adapter = withTestTranslatorBudget(createGoogleAdapter(zen({ adapter: "google", apiKey: "  " })));
    await expect(adapter.buildRequest(parseRequest({ model: "gemini-3.7-flash", input: "hello" })))
      .rejects.toThrow("OpenCode Zen requires a non-empty API key");
  });

  test("direct AI Studio, custom Google and Vertex keep their URL and model rules", async () => {
    for (const model of ["gemini-3.6-flash", "gemini-3.7-flash"]) for (const stream of [true, false]) {
      for (const baseUrl of ["https://generativelanguage.googleapis.com", "https://custom.example.test/v1"]) {
        const adapter = withTestTranslatorBudget(createGoogleAdapter({ adapter: "google", baseUrl, apiKey: "synthetic-google-key" }));
        const request = await adapter.buildRequest(parseRequest({ model, input: "hello", stream }));
        expect(request.url).toBe(`${baseUrl}/v1beta/models/${model}-tiered:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`);
      }
      const vertex = withTestTranslatorBudget(createGoogleAdapter(zen({ adapter: "google", googleMode: "vertex" })));
      const request = await vertex.buildRequest(parseRequest({ model, input: "hello", stream }));
      expect(request.url).toBe(`https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`);
    }
  });
});

describe("OpenCode Zen Gemini Responses translation", () => {
  const originalFetch = globalThis.fetch;
  let releaseSpendHome: (() => void) | undefined;
  afterEach(() => {
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    globalThis.fetch = originalFetch;
  });

  test("translated Claude uses parsed rate-limit types and preserves upstream retry hints", async () => {
    releaseSpendHome = acquireOwnedSpendHome();
    for (const retryAfter of [undefined, "37"]) {
      let sends = 0;
      globalThis.fetch = (async () => {
        sends++;
        return Response.json({ type: "error", error: { type: "rate_limit_error", message: "Too Many Requests" } },
          { status: 429, headers: retryAfter ? { "retry-after": retryAfter } : {} });
      }) as typeof fetch;
      const config = { providers: { "opencode-zen": zen() } } as unknown as OcxConfig;
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "opencode-zen/claude-sonnet-5-5", input: "hello", stream: false }),
      }), config, { model: "", provider: "" }, { inboundWire: "responses" });
      const text = await response.text();
      expect(response.status, text).toBe(429);
      expect(response.headers.get("retry-after")).toBe(retryAfter ?? "15");
      expect(text).toContain("15-20 requests per minute");
      expect(text.includes("Try again in 15s")).toBe(!retryAfter);
      expect(sends).toBe(1);
    }
  });

  // Routing canonicalizes the fixed Zen preset to /zen/v1; both accepted endpoint
  // spellings are exercised without that registry normalization in the adapter cases above.
  for (const baseUrl of [BASES[0]!]) for (const stream of [true, false]) {
    test(`${baseUrl} translates text and a two-turn tool continuation (${stream ? "SSE" : "JSON"})`, async () => {
      const model = "gemini-3.7-flash";
      const requests: Array<{ url: string; headers: Headers; body: Record<string, any> }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        const parts = requests.length === 1
          ? [{ text: "Checking weather." }, { functionCall: { id: "zen_weather_call", name: "weather", args: { city: "Paris" } }, thoughtSignature: "synthetic-zen-tool-signature-0123456789" }]
          : [{ text: "Paris is sunny." }];
        const payload = { candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } };
        return stream
          ? new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { "content-type": "text/event-stream" } })
          : Response.json(payload);
      }) as typeof fetch;
      releaseSpendHome = acquireOwnedSpendHome();
      const config = { providers: { "opencode-zen": zen({ baseUrl, modelAdapters: { [model]: "openai-responses" } }) } } as unknown as OcxConfig;
      const drive = async (input: unknown[]) => {
        const response = await handleResponses(new Request("http://localhost/v1/responses", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: `opencode-zen/${model}`, input, stream,
            tools: [{ type: "function", name: "weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }] }),
        }), config, { model: "", provider: "" }, { inboundWire: "responses" });
        const text = await response.text();
        expect(response.status, text).toBe(200);
        if (!stream) return JSON.parse(text);
        const events = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
        const completed = events.find(event => event.type === "response.completed");
        expect(completed).toBeDefined();
        return completed.response;
      };
      const initial = { role: "user", content: "Check Paris weather" };
      const first = await drive([initial]);
      const call = first.output.find((item: { type: string }) => item.type === "function_call");
      expect(call).toMatchObject({ name: "weather", arguments: '{"city":"Paris"}' });
      expect(typeof call.call_id).toBe("string");
      expect(call.call_id, JSON.stringify(first.output)).not.toBe("");
      expect(JSON.stringify(first.output)).toContain("Checking weather.");
      const second = await drive([initial, ...first.output, { type: "function_call_output", call_id: call.call_id, output: "sunny" }]);
      expect(second.status).toBe("completed");
      expect(JSON.stringify(second.output)).toContain("Paris is sunny.");
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.url).toBe(`${baseUrl}/models/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`);
        expect(request.headers.get("x-goog-api-key")).toBe("synthetic-zen-key");
        expect(request.headers.has("authorization")).toBe(false);
        expect(request.body.tools[0].functionDeclarations[0].name).toBe("weather");
        expect(request.body.messages).toBeUndefined();
        expect(request.body.input).toBeUndefined();
      }
      const contents = requests[1]!.body.contents;
      const callIndex = contents.findIndex((turn: { parts: Array<Record<string, unknown>> }) => turn.parts.some(part => part.functionCall));
      expect(callIndex).toBeGreaterThan(0);
      expect(contents[callIndex]).toMatchObject({ role: "model", parts: expect.arrayContaining([
        expect.objectContaining({ functionCall: expect.objectContaining({ name: "weather", args: { city: "Paris" } }), thoughtSignature: "synthetic-zen-tool-signature-0123456789" }),
      ]) });
      expect(contents[callIndex + 1]).toMatchObject({ role: "user", parts: expect.arrayContaining([
        expect.objectContaining({ functionResponse: expect.objectContaining({ name: "weather", response: { result: "sunny" } }) }),
      ]) });
    });
  }
});
