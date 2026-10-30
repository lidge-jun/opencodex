import { afterEach, expect, test } from "bun:test";
import { configSchema } from "../../src/config/schema/config-schema";
import { getDefaultConfig, loadConfig } from "../../src/config";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCapabilityTable } from "../../src/codex/role-capability";
import type { OcxConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const config = (value: unknown) => ({ codexRoleCapability: configSchema.shape.codexRoleCapability.parse(value) }) as OcxConfig;

test("only Artificial Analysis is requested and missing keys produce unattributed fallback", async () => {
  const requests: string[] = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
    requests.push(String(input));
    return Response.json({ data: [{ name: "Fixture model", evaluations: { artificial_analysis_coding_index: 42 } }] });
  }, { preconnect: originalFetch.preconnect }) as typeof fetch;
  const empty = await loadCapabilityTable(config(undefined));
  expect(empty).toMatchObject({ source: null, domains: {}, fallbackReason: "benchmark data was unavailable: no Artificial Analysis key is configured" });
  expect(requests).toEqual([]);
  const table = await loadCapabilityTable(config({ artificialAnalysis: { apiKey: "aa-consent-fixture" } }));
  expect(requests).toEqual(["https://artificialanalysis.ai/api/v2/data/llms/models"]);
  expect(table.source?.name).toBe("Artificial Analysis");
  expect(table.domains.coding?.get("fixture-model")).toBe(42);
});

test("retired source key is ignored without dropping the Artificial Analysis key", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-aa-legacy-"));
  const old = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = dir;
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ ...getDefaultConfig(), codexRoleCapability: { artificialAnalysis: { apiKey: "  aa-legacy-fixture  " }, huggingFace: { enabled: true } } }));
    expect(loadConfig().codexRoleCapability).toEqual({ artificialAnalysis: { apiKey: "aa-legacy-fixture" } });
  } finally {
    if (old === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = old;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("any other malformed capability block is dropped whole and reported as no configured key", async () => {
  // Same convention as the other strict optional blocks: a malformed block is never partially
  // trusted. The proposal then reports the missing key instead of reading with a guessed one.
  const parse = (value: unknown) => configSchema.shape.codexRoleCapability.parse(value);
  expect(parse({ artificialAnalysis: { apiKey: "aa-fixture" }, unknownSource: { enabled: true } })).toBeUndefined();
  expect(parse({ artificialAnalysis: { apiKey: "aa-fixture", extra: 1 } })).toBeUndefined();
  expect(parse({ artificialAnalysis: { apiKey: 42 } })).toBeUndefined();
  expect(parse({ artificialAnalysis: { apiKey: "   " } })).toBeUndefined();
  expect(parse("aa-fixture")).toBeUndefined();
  const requests: string[] = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
    requests.push(String(input));
    return Response.json({ data: [] });
  }, { preconnect: originalFetch.preconnect }) as typeof fetch;
  const table = await loadCapabilityTable(config({ artificialAnalysis: { apiKey: "aa-fixture" }, unknownSource: {} }));
  expect(table).toMatchObject({ source: null, fallbackReason: "benchmark data was unavailable: no Artificial Analysis key is configured" });
  expect(requests).toEqual([]);
});
