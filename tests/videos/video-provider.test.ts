import { afterEach, describe, expect, test } from "bun:test";
import { planVideoBridge } from "../../src/images/plan";
import { runWithImageBridge } from "../../src/images/loop";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const XAI_KEY = "xai-secret-key";
const BRIDGE_KEY = "bridge-key";

function xai(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "key", apiKey: XAI_KEY, ...overrides } as OcxProviderConfig;
}

function bridge(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat", baseUrl: "https://video.example.com/v1/", authMode: "key", apiKey: BRIDGE_KEY, ...overrides,
  } as OcxProviderConfig;
}

function config(providers: Record<string, OcxProviderConfig>, videoProvider?: unknown): OcxConfig {
  return {
    providers,
    images: { videoBridgeEnabled: true, ...(videoProvider !== undefined ? { videoProvider } : {}) },
  } as unknown as OcxConfig;
}

const parsed = (): OcxParsedRequest => ({ modelId: "m", stream: true, options: {}, context: { messages: [], tools: [] } }) as unknown as OcxParsedRequest;
const routed = { baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: "routed" } as OcxProviderConfig;

describe("images.videoProvider selection", () => {
  test("unset keeps the pinned xAI destination even when the xai row overrides baseUrl", async () => {
    const plan = await planVideoBridge(config({ xai: xai({ baseUrl: "https://elsewhere.example/v1" }) }), parsed(), routed);
    expect(plan?.auth).toEqual({ baseUrl: "https://api.x.ai/v1", token: XAI_KEY });
    expect(plan?.unavailable).toBeUndefined();
  });

  test("a named custom provider uses only its own baseUrl and key", async () => {
    const plan = await planVideoBridge(config({ xai: xai(), "my-bridge": bridge() }, "my-bridge"), parsed(), routed);
    expect(plan?.auth).toEqual({ baseUrl: "https://video.example.com/v1", token: BRIDGE_KEY });
    expect(plan?.unavailable).toBeUndefined();
  });

  test("a loopback provider is reachable only with allowPrivateNetwork", async () => {
    const local = bridge({ baseUrl: "http://127.0.0.1:8790/v1" });
    const refused = await planVideoBridge(config({ "my-bridge": local }, "my-bridge"), parsed(), routed);
    expect(refused?.auth).toBeUndefined();
    expect(refused?.unavailable).toContain("allowPrivateNetwork");
    const allowed = await planVideoBridge(
      config({ "my-bridge": { ...local, allowPrivateNetwork: true } }, "my-bridge"), parsed(), routed,
    );
    expect(allowed?.auth).toEqual({ baseUrl: "http://127.0.0.1:8790/v1", token: BRIDGE_KEY });
  });

  test("explicit xai stays pinned to the registry host", async () => {
    const plan = await planVideoBridge(config({ xai: xai({ baseUrl: "https://elsewhere.example/v1" }) }, "xai"), parsed(), routed);
    expect(plan?.auth).toEqual({ baseUrl: "https://api.x.ai/v1", token: XAI_KEY });
  });

  test.each([
    ["missing", {}, "missing", "is not configured"],
    ["disabled", { "my-bridge": bridge({ disabled: true }) }, "my-bridge", "is disabled"],
    ["keyless", { "my-bridge": bridge({ apiKey: "" }) }, "my-bridge", "has no usable API key"],
    ["oauth", { "my-bridge": bridge({ authMode: "oauth" }) }, "my-bridge", "API-key provider"],
    ["paused pool", { "my-bridge": bridge({ apiKeyPool: [{ id: "a", key: "k", disabled: true }] }) }, "my-bridge", "paused"],
    ["other registry id", { openai: bridge({ baseUrl: "https://api.openai.com/v1" }) }, "openai", "must name a custom provider or xai"],
    ["blank", {}, "  ", "nonblank provider name"],
    ["non-string", {}, 7, "nonblank provider name"],
    ["oauth xai", { xai: xai({ authMode: "oauth", apiKey: undefined }) }, "xai", "API-key provider"],
    ["prototype key", {}, "constructor", "is not configured"],
  ] as const)("%s provider fails closed without falling back to xAI", async (_label, extra, name, message) => {
    const plan = await planVideoBridge(config({ xai: xai(), ...extra } as Record<string, OcxProviderConfig>, name), parsed(), routed);
    expect(plan).toBeDefined();
    expect(plan!.auth).toBeUndefined();
    expect(plan!.provider).toBeUndefined();
    expect(plan!.unavailable).toContain(message);
    expect(JSON.stringify(plan)).not.toContain(XAI_KEY);
  });

  test("the xAI key is never sent to another host, even when a custom row reuses it", async () => {
    const reused = bridge({ apiKey: XAI_KEY });
    const plan = await planVideoBridge(config({ xai: xai(), "my-bridge": reused }, "my-bridge"), parsed(), routed);
    expect(plan!.auth).toBeUndefined();
    expect(plan!.unavailable).toContain("xAI API key");
    const pooled = await planVideoBridge(config({
      xai: xai({ apiKeyPool: [{ id: "p", key: "pooled-xai" }] }), "my-bridge": bridge({ apiKey: "pooled-xai" }),
    }, "my-bridge"), parsed(), routed);
    expect(pooled!.unavailable).toContain("xAI API key");
  });

  test("a custom row on api.x.ai may use its own xAI key", async () => {
    const plan = await planVideoBridge(config({ xai: xai(), "grok-direct": bridge({ baseUrl: "https://api.x.ai/v1", apiKey: XAI_KEY }) }, "grok-direct"), parsed(), routed);
    expect(plan?.auth).toEqual({ baseUrl: "https://api.x.ai/v1", token: XAI_KEY });
  });

  test.each([
    ["an xai- formatted key with no xAI row", {}, bridge({ apiKey: "xai-unlisted" })],
    ["a key held by a differently cased, overridden XAI row", { XAI: xai({ baseUrl: "https://elsewhere.example/v1", apiKey: "plain-1" }) }, bridge({ apiKey: "plain-1" })],
    ["a key held by a disabled xai row", { xai: xai({ disabled: true, apiKey: "plain-2" }) }, bridge({ apiKey: "plain-2" })],
    ["an environment reference named for xAI", {}, bridge({ apiKey: "${VP_TEST_XAI_KEY}" })],
    ["an xAI key over cleartext HTTP to api.x.ai", {}, bridge({ baseUrl: "http://api.x.ai/v1", apiKey: "xai-k" })],
    ["an xAI key to api.x.ai on another port", {}, bridge({ baseUrl: "https://api.x.ai:8443/v1", apiKey: "xai-k" })],
  ] as const)("refuses %s off the trusted xAI origin", async (_label, extra, row) => {
    process.env.VP_TEST_XAI_KEY = "plain-env-value";
    try {
      const plan = await planVideoBridge(config({ ...extra, "my-bridge": row } as Record<string, OcxProviderConfig>, "my-bridge"), parsed(), routed);
      expect(plan!.auth).toBeUndefined();
      expect(plan!.unavailable).toContain("xAI API key");
    } finally {
      delete process.env.VP_TEST_XAI_KEY;
    }
  });

  test("a keychain reference to another row's secret is never used", async () => {
    const plan = await planVideoBridge(config({ "my-bridge": bridge({ apiKey: "keychain:xai" }) }, "my-bridge"), parsed(), routed);
    expect(plan!.auth).toBeUndefined();
    expect(plan!.unavailable).toBeDefined();
  });

  test("a paused active key fails closed even when another pooled key is enabled", async () => {
    const pooled = bridge({ apiKey: "k-paused", apiKeyPool: [{ id: "a", key: "k-paused", disabled: true }, { id: "b", key: "k-live" }] });
    const plan = await planVideoBridge(config({ "my-bridge": pooled }, "my-bridge"), parsed(), routed);
    expect(plan!.auth).toBeUndefined();
    expect(plan!.unavailable).toContain("paused");
    const explicitXai = await planVideoBridge(config({
      xai: xai({ apiKey: "xai-paused", apiKeyPool: [{ id: "a", key: "xai-paused", disabled: true }, { id: "b", key: "xai-live" }] }),
    }, "xai"), parsed(), routed);
    expect(explicitXai!.auth).toBeUndefined();
  });

  test.each([
    "https://proxy.example/v1?token=fixture",
    "https://proxy.example/v1#frag",
    "https://user:pass@proxy.example.test/v1",
    "ftp://proxy.example/v1",
  ])("refuses the base URL %s", async baseUrl => {
    const plan = await planVideoBridge(config({ "my-bridge": bridge({ baseUrl }) }, "my-bridge"), parsed(), routed);
    expect(plan!.auth).toBeUndefined();
    expect(plan!.unavailable).toContain("plain http(s) baseUrl");
  });
});

describe("video_gen with an unavailable videoProvider", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test("answers the call with the configuration error and makes no network request", async () => {
    const plan = await planVideoBridge(config({ xai: xai() }, "missing"), parsed(), routed);
    const fetched: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    const requests: OcxParsedRequest[] = [];
    let iteration = 0;
    const adapter: ProviderAdapter = {
      name: "video-provider-fixture",
      buildRequest: async () => ({ url: "https://example.invalid/model", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response(""),
      parseStream: async function* (): AsyncGenerator<AdapterEvent> { /* runTurn only */ },
      runTurn: async (request, _incoming, emit) => {
        requests.push(request);
        if (iteration++ === 0) {
          emit({ type: "tool_call_start", id: "v1", name: "video_gen" });
          emit({ type: "tool_call_delta", arguments: '{"prompt":"a wave"}' });
          emit({ type: "tool_call_end" });
        } else {
          emit({ type: "text_delta", text: "done" });
        }
        emit({ type: "done" });
      },
    };
    const response = await runWithImageBridge({
      parsed: parsed(), adapter, videoPlan: plan,
      incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    });
    const sse = await response.text();
    expect(sse).toContain("event: response.completed");
    expect(fetched).toEqual([]);
    expect(requests).toHaveLength(2);
    const toolResult = requests[1]!.context.messages.find(message => message.role === "toolResult");
    const content = toolResult?.role === "toolResult" ? toolResult.content : undefined;
    expect(typeof content).toBe("string");
    expect(JSON.parse(content as string)).toMatchObject({ ok: false, error: 'images.videoProvider "missing" is not configured' });
  });
});
