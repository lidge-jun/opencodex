import { expect, test } from "bun:test";
import { routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";

test("routing preserves resolved user URLs only for registry template providers", () => {
  const config: OcxConfig = {
    port: 10100,
    defaultProvider: "azure-openai",
    providers: {
      "azure-openai": {
        adapter: "azure-openai",
        baseUrl: "https://myres.openai.azure.com/openai",
        apiKey: "azure-key",
      },
      "cloudflare-ai-gateway": {
        adapter: "anthropic",
        baseUrl: "https://gateway.ai.cloudflare.com/v1/my-account/my-gateway/anthropic",
        apiKey: "cloudflare-key",
      },
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://user-supplied.example.test/anthropic",
        apiKey: "anthropic-key",
      },
    },
  };

  expect(routeModel(config, "azure-openai/deployment").provider.baseUrl)
    .toBe("https://myres.openai.azure.com/openai");
  expect(routeModel(config, "cloudflare-ai-gateway/claude-sonnet-5").provider.baseUrl)
    .toBe("https://gateway.ai.cloudflare.com/v1/my-account/my-gateway/anthropic");
  expect(routeModel(config, "anthropic/claude-sonnet-5").provider.baseUrl)
    .toBe("https://api.anthropic.com");
});
