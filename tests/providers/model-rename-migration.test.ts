import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MODEL_RENAMES,
  projectModelRenames,
  type ModelRename,
} from "../../src/providers/model-rename-migration";
import { runModelRenameStartupMigration } from "../../src/providers/model-rename-startup";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { getConfigPath, loadConfig, saveConfig, setPersistedConfigMutationBeforeCommitForTests } from "../../src/config";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const INTL_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

const RENAME: ModelRename = {
  provider: "alibaba-token-plan-intl",
  from: "qwen3.8-max-preview",
  to: "qwen3.8-max",
  reason: "test",
};

/** The exact shape a config saved before d40367c0c carries (issue #1610). */
function staleConfig(): OcxConfig {
  return {
    providers: {
      "alibaba-token-plan-intl": {
        adapter: "openai-chat",
        baseUrl: INTL_BASE_URL,
        authMode: "key",
        apiKey: "sk-test",
        defaultModel: "qwen3.7-max",
        models: ["qwen3.8-max-preview", "qwen3.7-max", "glm-5.2"],
        liveModels: false,
        modelContextWindows: { "qwen3.8-max-preview": 983_616, "qwen3.7-max": 1_000_000 },
        modelInputModalities: { "qwen3.8-max-preview": ["text", "image"] },
        modelReasoningEfforts: { "qwen3.8-max-preview": ["low", "high", "xhigh"] },
        modelDefaultReasoningEfforts: { "qwen3.8-max-preview": "xhigh" },
        preserveReasoningContentModels: ["glm-5.2", "qwen3.8-max-preview", "qwen3.7-max"],
        thinkingBudgetModels: ["qwen3.8-max-preview", "qwen3.7-max"],
        retainModels: ["qwen3.8-max-preview"],
      },
    },
    disabledModels: ["alibaba-token-plan-intl/qwen3.8-max-preview", "other/model"],
  } as unknown as OcxConfig;
}

describe("registry model rename migration (#1610)", () => {
  test("rewrites every model-keyed field, preserving list order", () => {
    const { config, changed, warnings } = projectModelRenames(staleConfig(), [RENAME]);
    const prov = config.providers["alibaba-token-plan-intl"]!;

    expect(changed).toBe(true);
    expect(JSON.stringify(config)).not.toContain("qwen3.8-max-preview");

    // Order matters: the renamed id keeps its slot rather than moving to the end.
    expect(prov.models).toEqual(["qwen3.8-max", "qwen3.7-max", "glm-5.2"]);
    expect(prov.modelContextWindows?.["qwen3.8-max"]).toBe(983_616);
    expect(prov.modelInputModalities?.["qwen3.8-max"]).toEqual(["text", "image"]);
    expect(prov.modelReasoningEfforts?.["qwen3.8-max"]).toEqual(["low", "high", "xhigh"]);
    expect(prov.modelDefaultReasoningEfforts?.["qwen3.8-max"]).toBe("xhigh");
    expect(prov.preserveReasoningContentModels).toEqual(["glm-5.2", "qwen3.8-max", "qwen3.7-max"]);
    expect(prov.thinkingBudgetModels).toEqual(["qwen3.8-max", "qwen3.7-max"]);
    expect(prov.retainModels).toEqual(["qwen3.8-max"]);
    expect(warnings.some(w => w.includes("qwen3.8-max"))).toBe(true);
  });

  test("drops the retired disabledModels row instead of disabling the supported id", () => {
    const { config } = projectModelRenames(staleConfig(), [RENAME]);
    // Carrying the toggle across would hide the model the rename exists to expose.
    expect(config.disabledModels).toEqual(["other/model"]);
  });

  test("promotes a defaultModel that names the retired id", () => {
    const stale = staleConfig();
    stale.providers["alibaba-token-plan-intl"]!.defaultModel = "qwen3.8-max-preview";
    const { config } = projectModelRenames(stale, [RENAME]);
    expect(config.providers["alibaba-token-plan-intl"]!.defaultModel).toBe("qwen3.8-max");
  });

  test("is a no-op for a config that already uses the supported id", () => {
    const clean = staleConfig();
    const prov = clean.providers["alibaba-token-plan-intl"]!;
    prov.models = ["qwen3.8-max", "qwen3.7-max"];
    prov.modelContextWindows = { "qwen3.8-max": 983_616 };
    prov.modelInputModalities = {};
    prov.modelReasoningEfforts = {};
    prov.modelDefaultReasoningEfforts = {};
    prov.preserveReasoningContentModels = ["qwen3.8-max"];
    prov.thinkingBudgetModels = ["qwen3.7-max"];
    prov.retainModels = ["qwen3.8-max"];
    clean.disabledModels = ["other/model"];

    const { changed, warnings } = projectModelRenames(clean, [RENAME]);
    expect(changed).toBe(false);
    expect(warnings).toEqual([]);
  });

  test("leaves a row repointed at a different vendor alone", () => {
    const custom = staleConfig();
    // The user aimed this provider name at their own gateway; its ids are theirs.
    custom.providers["alibaba-token-plan-intl"]!.baseUrl = "https://my-proxy.internal/v1";
    const { config, changed } = projectModelRenames(custom, [RENAME]);
    expect(changed).toBe(false);
    expect(config.providers["alibaba-token-plan-intl"]!.models).toContain("qwen3.8-max-preview");
  });

  test("refuses to write an id the registry does not seed", () => {
    const bogus: ModelRename = { ...RENAME, to: "qwen-does-not-exist" };
    const { changed, warnings } = projectModelRenames(staleConfig(), [bogus]);
    expect(changed).toBe(false);
    expect(warnings.some(w => w.includes("no longer seeds"))).toBe(true);
  });

  test("collapses a duplicate when both ids are already present", () => {
    const both = staleConfig();
    both.providers["alibaba-token-plan-intl"]!.models = ["qwen3.8-max-preview", "qwen3.8-max", "qwen3.7-max"];
    const { config } = projectModelRenames(both, [RENAME]);
    expect(config.providers["alibaba-token-plan-intl"]!.models).toEqual(["qwen3.8-max", "qwen3.7-max"]);
  });

  test("does nothing when the provider is not configured", () => {
    const empty = { providers: {} } as unknown as OcxConfig;
    expect(projectModelRenames(empty, [RENAME]).changed).toBe(false);
  });

  test("every shipped rename targets an id the registry actually seeds", () => {
    for (const rename of MODEL_RENAMES) {
      const entry = PROVIDER_REGISTRY.find(row => row.id === rename.provider);
      expect(entry, `registry entry missing for ${rename.provider}`).toBeDefined();
      expect(entry?.models, `${rename.provider} seeds no models`).toBeDefined();
      expect(entry?.models).toContain(rename.to);
      // A rename whose source id is still seeded would fight the registry.
      expect(entry?.models).not.toContain(rename.from);
    }
  });
});

describe("model rename startup persistence", () => {
  const homes: string[] = [];
  const originalHome = process.env.OPENCODEX_HOME;

  function isolate(prefix: string): void {
    const home = mkdtempSync(join(tmpdir(), prefix));
    homes.push(home);
    process.env.OPENCODEX_HOME = home;
  }

  /** A saved config the renames actually rewrite, valid enough for loadConfig to accept. */
  function persistableStale(): OcxConfig {
    return { port: 10100, defaultProvider: "alibaba-token-plan-intl", ...staleConfig() } as OcxConfig;
  }

  afterEach(() => {
    setPersistedConfigMutationBeforeCommitForTests(null);
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalHome;
    for (const home of homes.splice(0)) removeTreeWithRetry(home);
  });

  test("startup no-op preserves the live config object identity", () => {
    const clean = projectModelRenames(staleConfig(), [RENAME]).config;
    const returned = runModelRenameStartupMigration(clean, {
      project: config => projectModelRenames(config, [RENAME]),
      save: () => { throw new Error("no-op must not save"); },
    });

    expect(returned).toBe(clean);
  });

  test("startup no-op still reports projection warnings", () => {
    const clean = projectModelRenames(staleConfig(), [RENAME]).config;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const returned = runModelRenameStartupMigration(clean, {
        project: config => ({ config, changed: false, warnings: ["rename target is unavailable"] }),
        save: () => { throw new Error("no-op must not save"); },
      });

      expect(returned).toBe(clean);
      expect(warn).toHaveBeenCalledWith("[model-rename-migration] rename target is unavailable");
    } finally {
      warn.mockRestore();
    }
  });

  // RED on dev: dev hands `projectModelRenames` the live object and saves the projection
  // wholesale, so an operator edit written after loadConfig() is silently discarded.
  test("rebases the startup rename over a concurrent provider edit", () => {
    isolate("ocx-model-rename-race-");
    const live = persistableStale();
    saveConfig(live);
    setPersistedConfigMutationBeforeCommitForTests(() => {
      const concurrent = loadConfig();
      concurrent.providers["alibaba-token-plan-intl"]!.note = "concurrent-operator-edit";
      writeFileSync(getConfigPath(), JSON.stringify(concurrent, null, 2) + "\n");
    });

    const returned = runModelRenameStartupMigration(live);

    expect(returned).toBe(live);
    expect(live.providers["alibaba-token-plan-intl"]!.models).toContain("qwen3.8-max");
    expect(live.providers["alibaba-token-plan-intl"]!.note).toBe("concurrent-operator-edit");
    const persisted = loadConfig();
    expect(persisted.providers["alibaba-token-plan-intl"]!.models).toContain("qwen3.8-max");
    expect(persisted.providers["alibaba-token-plan-intl"]!.note).toBe("concurrent-operator-edit");
  });

  // #3524 threw here, on the unguarded startServer() call site at src/server/index.ts:651.
  test("a config removed between load and migrate warns and degrades to an in-memory apply", () => {
    isolate("ocx-model-rename-unavailable-");
    const live = persistableStale();
    saveConfig(live);
    rmSync(getConfigPath());
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      let returned: OcxConfig | undefined;
      expect(() => { returned = runModelRenameStartupMigration(live); }).not.toThrow();

      expect(returned).toBe(live);
      expect(live.providers["alibaba-token-plan-intl"]!.models).toContain("qwen3.8-max");
      expect(warn.mock.calls.some(([first]) => typeof first === "string"
        && first.includes("[model-rename-migration] persistence unavailable (missing)"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("a malformed config degrades without throwing", () => {
    isolate("ocx-model-rename-invalid-");
    const live = persistableStale();
    saveConfig(live);
    writeFileSync(getConfigPath(), "{ this is not json");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => runModelRenameStartupMigration(live)).not.toThrow();
      expect(live.providers["alibaba-token-plan-intl"]!.models).toContain("qwen3.8-max");
      expect(warn.mock.calls.some(([first]) => typeof first === "string"
        && first.includes("[model-rename-migration] persistence unavailable"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("a fresh install with nothing to rename neither writes nor warns about persistence", () => {
    isolate("ocx-model-rename-fresh-");
    const clean = projectModelRenames(persistableStale()).config;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(runModelRenameStartupMigration(clean)).toBe(clean);
      expect(warn.mock.calls.some(([first]) => typeof first === "string"
        && first.includes("persistence unavailable"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test("an untouched top-level branch keeps its live object identity across the migration", () => {
    isolate("ocx-model-rename-identity-");
    const live = persistableStale();
    live.providers.untouched = {
      adapter: "openai",
      baseUrl: "http://127.0.0.1:9999/v1",
      allowPrivateNetwork: true,
      models: ["local-live"],
    };
    saveConfig(live);
    const liveUntouched = live.providers.untouched;

    runModelRenameStartupMigration(live);

    // adoptConfig copies key by key, so a reference a caller still holds to an unchanged
    // branch survives; a clear-and-reassign would silently detach it.
    expect(live.providers.untouched).toBe(liveUntouched);
  });
});
