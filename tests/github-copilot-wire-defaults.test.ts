/**
 * GitHub Copilot fronts a MIXED-wire catalog: several newer OpenAI models reject
 * /chat/completions for real Codex-agent traffic (function tools + reasoning), so the
 * registry declares them Responses-only via `modelWireDefaults` while the provider-wide
 * adapter stays openai-chat for the chat-served catalog (issue #748, PR #746 family).
 *
 * The resolver-only cases would pass even if the handleResponses replay silently
 * flipped the wire back, so the end-to-end cases assert the captured upstream URL —
 * the externally observable wire. Pattern mirrors tests/deepseek-inbound-wire.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { resolveWireProtocolOverride } from "../src/server/adapter-resolve";
import { handleResponses } from "../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const RESPONSES_ONLY = [
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
] as const;

const CHAT_SERVED = ["gpt-4o", "gpt-4.1", "gpt-4.1-mini", "claude-sonnet-4", "gemini-2.5-pro", "gpt-5-mini"] as const;

const INBOUNDS = ["responses", "chat", "anthropic"] as const;

function copilotProvider(): OcxProviderConfig {
  // The entry's allowKeyAuthOverride lets tests use key auth instead of live OAuth.
  return { ...providerConfigSeed(getProviderRegistryEntry("github-copilot")!), authMode: "key", apiKey: "sk-test" };
}

describe("Copilot Responses-only models ride Responses on every inbound", () => {
  for (const model of RESPONSES_ONLY) {
    test(`${model} resolves to openai-responses for all inbounds`, () => {
      for (const inbound of INBOUNDS) {
        expect(resolveWireProtocolOverride("github-copilot", model, copilotProvider(), inbound).adapter)
          .toBe("openai-responses");
      }
    });
  }
});

describe("Copilot chat-served models stay on the provider chat wire", () => {
  for (const model of CHAT_SERVED) {
    test(`${model} resolves to openai-chat for all inbounds`, () => {
      for (const inbound of INBOUNDS) {
        expect(resolveWireProtocolOverride("github-copilot", model, copilotProvider(), inbound).adapter)
          .toBe("openai-chat");
      }
    });
  }
});

describe("explicit modelAdapters beat the registry default in both directions", () => {
  test("opt-out: a listed Responses-default model pinned back to chat", () => {
    const provider = { ...copilotProvider(), modelAdapters: { "gpt-5.4": "openai-chat" } };
    for (const inbound of INBOUNDS) {
      expect(resolveWireProtocolOverride("github-copilot", "gpt-5.4", provider, inbound).adapter)
        .toBe("openai-chat");
    }
  });

  test("opt-in: an unlisted model mapped to Responses (the gpt-5.4-nano escape hatch)", () => {
    const provider = { ...copilotProvider(), modelAdapters: { "gpt-5.4-nano": "openai-responses" } };
    for (const inbound of INBOUNDS) {
      expect(resolveWireProtocolOverride("github-copilot", "gpt-5.4-nano", provider, inbound).adapter)
        .toBe("openai-responses");
    }
  });

  test("opt-in on a seeded chat model also wins", () => {
    const provider = { ...copilotProvider(), modelAdapters: { "gpt-5-mini": "openai-responses" } };
    expect(resolveWireProtocolOverride("github-copilot", "gpt-5-mini", provider, "responses").adapter)
      .toBe("openai-responses");
  });
});

describe("the registry default is isolated to the copilot provider", () => {
  test("a same-named model on another provider is untouched", () => {
    const other: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://example.com/v1", apiKey: "sk-test" };
    for (const inbound of INBOUNDS) {
      expect(resolveWireProtocolOverride("some-custom", "gpt-5.4", other, inbound).adapter)
        .toBe("openai-chat");
    }
  });

  test("resolution preserves credentials and base URL through the copy", () => {
    const resolved = resolveWireProtocolOverride("github-copilot", "gpt-5.4", copilotProvider(), "responses");
    expect(resolved.adapter).toBe("openai-responses");
    expect(resolved.apiKey).toBe("sk-test");
    expect(resolved.baseUrl).toBe("https://api.githubcopilot.com");
  });
});

describe("the wire default survives the handleResponses replay", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  function captureUpstreamUrl(): string[] {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    return urls;
  }

  async function drive(model: string, inboundWire?: "responses" | "chat" | "anthropic"): Promise<string> {
    const urls = captureUpstreamUrl();
    const config = { providers: { "github-copilot": copilotProvider() } } as unknown as OcxConfig;
    await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Provider-prefixed ids: bare gpt-* ids route to the canonical openai
        // provider family before provider-level wire defaults can apply.
        body: JSON.stringify({ model: `github-copilot/${model}`, input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      inboundWire === undefined ? {} : { inboundWire },
    );
    return urls[0] ?? "";
  }

  test("gpt-5.4 reaches the Responses endpoint, never /chat/completions", async () => {
    const url = await drive("gpt-5.4", "responses");
    expect(url).toContain("/responses");
    expect(url).not.toContain("/chat/completions");
  });

  test("gpt-5.6-sol reaches the Responses endpoint on a chat inbound replay", async () => {
    const url = await drive("gpt-5.6-sol", "chat");
    expect(url).toContain("/responses");
    expect(url).not.toContain("/chat/completions");
  });

  test("gpt-4o still reaches /chat/completions", async () => {
    expect(await drive("gpt-4o", "responses")).toBe("https://api.githubcopilot.com/chat/completions");
  });

  test("gpt-5-mini still reaches /chat/completions", async () => {
    expect(await drive("gpt-5-mini", "anthropic")).toBe("https://api.githubcopilot.com/chat/completions");
  });
});
