import { describe, expect, test } from "bun:test";
import { KEY_LOGIN_PROVIDERS } from "../src/oauth/key-providers";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";

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
});
