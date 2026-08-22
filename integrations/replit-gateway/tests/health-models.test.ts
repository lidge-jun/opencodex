import { describe, expect, test } from "bun:test";
import { GATEWAY_CONTRACT_VERSION } from "../src/constants";
import { createGatewayServer } from "../src/server/create-server";
import { createTestGatewayConfig, TEST_GATEWAY_KEY } from "./helpers/test-config";

describe("gateway transport routes", () => {
  test("GET /healthz returns ok without authentication", async () => {
    const server = createGatewayServer(createTestGatewayConfig());
    const res = await server.fetch(new Request("https://gateway.test/healthz"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.contractVersion).toBe(GATEWAY_CONTRACT_VERSION);
    await server.stop();
  });

  test("GET /v1/models returns configured OpenAI allowlist", async () => {
    const server = createGatewayServer(createTestGatewayConfig({
      openaiModels: ["gpt-4o", "gpt-4o-mini"],
    }));
    const res = await server.fetch(new Request("https://gateway.test/v1/models", {
      headers: { Authorization: `Bearer ${TEST_GATEWAY_KEY}` },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data).toEqual([
      { id: "gpt-4o", object: "model" },
      { id: "gpt-4o-mini", object: "model" },
    ]);
    await server.stop();
  });
});
