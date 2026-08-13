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
