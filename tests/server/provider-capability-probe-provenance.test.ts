import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { sanitizeCapabilityDeclarationsForLoad } from "../../src/config/load-degrade";
import { modelCapabilityProbesConfigError, pruneModelCapabilityProbes } from "../../src/config/provider-validation";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const AT = "2026-11-13T10:00:00.000Z";

describe("modelCapabilityProbes validation", () => {
  test("accepts sparse rows with true axis flags and an ISO UTC timestamp", () => {
    expect(modelCapabilityProbesConfigError(undefined)).toBeNull();
    expect(modelCapabilityProbesConfigError({ m: { probedAt: AT, inputModalities: true } })).toBeNull();
    expect(modelCapabilityProbesConfigError({ m: { probedAt: "2026-11-13T10:00:00Z", reasoningEfforts: true } })).toBeNull();
  });
  for (const value of [[], "x", { m: null }, { m: { probedAt: AT } }, { m: { probedAt: AT, inputModalities: false } },
    { m: { probedAt: "yesterday", inputModalities: true } }, { m: { probedAt: AT, inputModalities: true, extra: true } },
    { " m": { probedAt: AT, inputModalities: true } }, JSON.parse(`{"__proto__":{"probedAt":"${AT}","inputModalities":true}}`)]) {
    test(`rejects ${JSON.stringify(value)}`, () => expect(modelCapabilityProbesConfigError(value)).not.toBeNull());
  }
  test("load degradation drops malformed provenance only", () => {
    const parsed = { providers: { p: { adapter: "openai-chat", modelCapabilityProbes: { m: { probedAt: "bad", inputModalities: true } } } } };
    const warnings: string[] = [];
    sanitizeCapabilityDeclarationsForLoad(parsed, message => warnings.push(message));
    expect(parsed.providers.p).toEqual({ adapter: "openai-chat" } as any);
    expect(warnings).toHaveLength(1);
  });
  test("prune keeps only flags whose declaration exists and removes the empty field", () => {
    const row = { adapter: "openai-chat", baseUrl: "https://example.test/v1",
      modelCapabilities: { a: { inputModalities: ["text"] } }, modelReasoningEfforts: { a: ["low"] },
      modelCapabilityProbes: { a: { probedAt: AT, inputModalities: true, reasoningEfforts: true }, b: { probedAt: AT, inputModalities: true } },
    } as OcxProviderConfig;
    const stored = row.modelCapabilityProbes;
    expect(pruneModelCapabilityProbes(row, [["a", "reasoningEfforts"]])).toBe(true);
    expect(row.modelCapabilityProbes).toEqual({ a: { probedAt: AT, inputModalities: true } });
    expect(stored!.a!.reasoningEfforts).toBe(true);
    pruneModelCapabilityProbes(row, [["a", "inputModalities"]]);
    expect("modelCapabilityProbes" in row).toBe(false);
  });
});

describe("modelCapabilityProbes management round trip", () => {
  let home: string;
  let previous: Record<string, string | undefined>;
  beforeEach(() => {
    previous = { OPENCODEX_HOME: process.env.OPENCODEX_HOME, CODEX_HOME: process.env.CODEX_HOME };
    home = mkdtempSync(join(tmpdir(), "ocx-probe-provenance-"));
    process.env.OPENCODEX_HOME = home;
    process.env.CODEX_HOME = join(home, "codex");
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeTreeWithRetry(home);
  });
  const fixture = (): OcxConfig => ({ port: 0, defaultProvider: "caps", providers: { caps: {
    adapter: "openai-chat", baseUrl: "https://example.test/v1", liveModels: false, models: ["m", "n"],
    modelCapabilities: { m: { inputModalities: ["text", "image"], contextTier: "long_context" }, n: { inputModalities: ["text"] } },
    modelReasoningEfforts: { m: ["low", "high"] },
    modelCapabilityProbes: { m: { probedAt: AT, inputModalities: true, reasoningEfforts: true }, n: { probedAt: AT, inputModalities: true } },
  } } });
  const request = async (live: OcxConfig, method: string, path: string, body?: unknown) => {
    const url = new URL(`http://127.0.0.1${path}`);
    const response = (await handleManagementAPI(new Request(url, { method, headers: { Host: "127.0.0.1", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, live,
    { createManagementConvergeCodex: catalogConvergenceFactory() }))!;
    return { status: response.status, body: await response.json() as any };
  };

  test("GET exposes it, unrelated PATCH keeps it, manual modality PATCH drops only that axis", async () => {
    const live = fixture();
    saveConfig(live);
    const listed = await request(live, "GET", "/api/providers");
    expect(listed.body.find((row: any) => row.name === "caps").modelCapabilityProbes).toEqual(fixture().providers.caps!.modelCapabilityProbes);
    expect((await request(live, "PATCH", "/api/providers?name=caps", { contextWindow: 64000 })).status).toBe(200);
    expect(loadConfig().providers.caps!.modelCapabilityProbes).toEqual(fixture().providers.caps!.modelCapabilityProbes);
    expect((await request(live, "PATCH", "/api/providers?name=caps", { modelCapabilities: { m: { inputModalities: ["text"] } } })).status).toBe(200);
    expect(loadConfig().providers.caps!.modelCapabilityProbes).toEqual({
      m: { probedAt: AT, reasoningEfforts: true }, n: { probedAt: AT, inputModalities: true } });
    expect((await request(live, "PATCH", "/api/providers?name=caps", { modelCapabilities: null })).status).toBe(200);
    expect(loadConfig().providers.caps!.modelCapabilityProbes).toEqual({ m: { probedAt: AT, reasoningEfforts: true } });
  });

  test("same-name POST carries it when omitted and rejects a malformed value", async () => {
    const live = fixture();
    saveConfig(live);
    const form = { adapter: "openai-chat", baseUrl: "https://example.test/v1", liveModels: false, models: ["m", "n"] };
    expect((await request(live, "POST", "/api/providers", { name: "caps", provider: { ...form, modelCapabilityProbes: { m: { probedAt: "x" } } } })).status).toBe(400);
    expect((await request(live, "POST", "/api/providers", { name: "caps", provider: form })).status).toBe(200);
    // modelCapabilities is carried; modelReasoningEfforts is not, so its flag goes with it.
    expect(loadConfig().providers.caps!.modelCapabilityProbes).toEqual({ m: { probedAt: AT, inputModalities: true }, n: { probedAt: AT, inputModalities: true } });
  });

  test("model-settings edit of a probed ladder makes it manual and stays sparse", async () => {
    const live = fixture();
    live.providers.caps!.modelCapabilityProbes = { m: { probedAt: AT, reasoningEfforts: true } };
    saveConfig(live);
    const response = await request(live, "PUT", "/api/model-settings", { provider: "caps", modelId: "m", reasoningEfforts: ["low", "high"] });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ changed: true, saved: true });
    expect("modelCapabilityProbes" in loadConfig().providers.caps!).toBe(false);
  });
});
