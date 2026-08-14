import { expect, test } from "bun:test";
import { safeConfigDTO } from "../src/server/auth-cors";
import type { OcxConfig } from "../src/types";

test("renamed provider does not inherit another preset static discovery capability", () => {
  const dto = safeConfigDTO({
    port: 10100,
    defaultProvider: "my-cline",
    providers: {
      "my-cline": {
        adapter: "openai-chat",
        baseUrl: "https://api.cline.bot/api/v1",
        authMode: "key",
        liveModels: true,
        models: ["anthropic/claude-sonnet-4-6"],
      },
    },
  } as OcxConfig) as {
    providers: Record<string, { liveModels?: boolean; liveModelDiscoverySupported?: boolean }>;
  };

  expect(dto.providers["my-cline"]?.liveModels).toBe(true);
  expect(dto.providers["my-cline"]?.liveModelDiscoverySupported).not.toBe(false);
});
