import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as store from "../../src/oauth/store";
import * as modelRows from "../../src/server/management/model-rows";
import * as managementShared from "../../src/server/management/shared";
import { saveConfig } from "../../src/config";
import { anthropicOAuthInstanceConfigError, anthropicSidecarPatchError } from "../../src/config/schema/anthropic-account-pool";
import { handleManagementAPI } from "../../src/server/management-api";
import { sidecarAnthropicPoolOptions, sidecarOptionsAuth } from "../../src/server/management/web-search-sidecar-options";
import type { OcxConfig } from "../../src/types";
import type { ProviderAccountSet } from "../../src/oauth/types";
import { anthropicInstanceConfig, instanceFixtureCredential } from "../helpers/anthropic-instance-fixture";
import { ManagementRequest } from "../helpers/management-auth";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome;
let accounts: Partial<Record<string, ProviderAccountSet>>;
let accountSpy: ReturnType<typeof spyOn<typeof store, "getAccountSet">>;
let rowsSpy: ReturnType<typeof spyOn<typeof modelRows, "listManagementModelRows">>;
let catalogSpy: ReturnType<typeof spyOn<typeof managementShared, "fetchInitializedModels">>;
let allModelsSpy: ReturnType<typeof spyOn<typeof managementShared, "fetchAllModels">>;
beforeEach(() => {
  home = createTempHome("ocx-helper-instance-settings-");
  accounts = {};
  accountSpy = spyOn(store, "getAccountSet").mockImplementation(provider => accounts[provider] ?? null);
  rowsSpy = spyOn(modelRows, "listManagementModelRows").mockResolvedValue([]);
  catalogSpy = spyOn(managementShared, "fetchInitializedModels").mockResolvedValue([]);
  allModelsSpy = spyOn(managementShared, "fetchAllModels").mockResolvedValue([]);
});
afterEach(() => {
  accountSpy.mockRestore();
  rowsSpy.mockRestore();
  catalogSpy.mockRestore();
  allModelsSpy.mockRestore();
  home.remove();
});

function login(instance: "anthropic" | "anthropic2") {
  accounts[instance] = { activeAccountId: "same-id", accounts: [
    { id: "same-id", credential: instanceFixtureCredential(instance, 1) },
  ] };
}
async function request(config: OcxConfig, path: string, body?: unknown) {
  const url = new URL(`http://localhost${path}`);
  const req = new ManagementRequest(url, body === undefined ? undefined : {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const response = await handleManagementAPI(req, url, config, { claudeAgentConfigDir: home.path("claude-agents") });
  if (!response) throw new Error("settings route did not handle request");
  return response;
}
function persisted(): OcxConfig {
  return JSON.parse(readFileSync(home.path("config.json"), "utf8")) as OcxConfig;
}

for (const instance of ["anthropic", "anthropic2"] as const) {
  test(`global web-search and vision round-trip ${instance}; omission preserves and null deletes`, async () => {
    const config = anthropicInstanceConfig();
    const pair = { backend: "anthropic", model: "claude-haiku-4-5", anthropicInstance: instance };
    const put = await request(config, "/api/sidecar-settings", { webSearch: pair, vision: pair });
    expect(put.status).toBe(200);
    const body = await put.json() as { webSearch: Record<string, unknown>; vision: Record<string, unknown> };
    expect(body.webSearch.anthropicInstance).toBe(instance);
    expect(body.vision.anthropicInstance).toBe(instance);
    expect(persisted().webSearchSidecar?.anthropicInstance).toBe(instance);
    expect(persisted().visionSidecar?.anthropicInstance).toBe(instance);
    expect((await request(config, "/api/sidecar-settings", { webSearch: { streamRoutedModelOutput: true }, vision: { timeoutMs: 20_000 } })).status).toBe(200);
    expect(config.webSearchSidecar?.anthropicInstance).toBe(instance);
    expect(config.visionSidecar?.anthropicInstance).toBe(instance);
    expect((await request(config, "/api/sidecar-settings", { webSearch: { anthropicInstance: null }, vision: { anthropicInstance: null } })).status).toBe(200);
    const get = await (await request(config, "/api/sidecar-settings")).json() as typeof body;
    expect(Object.hasOwn(get.webSearch, "anthropicInstance")).toBe(false);
    expect(Object.hasOwn(get.vision, "anthropicInstance")).toBe(false);
    expect(Object.hasOwn(persisted().webSearchSidecar!, "anthropicInstance")).toBe(false);
    expect(Object.hasOwn(persisted().visionSidecar!, "anthropicInstance")).toBe(false);
  });
}

test("Claude overrides round-trip independently of global pool; clearing never writes A", async () => {
  const config = anthropicInstanceConfig();
  config.webSearchSidecar = { backend: "anthropic", model: "claude-haiku-4-5", anthropicInstance: "anthropic" };
  config.visionSidecar = { backend: "anthropic", model: "claude-haiku-4-5" };
  saveConfig(config);
  const body = { webSearchSidecar: { anthropicInstance: "anthropic2" }, visionSidecar: { anthropicInstance: "anthropic2" } };
  expect((await request(config, "/api/claude-code", body)).status).toBe(200);
  const get = await (await request(config, "/api/claude-code")).json() as Record<string, { anthropicInstance?: string }>;
  expect(get.webSearchSidecar.anthropicInstance).toBe("anthropic2");
  expect(get.visionSidecar.anthropicInstance).toBe("anthropic2");
  expect((await request(config, "/api/claude-code", { webSearchSidecar: { anthropicInstance: null }, visionSidecar: null })).status).toBe(200);
  expect(persisted().claudeCode?.webSearchSidecar).toBeUndefined();
  expect(persisted().claudeCode?.visionSidecar).toBeUndefined();
  expect(persisted().webSearchSidecar?.anthropicInstance).toBe("anthropic");
});

// Each value is wrapped: test.each spreads an array row into arguments, so a bare [] would run as undefined.
test.each([["bogus"], [1], [false], [{}], [[]]] as const)("invalid explicit pool %j is refused without mutation", async (value: unknown) => {
  const config = anthropicInstanceConfig();
  saveConfig(config);
  const before = readFileSync(home.path("config.json"), "utf8");
  expect((await request(config, "/api/sidecar-settings", { webSearch: { backend: "anthropic", anthropicInstance: value }, vision: { enabled: false } })).status).toBe(400);
  expect(config.webSearchSidecar).toBeUndefined();
  expect(config.visionSidecar).toBeUndefined();
  expect(readFileSync(home.path("config.json"), "utf8")).toBe(before);
  expect((await request(config, "/api/claude-code", { visionSidecar: { backend: "anthropic", anthropicInstance: value } })).status).toBe(400);
  expect(config.claudeCode?.visionSidecar).toBeUndefined();
});

test("effective preserved backend and model are validated before any field is mutated", async () => {
  const config = anthropicInstanceConfig();
  config.webSearchSidecar = { backend: "anthropic", model: "claude-haiku-4-5", anthropicInstance: "anthropic2" };
  config.visionSidecar = { backend: "anthropic", model: "claude-haiku-4-5", anthropicInstance: "anthropic2" };
  const before = structuredClone(config);
  expect((await request(config, "/api/sidecar-settings", { webSearch: { backend: "openai" }, vision: { enabled: false } })).status).toBe(400);
  expect(config).toEqual(before);
  expect(anthropicSidecarPatchError(config, { visionSidecar: { model: "anthropic/claude-sonnet-4-6" } })).toContain("conflicts");
  expect(anthropicSidecarPatchError(config, { webSearchSidecar: { backend: "openai", model: "gpt-5.6-luna", anthropicInstance: null } })).toBeUndefined();
  expect((await request(config, "/api/sidecar-settings", {
    webSearch: { backend: "openai", model: "gpt-5.6-luna", anthropicInstance: null },
    vision: { backend: "openai", model: "gpt-5.6-luna", anthropicInstance: null },
  })).status).toBe(200);
  expect(Object.hasOwn(persisted().webSearchSidecar!, "anthropicInstance")).toBe(false);
  expect(Object.hasOwn(persisted().visionSidecar!, "anthropicInstance")).toBe(false);
});

test("Claude overrides check an inherited global pool only while the merged backend stays Anthropic", () => {
  const config = anthropicInstanceConfig();
  config.webSearchSidecar = { backend: "anthropic", model: "claude-haiku-4-5", anthropicInstance: "anthropic2" };
  config.visionSidecar = { backend: "anthropic", model: "claude-haiku-4-5", anthropicInstance: "anthropic2" };
  // The inherited pool is inert once the override leaves Anthropic, exactly as in buildClaudeReplayConfig.
  expect(anthropicSidecarPatchError(config, { webSearchSidecar: { backend: "openai" }, visionSidecar: { backend: "openai" } }, true)).toBeUndefined();
  expect(anthropicSidecarPatchError(config, { visionSidecar: { backend: "routed", model: "anthropic/claude-sonnet-4-6" } }, true)).toBeUndefined();
  // A pool the override sets itself is still validated against its effective backend.
  expect(anthropicSidecarPatchError(config, { webSearchSidecar: { backend: "openai", anthropicInstance: "anthropic" } }, true)).toContain("requires an anthropic backend");
  // While the merged backend stays Anthropic, the inherited pool still conflicts with a model naming the other pool.
  expect(anthropicSidecarPatchError(config, { visionSidecar: { model: "anthropic/claude-sonnet-4-6" } }, true)).toContain("conflicts");
  // Vice versa: a global OpenAI block accepts an override that selects Anthropic and a pool.
  const openai = anthropicInstanceConfig();
  openai.webSearchSidecar = { backend: "openai", model: "gpt-5.6-luna" };
  expect(anthropicSidecarPatchError(openai, { webSearchSidecar: { backend: "anthropic", model: "claude-haiku-4-5", anthropicInstance: "anthropic2" } }, true)).toBeUndefined();
});

test("untouched settings reads and unrelated saves retain instance absence and non-Anthropic defaults", async () => {
  const config = anthropicInstanceConfig();
  const get = await (await request(config, "/api/sidecar-settings")).json() as {
    webSearch: Record<string, unknown>; vision: Record<string, unknown>;
  };
  expect(get.webSearch.model).toBe("gpt-5.6-luna");
  expect(get.vision.model).toBe("gpt-5.6-luna");
  expect(Object.hasOwn(get.webSearch, "anthropicInstance")).toBe(false);
  expect(Object.hasOwn(get.vision, "anthropicInstance")).toBe(false);
  expect((await request(config, "/api/sidecar-settings", { webSearch: { streamRoutedModelOutput: true } })).status).toBe(200);
  expect(Object.hasOwn(persisted().webSearchSidecar!, "anthropicInstance")).toBe(false);
});

test("options resolve B exactly, report mixed only with known parent, and refuse unavailable B", () => {
  const config = anthropicInstanceConfig();
  login("anthropic"); login("anthropic2");
  expect(sidecarAnthropicPoolOptions(config, { backend: "anthropic", anthropicInstance: "anthropic2" }, "anthropic"))
    .toMatchObject({ selected: "anthropic2", resolved: "anthropic2", mixed: true, available: ["anthropic", "anthropic2"] });
  expect(sidecarAnthropicPoolOptions(config, { backend: "anthropic", anthropicInstance: "anthropic2" }).mixed).toBe(false);
  expect(sidecarAnthropicPoolOptions(config, { backend: "anthropic" }, "anthropic2"))
    .toMatchObject({ resolved: "anthropic2", mixed: false });
  expect(sidecarAnthropicPoolOptions(config, { backend: "anthropic" }))
    .toMatchObject({ resolved: "anthropic", mixed: false });
  delete accounts.anthropic2;
  const unavailable = sidecarAnthropicPoolOptions(config, { backend: "anthropic", anthropicInstance: "anthropic2" }, "anthropic");
  expect(unavailable).toMatchObject({ selected: "anthropic2", code: "anthropic_helper_unavailable", available: ["anthropic"] });
  expect(Object.hasOwn(unavailable, "resolved")).toBe(false);
  expect(sidecarOptionsAuth(config, "anthropic2")).toEqual({ isCodexAuth: false, isAnthropicAuth: false });
  expect(sidecarAnthropicPoolOptions(config, { backend: "anthropic" }, "anthropic2").code).toBe("anthropic_helper_unavailable");
});

test("Claude vision options resolve the pool inherited from the Claude model, as the runtime planner does", async () => {
  // Only Pool 2 is usable; no explicit helper pool or backend is configured.
  const config = anthropicInstanceConfig(); login("anthropic2");
  config.claudeCode = { model: "anthropic2/claude-haiku-4-5" };
  const body = await (await request(config, "/api/claude-code")).json() as {
    sidecarPools: { visionSidecar: Record<string, unknown> };
  };
  expect(body.sidecarPools.visionSidecar).toMatchObject({ backend: "anthropic", parent: "anthropic2", resolved: "anthropic2", mixed: false });
  expect(Object.hasOwn(body.sidecarPools.visionSidecar, "code")).toBe(false);
});

test("changing explicit pool validates candidates from the submitted pool, never the old pool", async () => {
  const config = anthropicInstanceConfig(); login("anthropic"); login("anthropic2");
  config.webSearchSidecar = { backend: "anthropic", model: "claude-sonnet-4-6", anthropicInstance: "anthropic" };
  rowsSpy.mockResolvedValue([{ provider: "anthropic2", id: "claude-sonnet-4-6", namespaced: "anthropic2/claude-sonnet-4-6", disabled: false }]);
  expect((await request(config, "/api/sidecar-settings", { webSearch: { anthropicInstance: "anthropic2" } })).status).toBe(200);
  expect(config.webSearchSidecar.anthropicInstance).toBe("anthropic2");
  expect((await request(config, "/api/sidecar-settings", { webSearch: { anthropicInstance: "anthropic" } })).status).toBe(400);
  expect(config.webSearchSidecar.anthropicInstance).toBe("anthropic2");
});

test("unavailable explicit B remains a configurable slot and GET reports refusal without falling back to A", async () => {
  const config = anthropicInstanceConfig(); login("anthropic");
  expect((await request(config, "/api/sidecar-settings", { webSearch: {
    backend: "anthropic", model: "claude-haiku-4-5", anthropicInstance: "anthropic2",
  } })).status).toBe(200);
  const body = await (await request(config, "/api/sidecar-settings")).json() as {
    webSearch: { anthropicInstance: string; anthropicPool: Record<string, unknown> };
    webSearchModels: Array<{ backend: string }>;
  };
  expect(body.webSearch.anthropicInstance).toBe("anthropic2");
  expect(body.webSearch.anthropicPool).toMatchObject({ selected: "anthropic2", code: "anthropic_helper_unavailable", available: ["anthropic"] });
  expect(Object.hasOwn(body.webSearch.anthropicPool, "resolved")).toBe(false);
  // The persisted slot may be displayed, but no live A executor candidate may leak through.
  expect(body.webSearchModels).toHaveLength(1);
});

test("marker accessor is rejected by descriptor traversal without invoking the getter", () => {
  let reads = 0;
  const config = anthropicInstanceConfig();
  Object.defineProperty(config.providers.anthropic2, "anthropicOAuthInstance", { enumerable: true, get() { reads++; throw new Error("accessor ran"); } });
  expect(anthropicOAuthInstanceConfigError(config)).toContain("own data property");
  expect(reads).toBe(0);
});
