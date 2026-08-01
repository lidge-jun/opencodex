/**
 * GitHub Copilot fronts a mixed-wire catalog: the preset adapter `openai-chat` is right
 * for the Claude/Gemini/GPT-4 entries, but the GPT-5.3+ OpenAI models are Responses-only
 * and fail on chat completions — either outright (`is not accessible via the
 * /chat/completions endpoint`) or, for gpt-5.4, only once a real Codex request carries
 * function tools plus a reasoning effort. Without a registry default every user has to
 * hand-write the same `modelAdapters` map.
 */
import { describe, expect, test } from "bun:test";
import { resolveWireProtocolOverride } from "../src/server/adapter-resolve";
import { getProviderRegistryEntry, PROVIDER_REGISTRY, providerModelWireDefault } from "../src/providers/registry";
import { MODEL_ADAPTER_OVERRIDE_ALLOWED, type OcxProviderConfig } from "../src/types";

const RESPONSES_ONLY = [
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
];

const CHAT_MODELS = [
  "claude-sonnet-5",
  "claude-opus-4.8",
  "gemini-3.1-pro-preview",
  "gpt-4o",
  "gpt-4.1",
  "gpt-5-mini",
];

function copilot(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://api.githubcopilot.com",
    authMode: "oauth",
    ...overrides,
  } as OcxProviderConfig;
}

function wireFor(modelId: string, provider = copilot(), inbound: "responses" | "chat" | "anthropic" = "responses"): string {
  return resolveWireProtocolOverride("github-copilot", modelId, provider, inbound).adapter;
}

describe("github-copilot registry per-model wire defaults", () => {
  test("Responses-only models resolve to openai-responses with no user config", () => {
    for (const model of RESPONSES_ONLY) {
      expect(wireFor(model)).toBe("openai-responses");
    }
  });

  test("the rest of the catalog keeps the provider-wide chat wire", () => {
    for (const model of CHAT_MODELS) {
      expect(wireFor(model)).toBe("openai-chat");
    }
  });

  test("the default applies on every inbound, unlike an inbound-scoped entry", () => {
    // Copilot serves no chat route at all for these, so a Chat or Anthropic client must be
    // translated onto Responses too — the bare-string form, not DeepSeek's `{wire, inbound}`.
    for (const inbound of ["responses", "chat", "anthropic"] as const) {
      expect(wireFor("gpt-5.6-sol", copilot(), inbound)).toBe("openai-responses");
    }
  });

  test("an explicit modelAdapters entry overrides the registry default", () => {
    // Naming the provider-wide adapter is how a user opts a model back out, so it must
    // not fall through to the default the way an unconfigured model does.
    const pinnedToChat = copilot({ modelAdapters: { "gpt-5.4": "openai-chat" } });
    expect(wireFor("gpt-5.4", pinnedToChat)).toBe("openai-chat");

    const pinnedToResponses = copilot({ modelAdapters: { "gpt-4o": "openai-responses" } });
    expect(wireFor("gpt-4o", pinnedToResponses)).toBe("openai-responses");
  });

  test("an out-of-allow-list override falls back to the registry default", () => {
    const handEdited = copilot({ modelAdapters: { "gpt-5.5": "cursor" } });
    expect(wireFor("gpt-5.5", handEdited)).toBe("openai-responses");
  });

  test("resolving twice is stable", () => {
    const once = resolveWireProtocolOverride("github-copilot", "gpt-5.6-sol", copilot());
    const twice = resolveWireProtocolOverride("github-copilot", "gpt-5.6-sol", once);
    expect(once.adapter).toBe("openai-responses");
    expect(twice.adapter).toBe("openai-responses");
  });

  test("credentials and destination survive the wire swap", () => {
    const provider = copilot({ headers: { "Copilot-Integration-Id": "vscode-chat" } });
    const resolved = resolveWireProtocolOverride("github-copilot", "gpt-5.6-sol", provider);

    expect(provider.adapter).toBe("openai-chat"); // input not mutated
    expect(resolved.authMode).toBe("oauth");
    expect(resolved.baseUrl).toBe("https://api.githubcopilot.com");
    expect(resolved.headers).toEqual({ "Copilot-Integration-Id": "vscode-chat" });
  });

  test("a provider moved off an OpenAI-shaped wire is left alone", () => {
    expect(wireFor("gpt-5.6-sol", copilot({ adapter: "anthropic" }))).toBe("anthropic");
    expect(providerModelWireDefault(
      "github-copilot",
      copilot({ adapter: "anthropic" }),
      "gpt-5.6-sol",
      MODEL_ADAPTER_OVERRIDE_ALLOWED,
      "responses",
    )).toBeUndefined();
  });

  test("the default does not leak into unrelated providers", () => {
    const other = { adapter: "openai-chat", baseUrl: "https://gateway.example/v1", authMode: "key" } as OcxProviderConfig;
    expect(resolveWireProtocolOverride("localmodels", "gpt-5.6-sol", other).adapter).toBe("openai-chat");
  });

  test("the map lives on the canonical registry entry", () => {
    const entry = getProviderRegistryEntry("github-copilot");
    expect(Object.keys(entry?.modelWireDefaults ?? {}).sort()).toEqual([...RESPONSES_ONLY].sort());
  });
});

describe("registry model-wire-default invariants", () => {
  test("every wire default names a seeded model and an allowed wire", () => {
    // A default for a model missing from the seed is unreachable by qualified selector
    // until live discovery lands — exactly the cold-start case the seed exists for.
    for (const entry of PROVIDER_REGISTRY) {
      for (const [model, declared] of Object.entries(entry.modelWireDefaults ?? {})) {
        const wire = typeof declared === "string" ? declared : declared.wire;
        expect(MODEL_ADAPTER_OVERRIDE_ALLOWED.has(wire)).toBe(true);
        expect(entry.models ?? []).toContain(model);
        expect(model).toBe(model.trim().toLowerCase());
      }
    }
  });
});
