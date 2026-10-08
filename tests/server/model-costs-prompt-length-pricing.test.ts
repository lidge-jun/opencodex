import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, loadConfig, saveConfig, saveConfigPreservingClaudeCode, armClaudeCodeBaseline,
  providerModelCostsConfigError, validateConfigCandidate } from "../../src/config";
import { sanitizeModelCostsForDisplay } from "../../src/config/schema/leaf-validators";
import { ConfigWritePublishedError } from "../../src/config/persist-unlocked";
import { withModelCostRowReplacement } from "../../src/config/live-reconcile";
import { handleModelRoutes } from "../../src/server/management/model-routes";
import { handleModelsRuntimeCommand } from "../../src/cli/models-runtime";
import { activeUserCostOverlays, refreshUserCostOverlays, userCostOverlayVersion } from "../../src/usage/user-cost-overlays";
import { reconcileUserCostOverlaysFromDisk, resetUserCostOverlayReconcilerForTests, startUserCostOverlayReconciler } from "../../src/usage/user-cost-overlay-reconciler";
import type { OcxConfig, PromptLengthPricing } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const BASE = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 };
const POLICY: PromptLengthPricing = { mode: "custom", thresholdTokens: 100, comparison: "gte",
  rates: { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0 } };
const MODEL = "org/model--fast";
let home: string;
let previousHome: string | undefined;
let config: OcxConfig;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-prompt-pricing-"));
  process.env.OPENCODEX_HOME = home;
  config = { port: 10100, defaultProvider: "acme", providers: { acme: {
    adapter: "openai-chat", baseUrl: "https://example.invalid/v1", liveModels: false, models: [MODEL],
  } } };
  saveConfig(config);
});

afterEach(() => {
  resetUserCostOverlayReconcilerForTests();
  refreshUserCostOverlays({ providers: {} } as OcxConfig);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

async function call(method: "GET" | "PUT", cost?: unknown, persist = saveConfigPreservingClaudeCode) {
  const url = new URL("http://127.0.0.1:10100/api/providers/acme/model-costs");
  const response = await handleModelRoutes({ version: "test", config, url,
    req: new Request(url, { method, headers: { "Content-Type": "application/json" },
      ...(method === "PUT" ? { body: JSON.stringify({ modelId: MODEL, cost }) } : {}) }),
    deps: { saveConfigPreservingClaudeCode: persist },
    convergeCodexCatalog: async () => { throw new Error("unexpected catalog convergence"); },
    syncClaudeAgentDefsBestEffort: async () => {},
  });
  if (!response) throw new Error("pricing route missing");
  return response;
}

test("policy API receipts survive reopening; legacy replacement and null reset the whole row", async () => {
  for (const promptLengthPricing of [{ mode: "automatic" }, { mode: "flat" }, POLICY]) {
    const cost = { ...BASE, promptLengthPricing };
    const expected = promptLengthPricing.mode === "automatic" ? BASE : cost;
    const response = await call("PUT", cost);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, provider: "acme", modelId: MODEL, cost: expected });
    config = loadConfig();
    expect((await (await call("GET")).json()).modelCosts[MODEL]).toEqual(expected);
    expect(config.providers.acme!.modelCosts![MODEL]).toEqual(expected);
    expect(activeUserCostOverlays()[0]?.promptLengthPricing).toEqual(promptLengthPricing.mode === "automatic" ? undefined : promptLengthPricing);
  }
  await call("PUT", BASE);
  config = loadConfig();
  expect(config.providers.acme!.modelCosts![MODEL]).toEqual(BASE);
  await call("PUT", { ...BASE, promptLengthPricing: POLICY });
  const response = await call("PUT", null);
  expect((await response.json()).cost).toBeNull();
  config = loadConfig();
  expect((await (await call("GET")).json()).modelCosts).toEqual({});
  expect(activeUserCostOverlays()).toEqual([]);
});

test("hand-edited automatic validates, disappears from GET and overlays, and does not churn caches", async () => {
  await call("PUT", BASE);
  const version = userCostOverlayVersion();
  const disk = JSON.parse(readFileSync(getConfigPath(), "utf8"));
  disk.providers.acme.modelCosts[MODEL].promptLengthPricing = { mode: "automatic" };
  expect(providerModelCostsConfigError(disk.providers.acme.modelCosts)).toBeNull();
  writeFileSync(getConfigPath(), JSON.stringify(disk));
  config = loadConfig();
  expect((await (await call("GET")).json()).modelCosts[MODEL]).toEqual(BASE);
  expect(activeUserCostOverlays()[0]?.promptLengthPricing).toBeUndefined();
  expect(Object.hasOwn(activeUserCostOverlays()[0]!, "promptLengthPricing")).toBe(false);
  expect(userCostOverlayVersion()).toBe(version);
  expect(sanitizeModelCostsForDisplay(config.providers.acme!.modelCosts)?.[MODEL]).toEqual(BASE);
});

test("live-reconcile explicit automatic row replacement clears an external custom policy", () => {
  config.providers.acme!.modelCosts = { [MODEL]: BASE };
  saveConfig(config);
  armClaudeCodeBaseline(config);
  const disk = loadConfig();
  disk.providers.acme!.modelCosts = { [MODEL]: { ...BASE, promptLengthPricing: POLICY },
    sibling: { ...BASE, promptLengthPricing: POLICY } };
  saveConfig(disk);
  const automatic = { ...BASE, promptLengthPricing: { mode: "automatic" as const } };
  config.providers.acme!.modelCosts![MODEL] = automatic;
  withModelCostRowReplacement(config, "acme", MODEL, automatic, () => saveConfigPreservingClaudeCode(config));
  expect(config.providers.acme!.modelCosts![MODEL]).toEqual(BASE);
  expect(JSON.parse(readFileSync(getConfigPath(), "utf8")).providers.acme.modelCosts).toEqual({
    [MODEL]: BASE, sibling: { ...BASE, promptLengthPricing: POLICY },
  });
  expect(activeUserCostOverlays().find(row => row.modelId === MODEL)?.promptLengthPricing).toBeUndefined();
});

test("custom boundaries persist safe integers, both comparisons, zero and maximum rates", async () => {
  for (const thresholdTokens of [1, Number.MAX_SAFE_INTEGER]) {
    for (const comparison of ["gt", "gte"]) {
      const promptLengthPricing = { mode: "custom", thresholdTokens, comparison,
        rates: { input: 0, output: 1e6, cacheRead: 0, cacheWrite: 1e6 } };
      expect(providerModelCostsConfigError({ m: { ...BASE, promptLengthPricing } })).toBeNull();
      const cost = { ...BASE, promptLengthPricing };
      expect((await call("PUT", cost)).status).toBe(200);
      config = loadConfig();
      expect((await (await call("GET")).json()).modelCosts[MODEL]).toEqual(cost);
    }
  }
});

test("invalid policies fail writes without mutation or secret echo", async () => {
  await call("PUT", { ...BASE, promptLengthPricing: POLICY });
  const before = readFileSync(getConfigPath(), "utf8");
  const invalid: unknown[] = [null, [], "flat", {}, { mode: "unknown" },
    { mode: "flat", apiKey: "private-policy-value" }, { mode: "automatic", rates: BASE },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "100"].map(thresholdTokens => ({ ...POLICY, thresholdTokens })),
    { ...POLICY, comparison: "ge" }, { mode: "custom", thresholdTokens: 100, comparison: "gt" },
    { ...POLICY, rates: { input: 1, output: 2, cacheRead: 0 } },
    { ...POLICY, rates: { ...BASE, apiKey: "private-policy-value" } },
    ...[-1, 1e6 + 1, "2", null].map(input => ({ ...POLICY, rates: { ...BASE, input } })),
  ];
  for (const promptLengthPricing of invalid) {
    const candidate = { ...config, providers: { acme: { ...config.providers.acme,
      modelCosts: { [MODEL]: { ...BASE, promptLengthPricing } },
    } } };
    expect(validateConfigCandidate(candidate).ok).toBe(false);
    const response = await call("PUT", { ...BASE, promptLengthPricing });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private-policy-value");
    expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
  }
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    for (const invalidRate of [-1, 1e6 + 1, Infinity, NaN, "2", null]) {
      expect(providerModelCostsConfigError({ m: { ...BASE, promptLengthPricing: {
        ...POLICY, rates: { ...BASE, [key]: invalidRate },
      } } })).not.toBeNull();
    }
  }
});

test("display copies complete policies and discards invalid nested content", () => {
  const source = { m: { ...BASE, promptLengthPricing: structuredClone(POLICY), apiKey: "private-policy-value" } };
  const output = sanitizeModelCostsForDisplay(source)!;
  expect(output.m).toEqual({ ...BASE, promptLengthPricing: POLICY });
  expect(output.m!.promptLengthPricing).not.toBe(source.m.promptLengthPricing);
  if (source.m.promptLengthPricing.mode === "custom") source.m.promptLengthPricing.rates.input = 99;
  expect(output.m!.promptLengthPricing).toEqual(POLICY);
  expect(sanitizeModelCostsForDisplay({ m: { ...BASE, promptLengthPricing: { mode: "flat", secret: "value" } } })).toBeUndefined();
});

test("policy-only external edits invalidate once and survive unrelated live saves; malformed rows degrade", () => {
  config.providers.acme!.modelCosts = { [MODEL]: { ...BASE, promptLengthPricing: POLICY } };
  saveConfig(config);
  config = loadConfig();
  const version = userCostOverlayVersion();
  const disk = JSON.parse(readFileSync(getConfigPath(), "utf8"));
  disk.providers.acme.modelCosts[MODEL].promptLengthPricing = { ...POLICY, comparison: "gt" };
  disk.providers.acme.modelCosts.sibling = { ...BASE, promptLengthPricing: { mode: "flat" } };
  writeFileSync(getConfigPath(), JSON.stringify(disk));
  expect(reconcileUserCostOverlaysFromDisk(config)).toBe(true);
  expect(userCostOverlayVersion()).toBe(version + 1);
  expect(activeUserCostOverlays().find(row => row.modelId === MODEL)?.promptLengthPricing).toEqual({ ...POLICY, comparison: "gt" });
  reconcileUserCostOverlaysFromDisk(config);
  expect(userCostOverlayVersion()).toBe(version + 1);
  config.port = 10101;
  saveConfig(config);
  expect(userCostOverlayVersion()).toBe(version + 1);
  expect(loadConfig().providers.acme!.modelCosts!.sibling?.promptLengthPricing).toEqual({ mode: "flat" });
  disk.providers.acme.modelCosts[MODEL].promptLengthPricing.rates = { input: 2 };
  writeFileSync(getConfigPath(), JSON.stringify(disk));
  const degraded = loadConfig();
  expect(degraded.providers.acme!.baseUrl).toBe("https://example.invalid/v1");
  expect(degraded.providers.acme!.modelCosts![MODEL]).toBeUndefined();
  expect(degraded.providers.acme!.modelCosts!.sibling?.promptLengthPricing).toEqual({ mode: "flat" });
});

test("failed policy persistence rolls back the live row and leaves registry version stable", async () => {
  await call("PUT", BASE);
  const version = userCostOverlayVersion();
  await expect(call("PUT", { ...BASE, promptLengthPricing: POLICY }, () => { throw new Error("write failed"); })).rejects.toThrow("write failed");
  expect(config.providers.acme!.modelCosts![MODEL]).toEqual(BASE);
  expect(userCostOverlayVersion()).toBe(version);
});

test("post-publication errors retain committed pricing for recovery GET and subsequent saves", async () => {
  await call("PUT", BASE);
  armClaudeCodeBaseline(config);
  for (const cost of [{ ...BASE, promptLengthPricing: { mode: "flat" as const } }, null]) {
    await expect(call("PUT", cost, candidate => {
      saveConfigPreservingClaudeCode(candidate);
      throw new ConfigWritePublishedError(new Error("bookkeeping failed"));
    })).rejects.toBeInstanceOf(ConfigWritePublishedError);
    const expected = cost === null ? {} : { [MODEL]: cost };
    expect((await (await call("GET")).json()).modelCosts).toEqual(expected);
    expect(config.providers.acme!.modelCosts).toEqual(expected);
    config.modelCacheTtlMs = (config.modelCacheTtlMs ?? 60_000) + 1;
    saveConfigPreservingClaudeCode(config);
    expect(loadConfig().providers.acme!.modelCosts ?? {}).toEqual(expected);
    expect(activeUserCostOverlays().find(row => row.modelId === MODEL)?.promptLengthPricing)
      .toEqual(cost?.promptLengthPricing);
  }
});

test("policy writes retain sibling policies concurrently added by a disk writer", async () => {
  config = loadConfig();
  armClaudeCodeBaseline(config);
  const diskWriter = loadConfig();
  diskWriter.providers.acme!.modelCosts = { sibling: { ...BASE, promptLengthPricing: { mode: "flat" } } };
  saveConfig(diskWriter);
  await call("PUT", { ...BASE, promptLengthPricing: POLICY });
  const persisted = loadConfig();
  expect(persisted.providers.acme!.modelCosts).toEqual({
    sibling: { ...BASE, promptLengthPricing: { mode: "flat" } },
    [MODEL]: { ...BASE, promptLengthPricing: POLICY },
  });
});

test("running poller adopts a policy-only edit and leaves identical refreshes stable", async () => {
  await call("PUT", { ...BASE, promptLengthPricing: POLICY });
  const version = userCostOverlayVersion();
  const lease = startUserCostOverlayReconciler({ intervalMs: 10, liveConfig: config });
  try {
    const disk = JSON.parse(readFileSync(getConfigPath(), "utf8"));
    disk.providers.acme.modelCosts[MODEL].promptLengthPricing = { mode: "flat" };
    writeFileSync(getConfigPath(), JSON.stringify(disk));
    const deadline = Date.now() + 3000;
    while (userCostOverlayVersion() === version && Date.now() < deadline) await Bun.sleep(10);
    expect(userCostOverlayVersion()).toBe(version + 1);
    expect(config.providers.acme!.modelCosts![MODEL]?.promptLengthPricing).toEqual({ mode: "flat" });
    expect(activeUserCostOverlays()[0]?.promptLengthPricing).toEqual({ mode: "flat" });
    expect(activeUserCostOverlays()[0]?.cost4).toEqual(BASE);
    reconcileUserCostOverlaysFromDisk(config);
    expect(userCostOverlayVersion()).toBe(version + 1);
  } finally { lease.stop(); }
});

test("same-model automatic baseline, external custom policy, and explicit flat PUT replace atomically", async () => {
  config.providers.acme!.modelCosts = { [MODEL]: { ...BASE, promptLengthPricing: { mode: "automatic" } } };
  saveConfig(config);
  armClaudeCodeBaseline(config);
  const disk = loadConfig();
  disk.providers.acme!.modelCosts = {
    [MODEL]: { ...BASE, promptLengthPricing: POLICY },
    sibling: { ...BASE, promptLengthPricing: POLICY },
  };
  saveConfig(disk);
  const expected = { ...BASE, promptLengthPricing: { mode: "flat" } };
  expect((await (await call("PUT", expected)).json()).cost).toEqual(expected);
  expect(config.providers.acme!.modelCosts![MODEL]).toEqual(expected);
  expect(JSON.parse(readFileSync(getConfigPath(), "utf8")).providers.acme.modelCosts).toEqual({
    [MODEL]: expected, sibling: { ...BASE, promptLengthPricing: POLICY },
  });
  expect(providerModelCostsConfigError(config.providers.acme!.modelCosts)).toBeNull();
  expect(activeUserCostOverlays().find(row => row.modelId === MODEL)?.promptLengthPricing).toEqual({ mode: "flat" });
});

test("same-model CLI write clears an external custom policy not yet adopted by live config even when base rates equal baseline", async () => {
  config.providers.acme!.modelCosts = { [MODEL]: BASE };
  saveConfig(config);
  armClaudeCodeBaseline(config);
  const disk = loadConfig();
  disk.providers.acme!.modelCosts = { [MODEL]: { ...BASE, promptLengthPricing: POLICY } };
  saveConfig(disk);
  const output: string[] = [];
  const log = console.log;
  console.log = (...values) => { output.push(values.join(" ")); };
  try {
    const result = await handleModelsRuntimeCommand("set-price", [
      `acme/${MODEL}`, "--input", "1", "--output", "2", "--cache-read", "0.1", "--cache-write", "0", "--json",
    ], { baseUrl: "http://127.0.0.1:1", fetchImpl: async (_url, init) => {
      if (!init?.method || init.method === "GET") return call("GET");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ modelId: MODEL, cost: BASE });
      return call("PUT", body.cost);
    } });
    expect(result).toBe(0);
    expect(JSON.parse(output.join("\n")).cost).toEqual(BASE);
  } finally { console.log = log; }
  expect(JSON.parse(readFileSync(getConfigPath(), "utf8")).providers.acme.modelCosts[MODEL]).toEqual(BASE);
  expect(config.providers.acme!.modelCosts![MODEL]).toEqual(BASE);
  expect(activeUserCostOverlays().find(row => row.modelId === MODEL)?.promptLengthPricing).toBeUndefined();
  // Replacement intent must not leak into a later unrelated save.
  const later = loadConfig();
  later.providers.acme!.modelCosts![MODEL] = { ...BASE, promptLengthPricing: POLICY };
  saveConfig(later);
  config.modelCacheTtlMs = 60_001;
  saveConfigPreservingClaudeCode(config);
  expect(loadConfig().providers.acme!.modelCosts![MODEL]?.promptLengthPricing).toEqual(POLICY);
});

test("same-model reset wins over an external custom addition and retains sibling policies", async () => {
  armClaudeCodeBaseline(config);
  const disk = loadConfig();
  disk.providers.acme!.modelCosts = {
    [MODEL]: { ...BASE, promptLengthPricing: POLICY }, sibling: { ...BASE, promptLengthPricing: POLICY },
  };
  saveConfig(disk);
  expect((await (await call("PUT", null)).json()).cost).toBeNull();
  expect(JSON.parse(readFileSync(getConfigPath(), "utf8")).providers.acme.modelCosts).toEqual({
    sibling: { ...BASE, promptLengthPricing: POLICY },
  });
  expect(activeUserCostOverlays().some(row => row.modelId === MODEL)).toBe(false);
});

test("final merged candidate validation rejects an invalid sibling merge before publishing and rolls back", async () => {
  config.providers.acme!.modelCosts = { sibling: { ...BASE, promptLengthPricing: { mode: "automatic" } } };
  saveConfig(config);
  armClaudeCodeBaseline(config);
  const disk = loadConfig();
  disk.providers.acme!.modelCosts = { sibling: { ...BASE, promptLengthPricing: POLICY } };
  saveConfig(disk);
  config.providers.acme!.modelCosts.sibling = { ...BASE, promptLengthPricing: { mode: "flat" } };
  const before = readFileSync(getConfigPath(), "utf8");
  const previous = structuredClone(config.providers.acme!.modelCosts);
  const version = userCostOverlayVersion();
  await expect(call("PUT", { ...BASE, promptLengthPricing: POLICY })).rejects.toThrow();
  expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
  expect(config.providers.acme!.modelCosts).toEqual(previous);
  expect(userCostOverlayVersion()).toBe(version);
  // A failed write clears its replacement intent too.
  config.providers.acme!.modelCosts = { sibling: { ...BASE, promptLengthPricing: POLICY } };
  saveConfigPreservingClaudeCode(config);
  expect(loadConfig().providers.acme!.modelCosts![MODEL]).toBeUndefined();
});
