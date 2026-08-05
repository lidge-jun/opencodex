// 260715 issue #126: NVIDIA NIM hardening — parallel_tool_calls opt-out, kimi
// reasoning_effort suppression, and openai-chat formatErrorBody detail surfacing.
// Plan/evidence: devlog/_plan/260715_issue126_nim_kimi.
// 260804 issue #956: NIM vision classification — text-only models activate the sidecar,
// natively image-capable models do not. Plan/evidence:
// devlog/_fin/260804_stack7_service_vision (010 design, 011 per-id audit).
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
});

/**
 * 260804 issue #956. The reported defect: the `nvidia` entry declared no
 * `noVisionModels`, so `planVisionSidecar` never fired and the catalog never advertised
 * image input for text-only NIM models.
 *
 * PR #964 proposed a ~64-id text-only list. Six of its entries are natively
 * image-capable per NVIDIA's own documentation, and listing those is a SILENT defect:
 * the model could read the image, but the proxy substitutes another model's text
 * description. These tests pin both directions.
 */
describe("nvidia NIM vision classification (issue #956)", () => {
  const nvidia = () => PROVIDER_REGISTRY.find(entry => entry.id === "nvidia")!;

  const openAiSidecar = {
    providerName: "openai" as const,
    provider: { adapter: "openai-responses", baseUrl: "https://chatgpt.test/v1", authMode: "forward" as const },
    accountMode: "direct" as const,
    authContext: { kind: "main" as const, accountId: null },
    headers: new Headers({ authorization: "Bearer chatgpt" }),
  };

  function withImage(modelId: string) {
    return parseRequest({
      model: `nvidia/${modelId}`,
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "What is in this screenshot?" },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
        ],
      }],
    });
  }

  function plan(modelId: string) {
    const route = routeModel(nvidiaConfig(), `nvidia/${modelId}`);
    return planVisionSidecar(nvidiaConfig(), route.provider, route.modelId, withImage(modelId), openAiSidecar);
  }

  // The six ids PR #964 classified backwards. Each is documented by NVIDIA as accepting
  // image input, so the sidecar must NOT intercept it. Ablate by adding any of them to
  // NVIDIA_NIM_NO_VISION_MODELS and this goes red.
  const REVERSED_IN_964 = [
    "thinkingmachines/inkling",
    "minimaxai/minimax-m3",
    "moonshotai/kimi-k2.6",
    "moonshotai/kimi-k2.5",
    "stepfun-ai/step-3.7-flash",
    "mistralai/mistral-medium-3.5-128b",
  ];

  test("natively image-capable NIM models never route through the sidecar", () => {
    for (const id of [...REVERSED_IN_964, "meta/llama-3.2-11b-vision-instruct", "meta/llama-3.2-90b-vision-instruct"]) {
      expect(nvidia().noVisionModels).not.toContain(id);
      expect(plan(id)).toBeUndefined();
    }
  });

  test("verified text-only NIM models do route through the sidecar", () => {
    for (const id of [
      "deepseek-ai/deepseek-v4-flash",
      "z-ai/glm-5.2",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "openai/gpt-oss-120b",
      "moonshotai/kimi-k2-thinking",
    ]) {
      expect(nvidia().noVisionModels).toContain(id);
      expect(plan(id)).toMatchObject({ backend: "openai" });
    }
  });

  test("a text-only model without an image needs no sidecar", () => {
    const config = nvidiaConfig();
    const route = routeModel(config, "nvidia/deepseek-ai/deepseek-v4-flash");
    const noImage = parseRequest({
      model: "nvidia/deepseek-ai/deepseek-v4-flash",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    expect(planVisionSidecar(config, route.provider, route.modelId, noImage, openAiSidecar)).toBeUndefined();
  });

  // The honest boundary. NIM publishes no modality metadata and serves non-chat
  // endpoints (embeddings, rerankers, guards, OCR) that reach this same path, so an
  // unclassified id is deliberately left alone rather than defaulted in either
  // direction. If a future change defaults unknown ids, this test forces that to be a
  // conscious decision instead of a side effect.
  test("unclassified NIM ids stay unclassified, including non-chat endpoints", () => {
    for (const id of [
      "nvidia/nv-embedqa-e5-v5",
      "nvidia/nemotron-ocr-v2",
      "nvidia/llama-nemotron-rerank-1b-v2",
      "brandnew/model-nobody-classified",
    ]) {
      expect(nvidia().noVisionModels).not.toContain(id);
      expect(nvidia().modelInputModalities?.[id]).toBeUndefined();
      expect(plan(id)).toBeUndefined();
    }
  });

  // Both classes must advertise image input, by different mechanisms: text-only models
  // via the noVisionModels hint (the sidecar describes the image), vision models via
  // explicit modelInputModalities. Without the latter the Codex app blocks attachments
  // client-side and the native path never runs.
  test("the catalog advertises image input for both classes", () => {
    const config = nvidiaConfig();
    for (const id of ["deepseek-ai/deepseek-v4-flash", "z-ai/glm-5.2"]) {
      const route = routeModel(config, `nvidia/${id}`);
      const hinted = applyProviderConfigHints("nvidia", route.provider, { id, provider: "nvidia" });
      expect(hinted.inputModalities).toContain("image");
    }
    for (const id of REVERSED_IN_964) {
      const route = routeModel(config, `nvidia/${id}`);
      const hinted = applyProviderConfigHints("nvidia", route.provider, { id, provider: "nvidia" });
      expect(hinted.inputModalities).toEqual(["text", "image"]);
    }
  });

  test("a bare persisted nvidia config inherits the classification from the registry", () => {
    // The #956 reporter's exact config shape, which today needs a manual workaround.
    const route = routeModel(nvidiaConfig(), "nvidia/deepseek-ai/deepseek-v4-flash");
    expect(route.provider.noVisionModels).toContain("deepseek-ai/deepseek-v4-flash");
    expect(route.provider.modelInputModalities?.["moonshotai/kimi-k2.6"]).toEqual(["text", "image"]);
  });

  test("a user's own noVisionModels entries are preserved alongside the registry's", () => {
    // mergeStringArray unions registry and user arrays, so a user adds but cannot remove.
    const config = nvidiaConfig();
    config.providers.nvidia!.noVisionModels = ["some/private-endpoint"];
    const route = routeModel(config, "nvidia/some/private-endpoint");
    expect(route.provider.noVisionModels).toContain("some/private-endpoint");
    expect(route.provider.noVisionModels).toContain("z-ai/glm-5.2");
  });

  test("the two classifications cannot overlap", () => {
    const entry = nvidia();
    const visionIds = Object.keys(entry.modelInputModalities ?? {});
    expect(entry.noVisionModels?.filter(id => visionIds.includes(id))).toEqual([]);
  });

  test("kimi vision and reasoning classifications stay independent", () => {
    const entry = nvidia();
    // k2.5/k2.6 see images; k2-thinking/k2-instruct do not. All four keep reasoning
    // suppression, because that is a separate axis.
    for (const id of ["moonshotai/kimi-k2.6", "moonshotai/kimi-k2.5", "moonshotai/kimi-k2-thinking", "moonshotai/kimi-k2-instruct"]) {
      expect(entry.noReasoningModels).toContain(id);
      expect(entry.modelReasoningEfforts?.[id]).toEqual([]);
    }
    expect(entry.modelInputModalities?.["moonshotai/kimi-k2.5"]).toEqual(["text", "image"]);
    expect(entry.noVisionModels).toContain("moonshotai/kimi-k2-thinking");
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
