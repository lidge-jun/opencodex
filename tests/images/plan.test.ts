import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { OcxConfig, OcxProviderConfig, OcxParsedRequest } from "../../src/types";

const PREV_HOME = process.env.OPENCODEX_HOME;
let planImageBridge: typeof import("../../src/images/plan")["planImageBridge"];
let MAX_IMAGE_TIMEOUT_MS: typeof import("../../src/images/plan")["MAX_IMAGE_TIMEOUT_MS"];

/** Mutable token that the mocked getValidAccessToken resolves to. */
let tokenResult: string | null = null;

beforeAll(async () => {
  process.env.OPENCODEX_HOME = join(tmpdir(), "ocx-test-" + randomUUID());
  const actualOauth = await import("../../src/oauth/index");
  mock.module("../../src/oauth/index", () => ({
    ...actualOauth,
    getValidAccessToken: async () => tokenResult,
  }));
  ({ planImageBridge, MAX_IMAGE_TIMEOUT_MS } = await import("../../src/images/plan"));
});
afterAll(() => { if (PREV_HOME === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = PREV_HOME; mock.restore(); });

beforeEach(() => {
  tokenResult = null;
});

function makeConfig(
  providers: Record<string, Partial<OcxProviderConfig>>,
  images?: { bridgeEnabled?: boolean; bridgeModel?: string; timeoutMs?: number },
): OcxConfig {
  return {
    port: 0,
    defaultProvider: "test",
    providers: Object.fromEntries(
      Object.entries(providers).map(([k, v]) => [k, { adapter: "openai-chat", baseUrl: "https://api.test.com", ...v }]),
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

const routed = { adapter: "openai-chat", baseUrl: "https://api.anthropic.com" } as OcxProviderConfig;
const openaiRouted = { adapter: "openai-chat", baseUrl: "https://api.openai.com" } as OcxProviderConfig;

describe("planImageBridge", () => {
  test("bridgeEnabled false → undefined", async () => {
    expect(await planImageBridge(makeConfig({ test: routed }, { bridgeEnabled: false }), makeParsed(true), routed)).toBeUndefined();
  });

  test("bridgeEnabled not set → undefined (opt-in required)", async () => {
    // xAI provider configured but images.bridgeEnabled is absent — must not bridge.
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } });
    expect(await planImageBridge(cfg, makeParsed(true), routed)).toBeUndefined();
  });

  test("_imageGeneration not set → undefined", async () => {
    expect(await planImageBridge(makeConfig({ test: routed }, { bridgeEnabled: true }), makeParsed(false), routed)).toBeUndefined();
  });

  test("routedProvider is api.openai.com → undefined", async () => {
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } }, { bridgeEnabled: true });
    expect(await planImageBridge(cfg, makeParsed(true), openaiRouted)).toBeUndefined();
  });

  test("no xAI provider → undefined", async () => {
    expect(await planImageBridge(makeConfig({ test: routed }, { bridgeEnabled: true }), makeParsed(true), routed)).toBeUndefined();
  });

  test("xAI provider but apiKey empty and no OAuth → undefined", async () => {
    tokenResult = null;
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "" } }, { bridgeEnabled: true });
    expect(await planImageBridge(cfg, makeParsed(true), routed)).toBeUndefined();
  });

  test("xAI provider with API key → returns plan with correct model", async () => {
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } }, { bridgeEnabled: true });
    const plan = await planImageBridge(cfg, makeParsed(true), routed);
    expect(plan).toBeDefined();
    expect(plan!.model).toBe("grok-imagine-image-quality");
    expect(plan!.auth.token).toBe("test-token");
    expect(plan!.auth.baseUrl).toBe("https://api.x.ai/v1");
  });

  test("tool_choice cannot arm an excluded image sidecar", async () => {
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } }, { bridgeEnabled: true });
    const parsed = makeParsed(true);

    parsed.options.toolChoice = "none";
    expect(await planImageBridge(cfg, parsed, routed)).toBeUndefined();
    parsed.options.toolChoice = { name: "read_file" };
    expect(await planImageBridge(cfg, parsed, routed)).toBeUndefined();
    parsed.options.toolChoice = { allowedTools: ["read_file"], mode: "required" };
    expect(await planImageBridge(cfg, parsed, routed)).toBeUndefined();

    parsed.options.toolChoice = { name: "image_gen" };
    expect(await planImageBridge(cfg, parsed, routed)).toBeDefined();

    parsed._imageGeneration?.toolNames.add("generate_image");
    parsed.options.toolChoice = { name: "image_gen" };
    const canonicalPlan = await planImageBridge(cfg, parsed, routed);
    expect(canonicalPlan).toBeDefined();
    expect(canonicalPlan!.toolNames.has("image_gen")).toBe(true);
    expect(canonicalPlan!.toolNames.has("generate_image")).toBe(false);

    parsed.options.toolChoice = { name: "generate_image" };
    const aliasPlan = await planImageBridge(cfg, parsed, routed);
    expect(aliasPlan).toBeDefined();
    expect(aliasPlan!.toolNames.has("image_gen")).toBe(false);
    expect(aliasPlan!.toolNames.has("generate_image")).toBe(true);
  });

  test("xAI provider with OAuth only (no API key) → undefined (API-key-only bridge)", async () => {
    tokenResult = "fake-oauth-123";
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai" } }, { bridgeEnabled: true });
    expect(await planImageBridge(cfg, makeParsed(true), routed)).toBeUndefined();
    tokenResult = null;
  });

  test("custom-named provider with api.x.ai baseUrl → found via fallback", async () => {
    const cfg = makeConfig({ mygrok: { baseUrl: "https://api.x.ai", apiKey: "test-token" } }, { bridgeEnabled: true });
    const plan = await planImageBridge(cfg, makeParsed(true), routed);
    expect(plan).toBeDefined();
    expect(plan!.provider).toBe(cfg.providers.mygrok);
  });

  test("custom bridgeModel is honored", async () => {
    const cfg = makeConfig(
      { xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } },
      { bridgeEnabled: true, bridgeModel: "custom-img-model" },
    );
    expect((await planImageBridge(cfg, makeParsed(true), routed))!.model).toBe("custom-img-model");
  });

  test("images.timeoutMs is forwarded onto the plan", async () => {
    const cfg = makeConfig(
      { xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } },
      { bridgeEnabled: true, timeoutMs: 120_000 },
    );
    const plan = await planImageBridge(cfg, makeParsed(true), routed);
    expect(plan!.timeoutMs).toBe(120_000);
  });

  test("images.timeoutMs above ceiling is clamped", async () => {
    const cfg = makeConfig(
      { xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } },
      { bridgeEnabled: true, timeoutMs: 999_999_999 },
    );
    const plan = await planImageBridge(cfg, makeParsed(true), routed);
    expect(plan!.timeoutMs).toBe(MAX_IMAGE_TIMEOUT_MS);
  });

  test("toolNames includes IMAGE_GEN_TOOL_NAME so the loop can intercept synthetic calls", async () => {
    const { IMAGE_GEN_TOOL_NAME } = await import("../../src/images/synthetic-tool");
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } }, { bridgeEnabled: true });
    const plan = await planImageBridge(cfg, makeParsed(true), routed);
    expect(plan).toBeDefined();
    // The plan always merges in IMAGE_GEN_TOOL_NAME, even if _imageGeneration.toolNames
    // only contained the original hosted tool name.
    expect(plan!.toolNames.has(IMAGE_GEN_TOOL_NAME)).toBe(true);
  });

  test("baseUrl is pinned to registry regardless of config override", async () => {
    // config 里 xai provider 的 baseUrl 被改成恶意 host
    const cfg = makeConfig(
      { xai: { adapter: "openai-chat", baseUrl: "https://evil.example.com/v1", apiKey: "test-key" } },
      { bridgeEnabled: true },
    );
    const plan = await planImageBridge(cfg, makeParsed(true), routed);
    expect(plan).toBeDefined();
    // auth.baseUrl 必须是 registry pin 的地址，不是 config 里的恶意地址
    expect(plan!.auth.baseUrl).toBe("https://api.x.ai/v1");
  });

  test("custom-named provider with api.x.ai baseUrl does NOT get built-in OAuth token", async () => {
    tokenResult = "should-not-be-used";
    // provider 名为 "my-xai"，baseUrl 指向 api.x.ai，没有 apiKey
    const cfg = makeConfig(
      { "my-xai": { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1" } },
      { bridgeEnabled: true },
    );
    const plan = await planImageBridge(cfg, makeParsed(true), routed);
    // 没有 apiKey 也没有 "xai" 的 OAuth → 没有 token → 没有 plan
    expect(plan).toBeUndefined();
    tokenResult = null;
  });

  test("authMode oauth does not arm the bridge even with a stale apiKey", async () => {
    tokenResult = "oauth-token";
    const cfg = makeConfig(
      { xai: { baseUrl: "https://api.x.ai/v1", apiKey: "stale-key", authMode: "oauth" } },
      { bridgeEnabled: true },
    );
    expect(await planImageBridge(cfg, makeParsed(true), routed)).toBeUndefined();
    tokenResult = null;
  });

  test("authMode key does not fall back to stored OAuth", async () => {
    tokenResult = "oauth-token";
    const cfg = makeConfig(
      { xai: { baseUrl: "https://api.x.ai/v1", apiKey: "", authMode: "key" } },
      { bridgeEnabled: true },
    );
    expect(await planImageBridge(cfg, makeParsed(true), routed)).toBeUndefined();
    tokenResult = null;
  });
});
