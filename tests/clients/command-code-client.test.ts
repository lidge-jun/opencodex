import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  ClientPathError,
  EXPORT_CLIENTS,
  LOOPBACK_API_KEY_PLACEHOLDER,
  OPENCODE_PROVIDER_ID,
  buildClientConfig,
  buildClientConfigText,
  buildClientContribution,
  buildCommandCodeClientConfig,
  commandCodeConfigPath,
  commandCodeHomeDir,
  type CommandCodeGeneratedConfig,
  type ExportContext,
} from "../../src/clients/config-export";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import type { OcxConfig } from "../../src/types";

const CONFIG = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;

function context(): ExportContext {
  return {
    baseUrl: "http://127.0.0.1:10100/v1",
    config: CONFIG,
    models: [
      { namespaced: "anthropic/claude-opus-5", provider: "anthropic", id: "claude-opus-5", contextWindow: 200_000, inputModalities: ["text", "image"] },
      { namespaced: "openai/gpt-5.6-sol", provider: "openai", id: "gpt-5.6-sol", contextWindow: 922_000, reasoningEfforts: ["low", "medium", "high"] },
      { namespaced: "google-antigravity/gemini-3.8-flash", provider: "google-antigravity", id: "gemini-3.8-flash", contextWindow: 1_048_576, reasoningEfforts: ["low", "medium", "high"] },
      { namespaced: "mystery/model", provider: "mystery", id: "model" },
    ],
  };
}

describe("Command Code client config", () => {
  test("generates valid JSON with provider.opencodex block", () => {
    const built = buildClientConfigText("commandcode", context());
    expect(built.format).toBe("json");
    expect(JSON.parse(built.text)).toEqual(built.document as never);
  });

  test("adds only provider.opencodex, wired to the loopback proxy", () => {
    const document = buildClientConfig("commandcode", context()) as CommandCodeGeneratedConfig;
    expect(Object.keys(document)).toEqual(["provider"]);
    expect(Object.keys(document.provider)).toEqual([OPENCODE_PROVIDER_ID]);
    const provider = document.provider[OPENCODE_PROVIDER_ID]!;
    expect(provider.name).toBe("OpenCodex");
    expect(provider.api).toBe("openai-completions");
    expect(provider.baseURL).toBe("http://127.0.0.1:10100/v1");
    expect(provider.apiKey).toBeDefined();
  });

  test("emits contextWindow and reasoningEfforts correctly without guessing", () => {
    const document = buildClientConfig("commandcode", context()) as CommandCodeGeneratedConfig;
    const provider = document.provider[OPENCODE_PROVIDER_ID]!;
    const gemini = provider.models["google-antigravity/gemini-3.8-flash"];
    expect(gemini).toBeDefined();
    expect(gemini?.contextWindow).toBe(1_048_576);
    expect(gemini?.reasoningEfforts).toEqual(["low", "medium", "high"]);

    const mystery = provider.models["mystery/model"];
    expect(mystery).toBeDefined();
    expect(mystery?.contextWindow).toBeUndefined();
    expect(mystery?.reasoningEfforts).toBeUndefined();
  });

  test("the contribution owns exactly the provider.opencodex path under its own id", () => {
    const contribution = buildClientContribution("commandcode", context());
    expect(contribution.clientId).toBe("commandcode");
    expect(contribution.fragments.map(f => f.path)).toEqual([["provider", OPENCODE_PROVIDER_ID]]);
  });

  test("resolves the home directory override and the documented destination", () => {
    expect(commandCodeHomeDir({}, "/home/u")).toBe(join("/home/u", ".commandcode"));
    expect(commandCodeConfigPath({}, "/home/u")).toBe(join("/home/u", ".commandcode", "providers.json"));
    expect(commandCodeConfigPath({ COMMANDCODE_HOME: "/elsewhere" }, "/home/u")).toBe(join("/elsewhere", "providers.json"));
    expect(commandCodeConfigPath({ COMMANDCODE_HOME: "~/alt" }, "/home/u")).toBe(join("/home/u", "alt", "providers.json"));
    expect(() => commandCodeConfigPath({ COMMANDCODE_HOME: "relative" }, "/home/u")).toThrow(ClientPathError);
  });

  test("detects installation by the .commandcode directory the override names", () => {
    const spec = INTEGRATION_CLIENTS.commandcode;
    expect(spec.detectDir({}, "/home/u")).toBe(join("/home/u", ".commandcode"));
    expect(spec.detectDir({ COMMANDCODE_HOME: "/elsewhere" } as NodeJS.ProcessEnv, "/home/u")).toBe("/elsewhere");
  });

  test("ships as a loopback-only integration with proper export metadata", () => {
    const spec = EXPORT_CLIENTS.commandcode;
    expect(spec.id).toBe("commandcode");
    expect(spec.filename).toBe("providers.json");
    expect(spec.format).toBe("json");
    expect(spec.loopbackOnly).toBe(true);
  });
});

// A routed model reaches this exporter under ONE canonical selector, but the proxy
// publishes it under two interchangeable spellings: the raw selector with inner
// slashes (what /v1/models emits) and the Codex-facing encoded form where inner
// slashes became dashes (what ~/.codex/config.toml stores). Command Code addresses
// models by exact key, so a client that resolves the active model from one surface
// and looks it up in the other writes a config whose own active model is absent
// from its catalog.
describe("Command Code model-key spelling", () => {
  test("keys every model by the spelling the client can actually call", () => {
    const document = buildCommandCodeClientConfig({
      ...context(),
      models: [
        { namespaced: "command-code/deepseek/deepseek-v4.1-flash", provider: "command-code", id: "deepseek/deepseek-v4.1-flash", contextWindow: 1_000_000 },
      ],
    }) as CommandCodeGeneratedConfig;
    const keys = Object.keys(document.provider[OPENCODE_PROVIDER_ID]!.models);
    expect(keys).toContain("command-code/deepseek/deepseek-v4.1-flash");
  });

  test("never emits two keys that differ only by slash-versus-dash encoding", () => {
    const document = buildCommandCodeClientConfig({
      ...context(),
      models: [
        { namespaced: "command-code/deepseek/deepseek-v4.1-flash", provider: "command-code", id: "deepseek/deepseek-v4.1-flash", contextWindow: 1_000_000 },
        { namespaced: "command-code/deepseek-deepseek-v4.1-flash", provider: "command-code", id: "deepseek/deepseek-v4.1-flash", contextWindow: 1_000_000 },
      ],
    }) as CommandCodeGeneratedConfig;
    const keys = Object.keys(document.provider[OPENCODE_PROVIDER_ID]!.models);
    const encoded = keys.map(key => key.replaceAll("/", "-"));
    expect(new Set(encoded).size).toBe(encoded.length);
  });

  test("collapses a duplicate pair to one entry instead of shipping both", () => {
    const document = buildCommandCodeClientConfig({
      ...context(),
      models: [
        { namespaced: "command-code/meta/muse-spark-1.3-contributor", provider: "command-code", id: "meta/muse-spark-1.3-contributor", contextWindow: 1_048_576 },
        { namespaced: "command-code/meta-muse-spark-1.3-contributor", provider: "command-code", id: "meta/muse-spark-1.3-contributor", contextWindow: 1_048_576 },
      ],
    }) as CommandCodeGeneratedConfig;
    const models = document.provider[OPENCODE_PROVIDER_ID]!.models;
    const matching = Object.keys(models).filter(key => key.includes("muse-spark-1.3-contributor"));
    expect(matching.length).toBe(1);
    expect(models[matching[0]!]?.contextWindow).toBe(1_048_576);
  });

  test("keeps genuinely distinct models apart", () => {
    const document = buildCommandCodeClientConfig({
      ...context(),
      models: [
        { namespaced: "command-code/deepseek/deepseek-v4-pro", provider: "command-code", id: "deepseek/deepseek-v4-pro", contextWindow: 1_000_000 },
        { namespaced: "command-code/deepseek/deepseek-v4.1-flash", provider: "command-code", id: "deepseek/deepseek-v4.1-flash", contextWindow: 1_000_000 },
      ],
    }) as CommandCodeGeneratedConfig;
    expect(Object.keys(document.provider[OPENCODE_PROVIDER_ID]!.models).length).toBe(2);
  });
});
