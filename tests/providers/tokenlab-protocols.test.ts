/**
 * TokenLab per-model wires (mail from TokenLab, 2026-09-30; devlog/_plan/260930_gpt_6_1_sol_rollout/040).
 *
 * TokenLab publishes each model's accepted request formats in `tokenlab.accepted_request_formats`
 * on GET /v1/models/{id}. The released preset stays on Chat, which every model accepts. Models that
 * also declare Responses use it for Codex (Responses inbound); Claude models declare Anthropic
 * Messages and ride it on every inbound through the endpoint-bound prefix pin; Gemini 3.8 Flash
 * (Chat + Gemini native) stays on Chat. The end-to-end cases assert the captured upstream URL,
 * because a resolver-only test would pass even if the handleResponses replay flipped the wire back.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../src/adapters/anthropic";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const BASE_URL = "https://api.tokenlab.sh/v1";
const RESPONSES_MODELS = [
  "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "grok-4.7",
  "deepseek-v4.1-flash", "deepseek-v4-pro", "kimi-k3", "glm-5.3",
] as const;
const CLAUDE_MODELS = [
  "claude-opus-5", "claude-opus-5-5", "claude-sonnet-5", "claude-sonnet-5-5", "claude-fable-5", "claude-fable-5-1",
] as const;
const INBOUNDS = ["responses", "chat", "anthropic"] as const;

function tokenlab(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { ...providerConfigSeed(getProviderRegistryEntry("tokenlab")!), apiKey: "test-key", ...overrides };
}

function wire(model: string, inbound: typeof INBOUNDS[number], provider = tokenlab()): string {
  return resolveWireProtocolOverride("tokenlab", model, provider, inbound).adapter;
}

describe("TokenLab resolves each model to its declared wire", () => {
  test("the provider-wide adapter stays the released Chat preset", () => {
    expect(tokenlab()).toMatchObject({ adapter: "openai-chat", baseUrl: BASE_URL });
  });

  test.each(RESPONSES_MODELS)("%s rides Responses for Codex and Chat for Chat or Anthropic clients", model => {
    expect(wire(model, "responses")).toBe("openai-responses");
    expect(wire(model, "chat")).toBe("openai-chat");
    expect(wire(model, "anthropic")).toBe("openai-chat");
  });

  test.each(CLAUDE_MODELS)("%s rides Anthropic Messages on every inbound", model => {
    for (const inbound of INBOUNDS) expect(wire(model, inbound)).toBe("anthropic");
  });

  test("a Claude id TokenLab adds later is covered by the prefix, case-insensitively", () => {
    expect(wire("claude-haiku-4-5", "responses")).toBe("anthropic");
    expect(wire("Claude-Sonnet-5-5", "chat")).toBe("anthropic");
  });

  test("Gemini 3.8 Flash and undeclared models stay on Chat", () => {
    for (const model of ["gemini-3.8-flash", "gpt-5.6-terra", "doubao-seed-2.1-pro"]) {
      for (const inbound of INBOUNDS) expect(wire(model, inbound)).toBe("openai-chat");
    }
  });

  test("an explicit modelAdapters entry beats a Responses default", () => {
    const provider = tokenlab({ modelAdapters: { "gpt-6.1-sol": "openai-chat" } });
    expect(wire("gpt-6.1-sol", "responses", provider)).toBe("openai-chat");
    expect(wire("gpt-6-sol", "responses", provider)).toBe("openai-responses");
  });

  test("a retargeted TokenLab row keeps Claude on its own wire", () => {
    const custom = tokenlab({ baseUrl: "https://gateway.example.test/v1" });
    expect(wire("claude-sonnet-5-5", "responses", custom)).toBe("openai-chat");
  });

  test("builds Claude requests on TokenLab's Messages endpoint with the provider key", async () => {
    const provider = resolveWireProtocolOverride("tokenlab", "claude-sonnet-5-5", tokenlab(), "responses");
    const request = await createAnthropicAdapter(provider).buildRequest({
      modelId: "claude-sonnet-5-5",
      context: { messages: [{ role: "user", content: "hello" }], tools: [] },
      stream: true,
      options: {},
    });
    expect(request.url).toBe("https://api.tokenlab.sh/v1/messages");
    expect(new Headers(request.headers).get("x-api-key")).toBe("test-key");
    // Delivery policy stays with the API key: no policy header is forced.
    expect(new Headers(request.headers).has("x-tokenlab-delivery-policy")).toBe(false);
  });
});

describe("TokenLab wires survive the handleResponses replay", () => {
  const originalFetch = globalThis.fetch;
  let releaseSpendHome: (() => void) | undefined;

  afterEach(() => {
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    globalThis.fetch = originalFetch;
  });

  async function upstream(model: string, inboundWire: typeof INBOUNDS[number]): Promise<{ url: string; headers: Headers }> {
    const seen: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    releaseSpendHome ??= acquireOwnedSpendHome();
    const config = { providers: { tokenlab: tokenlab() } } as unknown as OcxConfig;
    await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `tokenlab/${model}`, input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      { inboundWire },
    );
    return seen[0] ?? { url: "", headers: new Headers() };
  }

  test("gpt-6.1-sol reaches /v1/responses for Codex", async () => {
    expect((await upstream("gpt-6.1-sol", "responses")).url).toBe(`${BASE_URL}/responses`);
  });

  test("gpt-6.1-sol keeps /v1/chat/completions for a Chat client", async () => {
    expect((await upstream("gpt-6.1-sol", "chat")).url).toBe(`${BASE_URL}/chat/completions`);
  });

  test("claude-sonnet-5-5 reaches /v1/messages", async () => {
    const seen = await upstream("claude-sonnet-5-5", "responses");
    expect(seen.url).toBe(`${BASE_URL}/messages`);
    expect(seen.headers.get("x-api-key")).toBe("test-key");
  });

  test("gemini-3.8-flash keeps /v1/chat/completions for Codex", async () => {
    expect((await upstream("gemini-3.8-flash", "responses")).url).toBe(`${BASE_URL}/chat/completions`);
  });
});

