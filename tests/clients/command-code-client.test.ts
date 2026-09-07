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

