import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfigCandidate } from "../../src/config";
import { NoEligiblePolicyCandidateError, routeModel, routedProviderConfig } from "../../src/router";
import { candidateCapabilityEvidence } from "../../src/routing/capability";
import { assemblePolicyCandidateEvidence } from "../../src/routing/compatibility/assemble";
import { evaluatePolicyProfile } from "../../src/routing/evaluator";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { getRoutingProfile } from "../../src/routing/profile";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { modelRecordValue } from "../../src/reasoning-effort";
import { isModelTextOnly } from "../../src/vision";
import type { OcxConfig, OcxProviderConfig, OcxRoutingProfileConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * `candidateCapabilityEvidence` describes what the resolver will do with a candidate,
 * so it has to match the resolver. Every runtime reader of `modelContextWindows`,
 * `modelInputModalities` and `modelReasoningEfforts` goes through `modelRecordValue`
 * (`src/reasoning-effort.ts:108`, `src/server/effort-policy.ts:122`,
 * `src/vision/index.ts:34`, `src/codex/catalog/provider-fetch.ts:612`), which accepts a
 * family entry for a tagged id. This file pins the evidence to that same rule.
 *
 * The window matters most: a bare lookup did not degrade to unknown there, it fell
 * through to the provider-wide `contextWindow` — a definite wrong answer, which the
 * module's own "unknown is not zero" contract is written to avoid.
 */

function providerWithFamilyEntries(): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    contextWindow: 8_000,
    models: ["gpt-oss:120b"],
    modelContextWindows: { "gpt-oss": 131_072 },
    modelInputModalities: { "gpt-oss": ["text"] },
    modelReasoningEfforts: { "gpt-oss": ["low", "high"] },
  } as unknown as OcxProviderConfig;
}

function configFor(provider: OcxProviderConfig): OcxConfig {
  return { providers: { custom: provider } } as unknown as OcxConfig;
}

describe("policy capability evidence uses the effective provider", () => {
  let testDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    testDir = mkdtempSync(join(tmpdir(), "ocx-effective-capability-"));
    process.env.OPENCODEX_HOME = testDir;
  });

  afterEach(() => {
    closeRequestHistoryIndex();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(testDir);
  });

  function policyConfig(
    name: string,
    provider: OcxProviderConfig,
    model: string,
    require: OcxRoutingProfileConfig["require"],
  ): OcxConfig {
    const result = validateConfigCandidate({
      port: 10100,
      defaultProvider: name,
      providers: { [name]: provider },
      routingProfiles: { guarded: { candidates: [{ provider: name, model }], require } },
    });
    if (!result.ok) throw new Error(result.error);
    return result.config;
  }

  const localOnly = { localOnly: true, remoteAllowed: false };
  const loopback = "http://127.0.0.1:11434/v1";

  test("a loopback URL discarded by registry routing cannot satisfy a local-only policy", () => {
    const config = policyConfig("deepseek", {
      adapter: "openai-chat", baseUrl: loopback, allowPrivateNetwork: true,
    }, "deepseek-v4-flash", localOnly);
    const before = structuredClone(config);

    expect(routeModel(config, "deepseek/deepseek-v4-flash").provider.baseUrl)
      .toBe("https://api.deepseek.com");
    expect(() => routeModel(config, "policy/guarded")).toThrow(NoEligiblePolicyCandidateError);
    expect(config).toEqual(before);
  });

  test.each(["custom-local", "ollama"])("a genuine local %s endpoint remains eligible", name => {
    const config = policyConfig(name, {
      adapter: "openai-chat", baseUrl: loopback, allowPrivateNetwork: true,
    }, "local-model", localOnly);
    const before = structuredClone(config);

    const route = routeModel(config, "policy/guarded");
    expect(route.providerName).toBe(name);
    expect(route.provider.baseUrl).toBe(loopback);
    expect(route.routeDecision?.requirements).toEqual([
      { id: "local-only", expected: true, actual: true, outcome: "satisfied" },
      { id: "remote-allowed", expected: false, actual: false, outcome: "satisfied" },
    ]);
    expect(config).toEqual(before);
  });

  test("an explicitly public endpoint remains ineligible for a local-only policy", () => {
    const config = policyConfig("deepseek", {
      adapter: "openai-chat", baseUrl: "https://api.deepseek.com",
    }, "deepseek-v4-flash", localOnly);
    expect(() => routeModel(config, "policy/guarded")).toThrow(NoEligiblePolicyCandidateError);
  });

  test("a local candidate is selected after excluding a registry-pinned remote candidate", () => {
    const config = policyConfig("deepseek", {
      adapter: "openai-chat", baseUrl: loopback, allowPrivateNetwork: true,
    }, "deepseek-v4-flash", localOnly);
    config.providers.local = { adapter: "openai-chat", baseUrl: loopback, allowPrivateNetwork: true };
    config.routingProfiles!.guarded!.candidates.push({ provider: "local", model: "local-model" });

    const route = routeModel(config, "policy/guarded");
    expect(route.providerName).toBe("local");
    expect(route.provider.baseUrl).toBe(loopback);
    expect(route.routeDecision?.candidates.map(candidate => candidate.eligible)).toEqual([false, true]);
  });

  test("registry no-vision defaults participate before policy image requirements", () => {
    const config = policyConfig("deepseek", {
      adapter: "openai-chat", baseUrl: "https://api.deepseek.com",
      modelInputModalities: { "deepseek-v4-flash": ["text", "image"] },
    }, "deepseek-v4-flash", { imageInput: true });
    const routed = routeModel(config, "deepseek/deepseek-v4-flash");
    expect(isModelTextOnly(routed.provider, routed.modelId)).toBe(true);
    expect(() => routeModel(config, "policy/guarded")).toThrow(NoEligiblePolicyCandidateError);
  });

  test("the effective model context ceiling gates a policy requirement", () => {
    const config = policyConfig("openai-apikey", {
      adapter: "openai-responses", baseUrl: "https://api.openai.com/v1",
      modelContextWindows: { "gpt-6-astra": 2_000_000 },
    }, "gpt-6-astra", { minContextWindow: 1_500_000 });
    const routed = routeModel(config, "openai-apikey/gpt-6-astra");
    expect(routed.provider.modelContextWindows?.["gpt-6-astra"]).toBe(1_050_000);
    expect(() => routeModel(config, "policy/guarded")).toThrow(NoEligiblePolicyCandidateError);
  });

  test("canonical forward auth filled by routing satisfies the encrypted-task requirement", () => {
    const config = policyConfig("openai", {
      adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
    }, "gpt-5.5", { encryptedCodexTasks: true });

    const route = routeModel(config, "policy/guarded");
    expect(route.provider.authMode).toBe("forward");
    expect(route.routeDecision?.candidates[0]?.capability?.encryptedCodexTasks).toBe(true);
    expect(config.providers.openai!.authMode).toBeUndefined();
  });

  test("the effective provider-wide reasoning ladder participates in policy selection", () => {
    const config = policyConfig("xiaomi-mimo", {
      adapter: "openai-chat", baseUrl: "https://api.xiaomimimo.com/v1",
    }, "mimo-v2.5", { reasoningEffort: "high" });

    const route = routeModel(config, "policy/guarded");
    expect(route.provider.reasoningEfforts).toEqual(["low", "medium", "high"]);
    expect(route.routeDecision?.candidates[0]?.capability?.reasoningEfforts)
      .toEqual(["low", "medium", "high"]);
    expect(config.providers["xiaomi-mimo"]!.reasoningEfforts).toBeUndefined();
  });

  test("a same-named custom transport does not inherit an unrelated registry model map", () => {
    const config = policyConfig("meta-model", {
      adapter: "openai-responses", baseUrl: "https://custom.example/v1",
    }, "muse-spark-1.3", { reasoningEffort: "high" });
    const routed = routeModel(config, "meta-model/muse-spark-1.3");
    expect(routed.provider.baseUrl).toBe("https://custom.example/v1");
    expect(routed.provider.modelReasoningEfforts).toBeUndefined();
    expect(() => routeModel(config, "policy/guarded")).toThrow(NoEligiblePolicyCandidateError);
  });

  test("an invalid unselected transport cannot prevent a healthy sibling from routing", () => {
    const config = policyConfig("local", {
      adapter: "openai-chat", baseUrl: loopback, allowPrivateNetwork: true,
    }, "local-model", {});
    config.providers.ollama = { adapter: "openai-chat", baseUrl: " " };
    config.routingProfiles!.guarded!.candidates.push({ provider: "ollama", model: "local-model" });

    const route = routeModel(config, "policy/guarded");
    expect(route.providerName).toBe("local");
    expect(route.provider.baseUrl).toBe(loopback);
    expect(route.routeDecision?.candidates[1]?.capability).toBeUndefined();
  });

  test("an unresolved transport contributes no positive capability evidence", () => {
    const config = policyConfig("ollama", {
      adapter: "openai-chat", baseUrl: loopback,
      modelInputModalities: { "local-model": ["text", "image"] },
    }, "local-model", { imageInput: true });
    config.providers.ollama!.baseUrl = " ";

    const evidence = assemblePolicyCandidateEvidence(config, getRoutingProfile(config, "guarded")!, Date.now(), {
      routedProviderConfig,
    });
    expect(evidence[0]?.capability).toBeUndefined();
    expect(() => routeModel(config, "policy/guarded")).toThrow(NoEligiblePolicyCandidateError);
  });

  test("missing and disabled providers are not resolved for capability evidence", () => {
    const config = policyConfig("local", {
      adapter: "openai-chat", baseUrl: loopback, allowPrivateNetwork: true,
    }, "local-model", { tools: true });
    config.providers.disabled = { ...config.providers.local!, disabled: true };
    config.routingProfiles!.guarded!.candidates.push(
      { provider: "missing", model: "model" },
      { provider: "disabled", model: "model" },
    );
    const resolved: string[] = [];
    const evidence = assemblePolicyCandidateEvidence(config, getRoutingProfile(config, "guarded")!, Date.now(), {
      routedProviderConfig: (name, provider) => {
        resolved.push(name);
        return routedProviderConfig(name, provider);
      },
    });

    expect(resolved).toEqual(["local"]);
    expect(evidence[0]?.capability?.tools).toBe(true);
    expect(evidence[1]?.capability).toBeUndefined();
    expect(evidence[2]?.capability).toBeUndefined();
  });

  for (const unavailable of ["missing", "disabled"] as const) {
    test.each(["allow", "penalize", "exclude"] as const)(
      `${unavailable} first candidate is excluded under %s unknown policy`,
      capability => {
        // Empty requirements prevent another capability guard from masking availability.
        const config = policyConfig("local", {
          adapter: "openai-chat", baseUrl: loopback, allowPrivateNetwork: true,
        }, "local-model", {});
        if (unavailable === "disabled") {
          config.providers.disabled = { ...config.providers.local!, disabled: true };
        }
        const profile = config.routingProfiles!.guarded!;
        profile.candidates.unshift({ provider: unavailable, model: "local-model" });
        profile.unknownEvidence = { ...profile.unknownEvidence, capability };

        for (const withSibling of [true, false]) {
          if (!withSibling) profile.candidates.pop();
          const resolved: string[] = [];
          const evidence = assemblePolicyCandidateEvidence(
            config, getRoutingProfile(config, "guarded")!, Date.now(), {
              routedProviderConfig: (name, provider) => {
                resolved.push(name);
                return routedProviderConfig(name, provider);
              },
            },
          );
          expect(resolved).toEqual(withSibling ? ["local"] : []);
          expect(evidence).toHaveLength(withSibling ? 2 : 1);
          expect(evidence[0]?.routeResolutionFailed).toBe(true);
          expect(evidence[0]?.capability).toBeUndefined();
          const evaluation = evaluatePolicyProfile(config, "guarded", {}, evidence);
          expect(evaluation.selectedIndex).toBe(withSibling ? 1 : null);
          expect(evaluation.candidates[0]).toMatchObject({
            provider: unavailable,
            eligible: false,
            requirements: [],
            exclusions: [{ code: "route-unavailable" }],
          });
          if (withSibling) {
            expect(evidence[1]?.routeResolutionFailed).toBeUndefined();
            expect(evidence[1]?.capability?.tools).toBe(true);
            expect(evaluation.candidates[1]?.eligible).toBe(true);
            const route = routeModel(config, "policy/guarded");
            expect(route.providerName).toBe("local");
            expect(route.routeDecision?.candidates.map(candidate => candidate.eligible)).toEqual([false, true]);
            expect(route.routeDecision?.candidates[0]?.exclusions).toEqual([{ code: "route-unavailable" }]);
          } else {
            expect(() => routeModel(config, "policy/guarded")).toThrow(NoEligiblePolicyCandidateError);
          }
        }
      },
    );
  }

  test.each(["allow", "penalize", "exclude"] as const)(
    "an unresolved first candidate is excluded when unknown capabilities are %s",
    capability => {
      const config = policyConfig("ollama", {
        adapter: "openai-chat", baseUrl: loopback,
      }, "local-model", {});
      config.providers.ollama!.baseUrl = " ";
      config.providers.local = { adapter: "openai-chat", baseUrl: loopback, allowPrivateNetwork: true };
      const profile = config.routingProfiles!.guarded!;
      profile.candidates.push({ provider: "local", model: "local-model" });
      profile.unknownEvidence = { ...profile.unknownEvidence, capability };

      const route = routeModel(config, "policy/guarded");
      expect(route.providerName).toBe("local");
      expect(route.routeDecision?.candidates.map(candidate => candidate.eligible)).toEqual([false, true]);
      expect(route.routeDecision?.candidates[0]?.exclusions).toContainEqual({ code: "route-unavailable" });
      expect(JSON.stringify(route.routeDecision)).not.toContain("Invalid baseUrl");
    },
  );

  test("all unresolved candidates produce a policy exclusion while explicit routing keeps validation", () => {
    const config = policyConfig("ollama", {
      adapter: "openai-chat", baseUrl: loopback,
    }, "local-model", {});
    config.providers.ollama!.baseUrl = " ";

    expect(() => routeModel(config, "policy/guarded")).toThrow(NoEligiblePolicyCandidateError);
    expect(() => routeModel(config, "ollama/local-model")).toThrow('Invalid baseUrl for provider "ollama"');
  });
});

describe("candidateCapabilityEvidence model matching", () => {
  test("a family entry covers its tagged siblings, as the resolver does", () => {
    const provider = providerWithFamilyEntries();

    // Ground truth first: what the runtime itself resolves off this config.
    expect(modelRecordValue(provider.modelContextWindows, "gpt-oss:120b")).toBe(131_072);
    expect(isModelTextOnly(provider, "gpt-oss:120b")).toBe(true);

    const evidence = candidateCapabilityEvidence(configFor(provider), "custom", "gpt-oss:120b");
    expect(evidence.contextWindow).toBe(131_072);
    expect(evidence.image).toBe(false);
    expect(evidence.reasoningEfforts).toEqual(["low", "high"]);
  });

  test("the window does not fall through to the provider-wide value", () => {
    // The specific regression: the provider-wide 8_000 is not "unknown", it is a
    // definite answer belonging to a different model, and routing would act on it.
    // Asserted as the exact expected number rather than `not.toBe(8_000)`, which
    // would also pass for `undefined` or any other wrong value.
    const evidence = candidateCapabilityEvidence(
      configFor(providerWithFamilyEntries()),
      "custom",
      "gpt-oss:120b",
    );
    expect(evidence.contextWindow).toBe(131_072);
  });

  test("an exact entry still wins over the family entry", () => {
    const provider = {
      ...providerWithFamilyEntries(),
      modelContextWindows: { "gpt-oss": 131_072, "gpt-oss:20b": 32_000 },
    } as unknown as OcxProviderConfig;
    expect(candidateCapabilityEvidence(configFor(provider), "custom", "gpt-oss:20b").contextWindow)
      .toBe(32_000);
  });

  test("an unrelated model still falls back to the provider-wide window", () => {
    const evidence = candidateCapabilityEvidence(
      configFor(providerWithFamilyEntries()),
      "custom",
      "some-other-model",
    );
    expect(evidence.contextWindow).toBe(8_000);
    expect(evidence.reasoningEfforts).toBeUndefined();
  });

  test("noReasoningModels reports an EMPTY ladder, not an absent one", () => {
    // Every other consumer treats noReasoningModels as a positive "no effort control":
    // configuredReasoningEfforts (reasoning-effort.ts), supportedLadderFor
    // (server/effort-policy.ts) and the compatibility fingerprint all check it first.
    // Evidence must agree, and the difference between [] and absent is load-bearing:
    // absent makes the evaluator record "unknown", which is permissive.
    const provider = {
      ...providerWithFamilyEntries(),
      noReasoningModels: ["gpt-oss:120b"],
    } as unknown as OcxProviderConfig;

    const evidence = candidateCapabilityEvidence(configFor(provider), "custom", "gpt-oss:120b");
    expect(evidence.reasoningEfforts).toEqual([]);

    // The sibling that is NOT disabled still inherits the family ladder.
    const sibling = candidateCapabilityEvidence(configFor(provider), "custom", "gpt-oss:20b");
    expect(sibling.reasoningEfforts).toEqual(["low", "high"]);
  });

  test("a disabled model is capability-unsatisfied for an effort requirement, not unknown", () => {
    // The observable consequence of the case above. With an ABSENT ladder the evaluator took
    // its non-array branch and emitted `unknown-capability`, which an "allow" profile lets
    // through — so a model the operator explicitly disabled reasoning for could still
    // satisfy a reasoning-effort requirement.
    function configWithProfile(noReasoning: boolean): OcxConfig {
      return {
        providers: {
          custom: {
            adapter: "openai-chat",
            baseUrl: "https://example.test/v1",
            models: ["gpt-oss:120b"],
            modelReasoningEfforts: { "gpt-oss": ["low", "high"] },
            ...(noReasoning ? { noReasoningModels: ["gpt-oss:120b"] } : {}),
          },
        },
        routingProfiles: {
          effort: {
            candidates: [{ provider: "custom", model: "gpt-oss:120b" }],
            require: { reasoningEffort: "high" },
            unknownEvidence: { capability: "allow", health: "allow", quota: "allow", cost: "allow" },
          },
        },
      } as unknown as OcxConfig;
    }

    const disabled = configWithProfile(true);
    const result = evaluatePolicyProfile(disabled, "effort", {}, [
      {
        provider: "custom",
        model: "gpt-oss:120b",
        capability: candidateCapabilityEvidence(disabled, "custom", "gpt-oss:120b"),
      },
    ]);
    const candidate = result.candidates[0]!;
    expect(candidate.exclusions.some(e => e.code === "capability-unsatisfied" && e.detail === "reasoning-effort")).toBe(true);
    expect(candidate.exclusions.some(e => e.code === "unknown-capability")).toBe(false);

    // Control: the same profile without noReasoningModels is satisfied by the ladder.
    const enabled = configWithProfile(false);
    const allowed = evaluatePolicyProfile(enabled, "effort", {}, [
      {
        provider: "custom",
        model: "gpt-oss:120b",
        capability: candidateCapabilityEvidence(enabled, "custom", "gpt-oss:120b"),
      },
    ]);
    expect(allowed.candidates[0]!.exclusions).toEqual([]);
  });

  test("a registry entry covers its tagged siblings with no provider configured", () => {
    // The three registry lookups (capability.ts lines 170/180/206) are a separate branch
    // from the configured-provider ones above: they are only reached when the provider is
    // absent from the config, which every other case here supplies.
    const registryEntry = PROVIDER_REGISTRY.find(entry => entry.id === "xai");
    if (!registryEntry) throw new Error("fixture drift: no `xai` entry in PROVIDER_REGISTRY");

    // Pin the fixture's shape rather than its values, so registry churn does not turn
    // into a false failure here while real drift still does.
    const family = "grok-4.6";
    expect(registryEntry.modelContextWindows?.[family]).toBeNumber();
    expect(registryEntry.modelInputModalities?.[family]).toBeArray();
    expect(registryEntry.modelReasoningEfforts?.[family]).toBeArray();

    const emptyConfig = { providers: {} } as unknown as OcxConfig;
    const evidence = candidateCapabilityEvidence(emptyConfig, "xai", `${family}:latest`);

    expect(evidence.contextWindow).toBe(registryEntry.modelContextWindows![family]);
    expect(evidence.image).toBe(registryEntry.modelInputModalities![family].includes("image"));
    expect(evidence.reasoningEfforts).toEqual(registryEntry.modelReasoningEfforts![family]);
  });

  test("noVisionModels beats an exact modality entry, as isModelTextOnly does", () => {
    // `isModelTextOnly` matches the no-vision list and returns true before it ever
    // reads `modelInputModalities`, so the `gpt-oss` no-vision entry wins over an
    // exact `gpt-oss:120b` entry listing "image". Evidence that disagrees here is
    // worse than a wrong window: routing selects the candidate for image work and
    // execution then refuses it.
    const provider = {
      ...providerWithFamilyEntries(),
      noVisionModels: ["gpt-oss"],
      modelInputModalities: { "gpt-oss:120b": ["text", "image"] },
    } as unknown as OcxProviderConfig;

    // Ground truth first: the resolver this evidence claims to describe says text-only.
    expect(isModelTextOnly(provider, "gpt-oss:120b")).toBe(true);

    const evidence = candidateCapabilityEvidence(configFor(provider), "custom", "gpt-oss:120b");
    expect(evidence.image).toBe(false);
  });

  test("a model outside noVisionModels keeps its declared image modality", () => {
    // The negative half: the no-vision check must not spread to models the list does
    // not cover, or the fix would trade a false positive for a false negative.
    const provider = {
      ...providerWithFamilyEntries(),
      models: ["gpt-oss:120b", "llava:13b"],
      noVisionModels: ["gpt-oss"],
      modelInputModalities: { "llava:13b": ["text", "image"] },
    } as unknown as OcxProviderConfig;

    expect(isModelTextOnly(provider, "llava:13b")).toBe(false);
    expect(candidateCapabilityEvidence(configFor(provider), "custom", "llava:13b").image).toBe(true);
  });

  test("a prototype-shaped model id resolves nothing", () => {
    // modelRecordValue uses hasOwnProperty; a bare lookup would return Object.prototype
    // members here and hand routing a function as evidence.
    for (const modelId of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      const evidence = candidateCapabilityEvidence(
        configFor(providerWithFamilyEntries()),
        "custom",
        modelId,
      );
      expect(evidence.contextWindow).toBe(8_000);
      expect(evidence.reasoningEfforts).toBeUndefined();
      expect(evidence.image).toBeUndefined();
    }
  });
});
