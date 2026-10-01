import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comboConfigIssues, comboDependsOnProvider, getCombo, lexicalDecisionModelBase } from "../../src/combos/types";
import { getConfigPath, loadConfig, readConfigDiagnostics, saveConfig } from "../../src/config";
import { configSchema } from "../../src/config/schema/config-schema";
import { comboDependsOnProviderRoute, decisionModelProviderPatchError, decisionModelRouteError, normalizeDecisionModelSelector } from "../../src/server/management/decision-model-validation";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxComboConfig, OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const targets = [{ provider: "a", model: "m1" }];
function config(combos?: OcxConfig["combos"]): OcxConfig {
  return { port: 10100, defaultProvider: "a", providers: {
    a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
    b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
    decision: { adapter: "jev-decision", baseUrl: "https://decision.example/v1/systemone", defaultModel: "tev1", liveModels: false },
  }, ...(combos ? { combos } : {}) };
}
async function withHome(run: () => Promise<void>): Promise<void> {
  const oldHome = process.env.OPENCODEX_HOME;
  const oldClaude = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), "ocx-jev-model-config-"));
  process.env.OPENCODEX_HOME = dir;
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
  try { await run(); } finally {
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = oldHome;
    if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = oldClaude;
    removeTreeWithRetry(dir);
  }
}
async function api(cfg: OcxConfig, method: string, path = "/api/combos", body?: unknown): Promise<Response> {
  const req = new ManagementRequest(`http://localhost${path}`, {
    method, headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handleManagementAPI(req, new URL(req.url), cfg, {
    createManagementConvergeCodex: catalogConvergenceFactory(async () => {}),
  });
  expect(response).not.toBeNull();
  return response!;
}
const put = (cfg: OcxConfig, id: string, combo: unknown, renameFrom?: string) =>
  api(cfg, "PUT", "/api/combos", { id, combo, ...(renameFrom ? { renameFrom } : {}) });

describe("JEV decision model config", () => {
  test("validates shape, strategy and mutually exclusive selectors", () => {
    const cfg = config();
    for (const decisionModel of ["", " ", 1, false, "x".repeat(513)]) {
      expect(comboConfigIssues("auto", { strategy: "jev", targets, decisionModel }, cfg.providers)
        .some(issue => issue.path[0] === "decisionModel")).toBe(true);
    }
    expect(comboConfigIssues("auto", { strategy: "failover", targets, decisionModel: "a/m1" }, cfg.providers))
      .toContainEqual({ path: ["decisionModel"], message: 'decisionModel is only valid with strategy "jev"' });
    expect(comboConfigIssues("auto", { strategy: "jev", targets, decisionModel: "a/m1", decisionProvider: "jev" }, cfg.providers))
      .toContainEqual({ path: ["decisionModel"], message: "decisionModel cannot coexist with decisionProvider" });
    expect(comboConfigIssues("auto", { strategy: "jev", targets, decisionModel: "a/m1", decisionProvider: null }, cfg.providers)).toEqual([]);
    expect(comboConfigIssues("auto", { strategy: "jev", targets, decisionModel: null }, cfg.providers)).toEqual([]);
    expect(comboConfigIssues("auto", { strategy: "jev", targets, decisionModel: "x".repeat(512) }, cfg.providers)).toEqual([]);
  });

  test("resolves self and JEV aliases in the injected prospective map; permits ordinary combos", () => {
    const cfg = config({
      auto: { strategy: "jev", alias: "judge", targets },
      other: { strategy: "jev", alias: "other-judge", targets },
      ordinary: { strategy: "failover", alias: "ordinary-judge", targets },
    });
    for (const decisionModel of ["combo/auto", "judge", "judge--fast", "other-judge", "other-judge--fast"]) {
      const issues = comboConfigIssues("auto", { strategy: "jev", targets, decisionModel }, cfg.providers, {
        combos: cfg.combos, normalizeDecisionModel: model => normalizeDecisionModelSelector(cfg, model),
      });
      expect(issues.some(issue => issue.path[0] === "decisionModel")).toBe(true);
      expect(issues[0]?.message).toContain(decisionModel.startsWith("other") ? 'combo "other"' : 'combo "auto"');
    }
    expect(comboConfigIssues("auto", { strategy: "jev", targets, decisionModel: "ordinary-judge" }, cfg.providers, { combos: cfg.combos })).toEqual([]);
    expect(comboConfigIssues("auto", { strategy: "jev", targets, decisionModel: "judge--fast" }, cfg.providers, { combos: cfg.combos })).toEqual([]);
  });

  test("normalization trims decisionModel and keeps explicit clears sparse", () => {
    const cfg = config({ auto: { strategy: "jev", targets, decisionModel: "  b/m2  " }, plain: { strategy: "jev", targets, decisionModel: null } });
    expect(getCombo(cfg, "auto")).toHaveProperty("decisionModel", "b/m2");
    expect(getCombo(cfg, "plain")).not.toHaveProperty("decisionModel");
  });

  test("save-time preview rejects missing qualified routes, disabled rows and decision adapters", () => {
    const cfg = config({ ordinary: { targets }, auto: { strategy: "jev", targets } });
    expect(decisionModelRouteError(cfg, "auto", "a/m1")).toBeNull();
    expect(decisionModelRouteError(cfg, "auto", "combo/ordinary")).toBeNull();
    expect(decisionModelRouteError(cfg, undefined, "a/m1")).toBeNull();
    expect(decisionModelRouteError(cfg, undefined, "combo/auto")).toContain("JEV combo");
    expect(decisionModelRouteError(cfg, "auto", "missing/model")).toContain("configured provider");
    expect(decisionModelRouteError(cfg, "auto", "combo/missing")).not.toBeNull();
    expect(decisionModelRouteError(cfg, "auto", "decision/tev1")).not.toBeNull();
    cfg.providers.b!.disabled = true;
    expect(decisionModelRouteError(cfg, "auto", "b/m2")).not.toBeNull();
  });

  test("load validation sees aliases and synthetic selectors across the entire map", async () => {
    await withHome(async () => {
      for (const decisionModel of ["judge", "judge--fast", "judge--high"]) {
        const cfg = { ...config({ auto: { strategy: "jev", alias: "judge", targets, decisionModel } }), cursorEffortRows: true };
        writeFileSync(getConfigPath(), JSON.stringify(cfg));
        const diagnostics = JSON.stringify(readConfigDiagnostics());
        expect(diagnostics).toContain("combos.auto.decisionModel");
        expect(diagnostics).toContain("itself");
      }
    });
  });

  test("provider dependency counts the exact decisionModel prefix", () => {
    const combo: OcxComboConfig = { strategy: "jev", targets, decisionModel: " b/m2--fast " };
    expect(comboDependsOnProvider(combo, "b")).toBe(true);
    expect(comboDependsOnProvider(combo, "bb")).toBe(false);
    expect(comboDependsOnProvider({ ...combo, decisionModel: "jev/model" }, "jev")).toBe(true);
  });

  test("provider deletion resolves an aliased or default-routed decision model", () => {
    const cfg = config({ auto: { strategy: "jev", targets, decisionModel: "bee/m2" } });
    cfg.providers.b!.alias = "bee";
    const combo = cfg.combos!.auto!;
    expect(comboDependsOnProvider(combo, "b")).toBe(false);
    expect(comboDependsOnProviderRoute(cfg, combo, "b")).toBe(true);
    expect(comboDependsOnProviderRoute(cfg, combo, "a")).toBe(true);
    const unqualified = { ...combo, targets: [{ provider: "b", model: "m2" }], decisionModel: "m1" };
    expect(comboDependsOnProviderRoute(cfg, unqualified, "a")).toBe(true);
    expect(comboDependsOnProviderRoute(cfg, { ...unqualified, decisionModel: "b/m2" }, "a")).toBe(false);
  });

  test("the schema's string-only selector stand-in strips fast and declared effort suffixes", () => {
    expect(lexicalDecisionModelBase("judge--fast", false)).toBe("judge");
    expect(lexicalDecisionModelBase("judge--high", false)).toBe("judge--high");
    expect(lexicalDecisionModelBase("judge--high", true)).toBe("judge");
    expect(lexicalDecisionModelBase("judge--none", true)).toBe("judge--none");
    expect(lexicalDecisionModelBase("judge--turbo", true)).toBe("judge--turbo");
  });

  test("adapter PATCH validation recognizes provider aliases and disabled qualified dependencies", () => {
    const cfg = config({ auto: { strategy: "jev", targets, decisionModel: "bee/m2" } });
    cfg.providers.b!.alias = "bee";
    const candidate = { ...cfg.providers.b!, adapter: "jev-decision" as const };
    expect(decisionModelProviderPatchError(cfg, "b", candidate)).not.toBeNull();
    cfg.providers.b!.disabled = true;
    expect(decisionModelProviderPatchError(cfg, "b", candidate)).not.toBeNull();
    expect(decisionModelProviderPatchError(cfg, "decision", cfg.providers.decision!)).toBeNull();
  });

  test("malformed neighboring identity rows produce schema issues without crashing selector normalization", () => {
    const result = configSchema.safeParse({ ...config(), combos: {
      auto: { strategy: "jev", targets, alias: "judge", decisionModel: "judge--fast" }, broken: null,
    }, routingProfiles: { broken: null } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(issue => issue.path.join(".") === "combos.auto.decisionModel")).toBe(true);
      expect(result.error.issues.some(issue => issue.path.join(".") === "combos.broken")).toBe(true);
    }
  });
});

describe("JEV decision model management", () => {
  test("round-trip PUT, GET and config reload preserve the trimmed model; omission and clear work", async () => {
    await withHome(async () => {
      const cfg = config();
      saveConfig(cfg);
      expect((await put(cfg, "auto", { strategy: "jev", targets, decisionModel: " b/m2 " })).status).toBe(200);
      expect((await put(cfg, "auto", { strategy: "jev", targets })).status).toBe(200);
      const listed = await (await api(cfg, "GET")).json() as { combos: unknown[] };
      expect(listed.combos).toContainEqual(expect.objectContaining({ id: "auto", decisionModel: "b/m2" }));
      expect(loadConfig().combos?.auto).toHaveProperty("decisionModel", "b/m2");
      expect(JSON.parse(readFileSync(getConfigPath(), "utf8")).combos.auto.decisionModel).toBe("b/m2");
      expect((await put(cfg, "auto", { strategy: "jev", targets, decisionModel: null })).status).toBe(200);
      expect(cfg.combos?.auto).not.toHaveProperty("decisionModel");
    });
  });

  test("explicit selectors replace a preserved opposite selector and both explicit values reject", async () => {
    await withHome(async () => {
      const cfg = config({ auto: { strategy: "jev", targets, decisionProvider: "decision" } });
      saveConfig(cfg);
      expect((await put(cfg, "auto", { strategy: "jev", targets, decisionModel: "b/m2" })).status).toBe(200);
      expect(cfg.combos?.auto).toHaveProperty("decisionModel", "b/m2");
      expect(cfg.combos?.auto).not.toHaveProperty("decisionProvider");
      expect((await put(cfg, "auto", { strategy: "jev", targets, decisionProvider: "decision" })).status).toBe(200);
      expect(cfg.combos?.auto).not.toHaveProperty("decisionModel");
      expect((await put(cfg, "auto", { strategy: "jev", targets, decisionModel: "b/m2", decisionProvider: "decision" })).status).toBe(400);
      expect(cfg.combos?.auto).toHaveProperty("decisionProvider", "decision");
    });
  });

  test("same-PUT aliases cannot self-reference, including Fast and effort selectors", async () => {
    await withHome(async () => {
      const cfg = { ...config(), cursorEffortRows: true };
      saveConfig(cfg);
      const before = readFileSync(getConfigPath(), "utf8");
      for (const decisionModel of ["judge", "judge--fast", "judge--high", "combo/auto"]) {
        const response = await put(cfg, "auto", { strategy: "jev", alias: "judge", targets, decisionModel });
        expect(response.status).toBe(400);
        expect((await response.json() as { error: string }).error).toContain('combo "auto"');
      }
      expect(cfg.combos).toBeUndefined();
      expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
    });
  });

  test("rejects another JEV alias, permits non-JEV combos and blocks changing a referenced strategy", async () => {
    await withHome(async () => {
      const cfg = config({ ordinary: { strategy: "failover", alias: "judge", targets }, other: { strategy: "jev", alias: "other-judge", targets } });
      saveConfig(cfg);
      expect((await put(cfg, "auto", { strategy: "jev", targets, decisionModel: "other-judge" })).status).toBe(400);
      expect((await put(cfg, "auto", { strategy: "jev", targets, decisionModel: "judge--fast" })).status).toBe(200);
      const before = readFileSync(getConfigPath(), "utf8");
      const response = await put(cfg, "ordinary", { strategy: "jev", alias: "judge", targets });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toContain('combo "auto"');
      expect(cfg.combos?.ordinary?.strategy).toBe("failover");
      expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
    });
  });

  test("renames migrate canonical, alias and synthetic decision references; delete refuses dependents", async () => {
    await withHome(async () => {
      const cfg = config({ ordinary: { alias: "judge", targets },
        direct: { strategy: "jev", targets, decisionModel: "combo/ordinary" },
        alias: { strategy: "jev", targets, decisionModel: "judge--fast" },
      });
      saveConfig(cfg);
      expect((await put(cfg, "ordinary2", { alias: "judge2", targets }, "ordinary")).status).toBe(200);
      expect(cfg.combos?.direct?.decisionModel).toBe("combo/ordinary2");
      expect(cfg.combos?.alias?.decisionModel).toBe("judge2--fast");
      const response = await api(cfg, "DELETE", "/api/combos?id=ordinary2");
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "combo_has_dependent_combos", combos: ["direct", "alias"] });
      expect(cfg.combos?.ordinary2).toBeDefined();
      expect(loadConfig().combos?.alias?.decisionModel).toBe("judge2--fast");
    });
  });

  test("an alias edit that makes another model reference self rejects before mutation", async () => {
    await withHome(async () => {
      const cfg = config({ auto: { strategy: "jev", targets, decisionModel: "judge" } });
      saveConfig(cfg);
      const response = await put(cfg, "auto", { strategy: "jev", targets, alias: "judge" });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toContain("itself");
      expect(cfg.combos?.auto?.alias).toBeUndefined();
    });
  });

  test("changing away from JEV drops preserved model and deadline", async () => {
    await withHome(async () => {
      const cfg = config({ auto: { strategy: "jev", targets, decisionModel: "b/m2", decisionTimeoutMs: 5000 } });
      saveConfig(cfg);
      expect((await put(cfg, "auto", { strategy: "failover", targets })).status).toBe(200);
      expect(cfg.combos?.auto).not.toHaveProperty("decisionModel");
      expect(cfg.combos?.auto).not.toHaveProperty("decisionTimeoutMs");
    });
  });

  test("unroutable saves reject and model providers cannot be deleted or changed into decision rows", async () => {
    await withHome(async () => {
      const cfg = config();
      saveConfig(cfg);
      for (const decisionModel of ["missing/model", "decision/tev1"]) {
        expect((await put(cfg, "auto", { strategy: "jev", targets, decisionModel })).status).toBe(400);
      }
      expect((await put(cfg, "auto", { strategy: "jev", targets, decisionModel: "b/m2" })).status).toBe(200);
      const removed = await api(cfg, "DELETE", "/api/providers?name=b");
      expect(removed.status).toBe(409);
      expect(await removed.json()).toMatchObject({ code: "provider_has_dependent_combos", combos: ["auto"] });
      const patched = await api(cfg, "PATCH", "/api/providers?name=b", { adapter: "jev-decision" });
      expect(patched.status).toBe(400);
      expect((await patched.json() as { error: string }).error).toContain('combo "auto"');
      expect(cfg.providers.b?.adapter).toBe("openai-chat");
    });
  });
});
