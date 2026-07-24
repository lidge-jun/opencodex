import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { OcxConfig, OcxProviderConfig, OcxParsedRequest } from "../../src/types";

const PREV_HOME = process.env.OPENCODEX_HOME;
beforeAll(() => { process.env.OPENCODEX_HOME = join(tmpdir(), "ocx-test-" + randomUUID()); });
afterAll(() => { if (PREV_HOME === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = PREV_HOME; });

/** Mutable credential that the mocked getCredential returns. */
let credResult: { access: string } | null = null;
mock.module("../../src/oauth/store", () => ({
  getCredential: () => credResult,
}));

const { planImageBridge } = await import("../../src/images/plan");

function makeConfig(
  providers: Record<string, Partial<OcxProviderConfig>>,
  images?: { bridgeEnabled?: boolean; bridgeModel?: string },
): OcxConfig {
  return {
    port: 0,
    defaultProvider: "test",
    providers: Object.fromEntries(
      Object.entries(providers).map(([k, v]) => [k, { adapter: "openai", baseUrl: "https://api.test.com", ...v }]),
    ),
    ...(images ? { images } : {}),
  } as OcxConfig;
}

function makeParsed(withImageGen: boolean): OcxParsedRequest {
  return {
    modelId: "test-model",
    context: { messages: [], tools: [] },
    stream: true,
    options: {},
    ...(withImageGen ? { _imageGeneration: { toolNames: new Set(["image_gen"]) } } : {}),
  } as OcxParsedRequest;
}

const routed = { adapter: "openai", baseUrl: "https://api.anthropic.com" } as OcxProviderConfig;
const openaiRouted = { adapter: "openai", baseUrl: "https://api.openai.com" } as OcxProviderConfig;

describe("planImageBridge", () => {
  test("bridgeEnabled false → undefined", () => {
    expect(planImageBridge(makeConfig({ test: routed }, { bridgeEnabled: false }), makeParsed(true), routed)).toBeUndefined();
  });

  test("_imageGeneration not set → undefined", () => {
    expect(planImageBridge(makeConfig({ test: routed }), makeParsed(false), routed)).toBeUndefined();
  });

  test("routedProvider is api.openai.com → undefined", () => {
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } });
    expect(planImageBridge(cfg, makeParsed(true), openaiRouted)).toBeUndefined();
  });

  test("no xAI provider → undefined", () => {
    expect(planImageBridge(makeConfig({ test: routed }), makeParsed(true), routed)).toBeUndefined();
  });

  test("xAI provider but apiKey empty and no OAuth → undefined", () => {
    credResult = null;
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "" } });
    expect(planImageBridge(cfg, makeParsed(true), routed)).toBeUndefined();
  });

  test("xAI provider with API key → returns plan with correct model", () => {
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } });
    const plan = planImageBridge(cfg, makeParsed(true), routed);
    expect(plan).toBeDefined();
    expect(plan!.model).toBe("grok-imagine-image-quality");
    expect(plan!.auth.token).toBe("test-token");
    expect(plan!.auth.baseUrl).toBe("https://api.x.ai");
  });

  test("xAI provider with OAuth (getCredential) → returns plan", () => {
    credResult = { access: "fake-oauth-123" };
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai" } });
    const plan = planImageBridge(cfg, makeParsed(true), routed);
    expect(plan).toBeDefined();
    expect(plan!.auth.token).toBe("fake-oauth-123");
    credResult = null;
  });

  test("custom-named provider with api.x.ai baseUrl → found via fallback", () => {
    const cfg = makeConfig({ mygrok: { baseUrl: "https://api.x.ai", apiKey: "test-token" } });
    const plan = planImageBridge(cfg, makeParsed(true), routed);
    expect(plan).toBeDefined();
    expect(plan!.provider).toBe(cfg.providers.mygrok);
  });

  test("custom bridgeModel is honored", () => {
    const cfg = makeConfig(
      { xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } },
      { bridgeModel: "custom-img-model" },
    );
    expect(planImageBridge(cfg, makeParsed(true), routed)!.model).toBe("custom-img-model");
  });

  test("toolNames includes IMAGE_GEN_TOOL_NAME so the loop can intercept synthetic calls", async () => {
    const { IMAGE_GEN_TOOL_NAME } = await import("../../src/images/synthetic-tool");
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } });
    const plan = planImageBridge(cfg, makeParsed(true), routed);
    expect(plan).toBeDefined();
    // The plan always merges in IMAGE_GEN_TOOL_NAME, even if _imageGeneration.toolNames
    // only contained the original hosted tool name.
    expect(plan!.toolNames.has(IMAGE_GEN_TOOL_NAME)).toBe(true);
  });
});
