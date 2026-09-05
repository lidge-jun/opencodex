import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GATED_MODEL_CLIENT_VERSION_FLOOR,
  resetCodexModelEntitlementCacheForTests,
  seedCodexModelEntitlementsForTests,
} from "../../src/codex/model-entitlements";
import { handleManagementAPI } from "../../src/server/management-api";
import { listManagementModelRows, loadExportModels } from "../../src/server/management/model-rows";
import {
  OPENCODE_API_KEY_ENV,
  OPENCODE_CONFIG_SCHEMA,
  OPENCODE_PROVIDER_ID,
  LOOPBACK_API_KEY_PLACEHOLDER,
  buildClientConfig,
  normalizeExportModels,
  opencodeGlobalConfigPath,
  type DshGeneratedConfig,
  type ExportModel,
  type HermesGeneratedConfig,
  type McodeGeneratedConfig,
  type OpencodeGeneratedConfig,
  type PiGeneratedConfig,
} from "../../src/clients/config-export";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * A key that looks exactly like a real one. Every assertion about `ocx_` absence is
 * worthless unless the running config actually holds a serializable secret (030 §Security).
 */
const REAL_LOOKING_KEY = "ocx_live_9f3c7a2b41d84e6fa05c8e17b3d92764";

const originalOpenCodexHome = process.env.OPENCODEX_HOME;
const originalCodexHome = process.env.CODEX_HOME;
let entitlementTestRoot = "";
let entitlementCodexHome = "";

beforeAll(() => {
  entitlementTestRoot = mkdtempSync(join(tmpdir(), "ocx-client-config-entitlement-"));
  entitlementCodexHome = join(entitlementTestRoot, "codex");
  mkdirSync(entitlementCodexHome, { recursive: true });
  process.env.OPENCODEX_HOME = join(entitlementTestRoot, "opencodex");
  process.env.CODEX_HOME = entitlementCodexHome;
});

afterAll(() => {
  if (originalOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalOpenCodexHome;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  removeTreeWithRetry(entitlementTestRoot);
});

afterEach(() => {
  resetCodexModelEntitlementCacheForTests();
  rmSync(join(entitlementCodexHome, "auth.json"), { force: true });
});

interface ClientConfigEnvelope {
  client: string;
  filename: string;
  destination: string;
  apiKeyEnv: string;
  exportHint: string;
  modelCount: number;
  modelsWithoutLimits: number;
  format: string;
  text: string;
  config: unknown;
}

interface ModelRow {
  provider: string;
  id: string;
  namespaced: string;
  disabled: boolean;
  native?: boolean;
  fastRowAvailable?: boolean;
  displayName?: string;
  displayNameSource?: "operator" | "provider" | "fallback";
  contextWindow?: number;
  inputModalities?: string[];
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

/**
 * Static provider catalogs (`liveModels: false`) so the model list is deterministic and no
 * test ever reaches the network. `b/no-context` carries no context window, which is what
 * makes `modelsWithoutLimits` non-zero and therefore actually assertable.
 */
function baseConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "a",
    apiKeys: [{ id: "key-1", name: "default", key: REAL_LOOKING_KEY, createdAt: new Date(0).toISOString() }],
    providers: {
      a: {
        adapter: "openai-chat",
        baseUrl: "https://a.example/v1",
        apiKey: REAL_LOOKING_KEY,
        liveModels: false,
        models: ["m1", "m2"],
        modelContextWindows: { m1: 128_000 },
        modelInputModalities: { m1: ["text", "image"], m2: ["text"] },
        modelReasoningEfforts: { m1: ["none", "minimal", "low", "high"] },
      },
      b: {
        adapter: "openai-chat",
        baseUrl: "https://b.example/v1",
        apiKey: REAL_LOOKING_KEY,
        liveModels: false,
        models: ["no-context"],
      },
    },
    ...overrides,
  } as OcxConfig;
}

async function clientConfigApi(config: OcxConfig, query: string): Promise<Response> {
  const url = new URL(`http://127.0.0.1:10100/api/client-config${query}`);
  const response = await handleManagementAPI(
    new Request(url, { headers: { Host: url.host } }),
    url,
    config,
    { saveConfigPreservingClaudeCode: () => {}, createManagementConvergeCodex: catalogConvergenceFactory() },
  );
  expect(response).not.toBeNull();
  return response!;
}

async function modelRows(config: OcxConfig): Promise<ModelRow[]> {
  const url = new URL("http://127.0.0.1:10100/api/models");
  const response = await handleManagementAPI(
    new Request(url, { headers: { Host: url.host } }),
    url,
    config,
    { saveConfigPreservingClaudeCode: () => {}, createManagementConvergeCodex: catalogConvergenceFactory() },
  );
  return await response!.json() as ModelRow[];
}

function toExportModel(row: ModelRow): ExportModel {
  return {
    namespaced: row.namespaced,
    provider: row.provider,
    id: row.id,
    fastRowAvailable: row.fastRowAvailable === true,
    ...(row.native ? { native: true } : {}),
    ...(row.displayName && row.displayNameSource !== "fallback" ? { displayName: row.displayName } : {}),
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    ...(row.inputModalities ? { inputModalities: row.inputModalities } : {}),
    ...(row.reasoningEfforts ? { reasoningEfforts: row.reasoningEfforts } : {}),
    ...(row.defaultReasoningEffort ? { defaultReasoningEffort: row.defaultReasoningEffort } : {}),
  };
}


describe("native Anthropic effort ladder reaches the Aside document", () => {
  /**
   * The end-to-end guard for the defect: native Anthropic rows used to reach Aside with no
   * effort control, while the SAME Claude models routed through cursor or google-antigravity
   * had one. Every other test for this fix starts from a hand-built ExportModel or registry
   * lookup, so all of them would stay green if enrichment, CatalogModel, ManagementModelRow
   * or toExportModel dropped the field tomorrow. This one starts from a bare PROVIDER CONFIG
   * and asserts the emitted document, so it covers the whole chain:
   *
   *   registry -> enrichProviderFromRegistry -> CatalogModel -> ManagementModelRow
   *   -> toExportModel -> buildClientConfig("aside")
   *
   * It calls the production loader directly rather than the ?client=aside route, because that
   * route resolves ~/.aside/accounts.json for its destination and this must not depend on the
   * developer's real Aside install.
   */
  test("a bare Anthropic provider config emits reasoning and a thinkingLevelMap", async () => {
    const config = {
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "anthropic",
      providers: {
        anthropic: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "oauth",
          liveModels: false,
        },
      },
    } as unknown as OcxConfig;

    const models = await loadExportModels(config);
    const document = buildClientConfig("aside", {
      baseUrl: "http://127.0.0.1:10100/v1",
      config,
      models,
    }) as PiGeneratedConfig;

    const rows = document.providers[OPENCODE_PROVIDER_ID]!.models
      .filter(model => model.id.startsWith("anthropic/claude-"));
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.reasoning).toBe(true);
      expect(row.thinkingLevelMap!.low).toBe("low");
      expect(row.thinkingLevelMap!.high).toBe("high");
      expect(row.thinkingLevelMap!.max).toBe("max");
      // The ladder declares neither sentinel, so neither is offered as a selectable level.
      expect(row.thinkingLevelMap!.off).toBeNull();
      expect(row.thinkingLevelMap!.minimal).toBeNull();
    }
  });
});
describe("GET /api/client-config", () => {
  test("opencode envelope carries the shared builder's exact bytes", async () => {
    const config = baseConfig();
    const response = await clientConfigApi(config, "?client=opencode");
    expect(response.status).toBe(200);
    const body = await response.json() as ClientConfigEnvelope;

    expect(body.client).toBe("opencode");
    expect(body.filename).toBe("opencode.json");
    expect(body.destination).toBe(opencodeGlobalConfigPath(process.env));
    expect(body.apiKeyEnv).toBe(OPENCODE_API_KEY_ENV);
    expect(body.exportHint).toBe(`export ${OPENCODE_API_KEY_ENV}=<your key>`);

    // Accept criterion 1: the route's `config` must equal what the shared builder produces
    // for the same input, so the GUI download and `ocx export` can never disagree.
    const rows = await modelRows(config);
    const expected = buildClientConfig("opencode", {
      baseUrl: "http://127.0.0.1:10100/v1",
      models: rows.filter(row => !row.disabled).map(toExportModel),
      config,
    });
    expect(body.config).toEqual(expected as Record<string, unknown>);
    expect(JSON.stringify(body.config)).toBe(JSON.stringify(expected));

    const document = body.config as OpencodeGeneratedConfig;
    expect(document.$schema).toBe(OPENCODE_CONFIG_SCHEMA);
    const models = document.provider[OPENCODE_PROVIDER_ID].models;
    expect(models["a/m1"]).toEqual({ name: "m1 (a)", limit: { context: 128_000, output: 32_000 } });
    expect(models["b/no-context"]).toEqual({ name: "no-context (b)" });
  }, 15_000);

  test("pi returns a models ARRAY under the same provider id", async () => {
    const response = await clientConfigApi(baseConfig(), "?client=pi");
    expect(response.status).toBe(200);
    const body = await response.json() as ClientConfigEnvelope;

    expect(body.client).toBe("pi");
    expect(body.filename).toBe("pi-models.json");
    expect(body.apiKeyEnv).toBe("");

    const provider = (body.config as PiGeneratedConfig).providers[OPENCODE_PROVIDER_ID];
    expect(Array.isArray(provider.models)).toBe(true);
    expect(provider.apiKey).toBe(LOOPBACK_API_KEY_PLACEHOLDER);
    expect(provider.baseUrl).toBe("http://127.0.0.1:10100/v1");
    expect(provider.models.map(model => model.id)).toContain("a/m1");
  }, 15_000);

  test("OMP returns the full routed catalog as models.yml YAML", async () => {
    const response = await clientConfigApi(baseConfig(), "?client=omp");
    expect(response.status).toBe(200);
    const body = await response.json() as ClientConfigEnvelope;

    expect(body.client).toBe("omp");
    expect(body.filename).toBe("omp-models.yaml");
    expect(body.format).toBe("yaml");
    expect(body.text).toContain("providers:");
    expect(body.text).toContain("a/m1");
    const provider = (body.config as PiGeneratedConfig).providers[OPENCODE_PROVIDER_ID];
    const routedIds = provider.models
      .map(model => model.id)
      .filter(id => id.startsWith("a/") || id.startsWith("b/"));
    expect(routedIds).toEqual(["a/m1", "a/m2", "b/no-context"]);
    expect(provider.models.find(model => model.id === "a/m1")?.contextWindow).toBe(128_000);
    expect(provider.models.find(model => model.id === "b/no-context")?.contextWindow).toBeUndefined();
    expect(provider.apiKey).toBe(LOOPBACK_API_KEY_PLACEHOLDER);
    expect(body.text).not.toContain(REAL_LOOKING_KEY);
    expect(JSON.stringify(body.config)).not.toContain(REAL_LOOKING_KEY);
  }, 15_000);

  test("DSH response keeps management reasoning metadata in the rc.6 model map", async () => {
    writeFileSync(join(entitlementCodexHome, "auth.json"), JSON.stringify({
      tokens: { access_token: "dsh-token", account_id: "dsh-main" },
    }));
    seedCodexModelEntitlementsForTests(
      "main",
      ["gpt-5.6-luna"],
      Date.now(),
      GATED_MODEL_CLIENT_VERSION_FLOOR,
      "main:dsh-main",
    );
    const response = await clientConfigApi(baseConfig(), "?client=dsh");
    expect(response.status).toBe(200);
    const body = await response.json() as ClientConfigEnvelope;
    expect(body.filename).toBe("settings.yaml");
    expect(body.format).toBe("yaml");
    expect(Bun.YAML.parse(body.text)).toEqual(body.config as Record<string, unknown>);

    const provider = (body.config as DshGeneratedConfig)["llm-pi-ai"].providers[OPENCODE_PROVIDER_ID]!;
    const native = provider.models.find(model => model.id === "gpt-5.6-luna")!;
    expect(native.reasoningEfforts).toEqual({
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });
  }, 15_000);

  test("Hermes response projects catalog vision metadata through YAML", async () => {
    const response = await clientConfigApi(baseConfig(), "?client=hermes");
    expect(response.status).toBe(200);
    const body = await response.json() as ClientConfigEnvelope;
    const models = (body.config as HermesGeneratedConfig).providers[OPENCODE_PROVIDER_ID]!.models;

    expect(Bun.YAML.parse(body.text)).toEqual(body.config as Record<string, unknown>);
    expect(models["a/m1"]).toEqual({ supports_vision: true });
    // Effective catalog hints may widen ordinary text rows to image-capable.
    expect(models["a/m2"]).toEqual({ supports_vision: true });
    expect(models["b/no-context"]).toEqual({});
    expect(body.modelCount).toBe(Object.keys(models).length);
  }, 15_000);

  test("an expired management roster is refreshed once before client-config is projected", async () => {
    writeFileSync(join(entitlementCodexHome, "auth.json"), JSON.stringify({
      tokens: { access_token: "client-config-token", account_id: "client-config-account" },
    }));
    const originalFetch = globalThis.fetch;
    let entitlementFetches = 0;
    globalThis.fetch = (async input => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "chatgpt.com" && url.pathname === "/backend-api/codex/models") {
        entitlementFetches += 1;
        return Response.json({ models: [
          { slug: "gpt-5.6-sol", supported_in_api: true, visibility: "list" },
          { slug: "gpt-5.6-terra", supported_in_api: true, visibility: "list" },
          { slug: "gpt-5.6-luna", supported_in_api: true, visibility: "list" },
        ] });
      }
      return originalFetch(input);
    }) as typeof fetch;
    try {
      const config = baseConfig({
        providers: {
          ...baseConfig().providers,
          openai: { authMode: "forward", liveModels: false, models: [] },
        },
      });
      const response = await clientConfigApi(config, "?client=opencode");
      expect(response.status).toBe(200);
      const body = await response.json() as ClientConfigEnvelope;
      const models = (body.config as OpencodeGeneratedConfig).provider[OPENCODE_PROVIDER_ID].models;
      expect(entitlementFetches).toBe(1);
      expect(Object.keys(models)).toEqual(expect.arrayContaining([
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
      ]));
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 15_000);

  test("an entitlement ensure rejection cannot turn client-config into a 503", async () => {
    const config = baseConfig();
    Object.defineProperty(config, "codexAccounts", {
      get() { throw new Error("entitlement identity unavailable"); },
      configurable: true,
    });

    const response = await clientConfigApi(config, "?client=opencode");
    expect(response.status).toBe(200);
  }, 15_000);

  test("MCode response carries catalog context and its usable reasoning ladder", async () => {
    const response = await clientConfigApi(baseConfig(), "?client=mcode");
    expect(response.status).toBe(200);
    const body = await response.json() as ClientConfigEnvelope;
    const provider = (body.config as McodeGeneratedConfig).custom_provider[OPENCODE_PROVIDER_ID]!;

    expect(body.format).toBe("yaml");
    expect(Bun.YAML.parse(body.text)).toEqual(body.config as Record<string, unknown>);
    expect(provider.models["a/m1"]).toEqual({
      limit: { context: 128_000 },
      thinking: { effortOptions: ["minimal", "low", "high"] },
    });
    expect(provider.models["b/no-context"]).toEqual({});
    expect(body.modelsWithoutLimits).toBe(2);
  }, 15_000);

  test("counts describe the emitted document, including models without limits", async () => {
    const config = baseConfig();
    const opencode = await (await clientConfigApi(config, "?client=opencode")).json() as ClientConfigEnvelope;
    const models = (opencode.config as OpencodeGeneratedConfig).provider[OPENCODE_PROVIDER_ID].models;
    const entries = Object.values(models);

    expect(opencode.modelCount).toBe(entries.length);
    expect(opencode.modelsWithoutLimits).toBe(entries.filter(entry => entry.limit === undefined).length);
    // Non-zero, or the assertion above would hold vacuously for a fixture with limits everywhere.
    expect(opencode.modelsWithoutLimits).toBeGreaterThan(0);

    const pi = await (await clientConfigApi(config, "?client=pi")).json() as ClientConfigEnvelope;
    const piModels = (pi.config as PiGeneratedConfig).providers[OPENCODE_PROVIDER_ID].models;
    expect(pi.modelCount).toBe(piModels.length);
    expect(pi.modelsWithoutLimits).toBe(piModels.filter(model => model.contextWindow === undefined).length);
  }, 15_000);

  test("disabled models are filtered before the config is built", async () => {
    const enabled = await (await clientConfigApi(baseConfig(), "?client=opencode")).json() as ClientConfigEnvelope;
    const enabledModels = (enabled.config as OpencodeGeneratedConfig).provider[OPENCODE_PROVIDER_ID].models;
    expect(Object.keys(enabledModels)).toContain("a/m2");

    // The export core (src/clients/config-export.ts) does not filter visibility; this route
    // must, or a user's hidden model ships as a selector the proxy refuses to route.
    const response = await clientConfigApi(baseConfig({ disabledModels: ["a/m2"] }), "?client=opencode");
    const body = await response.json() as ClientConfigEnvelope;
    const models = (body.config as OpencodeGeneratedConfig).provider[OPENCODE_PROVIDER_ID].models;
    expect(Object.keys(models)).not.toContain("a/m2");
    expect(Object.keys(models)).toContain("a/m1");
    expect(body.modelCount).toBe(enabled.modelCount - 1);
  }, 15_000);

  test("manual OpenAI replacement, disable, and removal reach the loader and exported selectors", async () => {
    const config = baseConfig({
      // Test base-selector identity here; the Fast projection has its own regressions below.
      fastRows: false,
      providers: {
        ...baseConfig().providers,
        openai: {
          adapter: "openai-responses", authMode: "forward", liveModels: false,
          baseUrl: "https://chatgpt.com/backend-api/codex", models: [],
        },
      },
    });
    const manual = [{ id: "manual-gpt", provider: "openai", modelId: "gpt-5.5", contextWindow: 128_000 }];
    const stages = [
      { customModels: [], disabledModels: [], selectors: ["gpt-5.5"], native: true },
      { customModels: manual, disabledModels: [], selectors: ["openai/gpt-5.5"], native: false },
      { customModels: manual, disabledModels: ["openai/gpt-5.5"], selectors: [], native: false },
      // Removing the manual row restores the bare route even while its routed disable key remains.
      { customModels: [], disabledModels: ["openai/gpt-5.5"], selectors: ["gpt-5.5"], native: true },
    ];
    for (const stage of stages) {
      config.customModels = stage.customModels;
      config.disabledModels = stage.disabledModels;
      const rows = await loadExportModels(config);
      const matchingRows = rows.filter(row => row.provider === "openai" && row.id === "gpt-5.5");
      expect(matchingRows.map(row => row.namespaced)).toEqual(stage.selectors);
      if (stage.selectors.length > 0) {
        expect(matchingRows[0]!.native === true).toBe(stage.native);
        if (!stage.native) expect(matchingRows[0]!.contextWindow).toBe(128_000);
      }
      const response = await clientConfigApi(config, "?client=pi");
      expect(response.status).toBe(200);
      const body = await response.json() as ClientConfigEnvelope;
      const models = (body.config as PiGeneratedConfig).providers[OPENCODE_PROVIDER_ID].models;
      // An array export exposes duplicates that a keyed document could silently overwrite.
      expect(models.filter(model => model.id === "gpt-5.5" || model.id === "openai/gpt-5.5")
        .map(model => model.id)).toEqual(stage.selectors);
      if (stage.selectors[0] === "openai/gpt-5.5") {
        expect(models.find(model => model.id === "openai/gpt-5.5")?.contextWindow).toBe(128_000);
      }
      expect(models.filter(model => model.id === "a/m1")).toHaveLength(1);
      expect(body.modelCount).toBe(models.length);
    }
  }, 15_000);

  test("model order and dedupe are stable across repeated calls", async () => {
    const config = baseConfig();
    const first = await (await clientConfigApi(config, "?client=opencode")).json() as ClientConfigEnvelope;
    const second = await (await clientConfigApi(config, "?client=opencode")).json() as ClientConfigEnvelope;
    expect(JSON.stringify(first.config)).toBe(JSON.stringify(second.config));

    const keys = Object.keys((first.config as OpencodeGeneratedConfig).provider[OPENCODE_PROVIDER_ID].models);
    expect(keys).toEqual(normalizeExportModels(keys.map(key => ({ namespaced: key, provider: "x", id: key }))).map(m => m.namespaced));
  }, 15_000);

  test("no response body serializes a real key", async () => {
    const config = baseConfig();
    // Precondition: the secret really is present in the config this route reads.
    expect(JSON.stringify(config)).toContain("ocx_");

    for (const client of ["opencode", "pi"]) {
      const raw = await (await clientConfigApi(config, `?client=${client}`)).text();
      expect(raw).not.toContain("ocx_");
      expect(raw).not.toContain(REAL_LOOKING_KEY);
    }
  }, 15_000);

  test("missing or unknown client is a 400 naming both valid values", async () => {
    for (const query of ["", "?client=", "?client=zed", "?client=OpenCode", "?client=%20"]) {
      const response = await clientConfigApi(baseConfig(), query);
      expect(response.status).toBe(400);
      const body = await response.json() as { error: string };
      expect(body.error).toContain("opencode");
      expect(body.error).toContain("pi");
    }
  }, 15_000);

  test("a catalog failure is 503, never a partial 200", async () => {
    const config = baseConfig();
    // A provider whose enumeration throws stands in for an unavailable catalog; the route
    // must refuse rather than emit a config missing that provider's models.
    Object.defineProperty(config, "providers", {
      get() { throw new Error("catalog offline"); },
      configurable: true,
    });

    const response = await clientConfigApi(config, "?client=opencode");
    expect(response.status).toBe(503);
    const body = await response.json() as { error: string; config?: unknown };
    expect(body.error).toContain("catalog offline");
    expect(body.config).toBeUndefined();
  }, 15_000);

  /**
   * A client's own environment override can name a path the resolver refuses.
   * The CLI already surfaces that as a readable error, and the integration
   * state and writer paths already catch it — this route did not, so the
   * exception escaped `handleManagementAPI` and the dashboard download saw a
   * generic 500 with the corrective message stripped. The hole was reachable
   * for every client whose destination resolves an override (mcode, zcode,
   * dsh); Pi joined that set when its resolver started honoring
   * `PI_CODING_AGENT_DIR`.
   */
  test("a refused path override answers 400 with the bounded message, not a thrown 500", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = "relative";
    try {
      const response = await clientConfigApi(baseConfig(), "?client=pi");
      expect(response.status).toBe(400);
      const body = await response.json() as { error: string; config?: unknown };
      expect(body.error).toContain("PI_CODING_AGENT_DIR");
      expect(body.error).toContain("absolute path");
      // The refusal must not leak a half-built envelope.
      expect(body.config).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  }, 15_000);

  test("an accepted override still resolves through the route", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    // One binding for the override, so the env value and the expectation cannot
    // drift apart, and `join` for the separator: the resolver builds the
    // destination with `join`, which is `\` on win32, so a hard-coded POSIX
    // string asserted the platform rather than the override taking effect.
    const overrideDir = "/tmp/opencodex-pi-route-fixture";
    process.env.PI_CODING_AGENT_DIR = overrideDir;
    try {
      const response = await clientConfigApi(baseConfig(), "?client=pi");
      expect(response.status).toBe(200);
      const body = await response.json() as ClientConfigEnvelope;
      expect(body.destination).toBe(join(overrideDir, "models.json"));
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  }, 15_000);

  test("a refused override wins over a failing catalog, and skips the catalog work", async () => {
    // The refusal is a property of the request, not of the catalog. Validating
    // it after the load let 503 answer first and hid the corrective message.
    const config = baseConfig();
    let providersRead = 0;
    Object.defineProperty(config, "providers", {
      get() { providersRead += 1; throw new Error("catalog offline"); },
      configurable: true,
    });
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = "relative";
    try {
      const response = await clientConfigApi(config, "?client=pi");
      expect(response.status).toBe(400);
      const body = await response.json() as { error: string };
      expect(body.error).toContain("PI_CODING_AGENT_DIR");
      expect(body.error).not.toContain("catalog offline");
      // Nothing enumerated the catalog for input that was going to be rejected.
      expect(providersRead).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  }, 15_000);

  test("cross-origin admission is unchanged from every other /api route", async () => {
    const url = new URL("http://127.0.0.1:10100/api/client-config?client=opencode");
    const response = await handleManagementAPI(
      new Request(url, { headers: { Host: url.host, Origin: "https://evil.example" } }),
      url,
      baseConfig(),
      { saveConfigPreservingClaudeCode: () => {}, createManagementConvergeCodex: catalogConvergenceFactory() },
    );
    expect(response?.status).toBe(403);
  }, 15_000);
});


describe("default Fast availability reaches external exports", () => {
  function fastConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
    return baseConfig({
      defaultProvider: "fixture",
      providers: { fixture: {
        adapter: "openai-responses", baseUrl: "https://fixture.example/v1",
        liveModels: false, models: ["m", "slow"], supportsServiceTier: true,
        modelSupportsServiceTier: { slow: false },
      } },
      ...overrides,
    });
  }

  test("omitted flag exports eligible Fast to pi, with the base still selectable", async () => {
    const config = fastConfig();
    const rows = await modelRows(config);
    expect(rows.find(row => row.namespaced === "fixture/m")?.fastRowAvailable).toBe(true);
    expect(rows.find(row => row.namespaced === "fixture/slow")?.fastRowAvailable).toBe(false);
    const response = await clientConfigApi(config, "?client=pi");
    const body = await response.json() as ClientConfigEnvelope;
    const models = (body.config as PiGeneratedConfig).providers.opencodex.models.map(model => model.id);
    expect(models).toContain("fixture/m");
    expect(models).toContain("fixture/m--fast");
    expect(models).not.toContain("fixture/slow--fast");
  });

  test("explicit off survives management and export projection", async () => {
    const config = fastConfig({ fastRows: false });
    const rows = await loadExportModels(config);
    expect(rows.every(row => row.fastRowAvailable === false)).toBe(true);
    const result = buildClientConfig("pi", { baseUrl: "http://127.0.0.1:10100/v1", models: rows, config }) as PiGeneratedConfig;
    expect(result.providers.opencodex.models.map(model => model.id)).not.toContain("fixture/m--fast");
  });

  test("a disabled real Fast-named model defeats synthesis before visibility filtering", async () => {
    const config = fastConfig({ disabledModels: ["fixture/m--fast"] });
    config.providers.fixture.models = ["m", "m--fast"];
    const rows = await loadExportModels(config);
    expect(rows.find(row => row.namespaced === "fixture/m")?.fastRowAvailable).toBe(false);
    const result = buildClientConfig("pi", { baseUrl: "http://127.0.0.1:10100/v1", models: rows, config }) as PiGeneratedConfig;
    expect(result.providers.opencodex.models.map(model => model.id)).not.toContain("fixture/m--fast");
  });
});

describe("Pi and Aside provider selection", () => {
  test.each(["pi", "aside"] as const)("%s exports selected Grok models while management retains the full roster", async client => {
    const config = baseConfig({
      fastRows: false,
      defaultProvider: "xai",
      providers: {
        xai: {
          adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "key",
          liveModels: false, models: ["grok-4.6", "grok-4.5", "grok-4.3"],
          selectedModels: ["grok-4.6"],
        },
      },
    });
    const ids = async () => {
      const models = await loadExportModels(config);
      const doc = buildClientConfig(client, { baseUrl: "http://127.0.0.1:10100/v1", config, models }) as PiGeneratedConfig;
      return doc.providers.opencodex!.models.map(model => model.id).filter(id => id.startsWith("xai/"));
    };
    const management = await listManagementModelRows(config);
    expect(management.filter(row => row.provider === "xai")).toHaveLength(3);
    expect(await ids()).toEqual(["xai/grok-4.6"]);
    config.disabledModels = ["xai/grok-4.6"];
    expect(await ids()).toEqual([]);
    config.disabledModels = [];
    config.providers.xai!.selectedModels = [];
    expect(await ids()).toEqual(["xai/grok-4.3", "xai/grok-4.5", "xai/grok-4.6"]);
  });
});
