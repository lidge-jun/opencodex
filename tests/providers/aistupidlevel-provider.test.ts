import { afterEach, describe, expect, test } from "bun:test";
import { gatherRoutedModels } from "../../src/codex/catalog";
import { clearModelCache } from "../../src/codex/model-cache";
import { buildModelsRequest } from "../../src/oauth";
import { KEY_LOGIN_PROVIDERS, validateApiKey } from "../../src/oauth/key-providers";
import { deriveInitProviders, deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { routeModel } from "../../src/router";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { isModelVisionSidecarConsumer } from "../../src/vision/eligibility";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";

const originalFetch = globalThis.fetch;
const baseUrl = "https://aistupidlevel.info/v1";
// The routing modes the authenticated GET /v1/models listed on 2026-10-23.
const ROUTING_MODES = [
  "auto-coding", "auto-tooling", "auto-reasoning", "auto-best", "auto", "auto-task",
  "auto-value", "auto-value-coding", "auto-value-tooling", "auto-value-reasoning",
  "auto-fastest-quality", "auto-consistent", "auto-cheapest", "auto-fastest", "auto-split",
] as const;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("aistupidlevel");
});

function entry() {
  const row = PROVIDER_REGISTRY.find(candidate => candidate.id === "aistupidlevel");
  if (!row) throw new Error("missing AI Stupid Level preset");
  return row;
}

function config(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return withStubbedProviderFetch({
    port: 10100,
    defaultProvider: "aistupidlevel",
    providers: { aistupidlevel: { ...providerConfigSeed(entry()), apiKey: "test-key", ...overrides } },
  });
}

describe("AI Stupid Level provider", () => {
  test("is offered by ocx provider add, ocx init and the dashboard picker", () => {
    expect(deriveInitProviders().find(row => row.id === "aistupidlevel")).toMatchObject({
      label: "AI Stupid Level", kind: "key", adapter: "openai-chat", baseUrl,
    });
    const preset = deriveProviderPresets().find(row => row.id === "aistupidlevel");
    expect(preset).toMatchObject({ auth: "key", dashboardUrl: "https://aistupidlevel.info/router/keys" });
    expect(preset?.sponsor).toBeUndefined();
    expect(KEY_LOGIN_PROVIDERS.aistupidlevel?.defaultModel).toBe("auto-coding");
  });

  test("seeds the routing modes as text-only, with limits that hold for any routed model", () => {
    const seeded = config().providers.aistupidlevel!;
    expect(seeded).toMatchObject({ adapter: "openai-chat", baseUrl, defaultModel: "auto-coding", liveModels: true });
    expect(entry().models).toEqual([...ROUTING_MODES]);
    for (const mode of ROUTING_MODES) {
      expect(seeded.modelContextWindows?.[mode]).toBe(262_144);
      expect(seeded.modelMaxOutputTokens?.[mode]).toBe(64_000);
      // Text-only: the vision sidecar describes an image before the request reaches the router.
      expect(isModelVisionSidecarConsumer(seeded, mode)).toBe(true);
    }
  });

  test.each(["auto-coding", "auto-tooling", "claude-opus-5-5"])("%s routes over Chat with its upstream id unchanged", model => {
    const route = routeModel(config(), `aistupidlevel/${model}`);
    expect(route.modelId).toBe(model);
    expect(route.provider).toMatchObject({ adapter: "openai-chat", baseUrl });
    for (const inbound of ["responses", "chat", "anthropic"] as const) {
      expect(resolveWireProtocolOverride("aistupidlevel", model, config().providers.aistupidlevel!, inbound).adapter)
        .toBe("openai-chat");
    }
  });

  test("keeps a same-named custom destination instead of retargeting it", () => {
    const custom = config({ baseUrl: "https://relay.example.test/v1" });
    expect(routeModel(custom, "aistupidlevel/custom-model").provider.baseUrl).toBe("https://relay.example.test/v1");
  });

  test("lists routing modes and pinnable models from the authenticated live catalog", async () => {
    let requests = 0;
    globalThis.fetch = (async (input, init) => {
      requests++;
      expect(String(input)).toBe("https://aistupidlevel.info/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
      // The upstream row shape: id, object, created and owned_by only.
      return Response.json({ object: "list", data: [
        { id: "auto-coding", object: "model", created: 1792750208, owned_by: "aistupidlevel" },
        { id: "auto-tooling", object: "model", created: 1792750208, owned_by: "aistupidlevel" },
        { id: "claude-opus-5-5", object: "model", created: 1792750208, owned_by: "anthropic" },
      ] });
    }) as typeof fetch;
    const models = (await gatherRoutedModels(config())).filter(row => row.provider === "aistupidlevel");
    expect(requests).toBe(1);
    expect(models.map(row => row.id).sort()).toEqual(["auto-coding", "auto-tooling", "claude-opus-5-5"]);
  });

  test("validates a key against the key-gated model list and separates rejection from an outage", async () => {
    expect(buildModelsRequest(config().providers.aistupidlevel!, "test-key", "aistupidlevel").url)
      .toBe("https://aistupidlevel.info/v1/models");
    for (const [status, expected] of [[200, true], [401, false], [503, "unknown"]] as const) {
      globalThis.fetch = (async (input, init) => {
        expect(String(input)).toBe("https://aistupidlevel.info/v1/models");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
        return new Response(status === 200 ? JSON.stringify({ object: "list", data: [] }) : null, { status });
      }) as typeof fetch;
      expect(await validateApiKey("aistupidlevel", KEY_LOGIN_PROVIDERS.aistupidlevel!, "test-key")).toBe(expected);
    }
  });
});
