import { describe, expect, test } from "bun:test";

import { createResponsesPassthroughAdapter } from "../src/adapters/openai-responses";
import { validateConfigCandidate } from "../src/config";
import {
  canonicalFastTierMarker,
  cloneFastWire,
  decideTier,
  resolveFastPolicy,
  tierValueAfterDecision,
  type FastPolicyAuthority,
  type ResolvedFastPolicy,
} from "../src/providers/fastwire";
import { captureFastPolicyAuthority, fastPolicyForModel } from "../src/providers/service-tier";
import { PROVIDER_REGISTRY, providerRegistryFastWireError } from "../src/providers/registry";
import {
  captureWireAdapterHardPins,
  isWirePinnedModel,
  type FastWire,
  type OcxConfig,
  type OcxParsedRequest,
  type TierDecision,
} from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const MODEL = "model";
const SERVICE_WIRE: FastWire = {
  kind: "service-tier",
  canonicalToWire: { priority: "priority" },
  foreignCallerTiers: "verbatim",
};

type AdapterSource = "hard-pin" | "override" | "registry-default" | "provider-adapter";
type DeclarationState = "undefined" | "null" | "explicit";
type CapabilityState = "false" | "undefined" | "true";

function authorityForMatrix(args: {
  source: AdapterSource;
  declaration: DeclarationState;
  overrideAllowed: boolean;
  capability: CapabilityState;
  chatForeignTierForward: boolean;
}): FastPolicyAuthority {
  const providerAdapter = args.source === "provider-adapter" ? "openai-chat" : "openai-responses";
  return {
    providerAdapter,
    fastWireDeclaration: args.declaration === "undefined"
      ? undefined
      : args.declaration === "null" ? null : SERVICE_WIRE,
    modelWireOverrideAllowed: args.overrideAllowed,
    authTransport: "authorization_bearer",
    capability: {
      ...(args.capability === "undefined" ? {} : { provider: args.capability === "true" }),
      models: {},
      chatServiceTier: args.chatForeignTierForward,
    },
    modelAdapters: args.source === "hard-pin" || args.source === "override"
      ? { [MODEL]: args.source === "override" ? "openai-chat" : "openai-responses" }
      : {},
    hardPins: args.source === "hard-pin" ? { [MODEL]: "openai-chat" } : {},
    registryWireDefaults: args.source === "hard-pin" || args.source === "override"
      ? { [MODEL]: "openai-responses" }
      : args.source === "registry-default" ? { [MODEL]: "openai-chat" } : {},
  };
}

const policyMatrix = (["undefined", "null", "explicit"] as const).flatMap(declaration =>
  ([false, true] as const).flatMap(overrideAllowed =>
    (["hard-pin", "override", "registry-default", "provider-adapter"] as const).flatMap(source =>
      (["false", "undefined", "true"] as const).flatMap(capability =>
        ([false, true] as const).map(chatForeignTierForward => ({
          declaration,
          overrideAllowed,
          source,
          capability,
          chatForeignTierForward,
        })),
      ),
    ),
  ),
);

describe("resolveFastPolicy matrix", () => {
  test.each(policyMatrix)(
    "$declaration declaration, overrideAllowed=$overrideAllowed, $source, capability=$capability, chatForeign=$chatForeignTierForward",
    row => {
      const authority = authorityForMatrix(row);
      const policy = resolveFastPolicy(authority, MODEL);
      const overrideCanWin = row.overrideAllowed && row.source !== "provider-adapter";
      const expectedAdapter = row.source === "hard-pin"
        ? "openai-chat"
        : overrideCanWin ? "openai-chat"
          : row.source === "provider-adapter" ? "openai-chat" : "openai-responses";
      const capability = row.capability === "undefined" ? undefined : row.capability === "true";
      const wireAvailable = row.declaration !== "null";
      const expectedEligibility: ResolvedFastPolicy["eligibility"] = capability === false
        ? "capability-unsupported"
        : !wireAvailable
          ? "wire-unavailable"
          : capability === undefined ? "unclassified" : "eligible";

      expect(policy.adapter).toBe(expectedAdapter);
      expect(policy.capability).toBe(capability);
      expect(policy.eligibility).toBe(expectedEligibility);
      expect(policy.fastWire === null ? null : policy.fastWire?.kind).toBe(
        row.declaration === "null" ? null : "service-tier",
      );
      expect(policy.forwardCallerTier).toBe(
        capability !== false
          && (expectedAdapter !== "openai-chat" || row.chatForeignTierForward),
      );
    },
  );

  test("registry defaults retain their inbound constraint", () => {
    const authority: FastPolicyAuthority = {
      ...authorityForMatrix({
        source: "registry-default",
        declaration: "undefined",
        overrideAllowed: true,
        capability: "true",
        chatForeignTierForward: true,
      }),
      providerAdapter: "openai-responses",
      registryWireDefaults: { [MODEL]: { wire: "openai-chat", inbound: ["chat"] } },
    };
    expect(resolveFastPolicy(authority, MODEL, "chat").adapter).toBe("openai-chat");
    expect(resolveFastPolicy(authority, MODEL, "responses").adapter).toBe("openai-responses");
  });

  test("registry defaults retain their auth-mode constraint", () => {
    const base: FastPolicyAuthority = {
      ...authorityForMatrix({
        source: "provider-adapter",
        declaration: "undefined",
        overrideAllowed: true,
        capability: "true",
        chatForeignTierForward: true,
      }),
      providerAdapter: "openai-chat",
      registryWireDefaults: {
        [MODEL]: { wire: "openai-responses", inbound: ["responses"], authModes: ["oauth"] },
      },
    };
    expect(resolveFastPolicy({ ...base, providerAuthMode: "oauth" }, MODEL).adapter)
      .toBe("openai-responses");
    expect(resolveFastPolicy({ ...base, providerAuthMode: "key" }, MODEL).adapter)
      .toBe("openai-chat");
    expect(resolveFastPolicy(base, MODEL).adapter).toBe("openai-chat");
  });

  test("hard pins and configured overrides retain exact runtime model-key semantics", () => {
    const authority: FastPolicyAuthority = {
      ...authorityForMatrix({
        source: "provider-adapter",
        declaration: "undefined",
        overrideAllowed: true,
        capability: "true",
        chatForeignTierForward: true,
      }),
      providerAdapter: "openai-responses",
      modelAdapters: { Model: "openai-chat" },
      hardPins: { Pinned: "anthropic" },
    };
    expect(resolveFastPolicy(authority, "model").adapter).toBe("openai-responses");
    expect(resolveFastPolicy(authority, "Model").adapter).toBe("openai-chat");
    expect(resolveFastPolicy(authority, "pinned").adapter).toBe("openai-responses");
    expect(resolveFastPolicy(authority, "Pinned").adapter).toBe("anthropic");
  });

  test("invalid configured overrides fall through to the captured registry default", () => {
    const authority: FastPolicyAuthority = {
      ...authorityForMatrix({
        source: "registry-default",
        declaration: "undefined",
        overrideAllowed: true,
        capability: "true",
        chatForeignTierForward: true,
      }),
      modelAdapters: { [MODEL]: "anthropic" },
      registryWireDefaults: { [MODEL]: "openai-chat" },
    };
    expect(resolveFastPolicy(authority, MODEL).adapter).toBe("openai-chat");
  });

  test("registry defaults do not move a provider outside the allowed base-wire family", () => {
    const authority: FastPolicyAuthority = {
      ...authorityForMatrix({
        source: "registry-default",
        declaration: "undefined",
        overrideAllowed: true,
        capability: "true",
        chatForeignTierForward: true,
      }),
      providerAdapter: "anthropic",
      registryWireDefaults: { [MODEL]: "openai-chat" },
    };
    expect(resolveFastPolicy(authority, MODEL).adapter).toBe("anthropic");
  });

  test("anthropic-speed has no A1 adapter mapping", () => {
    const policy = resolveFastPolicy({
      ...authorityForMatrix({
        source: "provider-adapter",
        declaration: "explicit",
        overrideAllowed: true,
        capability: "true",
        chatForeignTierForward: true,
      }),
      fastWireDeclaration: {
        kind: "anthropic-speed",
        canonicalToWire: { priority: "fast" },
        foreignCallerTiers: "drop",
        betas: ["fast-beta"],
      },
    }, MODEL);
    expect(policy).toMatchObject({ eligibility: "wire-unavailable", forwardCallerTier: false });
  });

  test("an incompatible hard pin reports pin-unavailable", () => {
    const policy = resolveFastPolicy({
      ...authorityForMatrix({
        source: "provider-adapter",
        declaration: "explicit",
        overrideAllowed: true,
        capability: "true",
        chatForeignTierForward: true,
      }),
      hardPins: { [MODEL]: "anthropic" },
    }, MODEL);
    expect(policy).toMatchObject({ adapter: "anthropic", eligibility: "pin-unavailable" });
  });

  test("an explicitly disabled wire reports wire-unavailable even when hard pinned", () => {
    const policy = resolveFastPolicy({
      ...authorityForMatrix({
        source: "provider-adapter",
        declaration: "null",
        overrideAllowed: true,
        capability: "true",
        chatForeignTierForward: true,
      }),
      hardPins: { [MODEL]: "anthropic" },
    }, MODEL);
    expect(policy).toMatchObject({ adapter: "anthropic", eligibility: "wire-unavailable" });
  });

  test("mutable providers rebuild authority after a capture", () => {
    const provider = {
      adapter: "openai-responses",
      baseUrl: "https://fixture.example/v1",
      supportsServiceTier: true,
    };
    expect(captureFastPolicyAuthority("fixture", provider, false).capability.provider).toBe(true);
    provider.supportsServiceTier = false;
    expect(fastPolicyForModel(provider, MODEL, "fixture").capability).toBe(false);
  });

  test("locks the five-row xAI and DeepSeek wire/tier regression matrix", () => {
    const rows = [
      {
        name: "xAI OAuth default",
        providerName: "xai",
        modelIds: ["grok-4.6", "grok-4.5"],
        provider: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "oauth" as const,
        },
        adapter: "openai-chat",
        forwardCallerTier: false,
        callerTier: undefined,
        settledCallerTier: undefined,
      },
      {
        name: "xAI OAuth Responses override",
        providerName: "xai",
        modelIds: ["grok-4.6", "grok-4.5"],
        provider: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "oauth" as const,
          modelAdapters: { "grok-4.6": "openai-responses", "grok-4.5": "openai-responses" },
        },
        adapter: "openai-responses",
        forwardCallerTier: false,
        callerTier: "flex",
        settledCallerTier: undefined,
      },
      {
        name: "xAI API-key default",
        providerName: "xai",
        modelIds: ["grok-4.6", "grok-4.5"],
        provider: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key" as const,
        },
        adapter: "openai-chat",
        forwardCallerTier: false,
        callerTier: undefined,
        settledCallerTier: undefined,
      },
      {
        name: "xAI API-key Responses override",
        providerName: "xai",
        modelIds: ["grok-4.6", "grok-4.5"],
        provider: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key" as const,
          modelAdapters: { "grok-4.6": "openai-responses", "grok-4.5": "openai-responses" },
        },
        adapter: "openai-responses",
        forwardCallerTier: true,
        callerTier: "flex",
        settledCallerTier: "flex",
      },
      {
        name: "DeepSeek V4 defaults",
        providerName: "deepseek",
        modelIds: ["deepseek-v4-flash", "deepseek-v4-pro"],
        provider: {
          adapter: "openai-chat",
          baseUrl: "https://api.deepseek.com",
          authMode: "key" as const,
        },
        adapter: "openai-responses",
        forwardCallerTier: false,
        callerTier: undefined,
        settledCallerTier: undefined,
      },
    ] as const;

    for (const row of rows) {
      for (const modelId of row.modelIds) {
        const policy = fastPolicyForModel(row.provider, modelId, row.providerName);
        expect(policy.adapter).toBe(row.adapter);
        expect(policy.forwardCallerTier).toBe(row.forwardCallerTier);
        expect(tierValueAfterDecision(decideTier(policy, undefined, undefined), undefined))
          .toBeUndefined();
        if (row.callerTier !== undefined) {
          expect(tierValueAfterDecision(decideTier(policy, undefined, row.callerTier), row.callerTier))
            .toBe(row.settledCallerTier);
        }
      }
    }
  });

  test("prototype-named providers and models use only own wire-policy rows", () => {
    expect(captureWireAdapterHardPins("toString")).toEqual({});
    expect(isWirePinnedModel("toString", MODEL)).toBe(false);
    const authority = authorityForMatrix({
      source: "provider-adapter",
      declaration: "undefined",
      overrideAllowed: true,
      capability: "true",
      chatForeignTierForward: true,
    });
    const responsesAuthority = { ...authority, providerAdapter: "openai-responses" };
    expect(resolveFastPolicy(responsesAuthority, "constructor")).toMatchObject({
      adapter: "openai-responses",
      eligibility: "eligible",
    });
    expect(resolveFastPolicy({
      ...responsesAuthority,
      hardPins: Object.fromEntries([["constructor", "anthropic"]]),
    }, "constructor")).toMatchObject({
      adapter: "anthropic",
      eligibility: "pin-unavailable",
    });
  });

  test("a missing provider name preserves the legacy provider-adapter short circuit", () => {
    const provider = {
      adapter: "anthropic",
      baseUrl: "https://fixture.example/v1",
      modelAdapters: { [MODEL]: "openai-responses" },
      supportsServiceTier: true,
    } as const;
    expect(fastPolicyForModel(provider, MODEL)).toMatchObject({
      adapter: "anthropic",
      capability: true,
      eligibility: "wire-unavailable",
    });
    expect(fastPolicyForModel(provider, MODEL, "fixture")).toMatchObject({
      adapter: "openai-responses",
      capability: true,
      eligibility: "eligible",
    });
  });
});

const tierGrid = ([false, undefined, true] as const).flatMap(support =>
  ([false, undefined, true] as const).flatMap(fastMode =>
    (["priority", "fast", "flex", undefined] as const).map(callerTier => ({
      support,
      fastMode,
      callerTier,
    })),
  ),
);

function tierPolicy(support: boolean | undefined): ResolvedFastPolicy {
  return {
    capability: support,
    eligibility: support === true ? "eligible" : support === false ? "capability-unsupported" : "unclassified",
    adapter: "openai-responses",
    fastWire: SERVICE_WIRE,
    forwardCallerTier: support !== false,
  };
}

describe("TierDecision state machine", () => {
  test.each(tierGrid)(
    "support=$support fastMode=$fastMode caller=$callerTier",
    ({ support, fastMode, callerTier }) => {
      const decision = decideTier(tierPolicy(support), fastMode, callerTier);
      const expectedValue = support === false
        ? undefined
        : support === undefined ? callerTier
          : fastMode === true ? "priority" : fastMode === false ? undefined
            : callerTier === "fast" ? "priority" : callerTier;
      const inheritedCanonicalFast = support === true
        && fastMode === undefined
        && (callerTier === "priority" || callerTier === "fast");
      const expectedKind: TierDecision["kind"] = support === false || (support === true && fastMode === false)
        ? "drop"
        : support === true && (fastMode === true || inheritedCanonicalFast) ? "set" : "forward-caller";
      expect(decision.kind).toBe(expectedKind);
      expect(tierValueAfterDecision(decision, callerTier)).toBe(expectedValue);
      expect(canonicalFastTierMarker(callerTier)).toBe(
        callerTier === "priority" || callerTier === "fast" ? "priority" : undefined,
      );
    },
  );

  test.each(([false, undefined, true] as const).flatMap(fastMode =>
    (["priority", "fast", "flex", undefined] as const).map(callerTier => ({ fastMode, callerTier })),
  ))("true capability plus null wire preserves caller with fastMode=$fastMode caller=$callerTier", ({ fastMode, callerTier }) => {
    const decision = decideTier({
      capability: true,
      eligibility: "wire-unavailable",
      adapter: "openai-responses",
      fastWire: null,
      forwardCallerTier: true,
    }, fastMode, callerTier);
    expect(decision).toEqual({ kind: "forward-caller" });
    expect(tierValueAfterDecision(decision, callerTier)).toBe(callerTier);
  });

  test.each(["Priority", "FAST", " fast "])("normalizes inherited canonical spelling %s to the wire value", callerTier => {
    expect(canonicalFastTierMarker(callerTier)).toBe("priority");
    const decision = decideTier(tierPolicy(true), undefined, callerTier);
    expect(decision).toEqual({ kind: "set", value: "priority" });
    expect(tierValueAfterDecision(decision, callerTier)).toBe("priority");
  });

  test.each([
    { callerTier: "priority", expected: { kind: "set", value: "priority" } },
    { callerTier: "fast", expected: { kind: "set", value: "priority" } },
    { callerTier: "flex", expected: { kind: "drop" } },
    { callerTier: undefined, expected: { kind: "forward-caller" } },
  ])("foreign-tier drop policy resolves caller=$callerTier to $expected.kind", ({ callerTier, expected }) => {
    expect(decideTier({
      ...tierPolicy(true),
      fastWire: { ...SERVICE_WIRE, foreignCallerTiers: "drop" },
    }, undefined, callerTier)).toEqual(expected);
  });

  test("Chat foreign-tier permission is independent from canonical Fast", () => {
    const policy = { ...tierPolicy(true), adapter: "openai-chat", forwardCallerTier: false };
    expect(decideTier(policy, undefined, "flex")).toEqual({ kind: "drop" });
    expect(decideTier(policy, undefined, "fast")).toEqual({ kind: "set", value: "priority" });
  });

  test("unclassified Responses capability keeps the full caller passthrough contract", () => {
    expect(decideTier({
      ...tierPolicy(undefined),
      fastWire: { ...SERVICE_WIRE, foreignCallerTiers: "drop" },
    }, true, "flex")).toEqual({ kind: "forward-caller" });
  });

  test("unclassified caller tiers honor the final adapter forwarding permission", () => {
    expect(decideTier({
      ...tierPolicy(undefined),
      adapter: "openai-chat",
      forwardCallerTier: false,
    }, undefined, "fast")).toEqual({ kind: "drop" });
    expect(decideTier({
      ...tierPolicy(undefined),
      adapter: "openai-responses",
      forwardCallerTier: true,
    }, undefined, "fast")).toEqual({ kind: "forward-caller" });
  });
});

function configWithFastWire(fastWire: unknown, capability?: { provider?: boolean; exact?: boolean }): unknown {
  return {
    port: 10100,
    defaultProvider: "fixture",
    providers: {
      fixture: {
        adapter: "openai-responses",
        baseUrl: "https://fixture.example/v1",
        fastWire,
        ...(capability?.provider === undefined ? {} : { supportsServiceTier: capability.provider }),
        ...(capability?.exact === undefined ? {} : { modelSupportsServiceTier: { [MODEL]: capability.exact } }),
      },
    },
  };
}

describe("FastWire config and registry validation", () => {
  test("the shared clone detaches nested FastWire records and arrays", () => {
    const canonicalToWire = { priority: "priority" };
    const betas = ["beta-one"];
    const original: FastWire = {
      kind: "service-tier",
      canonicalToWire,
      foreignCallerTiers: "verbatim",
      betas,
    };
    const cloned = cloneFastWire(original)!;
    canonicalToWire.priority = "performance";
    betas[0] = "changed";
    expect(cloned).toEqual({
      kind: "service-tier",
      canonicalToWire: { priority: "priority" },
      foreignCallerTiers: "verbatim",
      betas: ["beta-one"],
    });
  });

  test("accepts a complete declaration and trims its wire values", () => {
    const result = validateConfigCandidate(configWithFastWire({
      kind: "service-tier",
      canonicalToWire: { priority: " priority ", flex: " flex " },
      foreignCallerTiers: "verbatim",
      betas: [" beta-one "],
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.config as OcxConfig).providers.fixture?.fastWire).toEqual({
        kind: "service-tier",
        canonicalToWire: { priority: "priority", flex: "flex" },
        foreignCallerTiers: "verbatim",
        betas: ["beta-one"],
      });
    }
  });

  test.each([
    { label: "closed kind", value: { kind: "future", canonicalToWire: { priority: "priority" }, foreignCallerTiers: "verbatim" } },
    { label: "missing priority", value: { kind: "service-tier", canonicalToWire: { fast: "fast" }, foreignCallerTiers: "verbatim" } },
    { label: "blank priority", value: { kind: "service-tier", canonicalToWire: { priority: " " }, foreignCallerTiers: "verbatim" } },
    { label: "overlong wire value", value: { kind: "service-tier", canonicalToWire: { priority: "x".repeat(65) }, foreignCallerTiers: "verbatim" } },
    { label: "duplicate wire values", value: { kind: "service-tier", canonicalToWire: { priority: "fast", other: " fast " }, foreignCallerTiers: "verbatim" } },
    { label: "blank beta", value: { kind: "anthropic-speed", canonicalToWire: { priority: "fast" }, foreignCallerTiers: "drop", betas: [" "] } },
    { label: "duplicate betas", value: { kind: "anthropic-speed", canonicalToWire: { priority: "fast" }, foreignCallerTiers: "drop", betas: ["one", " one "] } },
    { label: "too many betas", value: { kind: "anthropic-speed", canonicalToWire: { priority: "fast" }, foreignCallerTiers: "drop", betas: Array.from({ length: 17 }, (_, index) => `b${index}`) } },
    { label: "unknown declaration key", value: { kind: "service-tier", canonicalToWire: { priority: "priority" }, foreignCallerTiers: "verbatim", future: true } },
  ])("rejects $label", ({ value }) => {
    expect(validateConfigCandidate(configWithFastWire(value)).ok).toBe(false);
  });

  test.each([
    { label: "provider capability", capability: { provider: true } },
    { label: "exact-model capability", capability: { exact: true } },
  ])("rejects null against $label", ({ capability }) => {
    expect(validateConfigCandidate(configWithFastWire(null, capability)).ok).toBe(false);
  });

  test("redacts a token-shaped provider name in a FastWire conflict path", () => {
    const providerName = ["sk", "proj", "fastwire", "A".repeat(40)].join("-");
    const result = validateConfigCandidate({
      port: 10100,
      defaultProvider: providerName,
      providers: {
        [providerName]: {
          adapter: "openai-responses",
          baseUrl: "https://fixture.example/v1",
          supportsServiceTier: true,
          fastWire: null,
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain(providerName);
      expect(result.error).toContain("providers.[REDACTED].fastWire");
    }
  });

  test("provider-level false keeps null valid even with an exact-model true", () => {
    expect(validateConfigCandidate(configWithFastWire(null, { provider: false, exact: true })).ok)
      .toBe(true);
  });

  test("accepts and preserves null against an inherited registry capability", () => {
    expect(validateConfigCandidate({
      port: 10100,
      defaultProvider: "openai-apikey",
      providers: {
        "openai-apikey": {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authMode: "key",
          fastWire: null,
        },
      },
    })).toMatchObject({
      ok: true,
      config: { providers: { "openai-apikey": { fastWire: null } } },
    });
  });

  test("provider-level false closes an inherited registry capability", () => {
    expect(validateConfigCandidate({
      port: 10100,
      defaultProvider: "openai-apikey",
      providers: {
        "openai-apikey": {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authMode: "key",
          supportsServiceTier: false,
          fastWire: null,
        },
      },
    }).ok).toBe(true);
  });

  test("registry validation rejects the same null/capability conflict", () => {
    expect(providerRegistryFastWireError({ fastWire: null, supportsServiceTier: true }))
      .toContain("conflicts");
    expect(providerRegistryFastWireError({ fastWire: null, modelSupportsServiceTier: { [MODEL]: true } }))
      .toContain("conflicts");
    expect(providerRegistryFastWireError({
      fastWire: null,
      supportsServiceTier: false,
      modelSupportsServiceTier: { [MODEL]: true },
    })).toBeNull();
  });

  test("A1 adds no explicit registry FastWire declaration", () => {
    expect(PROVIDER_REGISTRY.every(entry => entry.fastWire === undefined)).toBeTrue();
  });
});

describe("Responses TierDecision immutability", () => {
  test.each([
    { label: "set", decision: { kind: "set", value: "priority" } as TierDecision, expected: "priority" },
    { label: "drop", decision: { kind: "drop" } as TierDecision, expected: undefined },
    { label: "forward-caller", decision: { kind: "forward-caller" } as TierDecision, expected: "flex" },
  ])("$label preserves the caller-owned raw body", ({ decision, expected }) => {
    const rawBody = { model: MODEL, input: "ping", service_tier: "flex" };
    const original = { ...rawBody };
    const parsed: OcxParsedRequest = {
      modelId: MODEL,
      context: { messages: [] },
      stream: true,
      options: { serviceTier: expected, tierDecision: decision },
      _rawBody: rawBody,
    };
    const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://fixture.example/v1",
      authMode: "key",
      apiKey: "sk-test",
    }));
    const outbound = JSON.parse(adapter.buildRequest(parsed).body) as Record<string, unknown>;

    expect(parsed._rawBody).toBe(rawBody);
    expect(rawBody).toEqual(original);
    if (expected === undefined) expect(outbound).not.toHaveProperty("service_tier");
    else expect(outbound.service_tier).toBe(expected);
  });
});
