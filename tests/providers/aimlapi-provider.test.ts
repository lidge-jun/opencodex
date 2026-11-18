import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { gatherRoutedModels } from "../../src/codex/catalog";
import { clearModelCache } from "../../src/codex/model-cache";
import { buildModelsRequest } from "../../src/oauth";
import { KEY_LOGIN_PROVIDERS, validateApiKey } from "../../src/oauth/key-providers";
import { deriveInitProviders, deriveKeyLoginMap, deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";
import { extractProviderModelItems, providerModelDiscoverySpecError, resolveProviderModelDiscovery } from "../../src/providers/model-discovery";
import { PROVIDER_REGISTRY, withoutRegistryStaticHeaderCopies } from "../../src/providers/registry";
import { routeModel } from "../../src/router";
import { startServer } from "../../src/server";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { isModelVisionSidecarConsumer } from "../../src/vision/eligibility";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const baseUrl = "https://api.aimlapi.com/v1";
const RELAY = "https://relay.example.test/v1";
// Chat Completions rows of the public GET /v1/models, each answering chat, streaming and a tool
// call on 2026-10-27.
const SEEDS = [
  "openai/gpt-5.6-terra", "openai/gpt-6.1-terra", "anthropic/claude-sonnet-5-5", "google/gemini-3.5-flash",
  "deepseek/deepseek-v4-flash", "z-ai/glm-5.3-flash", "moonshot/kimi-k3",
] as const;
// Row shapes of the public GET /v1/models: only `type` tells a chat row from the rest, and one id
// can appear once per type it is served on.
const CATALOG = { object: "list", data: [
  { id: "openai/gpt-5.6-terra", type: "openai/chat-completions", aliases: ["gpt-5.6-terra"], info: {} },
  { id: "openai/gpt-5.6-terra", type: "openai/responses/submit", aliases: [], info: {} },
  { id: "anthropic/claude-sonnet-5-5", type: "anthropic/messages", aliases: [], info: {} },
  { id: "anthropic/claude-sonnet-5-5", type: "anthropic/batches", aliases: [], info: {} },
  { id: "anthropic/claude-sonnet-5-5", type: "openai/chat-completions", aliases: [], info: {} },
  { id: "flux/schnell", type: "openai/image-generations", aliases: [], info: {} },
  { id: "google/veo-3.1", type: "internal/video-generations/submit", aliases: [], info: {} },
  { id: "openai/text-embedding-3-small", type: "openai/embeddings", aliases: [], info: {} },
  { id: "elevenlabs/eleven_v3", type: "internal/text-to-speech", aliases: [], info: {} },
  { id: "untyped/row", aliases: [], info: {} },
] };

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("aimlapi");
});

function entry() {
  const row = PROVIDER_REGISTRY.find(candidate => candidate.id === "aimlapi");
  if (!row) throw new Error("missing AI/ML API preset");
  return row;
}

function config(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return withStubbedProviderFetch({
    port: 10100,
    defaultProvider: "aimlapi",
    providers: { aimlapi: { ...providerConfigSeed(entry()), apiKey: "test-key", ...overrides } },
  });
}

describe("AI/ML API provider", () => {
  test("is offered by ocx provider add, ocx init and the dashboard picker", () => {
    expect(deriveInitProviders().find(row => row.id === "aimlapi")).toMatchObject({
      label: "AI/ML API", kind: "key", adapter: "openai-chat", baseUrl,
    });
    const preset = deriveProviderPresets().find(row => row.id === "aimlapi");
    expect(preset).toMatchObject({ auth: "key", dashboardUrl: "https://aimlapi.com/app/keys" });
    expect(preset?.sponsor).toBeUndefined();
    expect(KEY_LOGIN_PROVIDERS.aimlapi?.defaultModel).toBe("openai/gpt-5.6-terra");
  });

  test("seeds the verified chat models with their catalog limits and live discovery on", () => {
    const seeded = config().providers.aimlapi!;
    expect(seeded).toMatchObject({ adapter: "openai-chat", baseUrl, defaultModel: "openai/gpt-5.6-terra", liveModels: true });
    expect(entry().models).toEqual([...SEEDS]);
    for (const model of SEEDS) expect(seeded.modelContextWindows?.[model]).toBeGreaterThanOrEqual(1_000_000);
    // DeepSeek V4 Flash is the one text-only seed: an image goes to the vision sidecar first.
    expect(isModelVisionSidecarConsumer(seeded, "deepseek/deepseek-v4-flash")).toBe(true);
    expect(isModelVisionSidecarConsumer(seeded, "openai/gpt-5.6-terra")).toBe(false);
  });

  test.each(SEEDS)("%s routes over Chat with its vendor-prefixed upstream id unchanged", model => {
    const route = routeModel(config(), `aimlapi/${model}`);
    expect(route.modelId).toBe(model);
    expect(route.provider).toMatchObject({ adapter: "openai-chat", baseUrl });
    for (const inbound of ["responses", "chat", "anthropic"] as const) {
      expect(resolveWireProtocolOverride("aimlapi", model, config().providers.aimlapi!, inbound).adapter)
        .toBe("openai-chat");
    }
  });

  test("keeps a same-named custom destination instead of retargeting it", () => {
    expect(routeModel(config({ baseUrl: RELAY }), "aimlapi/custom-model").provider.baseUrl).toBe(RELAY);
  });

  test("live discovery admits only Chat Completions rows, so image, video and audio models stay out", () => {
    const discovery = resolveProviderModelDiscovery("aimlapi", config().providers.aimlapi!);
    expect(providerModelDiscoverySpecError(entry().modelDiscovery!)).toBeNull();
    expect(buildModelsRequest(config().providers.aimlapi!, "test-key", "aimlapi").url).toBe(`${baseUrl}/models`);
    const result = extractProviderModelItems(CATALOG, discovery);
    if (!result.ok) throw new Error(result.reason);
    expect(result.items.map(row => row.id)).toEqual(["openai/gpt-5.6-terra", "anthropic/claude-sonnet-5-5"]);
  });

  test("the routed model list carries the chat rows only", async () => {
    globalThis.fetch = (async input => {
      expect(String(input)).toBe(`${baseUrl}/models`);
      return Response.json(CATALOG);
    }) as typeof fetch;
    const models = (await gatherRoutedModels(config())).filter(row => row.provider === "aimlapi");
    expect(models.map(row => row.id).sort()).toEqual(["anthropic/claude-sonnet-5-5", "openai/gpt-5.6-terra"]);
  });

  test("the public catalog is never probed to validate a key", async () => {
    expect(deriveKeyLoginMap().aimlapi?.apiKeyValidation).toBe("unknown");
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ object: "list", data: [] }); }) as unknown as typeof fetch;
    expect(await validateApiKey("aimlapi", KEY_LOGIN_PROVIDERS.aimlapi!, "any-key")).toBe("unknown");
    expect(calls).toBe(0);
  });
});

describe("AI/ML API attribution headers", () => {
  const MODEL = "openai/gpt-5.6-terra";
  let previousHome: string | undefined;
  let home = "";
  let codexHome: IsolatedCodexHome;
  let upstream: Array<{ url: string; headers: Headers }>;

  const attribution = () => Object.entries(entry().staticHeaders ?? {});

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    codexHome = installIsolatedCodexHome("ocx-aimlapi-attribution-codex-");
    home = mkdtempSync(join(tmpdir(), "ocx-aimlapi-attribution-"));
    process.env.OPENCODEX_HOME = home;
    clearModelCache();
    upstream = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "127.0.0.1") return originalFetch(input, init);
      if (url.origin !== "https://api.aimlapi.com" && url.origin !== "https://relay.example.test") {
        throw new Error(`Unexpected network destination in AI/ML API fixture: ${url.origin}`);
      }
      upstream.push({ url: url.toString(), headers: new Headers(input instanceof Request ? input.headers : init?.headers) });
      if (url.pathname === "/v1/models") return Response.json({ object: "list", data: [{ id: MODEL, type: "openai/chat-completions" }] });
      return Response.json({
        id: "chatcmpl-aimlapi", object: "chat.completion", model: MODEL,
        choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    clearModelCache();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    codexHome.restore();
    removeTreeWithRetry(home);
  });

  async function send(provider: OcxProviderConfig): Promise<void> {
    saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "aimlapi", providers: { aimlapi: provider } });
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `aimlapi/${MODEL}`, stream: false, messages: [{ role: "user", content: "ping" }] }),
      });
      expect(response.status).toBe(200);
      await response.text();
    } finally {
      await server.stop(true);
    }
  }

  test("declares the source and partner headers on the preset", () => {
    expect(entry().staticHeaders?.["X-AIMLAPI-Source"]).toBe("agent/opencodex");
    expect(entry().staticHeaders?.["X-AIMLAPI-Partner-ID"]).toBe("part_FwTskAwKV3EJU7Du1hqXx75d");
  });

  test("inference and model discovery at api.aimlapi.com carry both headers", async () => {
    await send({ ...providerConfigSeed(entry()), apiKey: "fixture-aimlapi-key" });
    const chat = upstream.filter(call => call.url === `${baseUrl}/chat/completions`);
    expect(chat).toHaveLength(1);
    for (const [name, value] of attribution()) expect(chat[0]!.headers.get(name)).toBe(value);

    upstream = [];
    await gatherRoutedModels(config());
    expect(upstream.map(call => call.url)).toEqual([`${baseUrl}/models`]);
    for (const [name, value] of attribution()) expect(upstream[0]!.headers.get(name)).toBe(value);
  });

  test("a preset row pointed at another host sends neither header there", async () => {
    // `ocx provider add aimlapi --base-url ...` seeds the row (static headers included) and then
    // replaces the URL, so the copies in the saved row must not follow it to the new host.
    await send({ ...providerConfigSeed(entry()), baseUrl: RELAY, apiKey: "fixture-relay-key" });
    const chat = upstream.filter(call => call.url === `${RELAY}/chat/completions`);
    expect(chat).toHaveLength(1);
    for (const [name] of attribution()) expect(chat[0]!.headers.has(name)).toBe(false);

    upstream = [];
    await gatherRoutedModels(config({ baseUrl: RELAY }));
    expect(upstream.map(call => call.url)).toEqual([`${RELAY}/models`]);
    for (const [name] of attribution()) expect(upstream[0]!.headers.has(name)).toBe(false);
  });

  test("on a retargeted row, headers named like the preset's are dropped and others are sent", async () => {
    // A copy seeded by an older release carries a different value; it must not follow the row either.
    await send({ ...providerConfigSeed(entry()), baseUrl: RELAY, apiKey: "fixture-relay-key",
      headers: { "X-AIMLAPI-Partner-ID": "part_seededByAnOlderRelease", "X-Relay-Tenant": "team-a" } });
    const chat = upstream.filter(call => call.url === `${RELAY}/chat/completions`);
    expect(chat).toHaveLength(1);
    expect(chat[0]!.headers.get("X-Relay-Tenant")).toBe("team-a");
    for (const [name] of attribution()) expect(chat[0]!.headers.has(name)).toBe(false);
  });

  test("a row still on api.aimlapi.com keeps its headers when its transport differs from the preset", () => {
    const seeded = providerConfigSeed(entry());
    const sameHost = { ...seeded, baseUrl: "https://api.aimlapi.com/v1beta", adapter: "openai-responses" as const };
    expect(withoutRegistryStaticHeaderCopies(entry(), sameHost)).toEqual(seeded.headers);
    const otherHost = { ...seeded, baseUrl: "https://api.aimlapi.com.relay.example.test/v1" };
    expect(withoutRegistryStaticHeaderCopies(entry(), otherHost)).toBeUndefined();
  });
});
