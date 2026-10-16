import { afterEach, describe, expect, test } from "bun:test";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { captureRouteStaticPolicy, routedProviderConfig } from "../../src/router";
import { fastPolicyForModel } from "../../src/providers/service-tier";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const BASES = ["https://opencode.ai/zen/go/v1", "https://opencode.ai/inference/go/v1", "https://custom.invalid/v1"];
const ROUTES = [
  ["gpt-6-luna", "openai-responses", "responses"],
  ["gpt-5.6-luna", "openai-responses", "responses"],
  ["claude-haiku-5-5", "anthropic", "messages"],
  ["glm-5.2", "openai-chat", "chat/completions"],
  ["qwen3.7-plus", "anthropic", "messages"],
  ["qwen3.8-max", "anthropic", "messages"],
  ["qwen3.8-flash", "anthropic", "messages"],
] as const;
function go(baseUrl = BASES[0]): OcxProviderConfig {
  return { ...providerConfigSeed(getProviderRegistryEntry("opencode-go")!), apiKey: "test-key", baseUrl: baseUrl! };
}

describe("OpenCode Go documented per-model protocols (2026-10-15)", () => {
  for (const baseUrl of BASES) for (const [model, adapter] of ROUTES) test(`${model} resolves consistently (${baseUrl})`, () => {
    const provider = routedProviderConfig("opencode-go", go(baseUrl));
    expect(provider.baseUrl).toBe(BASES[0]!);
    for (const inbound of ["responses", "chat", "anthropic"] as const) {
      expect(resolveWireProtocolOverride("opencode-go", model, provider, inbound).adapter).toBe(adapter);
      expect(captureRouteStaticPolicy("opencode-go", model, provider, undefined, inbound).model.adapter).toBe(adapter);
      expect(fastPolicyForModel(provider, model, "opencode-go", inbound).adapter).toBe(adapter);
    }
  });

  for (const model of ["qwen3.7-plus", "qwen3.8-max", "qwen3.8-flash"]) {
    test(`${model} does not pin differently named custom providers or non-key auth`, () => {
      for (const overrides of [{ baseUrl: "https://custom.invalid/v1" }, { authMode: "oauth" }, { authMode: "forward" }] as const) {
        const provider = { ...go(), ...overrides, modelAdapters: { [model]: "openai-responses" } };
        const name = "baseUrl" in overrides ? "custom-go" : "opencode-go";
        expect(resolveWireProtocolOverride(name, model, provider).adapter).toBe("openai-responses");
        expect(captureRouteStaticPolicy(name, model, provider).model.adapter).toBe("openai-responses");
        expect(fastPolicyForModel(provider, model, name).adapter).toBe("openai-responses");
      }
    });
  }

  test("Luna retains an explicit Chat opt-out and unknown siblings remain Chat", () => {
    const provider = { ...go(), modelAdapters: { "gpt-6-luna": "openai-chat" } };
    expect(resolveWireProtocolOverride("opencode-go", "gpt-6-luna", provider).adapter).toBe("openai-chat");
    for (const model of ["qwen-next", "gemini-next", "gpt-next", "glm-5.3-flash"])
      expect(resolveWireProtocolOverride("opencode-go", model, go()).adapter).toBe("openai-chat");
  });
});

const originalFetch = globalThis.fetch;
let releaseSpendHome: (() => void) | undefined;
afterEach(() => { globalThis.fetch = originalFetch; releaseSpendHome?.(); releaseSpendHome = undefined; });
for (const baseUrl of BASES) for (const [model, adapter, path] of ROUTES) test(`${model} dispatches ${path} (${baseUrl})`, async () => {
  releaseSpendHome = acquireOwnedSpendHome();
  const requests: Array<{ url: string; body: any; headers: Headers }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return Response.json(adapter === "anthropic"
      ? { id: "msg_fixture", type: "message", role: "assistant", model, content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 1 } }
      : adapter === "openai-chat"
        ? { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }
      : { id: "resp_fixture", object: "response", status: "completed", model,
        output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } });
  }) as typeof fetch;
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", "thread-id": "protocol-fixture" },
    body: JSON.stringify({ model: `opencode-go/${model}`, input: "ping", stream: false }),
  }), { providers: { "opencode-go": go(baseUrl) } } as OcxConfig, { model: "", provider: "" });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("ok");
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe(`${BASES[0]}/${path}`);
  expect(requests[0]!.body.model).toBe(model);
  if (adapter === "anthropic") expect(requests[0]!.headers.get("x-api-key")).toBe("test-key");
  else expect(requests[0]!.headers.get("authorization")).toBe("Bearer test-key");
  expect(requests[0]!.headers.get("x-opencode-session")).toMatch(/^ocx_[a-f0-9]{32}$/);
  if (adapter !== "openai-responses") expect(requests[0]!.body.messages[0].role).toBe("user");
  else expect(requests[0]!.body.input).toBeDefined();
});
