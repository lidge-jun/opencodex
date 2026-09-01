import { afterEach, describe, expect, test } from "bun:test";
import { clearModelCache, getFreshCached, setCached } from "../src/codex/model-cache";
import type { CatalogDisposition } from "../src/codex/convergence-types";
import { listManagementModelRows, toExportModel } from "../src/server/management/model-rows";
import { handleModelRoutes } from "../src/server/management/model-routes";
import type { OcxConfig } from "../src/types";

const DISPLAY_PROVIDER = "display-test";

function config(
  modelDisplayNames?: Record<string, string>,
  models: string[] = ["model-a"],
): OcxConfig {
  return {
    port: 10100,
    defaultProvider: DISPLAY_PROVIDER,
    modelCacheTtlMs: 60_000,
    providers: {
      [DISPLAY_PROVIDER]: {
        adapter: "openai-chat",
        baseUrl: "https://display.example.test/v1",
        liveModels: false,
        models,
        ...(modelDisplayNames ? { modelDisplayNames } : {}),
      },
    },
  };
}

afterEach(() => {
  clearModelCache();
});

describe("model display name management rows", () => {
  test("reports operator, provider, and fallback display name sources without provider secrets", async () => {
    const operatorConfig = config({ "model-a": "Operator Name" });
    operatorConfig.providers[DISPLAY_PROVIDER].apiKey = "sk-secret-not-for-rows";
    const operatorRow = (await listManagementModelRows(operatorConfig))
      .find(row => row.namespaced === `${DISPLAY_PROVIDER}/model-a`);

    expect(operatorRow).toMatchObject({
      displayName: "Operator Name",
      displayNameOverride: "Operator Name",
      displayNameSource: "operator",
    });
    expect(JSON.stringify(operatorRow)).not.toContain("sk-secret-not-for-rows");

    clearModelCache(DISPLAY_PROVIDER);
    setCached(DISPLAY_PROVIDER, [{
      provider: DISPLAY_PROVIDER,
      id: "model-a",
      displayName: "Provider Name",
    }]);
    const providerConfig = config();
    providerConfig.providers[DISPLAY_PROVIDER].liveModels = true;
    const providerRow = (await listManagementModelRows(providerConfig))
      .find(row => row.namespaced === `${DISPLAY_PROVIDER}/model-a`);
    expect(providerRow).toMatchObject({
      displayName: "Provider Name",
      displayNameSource: "provider",
    });
    expect(providerRow?.displayNameOverride).toBeUndefined();

    clearModelCache(DISPLAY_PROVIDER);
    const fallbackRow = (await listManagementModelRows(config()))
      .find(row => row.namespaced === `${DISPLAY_PROVIDER}/model-a`);
    expect(fallbackRow).toMatchObject({
      displayName: `${DISPLAY_PROVIDER}/model-a`,
      displayNameSource: "fallback",
    });
    expect(fallbackRow?.displayNameOverride).toBeUndefined();
  });

  test("management fallback text does not add redundant display metadata to client exports", () => {
    const fallback = toExportModel({
      provider: DISPLAY_PROVIDER,
      id: "model-a",
      namespaced: `${DISPLAY_PROVIDER}/model-a`,
      disabled: false,
      displayName: `${DISPLAY_PROVIDER}/model-a`,
      displayNameSource: "fallback",
    });
    const operator = toExportModel({
      provider: DISPLAY_PROVIDER,
      id: "model-a",
      namespaced: `${DISPLAY_PROVIDER}/model-a`,
      disabled: false,
      displayName: "Model Alpha",
      displayNameSource: "operator",
    });

    expect(fallback.displayName).toBeUndefined();
    expect(operator.displayName).toBe("Model Alpha");
  });
});

describe("provider model display name mutation route", () => {
  const catalogRefresh = {
    status: "committed" as const,
    changed: true,
    degraded: false,
    notices: [],
  };

  async function call(
    liveConfig: OcxConfig,
    body: unknown,
    options: {
      provider?: string;
      rawBody?: string;
      persist?: (saved: OcxConfig) => void;
      converge?: () => Promise<CatalogDisposition>;
    } = {},
  ): Promise<{ response: Response | null; persisted: OcxConfig[]; convergeCalls: number }> {
    const provider = options.provider ?? DISPLAY_PROVIDER;
    const url = new URL(`http://127.0.0.1:10100/api/providers/${encodeURIComponent(provider)}/model-display-names`);
    const req = new Request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: options.rawBody ?? JSON.stringify(body),
    });
    const persisted: OcxConfig[] = [];
    let convergeCalls = 0;
    const response = await handleModelRoutes({
      req,
      url,
      config: liveConfig,
      deps: {
        saveConfigPreservingClaudeCode: saved => {
          options.persist?.(saved);
          persisted.push(structuredClone(saved));
        },
      },
      convergeCodexCatalog: async () => {
        convergeCalls += 1;
        return options.converge ? options.converge() : catalogRefresh;
      },
      syncClaudeAgentDefsBestEffort: async () => {},
    });
    return { response, persisted, convergeCalls };
  }

  test("sets a trimmed label and returns the effective management state", async () => {
    const liveConfig = config();

    const result = await call(liveConfig, { modelId: "model-a", displayName: "  Model Alpha  " });
    const payload = await result.response!.json() as Record<string, unknown>;

    expect(result.response?.status).toBe(200);
    expect(liveConfig.providers[DISPLAY_PROVIDER].modelDisplayNames).toEqual({ "model-a": "Model Alpha" });
    expect(result.persisted).toHaveLength(1);
    expect(result.convergeCalls).toBe(1);
    expect(payload).toMatchObject({
      ok: true,
      provider: DISPLAY_PROVIDER,
      modelId: "model-a",
      displayName: "Model Alpha",
      displayNameOverride: "Model Alpha",
      displayNameSource: "operator",
      catalogRefresh,
    });
  });

  test("stores a label for a model temporarily absent from discovery", async () => {
    const liveConfig = config(undefined, []);

    const result = await call(liveConfig, { modelId: "future/model", displayName: "Future Model" });
    const payload = await result.response!.json() as Record<string, unknown>;

    expect(result.response?.status).toBe(200);
    expect(liveConfig.providers[DISPLAY_PROVIDER].modelDisplayNames).toEqual({ "future/model": "Future Model" });
    expect(payload).toMatchObject({
      displayName: "Future Model",
      displayNameOverride: "Future Model",
      displayNameSource: "operator",
    });
  });

  test("rejects an update that would grow the stored map beyond its limit", async () => {
    const existing = Object.fromEntries(
      Array.from({ length: 2_000 }, (_, index) => [`model-${index}`, `Model ${index}`]),
    );
    const liveConfig = config(existing);

    const result = await call(liveConfig, { modelId: "model-over-limit", displayName: "Too Many" });

    expect(result.response?.status).toBe(400);
    expect(result.persisted).toHaveLength(0);
    expect(result.convergeCalls).toBe(0);
    expect(liveConfig.providers[DISPLAY_PROVIDER].modelDisplayNames).toEqual(existing);
  });

  test("reset removes only the target and returns the fallback name", async () => {
    const liveConfig = config({ "model-a": "Alpha", "model-b": "Beta" }, ["model-a", "model-b"]);

    const result = await call(liveConfig, { modelId: "model-a", displayName: null });
    const payload = await result.response!.json() as Record<string, unknown>;

    expect(liveConfig.providers[DISPLAY_PROVIDER].modelDisplayNames).toEqual({ "model-b": "Beta" });
    expect(payload).toMatchObject({
      displayName: `${DISPLAY_PROVIDER}/model-a`,
      displayNameOverride: null,
      displayNameSource: "fallback",
    });
    expect(result.persisted).toHaveLength(1);
    expect(result.convergeCalls).toBe(1);
  });

  test("reset clears an overlaid discovery cache before catalog convergence", async () => {
    const liveConfig = config({ "model-a": "Operator Name" });
    setCached(DISPLAY_PROVIDER, [{
      provider: DISPLAY_PROVIDER,
      id: "model-a",
      displayName: "Operator Name",
    }]);
    let cacheWasClearAtConvergence = false;

    const result = await call(liveConfig, { modelId: "model-a", displayName: null }, {
      converge: async () => {
        cacheWasClearAtConvergence = getFreshCached(DISPLAY_PROVIDER, 60_000) === null;
        return catalogRefresh;
      },
    });

    expect(result.response?.status).toBe(200);
    expect(cacheWasClearAtConvergence).toBe(true);
  });

  test("reset omits an empty map", async () => {
    const liveConfig = config({ "model-a": "Alpha" });

    const result = await call(liveConfig, { modelId: "model-a", displayName: null });

    expect(result.response?.status).toBe(200);
    expect(liveConfig.providers[DISPLAY_PROVIDER].modelDisplayNames).toBeUndefined();
  });

  test("rejects unknown providers and malformed updates without side effects", async () => {
    const cases: Array<{ body: unknown; rawBody?: string }> = [
      { body: {}, rawBody: "{" },
      { body: {} },
      { body: { modelId: "", displayName: "Name" } },
      { body: { modelId: "", displayName: null } },
      { body: { modelId: "model-a", displayName: "   " } },
      { body: { modelId: "model-a", displayName: "Bad/Name" } },
      { body: { modelId: "model-a", displayName: "Bad\nName" } },
      { body: { modelId: "model-a", displayName: "A".repeat(129) } },
      { body: { modelId: "model-a", displayName: 7 } },
    ];
    for (const item of cases) {
      const liveConfig = config();
      const result = await call(liveConfig, item.body, { rawBody: item.rawBody });
      expect(result.response?.status).toBe(400);
      expect(result.persisted).toHaveLength(0);
      expect(result.convergeCalls).toBe(0);
      expect(liveConfig.providers[DISPLAY_PROVIDER].modelDisplayNames).toBeUndefined();
    }

    const unknown = await call(config(), { modelId: "model-a", displayName: "Name" }, { provider: "missing" });
    expect(unknown.response?.status).toBe(404);
    expect(unknown.persisted).toHaveLength(0);
    expect(unknown.convergeCalls).toBe(0);
  });

  test("a persistence failure restores the exact in memory map and never converges", async () => {
    const liveConfig = config({ "model-b": "Beta" });
    let convergeCalls = 0;

    await expect(handleModelRoutes({
      req: new Request(`http://127.0.0.1:10100/api/providers/${DISPLAY_PROVIDER}/model-display-names`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: "model-a", displayName: "Alpha" }),
      }),
      url: new URL(`http://127.0.0.1:10100/api/providers/${DISPLAY_PROVIDER}/model-display-names`),
      config: liveConfig,
      deps: { saveConfigPreservingClaudeCode: () => { throw new Error("disk full"); } },
      convergeCodexCatalog: async () => {
        convergeCalls += 1;
        return catalogRefresh;
      },
      syncClaudeAgentDefsBestEffort: async () => {},
    })).rejects.toThrow("disk full");

    expect(liveConfig.providers[DISPLAY_PROVIDER].modelDisplayNames).toEqual({ "model-b": "Beta" });
    expect(convergeCalls).toBe(0);
  });

  test("a convergence failure keeps the successfully persisted label", async () => {
    const liveConfig = config();
    let persisted: OcxConfig | undefined;

    await expect(call(liveConfig, { modelId: "model-a", displayName: "Alpha" }, {
      persist: saved => { persisted = structuredClone(saved); },
      converge: async () => { throw new Error("catalog busy"); },
    })).rejects.toThrow("catalog busy");

    expect(persisted?.providers[DISPLAY_PROVIDER].modelDisplayNames).toEqual({ "model-a": "Alpha" });
    expect(liveConfig.providers[DISPLAY_PROVIDER].modelDisplayNames).toEqual({ "model-a": "Alpha" });
  });

  test("a failed catalog result reports that the saved label still needs refresh", async () => {
    const liveConfig = config();
    const failedRefresh: CatalogDisposition = {
      status: "failed",
      reason: "disk",
      phase: "commit",
      retryable: true,
      partialWrite: false,
      cause: { kind: "io", code: "ENOSPC" },
    };

    const result = await call(liveConfig, { modelId: "model-a", displayName: "Alpha" }, {
      converge: async () => failedRefresh,
    });
    const payload = await result.response!.json() as Record<string, unknown>;

    expect(result.response?.status).toBe(503);
    expect(result.persisted).toHaveLength(1);
    expect(liveConfig.providers[DISPLAY_PROVIDER].modelDisplayNames).toEqual({ "model-a": "Alpha" });
    expect(payload).toEqual({
      error: "model display name saved but catalog refresh failed",
      saved: true,
      provider: DISPLAY_PROVIDER,
      modelId: "model-a",
      displayNameOverride: "Alpha",
      catalogRefresh: failedRefresh,
    });
  });

  test("sequential updates preserve neighboring labels and prototype shaped model ids", async () => {
    const liveConfig = config({ "model-b": "Beta" });

    await call(liveConfig, { modelId: "model-a", displayName: "Alpha" });
    await call(liveConfig, { modelId: "__proto__", displayName: "Prototype Model" });

    expect(Object.entries(liveConfig.providers[DISPLAY_PROVIDER].modelDisplayNames ?? {})).toEqual([
      ["model-b", "Beta"],
      ["model-a", "Alpha"],
      ["__proto__", "Prototype Model"],
    ]);
  });
});
