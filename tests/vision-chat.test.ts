import { afterEach, describe, expect, test } from "bun:test";
import { describeImageChat } from "../src/vision/describe-chat";
import { planVisionSidecar } from "../src/vision";
import { parseRequest } from "../src/responses/parser";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { resolveActiveProviderApiKey } from "../src/providers/api-keys";

const originalFetch = globalThis.fetch;
const image = "data:image/png;base64,aGVsbG8=";
const settings = { model: "vision-test", timeoutMs: 5000 };

afterEach(() => { globalThis.fetch = originalFetch; });

function chatSse(text: string): Response {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function geminiSse(text: string): Response {
  const body = [
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}`,
    "",
    `data: ${JSON.stringify({ candidates: [{ finishReason: "STOP" }] })}`,
    "",
  ].join("\n");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("chat vision sidecar", () => {
  test("resolves env-backed active keys and matches the active non-first pool entry without mutation", () => {
    const previous = process.env.VISION_CHAT_KEY;
    process.env.VISION_CHAT_KEY = " env-active-key ";
    try {
      const provider: OcxProviderConfig = {
        adapter: "openai-chat",
        baseUrl: "https://vision.example/v1",
        apiKey: "${VISION_CHAT_KEY}",
        apiKeyPool: [
          { id: "first", key: "first-key" },
          { id: "active", key: "${VISION_CHAT_KEY}" },
        ],
      };
      const before = structuredClone(provider);
      expect(resolveActiveProviderApiKey(provider)).toBe("env-active-key");
      expect(provider).toEqual(before);
    } finally {
      if (previous === undefined) delete process.env.VISION_CHAT_KEY;
      else process.env.VISION_CHAT_KEY = previous;
    }
  });

  test("does not advertise or send an unresolved env placeholder", async () => {
    const previous = process.env.VISION_CHAT_MISSING;
    delete process.env.VISION_CHAT_MISSING;
    try {
      const provider: OcxProviderConfig = {
        adapter: "openai-chat",
        baseUrl: "https://vision.example/v1",
        apiKey: "$VISION_CHAT_MISSING",
      };
      expect(resolveActiveProviderApiKey(provider)).toBeUndefined();
      expect(await describeImageChat(image, "high", "describe this", provider, "mimo", settings)).toEqual({
        text: "",
        error: "provider has no API key or OAuth token",
      });
    } finally {
      if (previous === undefined) delete process.env.VISION_CHAT_MISSING;
      else process.env.VISION_CHAT_MISSING = previous;
    }
  });

  test("sends an image_url through an OpenAI-compatible provider", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, any> | undefined;
    globalThis.fetch = (async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body));
      return chatSse("Mimo description");
    }) as typeof fetch;
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://vision.example/v1",
      authMode: "key",
      apiKey: "test-key",
    };

    const result = await describeImageChat(image, "high", "describe this", provider, "mimo", settings);

    expect(result).toEqual({ text: "Mimo description" });
    expect(capturedUrl).toBe("https://vision.example/v1/chat/completions");
    expect(capturedBody?.model).toBe("vision-test");
    expect(capturedBody?.messages[0].content).toEqual([
      { type: "text", text: "describe this" },
      { type: "image_url", image_url: { url: image, detail: "high" } },
    ]);
  });

  test("uses the active non-first pool key for Google adapter auth", async () => {
    let capturedKey = "";
    globalThis.fetch = (async (_url, init) => {
      capturedKey = new Headers(init?.headers).get("x-goog-api-key") ?? "";
      return geminiSse("Gemini pool description");
    }) as typeof fetch;
    const provider: OcxProviderConfig = {
      adapter: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      authMode: "key",
      apiKey: "active-google-key",
      apiKeyPool: [
        { id: "first", key: "first-google-key" },
        { id: "active", key: "active-google-key" },
      ],
    };

    const result = await describeImageChat(image, "high", "describe this", provider, "gemini", { model: "gemini-test", timeoutMs: 5000 });

    expect(result).toEqual({ text: "Gemini pool description" });
    expect(capturedKey).toBe("active-google-key");
  });

  test("uses the native Google adapter wire format", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, any> | undefined;
    globalThis.fetch = (async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body));
      return geminiSse("Gemini description");
    }) as typeof fetch;
    const provider: OcxProviderConfig = {
      adapter: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      authMode: "key",
      apiKey: "test-key",
    };

    const result = await describeImageChat(image, "high", "describe this", provider, "gemini", { model: "gemini-test", timeoutMs: 5000 });

    expect(result).toEqual({ text: "Gemini description" });
    expect(capturedUrl).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse");
    expect(capturedBody?.contents?.[0]?.parts).toEqual([
      { text: "describe this" },
      { inline_data: { mime_type: "image/png", data: "aGVsbG8=" } },
    ]);
  });

  test("the resolved credential wins over a static provider Authorization header", async () => {
    let capturedAuth = "";
    globalThis.fetch = (async (_url, init) => {
      capturedAuth = String((init?.headers as Record<string, string>)?.Authorization ?? (init?.headers as Headers)?.get?.("Authorization") ?? "");
      return chatSse("authed description");
    }) as typeof fetch;
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://vision.example/v1",
      authMode: "key",
      apiKey: "fresh-key",
      headers: { Authorization: "Bearer stale-static" },
    };

    const result = await describeImageChat(image, "high", "describe this", provider, "mimo", settings);

    expect(result.error).toBeUndefined();
    expect(capturedAuth).toBe("Bearer fresh-key");
  });

  test("a keyless local provider (authMode local) sends no Authorization header", async () => {
    let capturedAuth: string | undefined = "unset";
    globalThis.fetch = (async (_url, init) => {
      const h = init?.headers as Record<string, string>;
      capturedAuth = h?.Authorization ?? (init?.headers as Headers)?.get?.("Authorization") ?? undefined;
      return chatSse("local description");
    }) as typeof fetch;
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "http://127.0.0.1:1234/v1",
      authMode: "local",
    };

    const result = await describeImageChat(image, "high", "describe this", provider, "local", settings);

    expect(result.error).toBeUndefined();
    expect(capturedAuth).toBeUndefined();
  });

  test("forwards the planned reasoning through the provider-aware wire mapping", async () => {
    let capturedBody: Record<string, any> | undefined;
    globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return chatSse("reasoned description");
    }) as typeof fetch;
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://vision.example/v1",
      authMode: "key",
      apiKey: "k",
    };

    await describeImageChat(image, "high", "describe this", provider, "mimo", { ...settings, reasoning: "high" });

    expect(capturedBody?.reasoning_effort).toBe("high");
    expect(capturedBody?.reasoning).toBeUndefined();

    // gateway-object providers emit reasoning.enabled/effort instead.
    const gateway: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://gateway.example/v1",
      authMode: "key",
      apiKey: "k",
      reasoningWireFormat: "gateway-object",
    };
    globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return chatSse("gateway description");
    }) as typeof fetch;
    await describeImageChat(image, "high", "describe this", gateway, "gateway", { ...settings, reasoning: "medium" });

    expect(capturedBody?.reasoning).toEqual({ enabled: true, effort: "medium" });
    expect(capturedBody?.reasoning_effort).toBeUndefined();
  });
});

describe("chat vision destination guard", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("an http: openai-compatible destination fails without any network call", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; return chatSse("unreachable"); }) as typeof fetch;
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "http://vision.example/v1",
      authMode: "key",
      apiKey: "test-key",
    };

    const result = await describeImageChat(image, "high", "describe this", provider, "mimo", settings);

    expect(result.error).toContain("must use HTTPS");
    expect(result.text).toBe("");
    expect(fetchCalled).toBe(false);
  });

  test("an http: OAuth destination fails BEFORE token acquisition and before any network call", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; return chatSse("unreachable"); }) as typeof fetch;
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "http://vision.example/v1",
      authMode: "oauth",
    };

    const result = await describeImageChat(image, "high", "describe this", provider, "mimo", settings);

    // The HTTPS error, not an "oauth token failed" error: the guard must run before
    // getValidAccessToken is reached.
    expect(result.error).toContain("must use HTTPS");
    expect(result.error).not.toContain("oauth");
    expect(fetchCalled).toBe(false);
  });

  test("an http: Google destination fails before token acquisition and before any network call", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; return geminiSse("unreachable"); }) as typeof fetch;
    const provider: OcxProviderConfig = {
      adapter: "google",
      baseUrl: "http://generativelanguage.googleapis.com",
      authMode: "oauth",
    };

    const result = await describeImageChat(image, "high", "describe this", provider, "gemini", settings);

    expect(result.error).toContain("must use HTTPS");
    expect(result.error).not.toContain("oauth");
    expect(fetchCalled).toBe(false);
  });

  test("a loopback http: destination is allowed (cleartext never leaves the host)", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; return chatSse("local-description"); }) as typeof fetch;
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "http://127.0.0.1:1234/v1",
      authMode: "key",
      apiKey: "local-key",
    };

    const result = await describeImageChat(image, "high", "describe this", provider, "local", settings);

    expect(result.error).toBeUndefined();
    expect(fetchCalled).toBe(true);
  });
});

describe("chat vision plan provider resolution", () => {
  const routed: OcxProviderConfig = {
    adapter: "openai-chat",
    baseUrl: "https://routed.test/v1",
    apiKey: "routed-key",
    noVisionModels: ["text-model"],
  };
  const request = parseRequest({
    model: "routed/text-model",
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "what is in this picture?" },
        { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
      ],
    }],
  });
  const chatConfig = (providers: Record<string, OcxProviderConfig>, model: string): OcxConfig =>
    ({ port: 10100, defaultProvider: "routed", providers, visionSidecar: { enabled: true, backend: "chat", model } }) as OcxConfig;

  test("a bare model with two live-only providers produces NO plan (no arbitrary first-provider pick)", () => {
    const config = chatConfig({
      routed,
      p1: { adapter: "openai-chat", baseUrl: "https://p1.test/v1", apiKey: "k1", liveModels: true },
      p2: { adapter: "openai-chat", baseUrl: "https://p2.test/v1", apiKey: "k2", liveModels: true },
    }, "gemini-flash");

    expect(planVisionSidecar(config, routed, "text-model", request)).toBeUndefined();
  });

  test("a bare model listed by TWO configured providers is ambiguous and produces NO plan", () => {
    const config = chatConfig({
      routed,
      p1: { adapter: "openai-chat", baseUrl: "https://p1.test/v1", apiKey: "k1", models: ["gemini-flash"] },
      p2: { adapter: "openai-chat", baseUrl: "https://p2.test/v1", apiKey: "k2", models: ["gemini-flash"] },
    }, "gemini-flash");

    expect(planVisionSidecar(config, routed, "text-model", request)).toBeUndefined();
  });

  test("a provider-qualified model selects exactly that provider", () => {
    const config = chatConfig({
      routed,
      p1: { adapter: "openai-chat", baseUrl: "https://p1.test/v1", apiKey: "k1", liveModels: true },
      p2: { adapter: "openai-chat", baseUrl: "https://p2.test/v1", apiKey: "k2", liveModels: true },
    }, "p2/gemini-flash");

    const plan = planVisionSidecar(config, routed, "text-model", request);
    expect(plan?.backend).toBe("chat");
    expect(plan?.chatSidecar?.providerName).toBe("p2");
    expect(plan?.chatSidecar?.model).toBe("gemini-flash");
  });

  test("a uniquely configured bare model resolves to its provider", () => {
    const config = chatConfig({
      routed,
      p1: { adapter: "openai-chat", baseUrl: "https://p1.test/v1", apiKey: "k1", defaultModel: "gemini-flash" },
    }, "gemini-flash");

    const plan = planVisionSidecar(config, routed, "text-model", request);
    expect(plan?.backend).toBe("chat");
    expect(plan?.chatSidecar?.providerName).toBe("p1");
  });

  test("disabled or unauthenticated chat providers produce no plan", () => {
    const disabled = chatConfig({
      routed,
      p1: { adapter: "openai-chat", baseUrl: "https://p1.test/v1", apiKey: "k1", disabled: true, models: ["gemini-flash"] },
    }, "gemini-flash");
    expect(planVisionSidecar(disabled, routed, "text-model", request)).toBeUndefined();

    const unauthenticated = chatConfig({
      routed,
      p1: { adapter: "openai-chat", baseUrl: "https://p1.test/v1", models: ["gemini-flash"] },
    }, "gemini-flash");
    expect(planVisionSidecar(unauthenticated, routed, "text-model", request)).toBeUndefined();
  });

  test("a namespaced model id resolves through its unique configured provider", () => {
    // "anthropic" here is a MODEL NAMESPACE inside the published id, not a
    // configured provider: the prefix must not be read as a provider qualifier.
    const config = chatConfig({
      routed,
      p1: { adapter: "openai-chat", baseUrl: "https://p1.test/v1", apiKey: "k1", models: ["anthropic/claude-3-haiku"] },
    }, "anthropic/claude-3-haiku");

    const plan = planVisionSidecar(config, routed, "text-model", request);
    expect(plan?.backend).toBe("chat");
    expect(plan?.chatSidecar?.providerName).toBe("p1");
    expect(plan?.chatSidecar?.model).toBe("anthropic/claude-3-haiku");
  });

  test("a bare model matched by namespace suffix keeps the id the provider publishes", () => {
    // Bare "gemini-flash" matches the suffix of "google/gemini-flash": the plan
    // must carry the PUBLISHED namespaced id, not the bare (unroutable) one.
    const config = chatConfig({
      routed,
      p1: { adapter: "openai-chat", baseUrl: "https://p1.test/v1", apiKey: "k1", models: ["google/gemini-flash"] },
    }, "gemini-flash");

    const plan = planVisionSidecar(config, routed, "text-model", request);
    expect(plan?.backend).toBe("chat");
    expect(plan?.chatSidecar?.providerName).toBe("p1");
    expect(plan?.chatSidecar?.model).toBe("google/gemini-flash");
  });

  test("an ambiguous namespaced-suffix match produces no plan", () => {
    const config = chatConfig({
      routed,
      p1: { adapter: "openai-chat", baseUrl: "https://p1.test/v1", apiKey: "k1", models: ["google/gemini-flash"] },
      p2: { adapter: "openai-chat", baseUrl: "https://p2.test/v1", apiKey: "k2", models: ["vertex/gemini-flash"] },
    }, "gemini-flash");

    expect(planVisionSidecar(config, routed, "text-model", request)).toBeUndefined();
  });

  test("rejects malformed data URL or unsupported image scheme", async () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://vision.example/v1",
      apiKey: "k1",
    };
    const badScheme = await describeImageChat("http://insecure.example/img.png", "high", "desc", provider, "p", settings);
    expect(badScheme.error).toContain("unsupported image URL scheme");

    const badData = await describeImageChat("data:image/unsupported;base64,123", "high", "desc", provider, "p", settings);
    expect(badData.error).toContain("unsupported image type");
  });
});
