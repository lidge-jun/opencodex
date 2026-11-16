import { describe, expect, test } from "bun:test";
import { planVideoBridge } from "../../src/images/plan";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { VIDEO_GEN_TOOL_NAME } from "../../src/images/synthetic-tool";

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  const xai: OcxProviderConfig = {
    name: "xai",
    baseUrl: "https://api.x.ai/v1",
    authMode: "key",
    apiKey: "xai-test-key",
  };
  return {
    providers: { xai },
    ...overrides,
  } as unknown as OcxConfig;
}

function makeParsed(): OcxParsedRequest {
  return { stream: true, context: { messages: [] } } as unknown as OcxParsedRequest;
}

function makeProvider(host: string): OcxProviderConfig {
  return { baseUrl: `https://${host}`, authMode: "key", apiKey: "other-key" } as unknown as OcxProviderConfig;
}

describe("planVideoBridge", () => {
  test("returns undefined when videoBridgeEnabled is not true", async () => {
    const config = makeConfig({ images: { videoBridgeEnabled: false } } as unknown as OcxConfig);
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeUndefined();
  });

  test("returns undefined when videoBridgeEnabled is missing", async () => {
    const config = makeConfig({ images: {} } as unknown as OcxConfig);
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeUndefined();
  });

  test("returns plan when enabled with valid xAI provider", async () => {
    const config = makeConfig({ images: { videoBridgeEnabled: true } } as unknown as OcxConfig);
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeDefined();
    expect(plan!.model).toBe("grok-imagine-video");
    expect(plan!.auth.token).toBe("xai-test-key");
    expect(plan!.auth.baseUrl).toBe("https://api.x.ai/v1");
    expect(plan!.toolNames.has(VIDEO_GEN_TOOL_NAME)).toBe(true);
  });

  test("tool_choice cannot arm an excluded video sidecar", async () => {
    const config = makeConfig({ images: { videoBridgeEnabled: true } } as unknown as OcxConfig);
    const parsed = makeParsed();

    parsed.options = { toolChoice: "none" };
    expect(await planVideoBridge(config, parsed, makeProvider("api.anthropic.com"))).toBeUndefined();
    parsed.options = { toolChoice: { name: "read_file" } };
    expect(await planVideoBridge(config, parsed, makeProvider("api.anthropic.com"))).toBeUndefined();
    parsed.options = { toolChoice: { allowedTools: ["read_file"], mode: "required" } };
    expect(await planVideoBridge(config, parsed, makeProvider("api.anthropic.com"))).toBeUndefined();

    parsed.options = { toolChoice: { name: VIDEO_GEN_TOOL_NAME } };
    parsed.context.tools = [{ name: "generate_video", description: "Generate", parameters: {} }];
    const canonicalPlan = await planVideoBridge(config, parsed, makeProvider("api.anthropic.com"));
    expect(canonicalPlan).toBeDefined();
    expect(canonicalPlan!.toolNames.has(VIDEO_GEN_TOOL_NAME)).toBe(true);
    expect(canonicalPlan!.toolNames.has("generate_video")).toBe(false);

    parsed.options = { toolChoice: { name: "generate_video" } };
    const aliasPlan = await planVideoBridge(config, parsed, makeProvider("api.anthropic.com"));
    expect(aliasPlan).toBeDefined();
    expect(aliasPlan!.toolNames.has(VIDEO_GEN_TOOL_NAME)).toBe(false);
    expect(aliasPlan!.toolNames.has("generate_video")).toBe(true);
  });

  test("returns undefined for OpenAI native passthrough", async () => {
    const config = makeConfig({ images: { videoBridgeEnabled: true } } as unknown as OcxConfig);
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.openai.com"));
    expect(plan).toBeUndefined();
  });

  test("returns undefined when no xAI provider available", async () => {
    const config: OcxConfig = {
      providers: { anthropic: makeProvider("api.anthropic.com") },
      images: { videoBridgeEnabled: true },
    } as unknown as OcxConfig;
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeUndefined();
  });

  test("returns undefined when xAI provider uses oauth (no API key)", async () => {
    const config: OcxConfig = {
      providers: { xai: { baseUrl: "https://api.x.ai/v1", authMode: "oauth", apiKey: undefined } },
      images: { videoBridgeEnabled: true },
    } as unknown as OcxConfig;
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeUndefined();
  });

  test("respects custom videoBridgeModel", async () => {
    const config = makeConfig({ images: { videoBridgeEnabled: true, videoBridgeModel: "custom-video-model" } } as unknown as OcxConfig);
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeDefined();
    expect(plan!.model).toBe("custom-video-model");
  });
});

describe("planVideoBridge videoProvider", () => {
  function makeCustomConfig(images: Record<string, unknown>): OcxConfig {
    const xai: OcxProviderConfig = {
      name: "xai",
      baseUrl: "https://api.x.ai/v1",
      authMode: "key",
      apiKey: "xai-test-key",
    };
    const bridge: OcxProviderConfig = {
      name: "my-video-bridge",
      baseUrl: "http://127.0.0.1:8790/v1/",
      authMode: "key",
      apiKey: "bridge-test-key",
    };
    return {
      providers: { xai, "my-video-bridge": bridge },
      images: { videoBridgeEnabled: true, ...images },
    } as unknown as OcxConfig;
  }

  test("named provider owns the destination: its baseUrl and key, trailing slash trimmed", async () => {
    const config = makeCustomConfig({ videoProvider: "my-video-bridge", videoBridgeModel: "bridge-model" });
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeDefined();
    expect(plan!.auth.baseUrl).toBe("http://127.0.0.1:8790/v1");
    expect(plan!.auth.token).toBe("bridge-test-key");
    expect(plan!.provider).toBe((config.providers as Record<string, OcxProviderConfig>)["my-video-bridge"]);
    expect(plan!.model).toBe("bridge-model");
    expect(plan!.toolNames.has(VIDEO_GEN_TOOL_NAME)).toBe(true);
  });

  test("named provider is honored even when no xai provider exists", async () => {
    const bridge: OcxProviderConfig = {
      name: "solo-bridge",
      baseUrl: "https://video.example.com/v1",
      authMode: "key",
      apiKey: "solo-key",
    };
    const config: OcxConfig = {
      providers: { "solo-bridge": bridge },
      images: { videoBridgeEnabled: true, videoProvider: "solo-bridge" },
    } as unknown as OcxConfig;
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeDefined();
    expect(plan!.auth.baseUrl).toBe("https://video.example.com/v1");
    expect(plan!.auth.token).toBe("solo-key");
  });

  test("names a missing provider → fails closed, no xAI fallback", async () => {
    const config = makeCustomConfig({ videoProvider: "no-such-provider" });
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeUndefined();
  });

  test("names a disabled provider → fails closed, no xAI fallback", async () => {
    const config = makeCustomConfig({ videoProvider: "my-video-bridge" });
    (config.providers as Record<string, OcxProviderConfig>)["my-video-bridge"].disabled = true;
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeUndefined();
  });

  test("names a provider without a key → fails closed, no xAI fallback", async () => {
    const config = makeCustomConfig({ videoProvider: "my-video-bridge" });
    (config.providers as Record<string, OcxProviderConfig>)["my-video-bridge"].apiKey = undefined;
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeUndefined();
  });

  test("names an oauth provider → fails closed (bearer-key transport only)", async () => {
    const config = makeCustomConfig({ videoProvider: "my-video-bridge" });
    (config.providers as Record<string, OcxProviderConfig>)["my-video-bridge"].authMode = "oauth";
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeUndefined();
  });

  test("names a forward-auth provider → fails closed (bearer-key transport only)", async () => {
    const config = makeCustomConfig({ videoProvider: "my-video-bridge" });
    (config.providers as Record<string, OcxProviderConfig>)["my-video-bridge"].authMode = "forward";
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeUndefined();
  });

  test("names the reserved registry id \"xai\" → fails closed, never the baseUrl override", async () => {
    const config = makeCustomConfig({ videoProvider: "xai" });
    // The xai entry points elsewhere; naming it must not follow that host with the xAI key.
    (config.providers as Record<string, OcxProviderConfig>).xai.baseUrl = "https://other-host.example.com/v1";
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeUndefined();
  });

  test("mirrored registry-name case \"XAI\" → fails closed, never the baseUrl override", async () => {
    const config = makeCustomConfig({ videoProvider: "XAI" });
    // A config entry spelled XAI (not the registry id) must not slip past the guard, which
    // matches registry ids case-insensitively rather than by getProviderRegistryEntry.
    (config.providers as Record<string, OcxProviderConfig>).XAI = {
      name: "XAI",
      baseUrl: "https://other-host.example.com/v1",
      authMode: "key",
      apiKey: "xai-test-key",
    };
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeUndefined();
  });

  test("non-string videoProvider values fail closed", async () => {
    for (const value of [42, true, null, {}, 0, ["xai"]] as unknown[]) {
      const config = makeCustomConfig({ videoProvider: value });
      const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
      expect(plan).toBeUndefined();
    }
  });

  test("non-http(s) baseUrl scheme on the named provider → fails closed", async () => {
    const config = makeCustomConfig({ videoProvider: "my-video-bridge" });
    (config.providers as Record<string, OcxProviderConfig>)["my-video-bridge"].baseUrl = "ws://127.0.0.1:8790/v1";
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeUndefined();
  });

  test("blank videoProvider is treated as unset → xAI default, unchanged", async () => {
    for (const blank of ["", "   "] as const) {
      const config = makeCustomConfig({ videoProvider: blank });
      const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
      expect(plan).toBeDefined();
      expect(plan!.auth.baseUrl).toBe("https://api.x.ai/v1");
      expect(plan!.auth.token).toBe("xai-test-key");
      expect(plan!.provider).toBe((config.providers as Record<string, OcxProviderConfig>).xai);
    }
  });

  test("no-fallback invariant: every disarmed videoProvider yields no plan even with an armed xai provider", async () => {
    type Prep = (config: OcxConfig) => void;
    const setBridge = (patch: Partial<OcxProviderConfig>): Prep => config => {
      Object.assign((config.providers as Record<string, OcxProviderConfig>)["my-video-bridge"], patch);
    };
    const cases: Array<[string, Record<string, unknown>, Prep?]> = [
      ["null", { videoProvider: null }],
      ["object", { videoProvider: {} }],
      ["number", { videoProvider: 0 }],
      ["missing provider", { videoProvider: "ghost-bridge" }],
      ["disabled provider", { videoProvider: "my-video-bridge" }, setBridge({ disabled: true })],
      ["keyless provider", { videoProvider: "my-video-bridge" }, setBridge({ apiKey: undefined })],
      ["oauth provider", { videoProvider: "my-video-bridge" }, setBridge({ authMode: "oauth" })],
      ["forward-auth provider", { videoProvider: "my-video-bridge" }, setBridge({ authMode: "forward" })],
      ["ws baseUrl", { videoProvider: "my-video-bridge" }, setBridge({ baseUrl: "ws://127.0.0.1:8790/v1" })],
      ["invalid baseUrl", { videoProvider: "my-video-bridge" }, setBridge({ baseUrl: "not a url" })],
      ["reserved xai", { videoProvider: "xai" }],
      ["reserved XAI", { videoProvider: "XAI" }],
      ["reserved Xai", { videoProvider: "Xai" }],
      ["padded reserved xai", { videoProvider: "  xai  " }],
      ["padded reserved XAI", { videoProvider: " \tXAI " }],
    ];
    for (const [label, images, prep] of cases) {
      const config = makeCustomConfig(images);
      // A colliding config entry spelled XAI/ Xai would otherwise be a real destination.
      (config.providers as Record<string, OcxProviderConfig>).XAI = {
        name: "XAI", baseUrl: "https://other-host.example.com/v1", authMode: "key", apiKey: "xai-test-key",
      };
      (config.providers as Record<string, OcxProviderConfig>).Xai = {
        name: "Xai", baseUrl: "https://other-host.example.com/v1", authMode: "key", apiKey: "xai-test-key",
      };
      prep?.(config);
      const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
      // The xai provider stays fully armed in every case, so any fallback would arm the bridge.
      expect(`${label} → ${plan ? "planned" : "unarmed"}`).toBe(`${label} → unarmed`);
    }
  });

  test("invalid baseUrl on the named provider → fails closed", async () => {
    const config = makeCustomConfig({ videoProvider: "my-video-bridge" });
    (config.providers as Record<string, OcxProviderConfig>)["my-video-bridge"].baseUrl = "not a url";
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeUndefined();
  });

  test("regression: no videoProvider, xai provider with overridden baseUrl → still pinned to the registry URL", async () => {
    const xai: OcxProviderConfig = {
      name: "xai",
      baseUrl: "https://evil.example.com/v1",
      authMode: "key",
      apiKey: "xai-test-key",
    };
    const config: OcxConfig = {
      providers: { xai },
      images: { videoBridgeEnabled: true },
    } as unknown as OcxConfig;
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeDefined();
    expect(plan!.auth.baseUrl).toBe("https://api.x.ai/v1");
    expect(plan!.auth.token).toBe("xai-test-key");
  });

  test("named provider env reference resolves through resolveProviderApiKey", async () => {
    const original = process.env.OCX_TEST_BRIDGE_KEY;
    process.env.OCX_TEST_BRIDGE_KEY = "env-resolved-key";
    try {
      const config = makeCustomConfig({ videoProvider: "my-video-bridge" });
      (config.providers as Record<string, OcxProviderConfig>)["my-video-bridge"].apiKey = "${OCX_TEST_BRIDGE_KEY}";
      const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
      expect(plan).toBeDefined();
      expect(plan!.auth.token).toBe("env-resolved-key");
    } finally {
      if (original === undefined) delete process.env.OCX_TEST_BRIDGE_KEY;
      else process.env.OCX_TEST_BRIDGE_KEY = original;
    }
  });
});
