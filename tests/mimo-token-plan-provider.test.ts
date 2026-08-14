import { describe, expect, test } from "bun:test";
import { applyProviderConfigHints } from "../src/codex/catalog";
import { KEY_LOGIN_PROVIDERS } from "../src/oauth/key-providers";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { mapReasoningEffort } from "../src/reasoning-effort";
import { routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";

describe("Xiaomi MiMo public OpenAI Chat endpoint (#1483)", () => {
  const baseUrl = "https://api.xiaomimimo.com/v1";
  const entry = PROVIDER_REGISTRY.find(row => row.id === "xiaomi-mimo");

  test("owns the official destination and advertises only its validated ladder", () => {
    expect(entry).toMatchObject({
      adapter: "openai-chat",
      baseUrl,
      dashboardUrl: "https://platform.xiaomimimo.com/console/balance",
      defaultModel: "mimo-v2.5",
      models: ["mimo-v2.5"],
      preserveCustomDestination: true,
      reasoningEfforts: ["low", "medium", "high"],
    });
    expect(KEY_LOGIN_PROVIDERS["xiaomi-mimo"]?.baseUrl).toBe(baseUrl);

    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "xiaomi-mimo",
      providers: {
        "xiaomi-mimo": {
          adapter: "openai-chat",
          baseUrl,
          authMode: "key",
          apiKey: "test-key",
          liveModels: true,
        },
      },
    };
    const route = routeModel(config, "xiaomi-mimo/mimo-v2.5");
    const catalogModel = applyProviderConfigHints("xiaomi-mimo", route.provider, {
      provider: "xiaomi-mimo",
      id: route.modelId,
    });

    expect(catalogModel.reasoningEfforts).toEqual(["low", "medium", "high"]);
    for (const tier of ["xhigh", "max", "ultra"]) {
      expect(mapReasoningEffort(route.provider, route.modelId, tier)).toBe("high");
    }
  });

  test("does not claim a same-named provider at another destination", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "xiaomi-mimo",
      providers: {
        "xiaomi-mimo": {
          adapter: "openai-chat",
          baseUrl: "https://private.example/v1",
          authMode: "key",
          apiKey: "private-key",
        },
      },
    };

    const route = routeModel(config, "xiaomi-mimo/mimo-v2.5");
    expect(route.provider.baseUrl).toBe("https://private.example/v1");
    expect(route.provider.apiKey).toBe("private-key");
    expect(route.provider.reasoningEfforts).toBeUndefined();
    expect(route.provider.reasoningEffortMap).toBeUndefined();
  });
});

describe("Xiaomi MiMo token plan (#1158)", () => {
  const entry = PROVIDER_REGISTRY.find(row => row.id === "mimo");

  test("is pinned to the Chat wire, which is the one that accepts custom tools", () => {
    // The endpoint answers Responses for plain turns, so a hand-configured provider naturally
    // picks `openai-responses` — and then every agentic turn 400s, because the gateway rejects
    // `type: "custom"` tools and `apply_patch` is one. The preset exists to make the working
    // wire the default.
    expect(entry?.adapter).toBe("openai-chat");
    expect(entry?.baseUrl).toBe("https://token-plan-cn.xiaomimimo.com/v1");
    expect(entry?.models).toEqual(["mimo-v2.5-pro", "mimo-v2.5"]);

    const derived = KEY_LOGIN_PROVIDERS["mimo"];
    expect(derived?.adapter).toBe("openai-chat");
    expect(derived?.baseUrl).toBe("https://token-plan-cn.xiaomimimo.com/v1");
  });

  test("clamps reasoning tiers above the ladder the gateway validates", () => {
    expect(entry?.reasoningEfforts).toEqual(["low", "medium", "high"]);
    for (const tier of ["xhigh", "max", "ultra"]) {
      expect(entry?.reasoningEffortMap?.[tier]).toBe("high");
    }
  });

  test("a same-named custom provider keeps its own destination and credential", () => {
    // The claim the preset actually leans on, and the one the shape assertions above do NOT
    // exercise. Someone may already have a hand-rolled provider called `mimo` pointing
    // elsewhere; without `preserveCustomDestination`, routing would canonicalize their base URL
    // onto the registry's and send their key to a host they never chose.
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "mimo",
      providers: {
        mimo: {
          adapter: "openai-responses",
          baseUrl: "https://private.example/v1",
          apiKey: "user-key",
          authMode: "key",
        },
      },
    };

    const route = routeModel(config, "mimo/custom-model");
    expect(route.provider.baseUrl).toBe("https://private.example/v1");
    expect(route.provider.apiKey).toBe("user-key");
    expect(route.provider.adapter).toBe("openai-responses");
    // The registry's effort clamp must not be applied to a row we do not own either.
    expect(route.provider.reasoningEfforts).toBeUndefined();
  });

  // A user reasoningEffortMap CAN still lift a tier, and that is the shipped contract rather
  // than an oversight: `healMappedTiers` treats a wire map as authoritative evidence of the
  // tiers the upstream can emit and merges its Codex values into the ladder, which is what lets
  // a stale persisted ladder recover a newly documented tier without rewriting user config
  // (see "stale reasoning-ladder self-heal" in tests/reasoning-effort.test.ts).
  //
  // So the registry clamp protects the DEFAULT route, not a user who has deliberately written a
  // conflicting map. This test records that boundary so the next reader does not mistake the
  // clamp for an enforcement the code does not implement.
  test("a user reasoningEffortMap deliberately overrides the registry clamp", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "xiaomi-mimo",
      providers: {
        "xiaomi-mimo": {
          adapter: "openai-chat",
          baseUrl: "https://api.xiaomimimo.com/v1",
          apiKey: "k",
          authMode: "key",
          // Conflicts with the registry clamp on purpose.
          reasoningEffortMap: { max: "max", ultra: "ultra" },
        },
      },
    };

    const route = routeModel(config, "xiaomi-mimo/mimo-v2.5");
    // The stored ladder is untouched — healing happens at lookup time, not on the config.
    expect(route.provider.reasoningEfforts).toEqual(["low", "medium", "high"]);
    // ...but `configuredReasoningEfforts` merges the user map's Codex values in, so `max`
    // becomes a supported tier for resolution and the alias resolves to itself.
    expect(mapReasoningEffort(route.provider, "mimo-v2.5", "max")).toBe("max");

    // `ultra` still normalizes to `max` at the codex-rs boundary rather than reaching the wire.
    expect(mapReasoningEffort(route.provider, "mimo-v2.5", "ultra")).toBe("max");

    // Tiers inside the registry ladder are untouched.
    expect(mapReasoningEffort(route.provider, "mimo-v2.5", "low")).toBe("low");
    expect(mapReasoningEffort(route.provider, "mimo-v2.5", "medium")).toBe("medium");
  });

  // The case the clamp actually governs: no user map, so the registry ladder is authoritative
  // and a direct max/ultra/xhigh request lands on `high` instead of reproducing the #1483 400.
  test("without a conflicting user map the registry clamp holds", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "xiaomi-mimo",
      providers: {
        "xiaomi-mimo": {
          adapter: "openai-chat",
          baseUrl: "https://api.xiaomimimo.com/v1",
          apiKey: "k",
          authMode: "key",
        },
      },
    };

    const route = routeModel(config, "xiaomi-mimo/mimo-v2.5");
    expect(route.provider.reasoningEfforts).toEqual(["low", "medium", "high"]);
    for (const tier of ["max", "ultra", "xhigh"]) {
      expect(mapReasoningEffort(route.provider, "mimo-v2.5", tier)).toBe("high");
    }
    expect(mapReasoningEffort(route.provider, "mimo-v2.5", "low")).toBe("low");
  });

  test("an alias that lands inside the ladder still resolves through the map", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "custom-alias",
      providers: {
        "custom-alias": {
          adapter: "openai-chat",
          baseUrl: "https://alias.example/v1",
          apiKey: "k",
          authMode: "key",
          reasoningEfforts: ["low", "medium", "high"],
          reasoningEffortMap: { max: "medium" },
        },
      },
    };

    const route = routeModel(config, "custom-alias/some-model");
    expect(mapReasoningEffort(route.provider, "some-model", "max")).toBe("medium");
  });

  test("a provider without a configured ladder keeps its alias verbatim", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "no-ladder",
      providers: {
        "no-ladder": {
          adapter: "openai-chat",
          baseUrl: "https://noladder.example/v1",
          apiKey: "k",
          authMode: "key",
          reasoningEffortMap: { max: "turbo" },
        },
      },
    };

    const route = routeModel(config, "no-ladder/some-model");
    expect(mapReasoningEffort(route.provider, "some-model", "max")).toBe("turbo");
  });
});
