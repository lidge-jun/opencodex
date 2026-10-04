import { expect, test } from "bun:test";
import { getDefaultConfig, loadConfig, readConfigDiagnostics, validateConfigCandidate } from "../../src/config";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleConfigRoutes } from "../../src/server/management/config-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
function harness(failSave = false) {
  const config = getDefaultConfig();
  let saves = 0;
  const call = async (body?: unknown) => {
    const url = new URL("http://localhost/api/settings");
    return handleConfigRoutes({
      url, req: new Request(url, { method: body === undefined ? "GET" : "PUT", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
      config, version: "test", deps: { saveConfigPreservingClaudeCode: (_c: OcxConfig) => {
        saves++; if (failSave) throw new Error("fixture-save-failed");
      } },
    } as unknown as ManagementContext);
  };
  return { config, call, saves: () => saves };
}

test("reasoning retention settings round-trip, preserve omission, and reset", async () => {
  const h = harness();
  expect(await (await h.call())!.json()).toMatchObject({ reasoningRetention: null });
  const value = { maxContextPercent: 12.5, maxTokens: 50000 };
  expect(await (await h.call({ reasoningRetention: value }))!.json()).toMatchObject({ reasoningRetention: value });
  expect(h.config.reasoningRetention).toEqual(value);
  expect(await (await h.call())!.json()).toMatchObject({ reasoningRetention: value });
  await h.call({ streamMode: "auto" });
  expect(h.config.reasoningRetention).toEqual(value);
  expect(await (await h.call({ reasoningRetention: null }))!.json()).toMatchObject({ reasoningRetention: null });
  expect(h.config.reasoningRetention).toBeUndefined();
});
test("reasoning retention rejects invalid values before persistence", async () => {
  const h = harness();
  for (const value of [{ maxContextPercent: 0 }, { maxContextPercent: 101 }, { maxTokens: 0 }, { maxTokens: 1.5 }, { maxTokens: "100" }, { extra: true }]) {
    expect((await h.call({ reasoningRetention: value }))!.status).toBe(400);
  }
  expect(h.saves()).toBe(0);
});
test("reasoning retention save failure rolls back update and reset", async () => {
  const h = harness(true);
  const value = { maxTokens: 30000 };
  h.config.reasoningRetention = value;
  for (const next of [null, { maxTokens: 1000 }]) {
    await expect(h.call({ reasoningRetention: next })).rejects.toThrow("fixture-save-failed");
    expect(h.config.reasoningRetention).toEqual(value);
  }
});

test("reasoning retention candidate writes strictly validate optional fields", () => {
  const defaults = getDefaultConfig();
  expect(defaults.reasoningRetention).toBeUndefined();
  for (const value of [{ maxContextPercent: 12.5 }, { maxTokens: 50000 }, { maxContextPercent: 20, maxTokens: 100000 }]) {
    const validated = validateConfigCandidate({ ...defaults, reasoningRetention: value });
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.config.reasoningRetention).toEqual(value);
  }
  for (const value of [null, [], "20", { maxContextPercent: 0 }, { maxContextPercent: 101 },
    { maxContextPercent: Infinity }, { maxContextPercent: NaN }, { maxTokens: -1 },
    { maxTokens: 1.5 }, { maxTokens: "100" }, { maxTokens: 1, extra: true }]) {
    expect(validateConfigCandidate({ ...defaults, reasoningRetention: value }).ok).toBe(false);
  }
});

test("reasoning retention malformed disk settings degrade locally and warn without exposing values", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-retention-config-"));
  const previousHome = process.env.OPENCODEX_HOME;
  const previousWarn = console.warn;
  const warnings: string[] = [];
  process.env.OPENCODEX_HOME = home;
  console.warn = (value: unknown) => { warnings.push(String(value)); };
  try {
    const config = getDefaultConfig();
    writeFileSync(join(home, "config.json"), JSON.stringify({ ...config,
      reasoningRetention: { maxTokens: "private-fixture-value" } }));
    const loaded = loadConfig();
    expect(loaded.reasoningRetention).toBeUndefined();
    expect(loaded.providers).toEqual(config.providers);
    expect(warnings.some(value => value.includes("reasoningRetention"))).toBe(true);
    expect(warnings.join("\n")).not.toContain("private-fixture-value");
    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("file");
    expect(diagnostics.error).toBeNull();
    expect(diagnostics.warnings?.some(value => value.includes("reasoningRetention"))).toBe(true);
    expect(diagnostics.config.reasoningRetention).toBeUndefined();
  } finally {
    console.warn = previousWarn;
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("reasoning retention failed initial save restores key omission", async () => {
  const h = harness(true);
  await expect(h.call({ reasoningRetention: { maxTokens: 1000 } })).rejects.toThrow("fixture-save-failed");
  expect(Object.hasOwn(h.config, "reasoningRetention")).toBe(false);
});
