import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter, buildOpenAIChatPassthroughRequest } from "../src/adapters/openai-chat";
import {
  vercelGatewayRoutingConfigError,
  vercelGatewayProviderPayload,
} from "../src/providers/vercel-gateway-routing";
import { fastPolicyForModel } from "../src/providers/service-tier";
import { providerManagementConfigError, safeConfigDTO } from "../src/server/auth-cors";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../src/types";

function provider(baseUrl: string, overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { adapter: "openai-chat", baseUrl, apiKey: "test-key", ...overrides };
}

function parsed(modelId: string, stream = false): OcxParsedRequest {
  return {
    modelId,
    stream,
    context: { messages: [{ role: "user", content: "hello" }], tools: [] },
    options: {},
  };
}

function body(baseUrl: string, modelId: string, overrides: Partial<OcxProviderConfig> = {}, stream = false): Record<string, unknown> {
  const request = createOpenAIChatAdapter(provider(baseUrl, overrides)).buildRequest(parsed(modelId, stream));
  return JSON.parse(request.body as string) as Record<string, unknown>;
}

function passthroughBody(
  providerConfig: OcxProviderConfig,
  modelId: string,
  rawBody: Record<string, unknown> = {},
): Record<string, unknown> {
  const request = buildOpenAIChatPassthroughRequest(providerConfig, {
    messages: [{ role: "user", content: "hello" }],
    ...rawBody,
  }, modelId, false, fastPolicyForModel(providerConfig, modelId, undefined, "chat"));
  return JSON.parse(request.body as string) as Record<string, unknown>;
}

describe("Vercel AI Gateway configurable provider routing (#1406)", () => {
  const vercelLock = { vercelGatewayRouting: { only: ["novita"], sort: "ttft" as const } };

  test("maps the default preference to Vercel's wire format", () => {
    expect(body("https://ai-gateway.vercel.sh/v1", "zai/glm-5.2", vercelLock).provider).toEqual({
      only: ["novita"], sort: "ttft",
    });
  });

  test("an exact model preference replaces the provider-wide default", () => {
    const requestBody = body("https://ai-gateway.vercel.sh/v1", "zai/glm-5.2", {
      vercelGatewayRouting: { order: ["novita"], sort: "cost" },
      modelVercelGatewayRouting: {
        "zai/glm-5.2": { only: ["deepinfra"], order: ["deepinfra"] },
      },
    });
    expect(requestBody.provider).toEqual({
      only: ["deepinfra"], order: ["deepinfra"],
    });
  });

  test("a model without an override inherits the default preference", () => {
    const requestBody = body("https://ai-gateway.vercel.sh/v1", "other/model", {
      vercelGatewayRouting: { only: ["novita"], sort: "tps" },
      modelVercelGatewayRouting: {
        "zai/glm-5.2": { only: ["deepinfra"] },
      },
    });
    expect(requestBody.provider).toEqual({
      only: ["novita"], sort: "tps",
    });
  });

  test("requests without routing configuration omit the provider field", () => {
    expect(body("https://ai-gateway.vercel.sh/v1", "zai/glm-5.2").provider).toBeUndefined();
  });

  test("passthrough request builder applies the routing preference", () => {
    const requestBody = passthroughBody(
      provider("https://ai-gateway.vercel.sh/v1", { vercelGatewayRouting: { order: ["novita", "deepinfra"] } }),
      "zai/glm-5.2",
    );
    expect(requestBody.provider).toEqual({
      order: ["novita", "deepinfra"],
    });
  });

  test("config validation accepts valid default and model preferences", () => {
    expect(vercelGatewayRoutingConfigError(provider("https://ai-gateway.vercel.sh/v1", {
      vercelGatewayRouting: { order: ["novita"], only: ["novita"], sort: "cost" },
      modelVercelGatewayRouting: {
        "zai/glm-5.2": { only: ["deepinfra"] },
      },
    }))).toBeNull();
  });

  test("config validation rejects non-canonical baseUrls", () => {
    expect(vercelGatewayRoutingConfigError(provider("https://custom-gateway.test/v1", {
      vercelGatewayRouting: { only: ["novita"] },
    }))).toBe("Vercel AI Gateway routing preferences require the canonical https://ai-gateway.vercel.sh/v1 baseUrl");
  });

  test("config validation rejects non-openai-chat adapter", () => {
    expect(vercelGatewayRoutingConfigError({
      adapter: "openai-responses",
      baseUrl: "https://ai-gateway.vercel.sh/v1",
      vercelGatewayRouting: { only: ["novita"] },
    })).toBe("Vercel AI Gateway routing preferences require the openai-chat adapter");
  });

  test.each([
    ["an empty preference", { vercelGatewayRouting: {} }, "must define order, only, or sort"],
    ["an empty allowlist", { vercelGatewayRouting: { only: [] } }, "must contain 1-64 provider slugs"],
    ["duplicate slugs", { vercelGatewayRouting: { only: ["novita", "novita"] } }, "must not contain duplicate"],
    ["untrimmed slugs", { vercelGatewayRouting: { order: [" novita"] } }, "nonblank trimmed provider slugs"],
    ["an invalid sort value", { vercelGatewayRouting: { sort: "invalid" as never } }, 'must be "cost", "ttft", or "tps"'],
    ["unknown fields", { vercelGatewayRouting: { only: ["novita"], typo: true } }, "unknown field"],
  ])("config validation rejects %s", (_, override, expected) => {
    const error = vercelGatewayRoutingConfigError(provider(
      "https://ai-gateway.vercel.sh/v1",
      override as Partial<OcxProviderConfig>,
    ));
    expect(error).not.toBeNull();
    expect(error).toContain(expected);
  });

  test("safeConfigDTO preserves vercelGatewayRouting in management responses", () => {
    const config: OcxConfig = {
      port: 10100,
      providers: {
        "vercel-ai-gateway": {
          adapter: "openai-chat",
          baseUrl: "https://ai-gateway.vercel.sh/v1",
          apiKey: "secret",
          vercelGatewayRouting: { only: ["novita"], sort: "ttft" },
          modelVercelGatewayRouting: {
            "zai/glm-5.2": { order: ["novita", "deepinfra"] },
          },
        },
      },
    };
    const dto = safeConfigDTO(config);
    expect(dto.providers?.["vercel-ai-gateway"]?.vercelGatewayRouting).toEqual({
      only: ["novita"], sort: "ttft",
    });
    expect(dto.providers?.["vercel-ai-gateway"]?.modelVercelGatewayRouting).toEqual({
      "zai/glm-5.2": { order: ["novita", "deepinfra"] },
    });
  });
});
