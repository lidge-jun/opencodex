import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { gatherRoutedModels } from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";
import { buildInitProviders } from "../src/cli/init";
import { buildModelsRequest } from "../src/oauth";
import { KEY_LOGIN_PROVIDERS, validateApiKey } from "../src/oauth/key-providers";
import {
  deriveInitProviders,
  deriveProviderPresets,
  providerConfigSeed,
} from "../src/providers/derive";
import { providerModelDiscoverySpecError } from "../src/providers/model-discovery";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { routedSlug } from "../src/providers/slug-codec";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures/commandcode-models.json"), "utf8");
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("commandcode");
});

function commandcodeEntry() {
  const entry = PROVIDER_REGISTRY.find(row => row.id === "commandcode");
  if (!entry) throw new Error("missing Command Code registry entry");
  return entry;
}

function commandcodeConfig(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "commandcode",
    providers: {
      commandcode: {
        adapter: "openai-chat",
        baseUrl: "https://api.commandcode.ai/provider/v1",
        authMode: "key",
        apiKey: "cmd-test-key",
        liveModels: true,
        // The discovery fetch itself is fixture-only; this opt-in keeps the test focused on
        // the provider contract in environments that resolve public hosts differently.
        allowPrivateNetwork: true,
        ...overrides,
      },
    },
  };
}

describe("Command Code provider", () => {
  test("registers the fixed Provider API transport and bounded discovery policy", () => {
    const entry = commandcodeEntry();
    expect(entry).toMatchObject({
      id: "commandcode",
      label: "Command Code - API",
      adapter: "openai-chat",
      baseUrl: "https://api.commandcode.ai/provider/v1",
      authKind: "key",
      dashboardUrl: "https://commandcode.ai/studio/",
      liveModels: true,
      preserveCustomDestination: true,
      defaultModel: "deepseek/deepseek-v4-flash",
      apiKeyValidation: "unknown",
      reasoningEfforts: [],
      modelDiscovery: {
        path: "models",
        maxResponseBytes: 256 * 1024,
        maxModels: 256,
      },
    });
    expect(providerModelDiscoverySpecError(entry.modelDiscovery!)).toBeNull();
    // The public catalog lists ids/context windows only, so the only static seed is the default
    // model itself — it stays callable when live discovery fails on a fresh config (no cache).
    expect(entry.models).toEqual(["deepseek/deepseek-v4-flash"]);
  });

  test("derives key-login, init, and dashboard presets without persisting trust policy", () => {
    expect(KEY_LOGIN_PROVIDERS.commandcode).toMatchObject({
      label: "Command Code - API",
      adapter: "openai-chat",
      baseUrl: "https://api.commandcode.ai/provider/v1",
      dashboardUrl: "https://commandcode.ai/studio/",
      liveModels: true,
      defaultModel: "deepseek/deepseek-v4-flash",
      apiKeyValidation: "unknown",
      models: ["deepseek/deepseek-v4-flash"],
    });
    expect(buildInitProviders()).toEqual(deriveInitProviders());
    expect(buildInitProviders().find(row => row.id === "commandcode")).toMatchObject({
      kind: "key",
      adapter: "openai-chat",
      baseUrl: "https://api.commandcode.ai/provider/v1",
      defaultModel: "deepseek/deepseek-v4-flash",
    });
    expect(deriveProviderPresets().find(row => row.id === "commandcode")).toMatchObject({
      auth: "key",
      dashboardUrl: "https://commandcode.ai/studio/",
      defaultModel: "deepseek/deepseek-v4-flash",
    });

    const seed = providerConfigSeed(commandcodeEntry());
    expect(seed).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://api.commandcode.ai/provider/v1",
      authMode: "key",
      liveModels: true,
      reasoningEfforts: [],
      defaultModel: "deepseek/deepseek-v4-flash",
      models: ["deepseek/deepseek-v4-flash"],
    });
    expect(seed).not.toHaveProperty("modelDiscovery");
    expect(seed).not.toHaveProperty("preserveCustomDestination");
    expect(seed).not.toHaveProperty("apiKeyValidation");
  });

  test("reports key validity as unknown instead of trusting the public catalog", async () => {
    globalThis.fetch = (() => {
      throw new Error("validateApiKey must not probe a public catalog");
    }) as typeof fetch;

    expect(await validateApiKey(
      "commandcode",
      KEY_LOGIN_PROVIDERS.commandcode!,
      "cmd-validation-key",
    )).toBe("unknown");
  });

  test("lists models through the fixed public discovery endpoint with the bearer key", () => {
    const request = buildModelsRequest(
      commandcodeConfig().providers.commandcode!,
      "cmd-model-list-key",
      "commandcode",
    );
    expect(request).toEqual({
      url: "https://api.commandcode.ai/provider/v1/models",
      headers: { Authorization: "Bearer cmd-model-list-key" },
    });
  });

  test("routes chat completions to the Provider API with namespaced ids intact", () => {
    const route = routeModel(
      commandcodeConfig(),
      "commandcode/deepseek/deepseek-v4-flash",
    );
    // Command Code does not opt into parallel_tool_calls at the provider level, so the
    // openai-chat adapter omits the field unless parallelToolCalls is explicitly true.
    expect(route.provider.parallelToolCalls).toBeUndefined();
    expect(route.modelId).toBe("deepseek/deepseek-v4-flash");

    const request = createOpenAIChatAdapter(route.provider).buildRequest({
      modelId: route.modelId,
      context: {
        messages: [{ role: "user", content: "ping", timestamp: 0 }],
        tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;

    expect(request.url).toBe("https://api.commandcode.ai/provider/v1/chat/completions");
    expect(request.headers.Authorization).toBe("Bearer cmd-test-key");
    expect(body.model).toBe("deepseek/deepseek-v4-flash");
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });

  test("discovers the live catalog with context windows and preserves slash ids", async () => {
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe("https://api.commandcode.ai/provider/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cmd-test-key");
      expect(init?.redirect).toBe("manual");
      return new Response(FIXTURE, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const config = withStubbedProviderFetch(commandcodeConfig());
    const models = (await gatherRoutedModels(config)).filter(row => row.provider === "commandcode");
    // Full public catalog snapshot: 51 rows, including the free-tier entries.
    expect(models).toHaveLength(51);
    expect(models.map(row => row.id)).toContain("deepseek/deepseek-v4-flash");
    expect(models.map(row => row.id)).toContain("moonshotai/Kimi-K2.7-Code");
    expect(models.map(row => row.id)).toContain("poolside/laguna-s-2.1-free");

    const deepseek = models.find(row => row.id === "deepseek/deepseek-v4-flash")!;
    expect(deepseek.contextWindow).toBe(1_000_000);
    expect(deepseek.owned_by).toBe("command-code");
    // #1800: discovered models now surface the curated effort table (command-code-efforts.ts).
    expect(deepseek.reasoningEfforts).toEqual(["high", "max"]);

    const haiku = models.find(row => row.id === "claude-haiku-4-5-20251001")!;
    expect(haiku.contextWindow).toBe(200_000);
    expect(haiku.inputModalities).toBeUndefined();

    const sol = models.find(row => row.id === "gpt-5.6-sol")!;
    expect(sol.contextWindow).toBe(1_050_000);

    expect(routedSlug("commandcode", deepseek.id)).toBe("commandcode/deepseek-deepseek-v4-flash");
    expect(routeModel(config, "commandcode/deepseek/deepseek-v4-flash").modelId)
      .toBe("deepseek/deepseek-v4-flash");
    expect(routeModel(config, "commandcode/deepseek-deepseek-v4-flash").modelId)
      .toBe("deepseek/deepseek-v4-flash");
  });

  test("keeps the default model callable when live discovery fails on a fresh config", async () => {
    globalThis.fetch = (async () => new Response("upstream down", {
      status: 500,
      headers: { "content-type": "text/plain" },
    })) as typeof fetch;

    const config = withStubbedProviderFetch(commandcodeConfig());
    const models = (await gatherRoutedModels(config)).filter(row => row.provider === "commandcode");

    // No stale cache exists on a fresh config, so the seeded default must survive the failure.
    expect(models.map(row => row.id)).toEqual(["deepseek/deepseek-v4-flash"]);
    expect(routeModel(config, "commandcode/deepseek/deepseek-v4-flash").modelId)
      .toBe("deepseek/deepseek-v4-flash");
  });
});
