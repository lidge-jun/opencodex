import { expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

test("direct translated Chat rejects an unrepresentable computer_use choice before send", async () => {
  let sends = 0;
  const provider: OcxProviderConfig = {
    adapter: "openai-chat",
    baseUrl: "https://chat.fixture.invalid/v1",
    apiKey: "fixture-key",
    fetch: (async () => {
      sends += 1;
      throw new Error("unexpected upstream send");
    }) as typeof fetch,
  };
  const config = {
    port: 0,
    defaultProvider: "fixture",
    providers: { fixture: provider },
  } as OcxConfig;
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fixture/model",
      input: "Use the computer only.",
      tools: [
        { type: "computer_use" },
        { type: "function", name: "shell", parameters: { type: "object", properties: {} } },
      ],
      tool_choice: { type: "computer_use" },
    }),
  }), config, { model: "", provider: "" });

  expect(response.status).toBe(400);
  expect(await response.text()).toContain("mandatory tool_choice cannot be preserved");
  expect(sends).toBe(0);
});
