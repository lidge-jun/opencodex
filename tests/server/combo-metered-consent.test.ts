import { expect, test } from "bun:test";
import { loadConfig, saveConfig } from "../../src/config";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OcxConfig } from "../../src/types";
import { admissionMayUseMeteredComboTargets } from "../../src/server/admission-model-scope";
import { parseComboTargets } from "../../src/cli/combo-input";
import { comboConfigError, normalizeComboConfig } from "../../src/combos";
import { handleManagementAPI } from "../../src/server/management-api";
import { ManagementRequest } from "../helpers/management-auth";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { handleResponses } from "../../src/server/responses";
import { noteSubagentModelFailure, resetSubagentModelFallbackStateForTests } from "../../src/codex/subagent-model-fallback";
import { clearComboTargetCooldowns, coolComboTarget } from "../../src/combos/failover";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const key = { id: "issued", name: "issued", key: "ocx_data_" + "a".repeat(40), createdAt: "2026-10-15T00:00:00Z" };
const admission = { kind: "configured", keyId: key.id, source: "bearer" } as const;

test("metered consent is literal true on a matching configured key", () => {
  for (const consent of [undefined, false, "true", 1, null, true]) {
    const config = { apiKeys: [{ ...key, allowMeteredComboTargets: consent }] } as OcxConfig;
    expect(admissionMayUseMeteredComboTargets(config, admission)).toBe(consent === true);
    expect(admissionMayUseMeteredComboTargets(config, { ...admission, keyId: "missing" })).toBe(false);
    expect(admissionMayUseMeteredComboTargets(config, undefined)).toBe(false);
    expect(admissionMayUseMeteredComboTargets(config, { kind: "loopback", source: "loopback" })).toBe(false);
    expect(admissionMayUseMeteredComboTargets(config, { kind: "environment", source: "bearer" })).toBe(false);
  }
});

test("CLI and combo normalization validate and preserve metered metadata", () => {
  const target = { provider: "a", model: "m", metered: true };
  expect(parseComboTargets([target])).toEqual([target]);
  expect(() => parseComboTargets([{ ...target, metered: "true" }])).toThrow();
  expect(comboConfigError("chain", { targets: [{ ...target, metered: "true" }] }, { a: { adapter: "openai-chat", baseUrl: "https://a.test/v1" } })).toContain("metered");
  expect(normalizeComboConfig({ targets: [target] }).targets[0]?.metered).toBe(true);
  expect(normalizeComboConfig({ targets: [{ provider: "a", model: "m" }] }).targets[0]?.metered).toBe(false);
});

test("metered metadata survives dashboard saves, explicit false clears it, malformed key consent is dropped", async () => {
  const previous = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-metered-consent-"));
  process.env.OPENCODEX_HOME = home;
  try {
    const config: OcxConfig = {
      port: 16389, defaultProvider: "a",
      providers: { a: { adapter: "openai-chat", baseUrl: "https://a.test/v1", models: ["m"] } },
      apiKeys: [{ ...key, allowMeteredComboTargets: true }],
    };
    saveConfig(config);
    expect(loadConfig().apiKeys?.[0]?.allowMeteredComboTargets).toBe(true);
    const put = async (target: unknown, extra: Record<string, unknown> = {}, id = "chain", renameFrom?: string) => {
      const req = new ManagementRequest("http://localhost:16389/api/combos", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, ...(renameFrom ? { renameFrom } : {}), combo: { strategy: "failover", targets: [target], ...extra } }),
      });
      return handleManagementAPI(req, new URL(req.url), config, {
        createManagementConvergeCodex: catalogConvergenceFactory(async () => {}),
      });
    };
    expect((await put({ provider: "a", model: "m", metered: true }))?.status).toBe(200);
    expect((await put({ provider: " a ", model: " m " }))?.status).toBe(200);
    expect(config.combos?.chain?.targets[0]?.metered).toBe(true);
    const disk = () => JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as OcxConfig;
    expect(disk().combos?.chain?.targets[0]?.metered).toBe(true);
    expect((await put({ provider: "a", model: "m", metered: "true" }))?.status).toBe(400);
    expect(disk().combos?.chain?.targets[0]?.metered).toBe(true);
    expect((await put({ provider: "a", model: "m", metered: false }))?.status).toBe(200);
    expect(disk().combos?.chain?.targets[0]).not.toHaveProperty("metered");
    const target = { provider: "a", model: "m", metered: true };
    expect((await put(target, { allowMeteredTargets: true }))?.status).toBe(200);
    expect(loadConfig().combos?.chain?.allowMeteredTargets).toBe(true);
    expect((await put(target))?.status).toBe(200);
    expect(disk().combos?.chain?.allowMeteredTargets).toBe(true);
    for (const invalid of ["true", 1, null]) {
      expect((await put(target, { allowMeteredTargets: invalid }))?.status).toBe(400);
      expect(disk().combos?.chain?.allowMeteredTargets).toBe(true);
      writeFileSync(join(home, "config.json"), JSON.stringify({ ...config, combos: { chain: { targets: [target], allowMeteredTargets: invalid } } }));
      expect(loadConfig().combos?.chain).toBeUndefined();
      saveConfig(config);
    }
    expect((await put(target, {}, "renamed", "chain"))?.status).toBe(200);
    expect(disk().combos?.renamed?.allowMeteredTargets).toBe(true);
    expect((await put(target, { allowMeteredTargets: false }, "renamed"))?.status).toBe(200);
    expect(disk().combos?.renamed).not.toHaveProperty("allowMeteredTargets");
    writeFileSync(join(home, "config.json"), JSON.stringify({ ...config, apiKeys: [{ ...key, allowMeteredComboTargets: "true" }] }));
    expect(loadConfig().apiKeys ?? []).toHaveLength(0);
  } finally {
    if (previous === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previous;
    removeTreeWithRetry(home);
  }
});

// A subagent fallback naming a combo alias is collapsed to one pick by the router and dispatched
// outside the combo loop, so its metered pick must be refused there too.
test("a subagent fallback that collapses a combo onto its metered target needs key consent", async () => {
  const previous = { home: process.env.OPENCODEX_HOME, codex: process.env.CODEX_HOME };
  const home = mkdtempSync(join(tmpdir(), "ocx-metered-fallback-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  const release = acquireOwnedSpendHome();
  const originalFetch = globalThis.fetch;
  const provider = (host: string) => ({ adapter: "openai-chat" as const, baseUrl: `https://${host}.test/v1`, apiKey: "k", models: ["m"] });
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const post = (config: OcxConfig, consented: boolean) => {
    resetSubagentModelFallbackStateForTests();
    noteSubagentModelFailure("primary/m", "429", config);
    clearComboTargetCooldowns("chain");
    coolComboTarget("chain", { provider: "subscription", model: "m" }, { cooldownMs: 600_000 });
    urls.length = 0;
    return handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "x-openai-subagent": "collab_spawn" },
      body: JSON.stringify({ model: "primary/m", input: "hi", stream: false }),
    }), config, { model: "", provider: "" }, consented ? { admission } : {});
  };
  try {
    const config = (consent: boolean): OcxConfig => ({
      port: 16389, defaultProvider: "primary",
      providers: { primary: provider("primary"), subscription: provider("subscription"), paid: provider("paid") },
      combos: { chain: { alias: "chain-model", cooldownReprobe: { enabled: true }, targets: [{ provider: "subscription", model: "m" }, { provider: "paid", model: "m", metered: true }] } },
      subagentModelFallback: ["chain-model"],
      apiKeys: [{ ...key, allowMeteredComboTargets: consent }],
    });
    expect((await post(config(false), false)).status).toBe(503);
    expect(urls).toEqual([]);
    expect((await post(config(false), true)).status).toBe(503);
    expect(urls).toEqual([]);
    await post(config(true), true);
    expect(urls).toEqual(["https://paid.test/v1/chat/completions"]);
  } finally {
    globalThis.fetch = originalFetch;
    resetSubagentModelFallbackStateForTests();
    clearComboTargetCooldowns("chain");
    release();
    for (const [name, value] of [["OPENCODEX_HOME", previous.home], ["CODEX_HOME", previous.codex]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    removeTreeWithRetry(home);
  }
});
