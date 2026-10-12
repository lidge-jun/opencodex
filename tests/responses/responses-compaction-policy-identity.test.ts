import { describe, expect, test } from "bun:test";
import { getDefaultConfig } from "../../src/config";
import { routeConcreteModel } from "../../src/router";
import { compactionRoutingKeepsProviderIdentity } from "../../src/server/responses/compaction-routing";
import type { OcxConfig } from "../../src/types";

function policyConfig(): OcxConfig {
  return {
    ...getDefaultConfig(),
    defaultProvider: "openai-apikey",
    providers: {
      openai: {
        adapter: "openai-responses", authMode: "forward",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
      "openai-apikey": {
        adapter: "openai-responses", authMode: "key", apiKey: "fixture-key",
        baseUrl: "https://api.openai.com/v1",
      },
    },
    routingProfiles: {
      primary: {
        alias: "ocx/primary",
        candidates: [{ provider: "openai", model: "gpt-5.6-luna" }],
      },
    },
  };
}

describe("compaction routing policy identity", () => {
  test.each(["policy/primary", "ocx/primary"])("treats policy source %s as cross-identity", sourceModel => {
    const config = policyConfig();
    const target = routeConcreteModel(config, "openai-apikey/gpt-5.6-luna");

    expect(compactionRoutingKeepsProviderIdentity(config, { sourceModel }, target)).toBe(false);
  });

  test.each(["policy/primary--fast", "ocx/primary--fast"])(
    "treats synthetic policy selector %s as cross-identity",
    sourceModel => {
      const config = policyConfig();
      const target = routeConcreteModel(config, "openai-apikey/gpt-5.6-luna");

      expect(compactionRoutingKeepsProviderIdentity(config, { sourceModel }, target)).toBe(false);
    },
  );

  test("treats a stale policy alias as cross-identity after the profile is deleted", () => {
    const config = policyConfig();
    delete config.routingProfiles;
    const target = routeConcreteModel(config, "openai-apikey/gpt-5.6-luna");

    expect(compactionRoutingKeepsProviderIdentity(config, { sourceModel: "ocx/primary" }, target)).toBe(false);
  });

  test("fails closed for a selector that only resolves through the default provider", () => {
    const config = policyConfig();
    const target = routeConcreteModel(config, "openai-apikey/gpt-5.6-luna");

    expect(compactionRoutingKeepsProviderIdentity(
      config,
      { sourceModel: "unconfigured-model" },
      target,
    )).toBe(false);
  });

  test("retains identity for a concrete source on the target provider", () => {
    const config = policyConfig();
    const target = routeConcreteModel(config, "openai-apikey/gpt-5.6-luna");

    expect(compactionRoutingKeepsProviderIdentity(
      config,
      { sourceModel: "openai-apikey/gpt-6-astra" },
      target,
    )).toBe(true);
  });

  test("retains identity for a concrete fast selector on the target provider", () => {
    const config = policyConfig();
    const target = routeConcreteModel(config, "openai-apikey/gpt-5.6-luna");

    expect(compactionRoutingKeepsProviderIdentity(
      config,
      { sourceModel: "openai-apikey/gpt-6-astra--fast" },
      target,
    )).toBe(true);
  });
});
