import { describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
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
  type McodeGeneratedConfig,
  type OpencodeGeneratedConfig,
  type PiGeneratedConfig,
} from "../src/clients/config-export";
import type { OcxConfig } from "../src/types";
import { catalogConvergenceFactory } from "./helpers/catalog-convergence";

/**
 * A key that looks exactly like a real one. Every assertion about `ocx_` absence is
 * worthless unless the running config actually holds a serializable secret (030 §Security).
 */
const REAL_LOOKING_KEY = "ocx_live_9f3c7a2b41d84e6fa05c8e17b3d92764";

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
  displayName?: string;
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
    ...(row.native ? { native: true } : {}),
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    ...(row.inputModalities ? { inputModalities: row.inputModalities } : {}),
    ...(row.reasoningEfforts ? { reasoningEfforts: row.reasoningEfforts } : {}),
    ...(row.defaultReasoningEffort ? { defaultReasoningEffort: row.defaultReasoningEffort } : {}),
  };
}

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
    process.env.PI_CODING_AGENT_DIR = "/tmp/opencodex-pi-route-fixture";
    try {
      const response = await clientConfigApi(baseConfig(), "?client=pi");
      expect(response.status).toBe(200);
      const body = await response.json() as ClientConfigEnvelope;
      expect(body.destination).toBe("/tmp/opencodex-pi-route-fixture/models.json");
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
