import { expect, test } from "bun:test";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const OVERRIDE_PROVIDERS = [
  { id: "ollama", registryBaseUrl: "http://localhost:11434/v1" },
  { id: "vllm", registryBaseUrl: "http://localhost:8000/v1" },
  { id: "lm-studio", registryBaseUrl: "http://localhost:1234/v1" },
  {
    id: "alibaba-token-plan",
    registryBaseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  },
  {
    id: "cloudflare-workers-ai",
    registryBaseUrl: "https://api.cloudflare.com/client/v4/accounts/my-account/ai/v1",
  },
  { id: "litellm", registryBaseUrl: "http://localhost:4000/v1" },
] as const;

function configFor(providerName: string, provider: OcxProviderConfig): OcxConfig {
  return {
    port: 10100,
    defaultProvider: providerName,
    providers: { [providerName]: provider },
  };
}

for (const { id, registryBaseUrl } of OVERRIDE_PROVIDERS) {
  test(`${id} trims and preserves a configured base URL override`, () => {
    const override = `https://${id}.example.test/v1`;
    const config = configFor(id, {
      adapter: "openai-chat",
      baseUrl: `  ${override}  `,
    });

    expect(routeModel(config, `${id}/model`).provider.baseUrl).toBe(override);
  });

  test(`${id} accepts its resolved registry-default base URL`, () => {
    const config = configFor(id, {
      adapter: "openai-chat",
      baseUrl: registryBaseUrl,
    });

    expect(routeModel(config, `${id}/model`).provider.baseUrl).toBe(registryBaseUrl);
  });

  for (const [label, invalidBaseUrl] of [
    ["blank", ""],
    ["whitespace-only", "   \t"],
    ["unresolved placeholder", "http://{host}:8000/v1"],
  ] as const) {
    test(`${id} rejects a ${label} override instead of falling back`, () => {
      const config = configFor(id, {
        adapter: "openai-chat",
        baseUrl: invalidBaseUrl,
      });

      expect(() => routeModel(config, `${id}/model`))
        .toThrow(`Invalid baseUrl for provider "${id}": expected a nonblank URL without unresolved placeholders`);
    });
  }
}

for (const { id, registryBaseUrl, adapter } of [
  { id: "ollama-cloud", registryBaseUrl: "https://ollama.com/v1", adapter: "openai-chat" },
  { id: "anthropic", registryBaseUrl: "https://api.anthropic.com", adapter: "anthropic" },
] as const) {
  test(`${id} keeps its fixed remote registry endpoint authoritative`, () => {
    const config = configFor(id, {
      adapter,
      baseUrl: "https://user-supplied.example.test/v1",
    });

    expect(routeModel(config, `${id}/model`).provider.baseUrl).toBe(registryBaseUrl);
  });
}

for (const { id, adapter, registryTemplate, resolvedBaseUrl } of [
  {
    id: "azure-openai",
    adapter: "azure-openai",
    registryTemplate: "https://{resource}.openai.azure.com/openai",
    resolvedBaseUrl: "https://myres.openai.azure.com/openai",
  },
  {
    id: "cloudflare-ai-gateway",
    adapter: "anthropic",
    registryTemplate: "https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic",
    resolvedBaseUrl: "https://gateway.ai.cloudflare.com/v1/my-account/my-gateway/anthropic",
  },
] as const) {
  test(`${id} keeps resolved template behavior unchanged`, () => {
    const config = configFor(id, {
      adapter,
      baseUrl: `  ${resolvedBaseUrl}  `,
    });

    expect(routeModel(config, `${id}/model`).provider.baseUrl).toBe(resolvedBaseUrl);
  });

  test(`${id} keeps unresolved template fallback behavior unchanged`, () => {
    const config = configFor(id, {
      adapter,
      baseUrl: registryTemplate,
    });

    expect(routeModel(config, `${id}/model`).provider.baseUrl).toBe(registryTemplate);
  });
}
