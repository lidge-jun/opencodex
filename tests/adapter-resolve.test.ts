/**
 * Issue #404: one OpenAI-compatible gateway can front models that speak different
 * wires. Grok needs the Responses API for hosted web_search; a sibling model on the
 * same provider is fine on chat completions. Without a per-model override the
 * provider-wide adapter wins and the hosted tool is dropped on the way out.
 */
import { describe, expect, test } from "bun:test";
import { resolveWireProtocolOverride } from "../src/server/adapter-resolve";
import type { OcxProviderConfig } from "../src/types";

function gateway(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://gateway.example/v1",
    authMode: "key",
    apiKey: "test-key",
    ...overrides,
  } as OcxProviderConfig;
}

describe("per-model wire override (#404)", () => {
  test("selects the responses wire for the configured model only", () => {
    const provider = gateway({ modelAdapters: { "grok-4.5": "openai-responses" } });

    expect(resolveWireProtocolOverride("localmodels", "grok-4.5", provider).adapter)
      .toBe("openai-responses");
    // A sibling model on the same provider keeps the provider default.
    expect(resolveWireProtocolOverride("localmodels", "gemini-3-pro", provider).adapter)
      .toBe("openai-chat");
  });

  test("a provider without the field behaves exactly as before", () => {
    expect(resolveWireProtocolOverride("localmodels", "grok-4.5", gateway()).adapter)
      .toBe("openai-chat");
  });

  test("does not mutate the provider it was given", () => {
    const provider = gateway({ modelAdapters: { "grok-4.5": "openai-responses" } });
    const resolved = resolveWireProtocolOverride("localmodels", "grok-4.5", provider);

    expect(provider.adapter).toBe("openai-chat");
    // Credentials and destination must survive a wire swap untouched.
    expect(resolved.apiKey).toBe("test-key");
    expect(resolved.authMode).toBe("key");
    expect(resolved.baseUrl).toBe("https://gateway.example/v1");
  });

  test("a hard-pinned model ignores the override", () => {
    const provider = gateway({
      adapter: "openai-chat",
      modelAdapters: { "minimax-m3": "openai-chat" },
    });

    expect(resolveWireProtocolOverride("opencode-go", "minimax-m3", provider).adapter)
      .toBe("anthropic");
  });

  test("a pinned model survives a second resolve pass", () => {
    // The resolver runs twice per request (route time and adapter build). A pin check
    // phrased against the current adapter would pass the first time and then let the
    // override win on the second.
    const provider = gateway({ modelAdapters: { "minimax-m3": "openai-chat" } });
    const once = resolveWireProtocolOverride("opencode-go", "minimax-m3", provider);
    const twice = resolveWireProtocolOverride("opencode-go", "minimax-m3", once);

    expect(once.adapter).toBe("anthropic");
    expect(twice.adapter).toBe("anthropic");
  });

  test("values outside the allowed wires are ignored at resolve time", () => {
    // Hand-edited config, or one written by a build that allowed more values.
    for (const disallowed of ["cursor", "kiro", "google", "anthropic"]) {
      const provider = gateway({ modelAdapters: { "grok-4.5": disallowed } });
      expect(resolveWireProtocolOverride("localmodels", "grok-4.5", provider).adapter)
        .toBe("openai-chat");
    }
  });

  test("a canonical forward provider never takes an override", () => {
    // The chat adapter only sends provider.apiKey, so switching wires here would drop
    // the caller's forwarded credential entirely.
    const forward = gateway({
      adapter: "openai-responses",
      authMode: "forward",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      modelAdapters: { "gpt-5.5": "openai-chat" },
    });

    expect(resolveWireProtocolOverride("openai", "gpt-5.5", forward).adapter)
      .toBe("openai-responses");
  });
});

describe("registry per-model wire defaults", () => {
  function xai(authMode: "oauth" | "key", overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
    return gateway({
      baseUrl: "https://api.x.ai/v1",
      authMode,
      ...overrides,
    });
  }

  test("keeps current xAI subscription models on Chat by default", () => {
    for (const model of ["grok-4.6", "grok-4.5"]) {
      expect(resolveWireProtocolOverride("xai", model, xai("oauth"), "responses").adapter)
        .toBe("openai-chat");
    }
  });

  test("keeps xAI key auth and translated callers on their existing Chat wire", () => {
    expect(resolveWireProtocolOverride("xai", "grok-4.6", xai("key"), "responses").adapter)
      .toBe("openai-chat");
    expect(resolveWireProtocolOverride("xai", "grok-4.6", xai("oauth"), "chat").adapter)
      .toBe("openai-chat");
    expect(resolveWireProtocolOverride("xai", "grok-4.6", xai("oauth"), "anthropic").adapter)
      .toBe("openai-chat");
    expect(resolveWireProtocolOverride("xai", "grok-4.3", xai("oauth"), "responses").adapter)
      .toBe("openai-chat");
  });

  test("an explicit xAI Responses override opts into the native wire", () => {
    for (const model of ["grok-4.6", "grok-4.5"]) {
      const provider = xai("oauth", { modelAdapters: { [model]: "openai-responses" } });
      expect(resolveWireProtocolOverride("xai", model, provider, "responses").adapter)
        .toBe("openai-responses");
    }
  });

  function deepseek(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
    return gateway({
      baseUrl: "https://api.deepseek.com",
      authMode: "key",
      ...overrides,
    });
  }

  test("routes the official V4 API ids through Responses", () => {
    expect(resolveWireProtocolOverride("deepseek", "deepseek-v4-flash", deepseek()).adapter)
      .toBe("openai-responses");
    // V4 Pro GA (DeepSeek-V4-Pro-0813) is officially on the Responses wire too —
    // the /responses reference lists both V4 ids as accepted `model` values.
    expect(resolveWireProtocolOverride("deepseek", "deepseek-v4-pro", deepseek()).adapter)
      .toBe("openai-responses");
    // The dated release label is not the API model id and must not be silently rewritten.
    expect(resolveWireProtocolOverride("deepseek", "deepseek-v4-flash-0731", deepseek()).adapter)
      .toBe("openai-chat");
  });

  test("an explicit Chat override opts Flash back out of the default", () => {
    const provider = deepseek({ modelAdapters: { "deepseek-v4-flash": "openai-chat" } });
    expect(resolveWireProtocolOverride("deepseek", "deepseek-v4-flash", provider).adapter)
      .toBe("openai-chat");
  });

  test("defaults do not apply when the provider is already on another wire", () => {
    expect(resolveWireProtocolOverride("deepseek", "deepseek-v4-flash", deepseek({ adapter: "anthropic" })).adapter)
      .toBe("anthropic");
  });

  test("keeps provider credentials and destination untouched", () => {
    const provider = deepseek({ apiKey: "test-key" });
    const resolved = resolveWireProtocolOverride("deepseek", "deepseek-v4-flash", provider);
    expect(provider.adapter).toBe("openai-chat");
    expect(resolved.apiKey).toBe("test-key");
    expect(resolved.baseUrl).toBe("https://api.deepseek.com");
  });
});
