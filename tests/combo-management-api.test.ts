import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceComboAfterFailure,
  clearComboSelectionState,
  clearComboTargetCooldowns,
  comboAliasIssues,
  comboConfigError,
  comboConfigIssues,
  comboDefaultEffort,
  comboFailureDecision,
  comboIdFromRawBody,
  comboModelId,
  comboPublicModelId,
  concreteComboRequestBody,
  coolComboTarget,
  getCombo,
  isComboTargetInCooldown,
  isValidComboId,
  listComboIds,
  NoAvailableComboTargetsError,
  noteComboSuccess,
  noteComboFailure,
  normalizeComboConfig,
  parseComboModelId,
  parseRetryAfterMs,
  pickComboTarget,
  resetComboEffortWarningStateForTests,
  resolveComboId,
  targetKey,
  tryPickComboModel,
  UnknownComboError,
} from "../src/combos";
import { getConfigPath, readConfigDiagnostics, saveConfig } from "../src/config";
import { routeModel } from "../src/router";
import { handleManagementAPI } from "../src/server/management-api";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";
import { syncCatalogModels } from "../src/codex/catalog";
import { injectClaudeAgentDefs } from "../src/claude/agents-inject";
import { catalogConvergenceFactory } from "./helpers/catalog-convergence";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const VALID_COMBO = { targets: [{ provider: "a", model: "m1" }] };

function baseConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
      b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
      c: { adapter: "openai-chat", baseUrl: "https://c.example/v1", apiKey: "kc", models: ["m3"] },
    },
    combos: {
      free: {
        strategy: "failover",
        targets: [
          { provider: "a", model: "m1" },
          { provider: "b", model: "m2" },
        ],
      },
    },
    ...overrides,
  };
}

function rrConfig(stickyLimit: number, weights: number[]): OcxConfig {
  const providers = baseConfig().providers;
  const names = ["a", "b", "c"];
  return baseConfig({
    providers,
    combos: {
      free: {
        strategy: "round-robin",
        stickyLimit,
        targets: weights.map((weight, index) => ({
          provider: names[index]!,
          model: `m${index + 1}`,
          weight,
        })),
      },
    },
  });
}

function successfulPicks(config: OcxConfig, count: number): string[] {
  const combo = getCombo(config, "free")!;
  return Array.from({ length: count }, () => {
    const pick = pickComboTarget(config, "free")!;
    noteComboSuccess("free", combo, pick.target);
    return targetKey(pick.target);
  });
}

async function withTempHome<T>(run: (dir: string) => Promise<T> | T): Promise<T> {
  const previousHome = process.env.OPENCODEX_HOME;
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), "ocx-combos-"));
  process.env.OPENCODEX_HOME = dir;
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
  try {
    return await run(dir);
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    removeTreeWithRetry(dir);
  }
}

function writeRawConfig(config: unknown): void {
  writeFileSync(getConfigPath(), JSON.stringify(config), "utf8");
}

async function comboApi(
  config: OcxConfig,
  method: string,
  path: string,
  body?: unknown,
  refreshCodexCatalog: () => Promise<void> = async () => {},
): Promise<Response | null> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleManagementAPI(req, new URL(req.url), config, {
    createManagementConvergeCodex: catalogConvergenceFactory(refreshCodexCatalog),
  });
}

async function comboApiRaw(config: OcxConfig, method: string, path: string, body: string): Promise<Response | null> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body,
  });
  return handleManagementAPI(req, new URL(req.url), config, {
    createManagementConvergeCodex: catalogConvergenceFactory(),
  });
}

async function responseJson(response: Response | null): Promise<Record<string, unknown>> {
  expect(response).not.toBeNull();
  return response!.json() as Promise<Record<string, unknown>>;
}

afterEach(() => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
});

describe("combo management API", () => {
  test("bare alias precedence yields back to a non-OpenAI selector after rename and deletion", async () => {
    await withTempHome(async () => {
      const selector = "deepseek/deepseek-chat";
      const combo = {
        strategy: "failover" as const,
        targets: [{ provider: "deepseek", model: "deepseek-chat" }],
        alias: selector,
      };
      const config = baseConfig({
        defaultProvider: "deepseek",
        providers: {
          deepseek: {
            adapter: "openai-chat",
            baseUrl: "https://api.deepseek.com/v1",
            apiKey: "key",
            liveModels: false,
            models: ["deepseek-chat"],
          },
        },
        combos: { free: combo },
      });
      saveConfig(config);

      expect(routeModel(config, selector)).toMatchObject({
        providerName: "deepseek",
        modelId: "deepseek-chat",
        combo: { comboId: "free" },
      });

      const renamed = await comboApi(config, "PUT", "/api/combos", {
        id: "free",
        combo: { ...combo, alias: "fast-chat" },
      });
      expect(renamed?.status).toBe(200);
      expect(routeModel(config, selector)).toMatchObject({
        providerName: "deepseek",
        modelId: "deepseek-chat",
      });
      expect(routeModel(config, selector)).not.toHaveProperty("combo");
      expect(routeModel(config, "fast-chat")).toMatchObject({ combo: { comboId: "free" } });

      const restored = await comboApi(config, "PUT", "/api/combos", {
        id: "free",
        combo,
      });
      expect(restored?.status).toBe(200);
      expect(routeModel(config, selector)).toMatchObject({ combo: { comboId: "free" } });

      const deleted = await comboApi(config, "DELETE", "/api/combos?id=free");
      expect(deleted?.status).toBe(200);
      expect(routeModel(config, selector)).toMatchObject({
        providerName: "deepseek",
        modelId: "deepseek-chat",
      });
      expect(routeModel(config, selector)).not.toHaveProperty("combo");
    });
  });

  test("PUT and DELETE clear only the mutated combo cooldowns", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        combos: {
          free: VALID_COMBO,
          other: { targets: [{ provider: "b", model: "m2" }] },
        },
      });
      saveConfig(config);
      const freeTarget = { provider: "a", model: "m1" };
      const otherTarget = { provider: "b", model: "m2" };

      coolComboTarget("free", freeTarget, { cooldownMs: 60_000 });
      coolComboTarget("other", otherTarget, { cooldownMs: 60_000 });
      expect(isComboTargetInCooldown("free", freeTarget)).toBe(true);
      expect((await comboApi(config, "PUT", "/api/combos", {
        id: "free",
        combo: VALID_COMBO,
      }))?.status).toBe(200);
      expect(isComboTargetInCooldown("free", freeTarget)).toBe(false);
      expect(isComboTargetInCooldown("other", otherTarget)).toBe(true);

      coolComboTarget("free", freeTarget, { cooldownMs: 60_000 });
      expect((await comboApi(config, "DELETE", "/api/combos?id=free"))?.status).toBe(200);
      expect(isComboTargetInCooldown("free", freeTarget)).toBe(false);
      expect(isComboTargetInCooldown("other", otherTarget)).toBe(true);
    });
  });

  test("GET is sorted and PUT upserts normalized whole values", async () => {
    await withTempHome(async () => {
      const config = baseConfig({ combos: undefined });
      saveConfig(config);
      const created = await comboApi(config, "PUT", "/api/combos", {
        id: "zeta",
        combo: { targets: [{ provider: " a ", model: " m1 " }] },
      });
      expect(created?.status).toBe(200);
      expect(await responseJson(created)).toMatchObject({
        success: true,
        id: "zeta",
        model: "combo/zeta",
        combo: { strategy: "failover", stickyLimit: 1, defaultEffort: null },
      });
      const updated = await comboApi(config, "PUT", "/api/combos", {
        id: "zeta",
        combo: { strategy: "round-robin", stickyLimit: 2, defaultEffort: "high", targets: [{ provider: "b", model: "m2", weight: 3 }] },
      });
      expect((await responseJson(updated)).combo).toMatchObject({ strategy: "round-robin", stickyLimit: 2, defaultEffort: "high" });
      await comboApi(config, "PUT", "/api/combos", {
        id: "alpha",
        combo: { targets: [{ provider: "a", model: "m1" }] },
      });
      const listed = await responseJson(await comboApi(config, "GET", "/api/combos"));
      expect((listed.combos as Array<{ id: string }>).map(row => row.id)).toEqual(["alpha", "zeta"]);
      expect(listComboIds(config)).toEqual(["alpha", "zeta"]);
      // Default imageInput is not written to disk — only explicit "disabled" is.
      expect(config.combos?.zeta).not.toHaveProperty("imageInput");
    });
  });

  test("PUT persists explicit imageInput disabled", async () => {
    await withTempHome(async () => {
      const config = baseConfig({ combos: undefined });
      saveConfig(config);
      const response = await comboApi(config, "PUT", "/api/combos", {
        id: "limited",
        combo: {
          targets: [{ provider: "a", model: "m1" }],
          imageInput: "disabled",
        },
      });
      expect(response?.status).toBe(200);
      expect(await responseJson(response)).toMatchObject({
        combo: { imageInput: "disabled" },
      });
      expect(config.combos?.limited).toMatchObject({ imageInput: "disabled" });
      const listed = await responseJson(await comboApi(config, "GET", "/api/combos"));
      expect(listed.combos).toEqual([expect.objectContaining({
        id: "limited", imageInput: "disabled",
      })]);
    });
  });

  test("reasoningEffortMode survives a management round-trip and stays sparse when strict", async () => {
    await withTempHome(async () => {
      const config = baseConfig({ combos: undefined });
      saveConfig(config);

      // Opting in must survive PUT -> disk -> GET. The dashboard replaces the whole combo
      // on save, so a field that is not echoed here is a field the UI silently destroys.
      const opted = await comboApi(config, "PUT", "/api/combos", {
        id: "mixed",
        combo: {
          targets: [{ provider: "a", model: "m1" }],
          reasoningEffortMode: "adaptive",
        },
      });
      expect(opted?.status).toBe(200);
      expect(await responseJson(opted)).toMatchObject({
        combo: { reasoningEffortMode: "adaptive" },
      });
      expect(config.combos?.mixed).toMatchObject({ reasoningEffortMode: "adaptive" });
      const listed = await responseJson(await comboApi(config, "GET", "/api/combos"));
      expect(listed.combos).toEqual([expect.objectContaining({
        id: "mixed", reasoningEffortMode: "adaptive",
      })]);

      // The default is never materialized: neither on disk nor in the wire shape, so a
      // client that round-trips GET into PUT cannot write it back into every config.
      const plain = await comboApi(config, "PUT", "/api/combos", {
        id: "plain",
        combo: { targets: [{ provider: "a", model: "m1" }] },
      });
      expect((await responseJson(plain)).combo).not.toHaveProperty("reasoningEffortMode");
      expect(config.combos?.plain).not.toHaveProperty("reasoningEffortMode");

      // Explicitly turning it back off clears the stored field rather than pinning "strict".
      await comboApi(config, "PUT", "/api/combos", {
        id: "mixed",
        combo: {
          targets: [{ provider: "a", model: "m1" }],
          reasoningEffortMode: "strict",
        },
      });
      expect(config.combos?.mixed).not.toHaveProperty("reasoningEffortMode");
    });
  });

  test("PUT rejects an unknown reasoningEffortMode", async () => {
    await withTempHome(async () => {
      const config = baseConfig({ combos: undefined });
      saveConfig(config);
      const response = await comboApi(config, "PUT", "/api/combos", {
        id: "bad",
        combo: {
          targets: [{ provider: "a", model: "m1" }],
          reasoningEffortMode: "aggressive",
        },
      });
      expect(response?.status).toBe(400);
      expect(config.combos?.bad).toBeUndefined();
    });
  });

  test("PUT stores aliases and GET exposes the public model", async () => {
    await withTempHome(async () => {
      const config = baseConfig({ combos: undefined });
      saveConfig(config);
      const response = await comboApi(config, "PUT", "/api/combos", {
        id: "flash",
        combo: { ...VALID_COMBO, alias: "  deepseek-v4-flash  " },
      });
      expect(response?.status).toBe(200);
      expect(await responseJson(response)).toMatchObject({
        id: "flash",
        model: "deepseek-v4-flash",
        combo: { alias: "deepseek-v4-flash" },
      });
      expect(config.combos?.flash?.alias).toBe("deepseek-v4-flash");
      const listed = await responseJson(await comboApi(config, "GET", "/api/combos"));
      expect(listed.combos).toEqual([expect.objectContaining({
        id: "flash",
        model: "deepseek-v4-flash",
        alias: "deepseek-v4-flash",
      })]);
    });
  });

  test("PUT round-trips an explicitly labeled native alias", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        combos: undefined,
        disabledModels: ["gpt-5.6-sol"],
      });
      saveConfig(config);
      const response = await comboApi(config, "PUT", "/api/combos", {
        id: "nova-sol",
        combo: {
          ...VALID_COMBO,
          alias: "gpt-5.6-sol",
          nativeAlias: true,
          displayName: "Nova1 - codex-gpt-5.6-sol",
        },
      });

      expect(response?.status).toBe(200);
      expect(await responseJson(response)).toMatchObject({
        id: "nova-sol",
        model: "gpt-5.6-sol",
        combo: {
          alias: "gpt-5.6-sol",
          nativeAlias: true,
          displayName: "Nova1 - codex-gpt-5.6-sol",
        },
      });
      expect(config.combos?.["nova-sol"]).toMatchObject({
        nativeAlias: true,
        displayName: "Nova1 - codex-gpt-5.6-sol",
      });
      const listed = await responseJson(await comboApi(config, "GET", "/api/combos"));
      expect(listed.combos).toEqual([expect.objectContaining({
        id: "nova-sol",
        nativeAlias: true,
        displayName: "Nova1 - codex-gpt-5.6-sol",
      })]);
    });
  });

  test("PUT rejects a native alias without a displayName without mutating config", async () => {
    await withTempHome(async () => {
      const config = baseConfig({ combos: undefined });
      saveConfig(config);
      const beforeMemory = structuredClone(config);
      const beforeDisk = readFileSync(getConfigPath(), "utf8");
      const response = await comboApi(config, "PUT", "/api/combos", {
        id: "nova-sol",
        combo: {
          ...VALID_COMBO,
          alias: "gpt-5.6-sol",
          nativeAlias: true,
        },
      });

      expect(response?.status).toBe(400);
      expect(config).toEqual(beforeMemory);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeDisk);
    });
  });

  test("PUT rejects aliases owned by a Codex account namespace without mutating config", async () => {
    await withTempHome(async () => {
      const config = baseConfig({ codexAccountNamespaces: { side: "side-account-id" } });
      saveConfig(config);
      const beforeMemory = structuredClone(config);
      const beforeDisk = readFileSync(getConfigPath(), "utf8");

      const response = await comboApi(config, "PUT", "/api/combos", {
        id: "intentional",
        combo: { ...VALID_COMBO, alias: "side/gpt-5.5" },
      });

      expect(response?.status).toBe(409);
      expect(await responseJson(response)).toEqual({
        error: "combo alias must not use a configured Codex account namespace",
      });
      expect(config).toEqual(beforeMemory);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeDisk);
    });
  });

  test("PUT rejects invalid and duplicate aliases without memory or disk mutation", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        combos: { free: { ...VALID_COMBO, alias: "deepseek-v4-flash" } },
      });
      saveConfig(config);
      for (const alias of ["combo/shadow", "gpt-5", "deepseek-v4-flash"]) {
        const beforeMemory = structuredClone(config);
        const beforeDisk = readFileSync(getConfigPath(), "utf8");
        const response = await comboApi(config, "PUT", "/api/combos", {
          id: "other",
          combo: { ...VALID_COMBO, alias },
        });
        expect(response?.status).toBe(400);
        expect(config).toEqual(beforeMemory);
        expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeDisk);
      }
    });
  });

  test("PUT renames atomically, migrates public references, and clears both ids", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        disabledModels: ["before", "combo/old", "middle", "old-public", "after"],
        subagentModels: ["combo/old", "another", "old-public"],
        injectionModel: "combo/old",
        shadowCallIntercept: { enabled: true, model: "old-public" },
        claudeCode: {
          model: "combo/old",
          smallFastModel: "old-public",
          tierModels: { opus: "combo/old", sonnet: "a/m1", haiku: "old-public" },
          modelMap: { inbound: "combo/old", stable: "a/m1" },
        },
        combos: {
          old: {
            strategy: "round-robin",
            stickyLimit: 2,
            alias: "old-public",
            targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
          },
        },
      });
      saveConfig(config);
      injectClaudeAgentDefs(config, {});
      expect(readdirSync(join(process.env.CLAUDE_CONFIG_DIR!, "agents"))).toContain("ocx-old-public.md");
      const oldCombo = getCombo(config, "old")!;
      const oldPick = pickComboTarget(config, "old")!;
      noteComboSuccess("old", oldCombo, oldPick.target);
      config.combos!.new = {
        strategy: "round-robin",
        stickyLimit: 2,
        targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
      };
      const staleNewCombo = getCombo(config, "new")!;
      const staleNewPick = pickComboTarget(config, "new")!;
      noteComboSuccess("new", staleNewCombo, staleNewPick.target);
      delete config.combos!.new;
      coolComboTarget("old", { provider: "a", model: "m1" }, { cooldownMs: 60_000 });
      coolComboTarget("new", { provider: "b", model: "m2" }, { cooldownMs: 60_000 });

      const response = await comboApi(config, "PUT", "/api/combos", {
        id: "new",
        renameFrom: "old",
        combo: {
          strategy: "round-robin",
          stickyLimit: 2,
          alias: "new-public",
          targets: [{ provider: "b", model: "m2" }, { provider: "a", model: "m1" }],
        },
      });
      expect(response?.status).toBe(200);
      expect(await responseJson(response)).toMatchObject({ id: "new", model: "new-public" });
      expect(config.combos?.old).toBeUndefined();
      expect(config.combos?.new?.alias).toBe("new-public");
      expect(config.disabledModels).toEqual(["before", "new-public", "middle", "after"]);
      expect(config.subagentModels).toEqual(["new-public", "another"]);
      expect(config.injectionModel).toBe("new-public");
      expect(config.shadowCallIntercept).toEqual({ enabled: true, model: "new-public" });
      expect(config.claudeCode).toMatchObject({
        model: "new-public",
        smallFastModel: "new-public",
        tierModels: { opus: "new-public", sonnet: "a/m1", haiku: "new-public" },
        modelMap: { inbound: "new-public", stable: "a/m1" },
      });
      const agentBodies = readdirSync(join(process.env.CLAUDE_CONFIG_DIR!, "agents"))
        .map(file => readFileSync(join(process.env.CLAUDE_CONFIG_DIR!, "agents", file), "utf8"))
        .join("\n");
      expect(agentBodies).toContain("new-public");
      expect(agentBodies).not.toContain("old-public");
      expect(agentBodies).not.toContain("combo/old");
      expect(isComboTargetInCooldown("old", { provider: "a", model: "m1" })).toBe(false);
      expect(isComboTargetInCooldown("new", { provider: "b", model: "m2" })).toBe(false);
      expect(pickComboTarget(config, "new")?.target.provider).toBe("b");
      config.combos!.old = config.combos!.new!;
      expect(pickComboTarget(config, "old")?.target.provider).toBe("b");
      const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
      expect(persisted.combos?.old).toBeUndefined();
      expect(persisted.combos?.new?.alias).toBe("new-public");
      expect(persisted.disabledModels).toEqual(["before", "new-public", "middle", "after"]);
      expect(persisted.subagentModels).toEqual(["new-public", "another"]);
      expect(persisted.injectionModel).toBe("new-public");
      expect(persisted.shadowCallIntercept).toEqual({ enabled: true, model: "new-public" });
      expect(persisted.claudeCode).toMatchObject({
        model: "new-public",
        smallFastModel: "new-public",
        tierModels: { opus: "new-public", sonnet: "a/m1", haiku: "new-public" },
        modelMap: { inbound: "new-public", stable: "a/m1" },
      });
    });
  });

  test("PUT rename migrates canonical references when the public alias stays unchanged", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        disabledModels: ["before", "combo/old", "after"],
        subagentModels: ["combo/old", "another"],
        combos: {
          old: { ...VALID_COMBO, alias: "stable-public" },
        },
      });
      saveConfig(config);

      const response = await comboApi(config, "PUT", "/api/combos", {
        id: "new",
        renameFrom: "old",
        combo: { ...VALID_COMBO, alias: "stable-public" },
      });

      expect(response?.status).toBe(200);
      expect(config.disabledModels).toEqual(["before", "stable-public", "after"]);
      expect(config.subagentModels).toEqual(["stable-public", "another"]);
      const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
      expect(persisted.disabledModels).toEqual(["before", "stable-public", "after"]);
      expect(persisted.subagentModels).toEqual(["stable-public", "another"]);
    });
  });

  test("PUT rename preserves native disables and migrates only the canonical native-alias selector", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        disabledModels: ["gpt-5.6-sol", "combo/old", "gpt-5.5"],
        subagentModels: ["gpt-5.6-sol", "combo/old"],
        injectionModel: "gpt-5.6-sol",
        shadowCallIntercept: { enabled: true, model: "gpt-5.6-sol" },
        claudeCode: {
          model: "gpt-5.6-sol",
          smallFastModel: "gpt-5.6-sol",
          tierModels: { opus: "gpt-5.6-sol", sonnet: "combo/old" },
          modelMap: { native: "gpt-5.6-sol", combo: "combo/old" },
        },
        combos: {
          old: {
            ...VALID_COMBO,
            alias: "gpt-5.6-sol",
            nativeAlias: true,
            displayName: "Nova1 - Sol",
          },
        },
      });
      saveConfig(config);

      const response = await comboApi(config, "PUT", "/api/combos", {
        id: "new",
        renameFrom: "old",
        combo: {
          ...VALID_COMBO,
          alias: "gpt-5.6-terra",
          nativeAlias: true,
          displayName: "Nova1 - Terra",
        },
      });

      expect(response?.status).toBe(200);
      expect(config.disabledModels).toEqual(["gpt-5.6-sol", "combo/new", "gpt-5.5"]);
      expect(config.subagentModels).toEqual(["gpt-5.6-sol", "combo/new"]);
      expect(config.injectionModel).toBe("gpt-5.6-sol");
      expect(config.shadowCallIntercept?.model).toBe("gpt-5.6-sol");
      expect(config.claudeCode).toMatchObject({
        model: "gpt-5.6-sol",
        smallFastModel: "gpt-5.6-sol",
        tierModels: { opus: "gpt-5.6-sol", sonnet: "combo/new" },
        modelMap: { native: "gpt-5.6-sol", combo: "combo/new" },
      });
      expect(routeModel(config, "gpt-5.6-terra")).toMatchObject({
        providerName: "a",
        modelId: "m1",
      });
      expect(() => routeModel(config, "gpt-5.6-sol")).toThrow(
        "requires the canonical openai provider",
      );
      const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
      expect(persisted.disabledModels).toEqual(config.disabledModels);
      expect(persisted.subagentModels).toEqual(config.subagentModels);
    });
  });

  test("PUT rename rejects missing sources and existing destinations without mutation", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        combos: {
          free: VALID_COMBO,
          other: { targets: [{ provider: "b", model: "m2" }] },
        },
      });
      saveConfig(config);
      for (const request of [
        { id: "new", renameFrom: "missing", combo: VALID_COMBO },
        { id: "other", renameFrom: "free", combo: VALID_COMBO },
      ]) {
        const beforeMemory = structuredClone(config);
        const beforeDisk = readFileSync(getConfigPath(), "utf8");
        const response = await comboApi(config, "PUT", "/api/combos", request);
        expect(response?.status).toBe(400);
        expect(config).toEqual(beforeMemory);
        expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeDisk);
      }
    });
  });

  test("PUT alias changes migrate public references without renaming", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        disabledModels: ["combo/free"],
        subagentModels: ["combo/free"],
      });
      saveConfig(config);
      const response = await comboApi(config, "PUT", "/api/combos", {
        id: "free",
        combo: { ...VALID_COMBO, alias: "free-public" },
      });
      expect(response?.status).toBe(200);
      expect(config.disabledModels).toEqual(["free-public"]);
      expect(config.subagentModels).toEqual(["free-public"]);
    });
  });

  test("GET subagent models exposes a combo alias as an available round-trip value", async () => {
    const config = baseConfig({
      subagentModels: ["deepseek-v4-flash"],
      combos: {
        free: { ...VALID_COMBO, alias: "deepseek-v4-flash" },
      },
    });
    config.providers.a!.modelContextWindows = { m1: 128_000 };

    const response = await comboApi(config, "GET", "/api/subagent-models");
    expect(response?.status).toBe(200);
    const body = await response!.json() as { chosen: string[]; available: string[] };
    expect(body.chosen).toEqual(["deepseek-v4-flash"]);
    expect(body.available).toContain("deepseek-v4-flash");
    expect(body.available.filter(model => model === "deepseek-v4-flash")).toHaveLength(1);
    expect(body.available).not.toContain("combo/free");

    // Disabling an alias hides it from the pickable set, but NOT while it still holds a
    // saved roster slot: the dashboard PUTs exactly the rows it can render, so dropping a
    // chosen id here silently truncates the persisted roster on the next Save. Covered by
    // tests/subagent-roster-retention.test.ts.
    config.disabledModels = ["deepseek-v4-flash"];
    const disabledResponse = await comboApi(config, "GET", "/api/subagent-models");
    const disabledBody = await disabledResponse!.json() as { chosen: string[]; available: string[] };
    expect(disabledBody.chosen).toEqual(["deepseek-v4-flash"]);
    expect(disabledBody.available).toContain("deepseek-v4-flash");
    expect(disabledBody.available.filter(model => model === "deepseek-v4-flash")).toHaveLength(1);

    // Once it no longer occupies a roster slot, the disable takes full effect.
    config.subagentModels = [];
    const unfeaturedResponse = await comboApi(config, "GET", "/api/subagent-models");
    const unfeaturedBody = await unfeaturedResponse!.json() as { available: string[] };
    expect(unfeaturedBody.available).not.toContain("deepseek-v4-flash");
  }, 15_000);

  test("GET models round-trips a disabled combo alias for the Models GUI", async () => {
    const config = baseConfig({
      disabledModels: ["deepseek-v4-flash"],
      combos: {
        free: { ...VALID_COMBO, alias: "deepseek-v4-flash" },
      },
    });
    for (const provider of Object.values(config.providers)) provider.liveModels = false;
    config.providers.a!.modelContextWindows = { m1: 128_000 };

    const response = await comboApi(config, "GET", "/api/models");
    expect(response?.status).toBe(200);
    const rows = await response!.json() as Array<{
      provider: string;
      id: string;
      namespaced: string;
      disabled: boolean;
    }>;
    expect(rows.find(row => row.provider === "combo" && row.id === "free")).toMatchObject({
      namespaced: "deepseek-v4-flash",
      disabled: true,
    });
    expect(rows.some(row => row.namespaced === "combo/free")).toBe(false);

    const collisionConfig = baseConfig({
      disabledModels: ["a/m1"],
      combos: {
        free: { ...VALID_COMBO, alias: "a/m1" },
      },
    });
    collisionConfig.providers.a!.liveModels = false;
    collisionConfig.providers.a!.modelContextWindows = { m1: 128_000 };
    const collisionResponse = await comboApi(collisionConfig, "GET", "/api/models");
    const collisionRows = await collisionResponse!.json() as Array<{
      provider: string;
      id: string;
      namespaced: string;
      disabled: boolean;
    }>;
    expect(collisionRows.filter(row => row.namespaced === "a/m1")).toEqual([
      expect.objectContaining({ provider: "combo", id: "free", disabled: true }),
    ]);

    const customCollisionConfig = baseConfig({
      disabledModels: ["a/m1"],
      customModels: [{ id: "custom-a-m1", provider: "a", modelId: "m1", displayName: "Custom M1" }],
      combos: {
        free: { ...VALID_COMBO, alias: "a/m1" },
      },
    });
    customCollisionConfig.providers.a!.liveModels = false;
    customCollisionConfig.providers.a!.modelContextWindows = { m1: 128_000 };
    const customCollisionResponse = await comboApi(customCollisionConfig, "GET", "/api/models");
    const customCollisionRows = await customCollisionResponse!.json() as Array<{
      provider: string;
      id: string;
      namespaced: string;
      disabled: boolean;
      custom?: boolean;
    }>;
    expect(customCollisionRows.filter(row => row.namespaced === "a/m1")).toEqual([
      expect.objectContaining({ provider: "combo", id: "free", disabled: true }),
    ]);
  });

  test("GET models exposes one native-alias row and uses only its canonical disable selector", async () => {
    const config = baseConfig({
      disabledModels: ["gpt-5.6-sol"],
      combos: {
        free: {
          ...VALID_COMBO,
          alias: "gpt-5.6-sol",
          nativeAlias: true,
          displayName: "Nova1 - Sol",
        },
      },
    });
    for (const provider of Object.values(config.providers)) provider.liveModels = false;
    config.providers.a!.modelContextWindows = { m1: 128_000 };

    const response = await comboApi(config, "GET", "/api/models");
    const rows = await response!.json() as Array<{
      provider: string;
      id: string;
      namespaced: string;
      disabled: boolean;
      native?: boolean;
    }>;
    expect(rows.filter(row => row.namespaced === "gpt-5.6-sol")).toEqual([
      expect.objectContaining({ provider: "combo", id: "free", disabled: false }),
    ]);

    config.disabledModels!.push("combo/free");
    const disabledResponse = await comboApi(config, "GET", "/api/models");
    const disabledRows = await disabledResponse!.json() as typeof rows;
    expect(disabledRows.filter(row => row.namespaced === "gpt-5.6-sol")).toEqual([
      expect.objectContaining({ provider: "combo", id: "free", disabled: true }),
    ]);
  });

  test("PUT alias changes reject a migrated shadow-call self-target (#2706)", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        defaultProvider: "xai",
        providers: {
          xai: {
            adapter: "openai-chat",
            baseUrl: "https://api.x.ai/v1",
            apiKey: "test-xai-key",
            models: ["custom-helper"],
          },
        },
        combos: {
          helper: {
            alias: "old-public",
            targets: [{ provider: "xai", model: "custom-helper" }],
          },
        },
        shadowCallIntercept: {
          enabled: true,
          model: "old-public",
          sourceModels: ["custom-helper"],
        },
      });
      saveConfig(config);
      const beforeMemory = structuredClone(config);
      const beforeDisk = readFileSync(getConfigPath(), "utf8");

      const response = await comboApi(config, "PUT", "/api/combos", {
        id: "helper",
        combo: {
          alias: "custom-helper",
          targets: [{ provider: "xai", model: "custom-helper" }],
        },
      });

      expect(response?.status).toBe(400);
      expect(config).toEqual(beforeMemory);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeDisk);
    });
  });

  test("PUT clearing an alias deduplicates migrated references in stable order", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        disabledModels: ["before", "old-public", "combo/free", "after", "old-public"],
        subagentModels: ["old-public", "another", "combo/free"],
        combos: { free: { ...VALID_COMBO, alias: "old-public" } },
      });
      saveConfig(config);
      const response = await comboApi(config, "PUT", "/api/combos", {
        id: "free",
        combo: VALID_COMBO,
      });
      expect(response?.status).toBe(200);
      expect(config.disabledModels).toEqual(["before", "combo/free", "after"]);
      expect(config.subagentModels).toEqual(["combo/free", "another"]);
      const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
      expect(persisted.disabledModels).toEqual(["before", "combo/free", "after"]);
      expect(persisted.subagentModels).toEqual(["combo/free", "another"]);
    });
  });

  test("PUT rejects malformed JSON, non-record roots, and non-string ids without mutation", async () => {
    await withTempHome(async () => {
      const config = baseConfig();
      saveConfig(config);
      const before = readFileSync(getConfigPath(), "utf8");
      const malformed = await comboApiRaw(config, "PUT", "/api/combos", "{");
      expect(malformed?.status).toBe(400);
      expect(await responseJson(malformed)).toMatchObject({ error: "invalid JSON body" });
      for (const root of [null, [], "text", 3, true]) {
        const response = await comboApi(config, "PUT", "/api/combos", root);
        expect(response?.status).toBe(400);
        expect(await responseJson(response)).toMatchObject({ error: "request body must be an object" });
      }
      for (const id of [{}, [], 3]) {
        const response = await comboApi(config, "PUT", "/api/combos", { id, combo: VALID_COMBO });
        expect(response?.status).toBe(400);
        expect(await responseJson(response)).toMatchObject({ error: "id is required and must be a string" });
      }
      expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
      expect(config.combos).toEqual(baseConfig().combos);
    });
  });

  test("POST and PATCH cannot create or update combos", async () => {
    await withTempHome(async () => {
      const config = baseConfig();
      saveConfig(config);
      const before = readFileSync(getConfigPath(), "utf8");
      for (const method of ["POST", "PATCH"]) {
        expect(await comboApi(config, method, "/api/combos", { id: "new", combo: VALID_COMBO })).toBeNull();
      }
      expect(config.combos).toEqual(baseConfig().combos);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
    });
  });

  test("invalid PUT and all-disabled PUT leave config and disk unchanged", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        providers: {
          ...baseConfig().providers,
          a: { ...baseConfig().providers.a!, disabled: true },
        },
      });
      saveConfig(config);
      for (const combo of [
        { targets: [{ provider: "missing", model: "m" }] },
        { targets: [{ provider: "a", model: "m1" }] },
      ]) {
        const before = readFileSync(getConfigPath(), "utf8");
        const response = await comboApi(config, "PUT", "/api/combos", { id: "denied", combo });
        expect(response?.status).toBe(400);
        expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
        expect(config.combos?.denied).toBeUndefined();
      }
      const mixed = await comboApi(config, "PUT", "/api/combos", {
        id: "mixed",
        combo: { targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] },
      });
      expect(mixed?.status).toBe(200);
    });
  });

  test("DELETE is own-property safe and removes the final combo map", async () => {
    await withTempHome(async () => {
      const config = baseConfig();
      saveConfig(config);
      for (const id of ["missing", "constructor", "toString"]) {
        const response = await comboApi(config, "DELETE", `/api/combos?id=${id}`);
        expect(response?.status).toBe(404);
      }
      const deleted = await comboApi(config, "DELETE", "/api/combos?id=free");
      expect(deleted?.status).toBe(200);
      expect(config.combos).toBeUndefined();
      expect(JSON.parse(readFileSync(getConfigPath(), "utf8")).combos).toBeUndefined();
    });
  });

  test("DELETE refresh immediately retires the final managed combo catalog row", async () => {
    await withTempHome(async dir => {
      const previousCodexHome = process.env.CODEX_HOME;
      const codexHome = join(dir, "codex-home");
      mkdirSync(codexHome, { recursive: true });
      process.env.CODEX_HOME = codexHome;
      const catalogPath = join(codexHome, "opencodex-catalog.json");
      writeFileSync(catalogPath, JSON.stringify({
        models: [{
          slug: "combo/free",
          display_name: "combo/free",
          visibility: "list",
          supported_reasoning_levels: [{ effort: "low" }],
          input_modalities: ["text"],
          context_window: 128_000,
        }],
      }));
      try {
        const config = baseConfig({
          providers: {
            a: {
              adapter: "openai-chat",
              baseUrl: "https://a.example/v1",
              apiKey: "ka",
              liveModels: false,
              models: ["m1"],
              modelContextWindows: { m1: 128_000 },
            },
          },
          combos: { free: VALID_COMBO },
        });
        saveConfig(config);
        const deleted = await comboApi(
          config,
          "DELETE",
          "/api/combos?id=free",
          undefined,
          async () => { await syncCatalogModels(config); },
        );
        expect(deleted?.status).toBe(200);
        const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
          models: Array<{ slug?: string }>;
        };
        expect(catalog.models.some(model => model.slug === "combo/free")).toBe(false);
      } finally {
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousCodexHome;
      }
    });
  }, 15_000);

  test("provider deletion is guarded by sorted combo dependencies until cleanup", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        defaultProvider: "c",
        combos: {
          zeta: { targets: [{ provider: "a", model: "m1" }] },
          alpha: { targets: [{ provider: "a", model: "m1" }] },
        },
      });
      saveConfig(config);
      const before = readFileSync(getConfigPath(), "utf8");
      const blocked = await comboApi(config, "DELETE", "/api/providers?name=a");
      expect(blocked?.status).toBe(409);
      expect(await responseJson(blocked)).toMatchObject({ combos: ["alpha", "zeta"] });
      expect(config.providers.a).toBeDefined();
      expect(readFileSync(getConfigPath(), "utf8")).toBe(before);

      await comboApi(config, "DELETE", "/api/combos?id=alpha");
      await comboApi(config, "DELETE", "/api/combos?id=zeta");
      const deleted = await comboApi(config, "DELETE", "/api/providers?name=a");
      expect(deleted?.status).toBe(200);
      expect(config.providers.a).toBeUndefined();
    });
  });
});

describe("supported disabled-provider activation", () => {
  test("PATCH skips one disabled member, persists all-disabled state, and responses fail with the typed 503 envelope", async () => {
    await withTempHome(async () => {
      let bHits = 0;
      let cHits = 0;
      const upstreamB = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          bHits += 1;
          return Response.json({
            id: "chatcmpl-combo",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "from b" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        },
      });
      const upstreamC = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          cHits += 1;
          return Response.json({ error: { message: "default provider must not be reached" } }, { status: 500 });
        },
      });
      try {
        const config = baseConfig({
          defaultProvider: "c",
          providers: {
            a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka" },
            b: {
              adapter: "openai-chat",
              baseUrl: `${upstreamB.url.toString().replace(/\/$/, "")}/v1`,
              allowPrivateNetwork: true,
              apiKey: "kb",
            },
            c: {
              adapter: "openai-chat",
              baseUrl: `${upstreamC.url.toString().replace(/\/$/, "")}/v1`,
              allowPrivateNetwork: true,
              apiKey: "kc",
            },
          },
          combos: undefined,
        });
        saveConfig(config);
        expect((await comboApi(config, "PUT", "/api/combos", {
          id: "free",
          combo: { targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] },
        }))?.status).toBe(200);
        expect((await comboApi(config, "PATCH", "/api/providers?name=a", { disabled: true }))?.status).toBe(200);
        expect(routeModel(config, "combo/free").providerName).toBe("b");

        const routed = await handleResponses(new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "combo/free", input: "hello", stream: false }),
        }), config, { model: "", provider: "" });
        expect(routed.status).toBe(200);
        expect(bHits).toBe(1);
        expect(cHits).toBe(0);

        expect((await comboApi(config, "PATCH", "/api/providers?name=b", { disabled: true }))?.status).toBe(200);
        const diagnostics = readConfigDiagnostics();
        expect(diagnostics.source).toBe("file");
        expect(diagnostics.error).toBeNull();
        expect(diagnostics.config.combos?.free).toBeDefined();

        const unavailable = await handleResponses(new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "combo/free", input: "hello", stream: false }),
        }), diagnostics.config, { model: "", provider: "" });
        expect(unavailable.status).toBe(503);
        expect(await unavailable.json()).toMatchObject({
          error: { code: "combo_unavailable", type: "server_error" },
        });
        expect(bHits).toBe(1);
        expect(cHits).toBe(0);
      } finally {
        await upstreamB.stop(true);
        await upstreamC.stop(true);
      }
    });
  }, 10_000);
});

describe("combo response-path strategy accounting", () => {
  function responseRequest(): Request {
    return new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/free", input: "hello", stream: false }),
    });
  }

  function completion(label: string): Response {
    return Response.json({
      id: `chatcmpl-${label}`,
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: label }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }

  test("least-used counts successful response-path attempts", async () => {
    let aHits = 0;
    let bHits = 0;
    const upstreamA = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { aHits += 1; return completion("a"); } });
    const upstreamB = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { bHits += 1; return completion("b"); } });
    try {
      const config = baseConfig({
        providers: {
          a: { adapter: "openai-chat", baseUrl: `${upstreamA.url}v1`, allowPrivateNetwork: true, apiKey: "ka", models: ["m1"] },
          b: { adapter: "openai-chat", baseUrl: `${upstreamB.url}v1`, allowPrivateNetwork: true, apiKey: "kb", models: ["m2"] },
        },
        combos: { free: { strategy: "least-used", targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] } },
      });
      expect((await handleResponses(responseRequest(), config, { model: "", provider: "" })).status).toBe(200);
      expect((await handleResponses(responseRequest(), config, { model: "", provider: "" })).status).toBe(200);
      expect({ aHits, bHits }).toEqual({ aHits: 1, bHits: 1 });
    } finally {
      await upstreamA.stop(true);
      await upstreamB.stop(true);
    }
  }, 10_000);

  test("reset-window retries the next target and cools the failed target", async () => {
    let aHits = 0;
    let bHits = 0;
    const upstreamA = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() { aHits += 1; return Response.json({ error: { message: "busy" } }, { status: 429, headers: { "retry-after": "60" } }); },
    });
    const upstreamB = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { bHits += 1; return completion("b"); } });
    try {
      const config = baseConfig({
        providers: {
          a: { adapter: "openai-chat", baseUrl: `${upstreamA.url}v1`, allowPrivateNetwork: true, apiKey: "ka", models: ["m1"] },
          b: { adapter: "openai-chat", baseUrl: `${upstreamB.url}v1`, allowPrivateNetwork: true, apiKey: "kb", models: ["m2"] },
        },
        combos: { free: { strategy: "reset-window", targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] } },
      });
      const response = await handleResponses(responseRequest(), config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      expect({ aHits, bHits }).toEqual({ aHits: 1, bHits: 1 });
      expect(isComboTargetInCooldown("free", { provider: "a", model: "m1" })).toBe(true);
    } finally {
      await upstreamA.stop(true);
      await upstreamB.stop(true);
    }
  }, 10_000);
});
import { ManagementRequest as Request } from "./helpers/management-auth";
