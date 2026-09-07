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
  primeAgentDir,
  primeConfigPath,
  type ExportContext,
  type PiGeneratedConfig,
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
      // No authoritative context window: ships without limits rather than guessing.
      { namespaced: "mystery/model", provider: "mystery", id: "model" },
    ],
  };
}

describe("Prime Agent client config", () => {
  test("shares Pi's model contract without opting Prime into session headers", () => {
    const prime = buildClientConfig("prime", context()) as PiGeneratedConfig;
    const pi = buildClientConfig("pi", context()) as PiGeneratedConfig;
    expect(pi.providers[OPENCODE_PROVIDER_ID]!.compat).toEqual({ sendSessionAffinityHeaders: true });
    delete pi.providers[OPENCODE_PROVIDER_ID]!.compat;
    expect(prime).toEqual(pi);
    expect(buildClientContribution("prime", context()).fragments[0]!.value)
      .toEqual(prime.providers[OPENCODE_PROVIDER_ID]);
  });

  test("adds only providers.opencodex, wired to the loopback proxy", () => {
    const document = buildClientConfig("prime", context()) as PiGeneratedConfig;
    expect(Object.keys(document)).toEqual(["providers"]);
    expect(Object.keys(document.providers)).toEqual([OPENCODE_PROVIDER_ID]);
    const provider = document.providers[OPENCODE_PROVIDER_ID]!;
    expect(provider.baseUrl).toBe("http://127.0.0.1:10100/v1");
    expect(provider.api).toBe("openai-completions");
    expect(provider.apiKey).toBe(LOOPBACK_API_KEY_PLACEHOLDER);
  });

  test("native JSON round-trips and never carries a credential", () => {
    const sentinel = ["sk", "live", "prime", "sentinel"].join("-");
    const withKey = { ...CONFIG, apiKeys: [{ key: sentinel }] } as OcxConfig;
    const built = buildClientConfigText("prime", { ...context(), config: withKey });
    expect(JSON.parse(built.text)).toEqual(built.document as never);
    expect(built.text).not.toContain(sentinel);
    expect(built.text).toContain(LOOPBACK_API_KEY_PLACEHOLDER);
  });

  test("the contribution owns exactly the providers.opencodex path under its own id", () => {
    const contribution = buildClientContribution("prime", context());
    // Reusing Pi's builder must not leak Pi's id into the ownership record, or
    // the writer would stamp one client's block with the other's name.
    expect(contribution.clientId).toBe("prime");
    expect(contribution.fragments.map(f => f.path)).toEqual([["providers", OPENCODE_PROVIDER_ID]]);
  });

  test("resolves the agent-dir override and the documented destination", () => {
    expect(primeAgentDir({}, "/home/u")).toBe(join("/home/u", ".prime", "agent"));
    expect(primeConfigPath({}, "/home/u")).toBe(join("/home/u", ".prime", "agent", "models.json"));
    expect(primeConfigPath({ PRIME_AGENT_CODING_AGENT_DIR: "/elsewhere" }, "/home/u")).toBe(join("/elsewhere", "models.json"));
    expect(primeConfigPath({ PRIME_AGENT_CODING_AGENT_DIR: "~/alt" }, "/home/u")).toBe(join("/home/u", "alt", "models.json"));
    // A relative override would name different files for the proxy and the
    // agent, which have different working directories.
    expect(() => primeConfigPath({ PRIME_AGENT_CODING_AGENT_DIR: "relative" }, "/home/u")).toThrow(ClientPathError);
  });

  test("detects installation by the agent directory the override names", () => {
    const spec = INTEGRATION_CLIENTS.prime;
    expect(spec.detectDir({}, "/home/u")).toBe(join("/home/u", ".prime", "agent"));
    expect(spec.detectDir({ PRIME_AGENT_CODING_AGENT_DIR: "/elsewhere" } as NodeJS.ProcessEnv, "/home/u")).toBe("/elsewhere");
  });

  test("ships as a loopback-only integration with no env var to export", () => {
    const spec = EXPORT_CLIENTS.prime;
    expect(spec.loopbackOnly).toBe(true);
    expect(spec.apiKeyEnv).toBe("");
    expect(spec.filename).toBe("prime-models.json");
  });
});
