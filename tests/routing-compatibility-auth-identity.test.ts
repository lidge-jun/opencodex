import { describe, expect, test } from "bun:test";
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
});
