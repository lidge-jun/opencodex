import { expect, test } from "bun:test";
import { handleManagementAPI, type ManagementApiDeps } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { ManagementRequest as Request } from "./helpers/management-auth";
import { startupHealthFixture } from "./helpers/startup-health";

function baseConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-secret-value",
        defaultModel: "gpt-test",
      },
    },
  };
}

test("settings PUT uses the injected startup-health reader", async () => {
  const config = baseConfig();
  let reads = 0;
  const expectedHealth = startupHealthFixture({ diagnosticStale: true });
  const deps: ManagementApiDeps = {
    saveConfigPreservingClaudeCode: () => {},
    getCachedStartupHealth: async () => {
      reads += 1;
      return expectedHealth;
    },
  };
  const req = new Request("http://127.0.0.1:10100/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ streamMode: "eager-relay" }),
  });

  const response = await handleManagementAPI(req, new URL(req.url), config, deps);

  expect(response?.status).toBe(200);
  expect(reads).toBe(1);
  expect(await response!.json()).toMatchObject({
    startupHealth: { diagnosticStale: true, status: "native" },
  });
});
