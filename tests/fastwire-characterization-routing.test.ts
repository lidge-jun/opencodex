import { describe, expect, test } from "bun:test";
import { applyCatalogModelMetadata } from "../src/codex/catalog/effort";
import type { CatalogModel, RawEntry } from "../src/codex/catalog/parsing";
import { candidateCapabilityEvidence } from "../src/routing/capability";
import { resolveProductionBehaviorValues } from "../src/routing/compatibility/behavior";
import { evaluatePolicyProfile } from "../src/routing/evaluator";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

describe("FastWire characterization: routing profile service-tier evidence", () => {
  test("require.serviceTier sees supportsServiceTier=true plus chatServiceTier=false as unsupported", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://chat-no-tier.example.test/v1",
      authMode: "key",
      apiKey: "sk-test",
      supportsServiceTier: true,
      chatServiceTier: false,
    };
    const config = {
      port: 0,
      defaultProvider: "chat-no-tier",
      providers: { "chat-no-tier": provider },
      routingProfiles: {
        fast: {
          candidates: [{ provider: "chat-no-tier", model: "model" }],
          require: { serviceTier: "supported" },
        },
      },
    } as OcxConfig;
    const capability = candidateCapabilityEvidence(config, "chat-no-tier", "model");

    expect(capability.serviceTier).toBe("unsupported");
    const result = evaluatePolicyProfile(config, "fast", {}, [{
      provider: "chat-no-tier",
      model: "model",
      capability,
    }]);
    expect(result.candidates[0]).toMatchObject({
      eligible: false,
      requirements: [{
        id: "service-tier",
        expected: "supported",
        actual: "unsupported",
        outcome: "unsatisfied",
      }],
    });
    expect(result.selectedIndex).toBeNull();
  });
});

describe("FastWire characterization: compatibility fingerprint projection", () => {
  const cases: Array<{ label: string; expected: boolean; provider: OcxProviderConfig }> = [
    {
      label: "supported",
      expected: true,
      provider: {
        adapter: "openai-responses",
        baseUrl: "https://supported.example.test/v1",
        supportsServiceTier: true,
      },
    },
    {
      label: "unsupported",
      expected: false,
      provider: {
        adapter: "openai-responses",
        baseUrl: "https://unsupported.example.test/v1",
        supportsServiceTier: false,
      },
    },
  ];

  test.each(cases)("projects $label service-tier behavior", ({ label, expected, provider }) => {
    const config = {
      port: 0,
      defaultProvider: label,
      fastMode: true,
      providers: { [label]: provider },
    } as OcxConfig;
    const values = resolveProductionBehaviorValues(
      config,
      label,
      "model",
      provider,
      "fastwire-characterization-salt",
    );

    expect(values?.["responses.serviceTier"]).toEqual({
      source: "provider_config",
      value: expected,
    });
    expect(values?.["runtime.fastMode"]).toEqual({
      source: "global_config",
      value: true,
    });
  });
});

describe("FastWire characterization: catalog service-tier bytes", () => {
  function apply(supportsServiceTier?: boolean): RawEntry {
    const entry: RawEntry = {};
    const model: CatalogModel = {
      id: "model",
      provider: "fixture",
      ...(supportsServiceTier === undefined ? {} : { supportsServiceTier }),
    };
    applyCatalogModelMetadata(entry, model);
    return entry;
  }

  test("supportsServiceTier=true emits the current narrow byte golden", () => {
    const entry = apply(true);
    const projection = {
      default_service_tier: entry.default_service_tier,
      service_tiers: entry.service_tiers,
      additional_speed_tiers: entry.additional_speed_tiers,
    };
    expect(JSON.stringify(projection)).toBe(
      '{"default_service_tier":null,"service_tiers":[{"id":"priority","name":"Fast","description":"1.5x speed, increased usage"}],"additional_speed_tiers":["fast"]}',
    );
  });

  test.each([
    { label: "false", supportsServiceTier: false },
    { label: "unset", supportsServiceTier: undefined },
  ])("supportsServiceTier=$label omits all catalog tier fields", ({ supportsServiceTier }) => {
    const entry = apply(supportsServiceTier);
    expect(entry).not.toHaveProperty("default_service_tier");
    expect(entry).not.toHaveProperty("service_tiers");
    expect(entry).not.toHaveProperty("additional_speed_tiers");
  });
});
