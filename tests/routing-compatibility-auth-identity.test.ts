import { describe, expect, test } from "bun:test";
import { buildBehaviorFingerprintV1 } from "../src/lab/subject/behavior-fingerprint";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { resolveProductionBehaviorValues } from "../src/routing/compatibility/behavior";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

describe("CL-06 registry auth compatibility identity", () => {
  test("registry-derived OAuth matches explicit OAuth behavior identity", () => {
    const registryEntry = PROVIDER_REGISTRY.find(entry => entry.authKind === "oauth");
    expect(registryEntry).toBeDefined();
    if (!registryEntry) return;

    const modelId = "identity-model";
    const provider: OcxProviderConfig = {
      adapter: registryEntry.adapter,
      baseUrl: registryEntry.baseUrl,
      models: [modelId],
    };
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: registryEntry.id,
      providers: { [registryEntry.id]: provider },
    };

    const registryDerived = resolveProductionBehaviorValues(
      config,
      registryEntry.id,
      modelId,
      provider,
      "compatibility-test-salt",
    );
    const explicit = resolveProductionBehaviorValues(
      config,
      registryEntry.id,
      modelId,
      { ...provider, authMode: "oauth" },
      "compatibility-test-salt",
    );

    expect(registryDerived?.["auth.mode"]?.value).toBe("oauth");
    expect(registryDerived?.["auth.transport"]?.value).toBe("oauth_bearer");
    expect(registryDerived).toEqual(explicit);
  });

  test("fingerprints Command Code project-context behavior only for its native adapter", () => {
    const commandCode: OcxProviderConfig = {
      adapter: "command-code",
      baseUrl: "https://api.commandcode.ai",
      authMode: "oauth",
      projectContext: "on",
    };
    const openAiChat: OcxProviderConfig = {
      ...commandCode,
      adapter: "openai-chat",
    };
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "command-code",
      providers: { "command-code": commandCode, "openai-chat": openAiChat },
    };

    const commandCodeValues = resolveProductionBehaviorValues(
      config,
      "command-code",
      "context-model",
      commandCode,
      "compatibility-test-salt",
    );
    const openAiChatValues = resolveProductionBehaviorValues(
      config,
      "openai-chat",
      "context-model",
      openAiChat,
      "compatibility-test-salt",
    );

    expect(commandCodeValues?.["wire.commandCodeProjectContext"]).toEqual({
      source: "provider_config",
      value: "on",
    });
    expect(openAiChatValues).not.toHaveProperty("wire.commandCodeProjectContext");
    expect(() => buildBehaviorFingerprintV1(commandCodeValues!)).not.toThrow();
    expect(() => buildBehaviorFingerprintV1(openAiChatValues!)).not.toThrow();
  });
});
