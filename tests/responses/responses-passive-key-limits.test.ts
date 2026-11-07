import { afterEach, expect, test } from "bun:test";
import { getDefaultConfig } from "../../src/config";
import { handleResponses } from "../../src/server/responses/core";
import { getPassiveKeyLimits } from "../../src/providers/passive-key-observation";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("Responses dispatch records canonical key headers for the physical wire model", async () => {
  const config = getDefaultConfig();
  config.defaultProvider = "fixture";
  config.defaultModel = "wire-model";
  config.providers = { fixture: { adapter: "openai-chat", baseUrl: "https://api.groq.com/openai/v1",
    authMode: "key", apiKey: "synthetic-key", models: ["wire-model"], liveModels: false } };
  let sends = 0;
  globalThis.fetch = (async (_input, init) => {
    sends++;
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-key");
    expect(JSON.parse(String(init?.body)).model).toBe("wire-model");
    return Response.json({ id: "synthetic", object: "chat.completion", model: "wire-model",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] },
    { headers: { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "42" } });
  }) as typeof fetch;
  const req = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture/wire-model", input: "synthetic", stream: false, store: false }) });
  const response = await handleResponses(req, config, { provider: "fixture", model: "wire-model" }, {});
  await response.text();
  expect(sends).toBe(1);
  expect(getPassiveKeyLimits(config, "fixture", "wire-model")).toMatchObject([{ dimension: "requests", limit: 100, remaining: 42 }]);
});
