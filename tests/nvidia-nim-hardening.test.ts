// 260715 issue #126: NVIDIA NIM hardening — parallel_tool_calls opt-out, kimi
// reasoning_effort suppression, and openai-chat formatErrorBody detail surfacing.
// 260804 issue #956: NIM text-only families get noVisionModels so the vision sidecar runs.
// Plan/evidence: devlog/_plan/260715_issue126_nim_kimi.
import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter, formatOpenAIChatErrorBody } from "../src/adapters/openai-chat";
import { applyProviderConfigHints, normalizeRoutedCatalogEntry } from "../src/codex/catalog";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { parseRequest } from "../src/responses/parser";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxParsedRequest, OcxTool } from "../src/types";
import { planVisionSidecar } from "../src/vision";

const tools: OcxTool[] = [{ name: "shell", description: "run", parameters: { type: "object" } }];

function nvidiaConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "nvidia",
    providers: {
      // Bare persisted config, like `ocx init` writes: registry seeds must backfill the flags.
      nvidia: { adapter: "openai-chat", baseUrl: "https://integrate.api.nvidia.com/v1", apiKey: "k" },
    },
  };
}

function parsedFor(modelId: string, options: Partial<OcxParsedRequest["options"]> = {}): Parameters<ReturnType<typeof createOpenAIChatAdapter>["buildRequest"]>[0] {
  return {
    modelId,
    context: {
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
      tools,
    },
    stream: true,
    options: { ...options },
  } as never;
}

describe("nvidia NIM registry hardening (issue #126)", () => {
  test("bare persisted nvidia config inherits parallelToolCalls:false from the registry", () => {
    const route = routeModel(nvidiaConfig(), "nvidia/moonshotai/kimi-k2.6");
    expect(route.provider.parallelToolCalls).toBe(false);
    expect(route.modelId).toBe("moonshotai/kimi-k2.6");
  });

  test("kimi-k2.6 request drops reasoning_effort and pins parallel_tool_calls:false", () => {
    const route = routeModel(nvidiaConfig(), "nvidia/moonshotai/kimi-k2.6");
    const adapter = createOpenAIChatAdapter(route.provider);
    const body = JSON.parse(adapter.buildRequest(parsedFor(route.modelId, { reasoning: "medium" })).body) as Record<string, unknown>;
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.model).toBe("moonshotai/kimi-k2.6");
  });

  test("whole documented NIM kimi family suppresses reasoning_effort", () => {
    const route = routeModel(nvidiaConfig(), "nvidia/moonshotai/kimi-k2.6");
    for (const id of [
      "moonshotai/kimi-k2.6", "moonshotai/kimi-k2.5", "moonshotai/kimi-k2-thinking",
      "moonshotai/kimi-k2-instruct", "moonshotai/kimi-k2-instruct-0905",
    ]) {
      const adapter = createOpenAIChatAdapter(route.provider);
      const body = JSON.parse(adapter.buildRequest(parsedFor(id, { reasoning: "high" })).body) as Record<string, unknown>;
      expect(body.reasoning_effort).toBeUndefined();
    }
  });

  test("gpt-oss on NIM keeps its working reasoning_effort (exact-id scoping)", () => {
    const route = routeModel(nvidiaConfig(), "nvidia/openai/gpt-oss-120b");
    const adapter = createOpenAIChatAdapter(route.provider);
    const body = JSON.parse(adapter.buildRequest(parsedFor(route.modelId, { reasoning: "medium" })).body) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("medium");
    expect(body.parallel_tool_calls).toBe(false);
  });

  test("NIM kimi thinking family preserves reasoning_content in chat history", () => {
    const route = routeModel(nvidiaConfig(), "nvidia/moonshotai/kimi-k2.6");
    expect(route.provider.preserveReasoningContentModels).toContain("moonshotai/kimi-k2.6");
    expect(route.provider.preserveReasoningContentModels).toContain("moonshotai/kimi-k2-thinking");
    expect(route.provider.preserveReasoningContentModels).not.toContain("moonshotai/kimi-k2-instruct");
  });

  test("catalog bit: nvidia routed entries stop advertising supports_parallel_tool_calls", () => {
    const route = routeModel(nvidiaConfig(), "nvidia/moonshotai/kimi-k2.6");
    const hinted = applyProviderConfigHints(
      "nvidia",
      route.provider,
      { id: "moonshotai/kimi-k2.6", provider: "nvidia" },
    );
    expect(hinted.parallelToolCalls).toBeUndefined();
    const entry = normalizeRoutedCatalogEntry({ slug: "nvidia/moonshotai/kimi-k2.6" }, hinted.parallelToolCalls);
    expect(entry.supports_parallel_tool_calls).toBe(false);
  });

  test("registry nvidia entry declares text-only families and excludes vision-capable models", () => {
    const nvidia = PROVIDER_REGISTRY.find(entry => entry.id === "nvidia")!;
    for (const id of [
      "deepseek-ai/deepseek-v4-flash",
      "deepseek-ai/deepseek-v4-pro",
      "z-ai/glm-5.2",
      "minimaxai/minimax-m3",
      "moonshotai/kimi-k2.6",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nvidia/nemotron-3-super-120b-a12b",
      "openai/gpt-oss-120b",
    ]) {
      expect(nvidia.noVisionModels).toContain(id);
    }
    for (const id of [
      "meta/llama-3.2-11b-vision-instruct",
      "meta/llama-3.2-90b-vision-instruct",
      "microsoft/phi-3-vision-128k-instruct",
      "adept/fuyu-8b",
      "nvidia/llama-3.1-nemotron-nano-vl-8b-v1",
      "nvidia/nemotron-nano-12b-v2-vl",
      "nvidia/neva-22b",
      "nvidia/vila",
    ]) {
      expect(nvidia.noVisionModels).not.toContain(id);
    }
  });

  test("bare persisted nvidia config inherits noVisionModels from the registry", () => {
    const route = routeModel(nvidiaConfig(), "nvidia/deepseek-ai/deepseek-v4-flash");
    expect(route.provider.noVisionModels).toContain("deepseek-ai/deepseek-v4-flash");
    expect(route.modelId).toBe("deepseek-ai/deepseek-v4-flash");
  });

  test("vision sidecar plans for text-only NIM models but not vision-capable ones", () => {
    const config = nvidiaConfig();
    const openAiSidecar = {
      providerName: "openai" as const,
      provider: { adapter: "openai-responses", baseUrl: "https://chatgpt.test/v1", authMode: "forward" as const },
      accountMode: "direct" as const,
      authContext: { kind: "main" as const, accountId: null },
      headers: new Headers({ authorization: "Bearer chatgpt" }),
    };
    const withImage = parseRequest({
      model: "nvidia/deepseek-ai/deepseek-v4-flash",
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "What is in this screenshot?" },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
        ],
      }],
    });
    const noImage = parseRequest({
      model: "nvidia/deepseek-ai/deepseek-v4-flash",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });

    const textRoute = routeModel(config, "nvidia/deepseek-ai/deepseek-v4-flash");
    expect(planVisionSidecar(config, textRoute.provider, textRoute.modelId, withImage, openAiSidecar))
      .toMatchObject({ backend: "openai" });
    expect(planVisionSidecar(config, textRoute.provider, textRoute.modelId, noImage, openAiSidecar))
      .toBeUndefined();

    const visionRoute = routeModel(config, "nvidia/meta/llama-3.2-11b-vision-instruct");
    expect(planVisionSidecar(config, visionRoute.provider, visionRoute.modelId, withImage, openAiSidecar))
      .toBeUndefined();
  });

  test("catalog advertises image input for text-only NIM models, not for vision-capable ones", () => {
    const config = nvidiaConfig();
    const textRoute = routeModel(config, "nvidia/deepseek-ai/deepseek-v4-flash");
    const hinted = applyProviderConfigHints("nvidia", textRoute.provider, {
      id: "deepseek-ai/deepseek-v4-flash",
      provider: "nvidia",
    });
    expect(hinted.inputModalities).toContain("image");

    const visionRoute = routeModel(config, "nvidia/meta/llama-3.2-11b-vision-instruct");
    const visionHinted = applyProviderConfigHints("nvidia", visionRoute.provider, {
      id: "meta/llama-3.2-11b-vision-instruct",
      provider: "nvidia",
    });
    expect(visionHinted.inputModalities).toBeUndefined();
  });
});

describe("formatOpenAIChatErrorBody (web-search sidecar detail surfacing)", () => {
  test("OpenAI error object shape", () => {
    expect(formatOpenAIChatErrorBody(400, new Headers(), '{"error":{"message":"This model only supports single tool-calls at once!"}}'))
      .toBe("This model only supports single tool-calls at once!");
  });

  test("OpenAI error string shape", () => {
    expect(formatOpenAIChatErrorBody(401, new Headers(), '{"error":"invalid key"}')).toBe("invalid key");
  });

  test("FastAPI string detail (NIM)", () => {
    expect(formatOpenAIChatErrorBody(404, new Headers(), '{"detail":"Not Found"}')).toBe("Not Found");
  });

  test("pydantic validation array detail (NIM extra_forbidden)", () => {
    const body = '{"detail":[{"loc":["body","max_new_tokens"],"msg":"extra fields not permitted","type":"extra_forbidden"},{"loc":["body","x"],"msg":"value error","type":"value_error"}]}';
    expect(formatOpenAIChatErrorBody(400, new Headers(), body)).toBe("extra fields not permitted; value error");
  });

  test("generic message / RFC7807 title fallbacks", () => {
    expect(formatOpenAIChatErrorBody(400, new Headers(), '{"message":"quota exceeded"}')).toBe("quota exceeded");
    expect(formatOpenAIChatErrorBody(404, new Headers(), '{"title":"Not Found","status":404}')).toBe("Not Found");
  });

  test("HTML and non-JSON bodies are never echoed", () => {
    expect(formatOpenAIChatErrorBody(502, new Headers(), "<html><body>Bad gateway</body></html>")).toBe("");
    expect(formatOpenAIChatErrorBody(500, new Headers(), "plain text panic")).toBe("");
  });

  test("secret-shaped values are redacted", () => {
    const out = formatOpenAIChatErrorBody(401, new Headers(), '{"error":{"message":"key sk-abcdef1234567890 rejected"}}');
    expect(out).not.toContain("sk-abcdef1234567890");
    expect(out).toContain("[REDACTED]");
  });

  test("caps output at 400 chars", () => {
    const long = JSON.stringify({ error: { message: "x".repeat(1000) } });
    expect(formatOpenAIChatErrorBody(400, new Headers(), long).length).toBe(400);
  });
});
