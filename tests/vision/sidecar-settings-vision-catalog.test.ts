import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { clearGatherRoutedModelsInflight, resetCatalogRuntimeStateForTests } from "../../src/codex/catalog";
import { setBundledCatalogCacheForTests } from "../../src/codex/catalog/bundled";
import type { CatalogDisposition } from "../../src/codex/convergence-types";
import { projectCatalogOnlyOutcome } from "../../src/codex/management-convergence";
import { clearModelCache } from "../../src/codex/model-cache";
import { resetCodexModelEntitlementCacheForTests } from "../../src/codex/model-entitlements";
import { resetCodexRuntimeResolveCacheForTests, setCodexRuntimeResolveCacheForTests } from "../../src/codex/runtime";
import { resetSiblingStartForTests } from "../../src/codex/sibling-start";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementApiDeps } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest } from "../helpers/management-auth";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome;
let previousCli: string | undefined;
const originalFetch = globalThis.fetch;
const native = { slug: "gpt-5.5", display_name: "Native", priority: 1, visibility: "list",
  base_instructions: "You are Codex.", supported_reasoning_levels: [{ effort: "medium", description: "Medium" }] };

/** A static text-only route needs no live credential or provider discovery. */
function fixture(enabled?: boolean): OcxConfig {
  return { port: 10100, defaultProvider: "vision-settings-fixture", providers: {
    "vision-settings-fixture": { adapter: "openai-chat", baseUrl: "https://vision-settings.example/v1",
      apiKey: "fixture-key", authMode: "key", liveModels: false, models: ["planner"],
      modelInputModalities: { planner: ["text"] }, modelContextWindows: { planner: 200_000 } },
  }, ...(enabled === undefined ? {} : { visionSidecar: { enabled } }) };
}

/** Exercise the authenticated management dispatcher and its catalog-only callback. */
async function put(config: OcxConfig, body: unknown, deps: ManagementApiDeps = {}): Promise<Response> {
  const url = new URL("http://localhost/api/sidecar-settings");
  const response = await handleManagementAPI(new ManagementRequest(url, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), url, config, deps);
  if (!response) throw new Error("Sidecar settings route was not handled.");
  return response;
}

beforeEach(() => {
  home = createTempHome("ocx-vision-settings-catalog-");
  mkdirSync(home.codexHome);
  previousCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = home.path("must-not-execute");
  globalThis.fetch = (async () => { throw new Error("Unexpected upstream request."); }) as typeof fetch;
  resetSiblingStartForTests();
  clearModelCache(); clearGatherRoutedModelsInflight(); resetCatalogRuntimeStateForTests();
  resetCodexModelEntitlementCacheForTests(); resetCodexRuntimeResolveCacheForTests();
  const runtime = { command: process.env.CODEX_CLI_PATH, version: "0.145.0", source: "fallback" as const };
  setCodexRuntimeResolveCacheForTests({ runtime, failures: [] }, { discoverAlternatives: false });
  setBundledCatalogCacheForTests(runtime, { models: [native] });
  writeFileSync(join(home.codexHome, "config.toml"), 'model_catalog_json = "opencodex-catalog.json"\n');
  writeFileSync(join(home.codexHome, "opencodex-catalog.json"), JSON.stringify({ models: [native] }));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache(); clearGatherRoutedModelsInflight(); resetCatalogRuntimeStateForTests();
  resetCodexModelEntitlementCacheForTests(); resetCodexRuntimeResolveCacheForTests(); resetSiblingStartForTests();
  if (previousCli === undefined) delete process.env.CODEX_CLI_PATH;
  else process.env.CODEX_CLI_PATH = previousCli;
  home.remove();
});

test.each([[undefined, false], [true, false], [false, true]] as const)("an effective Vision change converges only after persistence: %j -> %j", async (before, enabled) => {
  const config = fixture(before);
  saveConfig(config);
  let calls = 0;
  const response = await put(config, { vision: { enabled } }, {
    createManagementConvergeCodex: captured => async request => {
      calls++;
      expect(captured).toBe(config);
      expect(request).toMatchObject({ scope: "catalog", reason: "management-mutation", deadlineMs: 1_000 });
      const saved = JSON.parse(readFileSync(home.path("config.json"), "utf8")) as OcxConfig;
      expect(saved.visionSidecar?.enabled !== false).toBe(enabled);
      return projectCatalogOnlyOutcome({ changed: true,
        catalogRefresh: { status: "committed", changed: true, degraded: false, notices: [] } });
    },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ vision: { enabled }, catalogRefreshPending: false });
  expect(calls).toBe(1);
});

test.each([[undefined, true], [true, true], [false, false]] as const)("the same effective Vision setting does not converge: %j -> %j", async (before, enabled) => {
  const response = await put(fixture(before), { vision: { enabled } }, {
    createManagementConvergeCodex: () => { throw new Error("Unchanged setting must not converge."); },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ catalogRefreshPending: false });
});

test("partial and invalid writes do not refresh the catalog", async () => {
  const config = fixture(false);
  let calls = 0;
  const deps: ManagementApiDeps = { createManagementConvergeCodex: () => {
    calls++; throw new Error("Unrelated writes must not converge.");
  } };
  for (const body of [{ vision: { timeoutMs: 12_000 } }, { webSearch: { streamRoutedModelOutput: true } }]) {
    expect((await put(config, body, deps)).status).toBe(200);
  }
  expect((await put(config, { vision: { enabled: "false" } }, deps)).status).toBe(400);
  expect(calls).toBe(0);
});

test.each([
  { status: "skipped", reason: "busy", retryable: true },
  { status: "skipped", reason: "catalog-unavailable", retryable: false },
  { status: "failed", reason: "disk", phase: "commit", retryable: false, partialWrite: false },
] satisfies CatalogDisposition[])("an incomplete catalog refresh is reported without undoing the saved switch: %j", async disposition => {
  const response = await put(fixture(), { vision: { enabled: false } }, {
    createManagementConvergeCodex: () => async () => projectCatalogOnlyOutcome({ changed: false, catalogRefresh: disposition }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ vision: { enabled: false }, catalogRefreshPending: true });
  expect(JSON.parse(readFileSync(home.path("config.json"), "utf8")).visionSidecar.enabled).toBe(false);
});

test("a live settings toggle publishes new modalities to both managed catalog and Codex cache", async () => {
  const config = fixture();
  saveConfig(config);
  const paths = ["opencodex-catalog.json", "models_cache.json"].map(name => join(home.codexHome, name));
  const stale = { models: [native, { slug: "vision-settings-fixture/planner", input_modalities: ["text", "image"] }] };
  for (const path of paths) writeFileSync(path, JSON.stringify(stale));
  for (const enabled of [false, true]) {
    const response = await put(config, { vision: { enabled } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ catalogRefreshPending: false });
    for (const path of paths) {
      const rows = JSON.parse(readFileSync(path, "utf8")).models as Array<{ slug: string; input_modalities?: string[] }>;
      expect(rows.find(row => row.slug === "vision-settings-fixture/planner")?.input_modalities)
        .toEqual(enabled ? ["text", "image"] : ["text"]);
    }
  }
});
