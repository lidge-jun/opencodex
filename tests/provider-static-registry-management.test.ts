import { describe, expect, test } from "bun:test";
import { clearModelCache, markProviderDiscoveryFailed } from "../src/codex/model-cache";
import { handleManagementAPI } from "../src/server/management-api";
import { ManagementRequest as Request } from "./helpers/management-auth";

describe("static-only provider management", () => {
  test("provider list repairs registry metadata without replacing saved models", async () => {
    markProviderDiscoveryFailed("mimo-free", { reason: "http", httpStatus: 400 });
    markProviderDiscoveryFailed("cline-pass", { reason: "http", httpStatus: 404 });
    try {
      const requestUrl = new URL("http://127.0.0.1/api/providers");
      const response = await handleManagementAPI(
        new Request(requestUrl),
        requestUrl,
        {
          port: 10100,
          defaultProvider: "mimo-free",
          providers: {
            "mimo-free": {
              adapter: "mimo-free",
              baseUrl: "https://api.xiaomimimo.com/api/free-ai/openai/chat",
              authMode: "local",
              liveModels: true,
              models: ["mimo-auto", "preview-model"],
            },
            "cline-pass": {
              adapter: "openai-chat",
              baseUrl: "https://api.cline.bot/api/v1",
              authMode: "key",
              liveModels: true,
              models: ["cline-pass/kimi-k3"],
            },
          },
        },
      );
      const providers = await response!.json() as Array<Record<string, unknown>>;

      expect(providers.find(provider => provider.name === "mimo-free")).toMatchObject({
        authMode: "key",
        liveModels: false,
        liveModelDiscoverySupported: false,
        models: ["mimo-auto", "preview-model"],
      });
      expect(providers.find(provider => provider.name === "mimo-free")).not.toHaveProperty("discovery");
      expect(providers.find(provider => provider.name === "cline-pass")).toMatchObject({
        liveModels: false,
        liveModelDiscoverySupported: false,
        models: ["cline-pass/kimi-k3"],
      });
      expect(providers.find(provider => provider.name === "cline-pass")).not.toHaveProperty("discovery");
    } finally {
      clearModelCache();
    }
  });
});
