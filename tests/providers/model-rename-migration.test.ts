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
import { providerConfigSeed } from "../../src/providers/derive";
import { reconcileOAuthProviders } from "../../src/oauth";
import {
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_MODEL_CONTEXT_WINDOWS,
} from "../../src/providers/antigravity-models";
import { getConfigPath, loadConfig, saveConfig, setPersistedConfigMutationBeforeCommitForTests } from "../../src/config";
import type { OcxConfig } from "../../src/types";
import { routeModel } from "../../src/router";
import { requestPacingIntervalMs } from "../../src/providers/request-pacing";
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

  test("repairs a saved kimi row still defaulting to the retired k2.7 id", () => {
    // The shape a config saved under the pre-K2.8 registry carries: the picker list,
    // the context-window record and the default all name kimi-k2.7-code, and the old
    // registry already seeded kimi-for-coding rows next to them.
    const stale = {
      providers: {
        kimi: {
          adapter: "openai-chat",
          baseUrl: "https://api.kimi.com/coding/v1",
          authMode: "oauth",
          defaultModel: "kimi-k2.7-code",
          models: ["k3", "k3[1m]", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5", "kimi-for-coding"],
          modelContextWindows: { "kimi-k2.7-code": 262_144, "kimi-for-coding": 262_144 },
          noReasoningModels: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5", "kimi-for-coding"],
          modelReasoningEfforts: { "kimi-k2.7-code": [], "kimi-for-coding": [] },
          modelDefaultReasoningEfforts: { k3: "max" },
          modelReasoningEffortMap: { k3: { high: "high" } },
        },
      },
    } as unknown as OcxConfig;

    const { config, changed } = projectModelRenames(stale, MODEL_RENAMES);
    const prov = config.providers.kimi!;
    expect(changed).toBe(true);
    expect(prov.defaultModel).toBe("kimi-for-coding");
    expect(prov.models).toEqual(["k3", "k3[1m]", "kimi-for-coding"]);
    expect(prov.modelContextWindows).toEqual({ "kimi-for-coding": 1_048_576 });
    expect(prov.noReasoningModels).toEqual([]);
    expect(prov.modelReasoningEfforts).toEqual({ "kimi-for-coding": ["low", "high", "max"] });
    expect(prov.modelDefaultReasoningEfforts).toEqual({ k3: "max", "kimi-for-coding": "max" });
    expect(prov.modelReasoningEffortMap?.["kimi-for-coding"]).toEqual({
      none: "none", low: "low", medium: "high", high: "high", xhigh: "max", max: "max",
    });
  });

  test("repairs the kimi-code key preset row the same way", () => {
    const stale = {
      providers: {
        "kimi-code": {
          adapter: "openai-chat",
          baseUrl: "https://api.kimi.com/coding/v1",
          authMode: "key",
          apiKey: "sk-test",
          defaultModel: "kimi-k2.7-code",
          models: ["k3", "k3[1m]", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5", "kimi-for-coding"],
        },
      },
    } as unknown as OcxConfig;

    const { config, changed } = projectModelRenames(stale, MODEL_RENAMES);
    const prov = config.providers["kimi-code"]!;
    expect(changed).toBe(true);
    expect(prov.defaultModel).toBe("kimi-for-coding");
    expect(prov.models).toEqual(["k3", "k3[1m]", "kimi-for-coding"]);
  });

  test("renamed operator aliases, wire policy and nested pacing remain effective", () => {
    const from = "kimi-k2.7-code", to = "kimi-for-coding";
    const stale = { defaultProvider: "kimi-code", providers: { "kimi-code": {
      adapter: "openai-chat", baseUrl: "https://api.kimi.com/coding/v1", apiKey: "fixture-key",
      models: [from], modelAliases: { [from]: "work" },
      modelAdapters: { [from]: "openai-responses" }, modelCapabilities: { [from]: { inputModalities: ["text"] } },
      modelMaxInputTokens: { [from]: 12345 }, modelPinnedReasoningEfforts: { [from]: "high" },
      autoReviewModelOverrides: { [from]: "reviewer/model" },
      requestPacing: { enabled: true, models: { [from]: { minIntervalMs: 125 } } },
      noStructuredOutputModels: [from], requiresReasoningPlaceholderModels: [from],
    } } } as unknown as OcxConfig;
    const { config, changed } = projectModelRenames(stale);
    expect(changed).toBe(true);
    const prov = config.providers["kimi-code"]!;
    const route = routeModel(config, "kimi-code/work");
    expect(route.modelId).toBe(to);
    expect(route.staticPolicy.model.adapter).toBe("openai-responses");
    expect(route.staticPolicy.model.inputModalities).toEqual(["text"]);
    expect(route.staticPolicy.model.maxInputTokens).toBe(12345);
    expect(prov.modelPinnedReasoningEfforts).toEqual({ [to]: "high" });
    expect(prov.autoReviewModelOverrides).toEqual({ [to]: "reviewer/model" });
    expect(requestPacingIntervalMs(prov, to)).toBe(125);
    expect(prov.requestPacing?.models?.[from]).toBeUndefined();
    expect(prov.noStructuredOutputModels).toEqual([to]);
    expect(prov.requiresReasoningPlaceholderModels).toEqual([to]);
    expect(projectModelRenames(config).changed).toBe(false);
  });

  test("newer target alias and nested pacing win during a rename", () => {
    const from = "kimi-k2.7-code", to = "kimi-for-coding";
    const stale = { providers: { "kimi-code": {
      adapter: "openai-chat", baseUrl: "https://api.kimi.com/coding/v1",
      modelAliases: { [from]: "old", [to]: "new" },
      autoReviewModelOverrides: { [from]: "reviewer/old", [to]: "reviewer/new" },
      requestPacing: { enabled: true, minIntervalMs: 10, models: {
        [from]: { minIntervalMs: 125 }, [to]: { minIntervalMs: 250 },
      } },
    } } } as unknown as OcxConfig;
    const prov = projectModelRenames(stale).config.providers["kimi-code"]!;
    expect(prov.modelAliases).toEqual({ [to]: "new" });
    expect(prov.autoReviewModelOverrides).toEqual({ [to]: "reviewer/new" });
    expect(prov.requestPacing?.minIntervalMs).toBe(10);
    expect(prov.requestPacing?.models).toEqual({ [to]: { minIntervalMs: 250 } });
  });

  test("preserves explicit kimi-for-coding metadata while retiring old ids", () => {
    const stale = {
      providers: {
        kimi: {
          adapter: "openai-chat",
          baseUrl: "https://api.kimi.com/coding/v1",
          authMode: "oauth",
          defaultModel: "kimi-k2.6",
          models: ["kimi-k2.6", "kimi-for-coding"],
          modelContextWindows: { "kimi-k2.6": 262_144, "kimi-for-coding": 131_072 },
          modelReasoningEfforts: { "kimi-k2.6": [], "kimi-for-coding": ["low"] },
          modelDefaultReasoningEfforts: { "kimi-for-coding": "low" },
          modelReasoningEffortMap: { "kimi-for-coding": { medium: "low" } },
        },
      },
    } as unknown as OcxConfig;

    const { config } = projectModelRenames(stale, MODEL_RENAMES);
    const prov = config.providers.kimi!;
    expect(prov.defaultModel).toBe("kimi-for-coding");
    expect(prov.models).toEqual(["kimi-for-coding"]);
    expect(prov.modelContextWindows?.["kimi-for-coding"]).toBe(131_072);
    expect(prov.modelReasoningEfforts?.["kimi-for-coding"]).toEqual(["low"]);
    expect(prov.modelDefaultReasoningEfforts?.["kimi-for-coding"]).toBe("low");
    expect(prov.modelReasoningEffortMap?.["kimi-for-coding"]).toEqual({ medium: "low" });
  });

  test("clears a stale no-reasoning classification saved under the live alias alone", () => {
    // A config saved by the pre-K2.8 registry can carry kimi-for-coding in
    // noReasoningModels even after every retired id is gone from the row - the old
    // registry seeded the alias there. With no `from` left to rename, the stale
    // classification would survive and keep the picker disabled; the drop must
    // therefore trigger on the replacement id alone.
    const stale = {
      providers: {
        kimi: {
          adapter: "openai-chat",
          baseUrl: "https://api.kimi.com/coding/v1",
          authMode: "oauth",
          defaultModel: "kimi-for-coding",
          models: ["k3", "k3[1m]", "kimi-for-coding"],
          noReasoningModels: ["kimi-for-coding"],
          modelReasoningEfforts: { "kimi-for-coding": [] },
        },
      },
    } as unknown as OcxConfig;

    const { config, changed } = projectModelRenames(stale, MODEL_RENAMES);
    const prov = config.providers.kimi!;
    expect(changed).toBe(true);
    expect(prov.noReasoningModels).toEqual([]);
    expect(prov.modelReasoningEfforts?.["kimi-for-coding"]).toEqual(["low", "high", "max"]);
  });

  test("preserves an explicit no-reasoning override on the live alias", () => {
    const configured = {
      providers: {
        kimi: {
          adapter: "openai-chat",
          baseUrl: "https://api.kimi.com/coding/v1",
          authMode: "oauth",
          defaultModel: "kimi-for-coding",
          models: ["k3", "k3[1m]", "kimi-for-coding"],
          noReasoningModels: ["kimi-for-coding"],
          modelReasoningEfforts: { "kimi-for-coding": ["low"] },
        },
      },
    } as unknown as OcxConfig;

    const { config, changed } = projectModelRenames(configured, MODEL_RENAMES);
    expect(changed).toBe(false);
    expect(config.providers.kimi?.noReasoningModels).toEqual(["kimi-for-coding"]);
  });

  test("leaves a kimi row repointed at a different gateway alone", () => {
    const custom = {
      providers: {
        kimi: {
          adapter: "openai-chat",
          baseUrl: "https://my-proxy.internal/v1",
          authMode: "oauth",
          defaultModel: "kimi-k2.7-code",
          models: ["kimi-k2.7-code"],
        },
      },
    } as unknown as OcxConfig;
    const { changed } = projectModelRenames(custom, MODEL_RENAMES);
    expect(changed).toBe(false);
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

// ── Issue #5066: the migration has to converge, not re-announce itself on every boot ──
//
// The reporter saw the same nine `[model-rename-migration]` lines at every `ocx start`. Nothing
// in the projection, the persistence or the in-memory fallback was broken; the migration was
// losing to the second half of its own boot. `startServer` runs it and then
// `reconcileOAuthProviders`, and the Antigravity OAuth preset carries
// `ANTIGRAVITY_MODEL_CONTEXT_WINDOWS`, which derives a window for every compatibility alias —
// all nine retired Flash ids among them. `applyOAuthPresetCatalog` copies that record over the
// saved one whenever the two differ, so reconciliation restored precisely the keys the rename
// had removed, and the next boot found them and said so again.
//
// It also explains the count: nine messages for a user who never chose nine models, because the
// ids came from the registry rather than from anything they had selected.
describe("registry-seeded metadata does not re-arm the rename (#5066)", () => {
  const homes: string[] = [];
  const originalHome = process.env.OPENCODEX_HOME;

  function isolate(prefix: string): void {
    const home = mkdtempSync(join(tmpdir(), prefix));
    homes.push(home);
    process.env.OPENCODEX_HOME = home;
  }

  afterEach(() => {
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalHome;
    for (const home of homes.splice(0)) removeTreeWithRetry(home);
  });

  /**
   * A saved Antigravity row carrying one genuinely stale user selection.
   *
   * `modelContextWindows` is deliberately absent. The point of the fixture is to watch
   * reconciliation introduce it between the two boots rather than to assume it is there.
   */
  function antigravityRow(): Record<string, unknown> {
    return {
      adapter: "google",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      authMode: "oauth",
      googleMode: "cloud-code-assist",
      liveModels: true,
      defaultModel: "gemini-3.8-flash",
      models: [...ANTIGRAVITY_MODELS],
      // Reconciliation does not carry `selectedModels`, so this one is the migration’s to fix
      // — once.
      selectedModels: ["gemini-3.6-flash-high"],
    };
  }

  function antigravityConfig(): OcxConfig {
    return {
      port: 10100,
      defaultProvider: "google-antigravity",
      providers: { "google-antigravity": antigravityRow() },
    } as unknown as OcxConfig;
  }

  /** The rename lines a boot prints, in order. */
  function renameLines(boot: () => void): string[] {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      boot();
      return warn.mock.calls
        .map(([first]) => (typeof first === "string" ? first : ""))
        .filter(line => line.startsWith("[model-rename-migration] renamed "));
    } finally {
      warn.mockRestore();
    }
  }

  // RED on dev, at the last assertion: the second boot reprints nine lines, and so does the
  // third, and every one after it.
  test("the second boot after reconciliation renames nothing and prints nothing", () => {
    isolate("ocx-antigravity-rename-loop-");
    saveConfig(antigravityConfig());

    // Boot one, in startServer’s order: migrate, then reconcile the OAuth presets.
    const first = renameLines(() => {
      reconcileOAuthProviders(runModelRenameStartupMigration(loadConfig()));
    });
    expect(first).toHaveLength(1);
    expect(first.join("\n")).toContain("google-antigravity/gemini-3.6-flash-high");

    const afterFirstBoot = loadConfig().providers["google-antigravity"]!;
    // The writer between the two boots, caught in the act: reconciliation put the registry’s
    // own record on disk, retired keys and all. The next boot must not read that as a repair
    // the user is still owed.
    expect(Object.keys(afterFirstBoot.modelContextWindows ?? {})).toContain("gemini-3.6-flash");
    // What the migration did own stayed fixed.
    expect(afterFirstBoot.selectedModels).toEqual(["gemini-3.7-flash"]);

    const second = renameLines(() => { runModelRenameStartupMigration(loadConfig()); });
    expect(second).toEqual([]);
  });

  test("a registry-published id survives in metadata while a user selection is still repaired", () => {
    const reconciled = {
      ...antigravityRow(),
      modelContextWindows: { ...ANTIGRAVITY_MODEL_CONTEXT_WINDOWS },
    };
    const config = { providers: { "google-antigravity": reconciled } } as unknown as OcxConfig;

    const { config: out, changed, warnings } = projectModelRenames(config);
    const prov = out.providers["google-antigravity"]!;

    expect(changed).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(prov.selectedModels).toEqual(["gemini-3.7-flash"]);
    // Left alone on purpose: a request that still names the retired id routes to 3.7 and needs
    // a window under the id it asked for, and reconciliation would rewrite this record anyway.
    expect(prov.modelContextWindows?.["gemini-3.6-flash"]).toBe(1_048_576);
  });

  // The general form of the defect, applied to every rename this file ships: a provider row the
  // registry itself produced must never be something the migration wants to rewrite. When it is,
  // the two halves of the boot disagree forever and the user pays for it in log noise.
  const seedCases: [string, ModelRename][] = MODEL_RENAMES.map(
    rename => [`${rename.provider}/${rename.from}`, rename],
  );
  test.each(seedCases)("the registry seed for %s is not something the migration rewrites", (_label, rename) => {
    const entry = PROVIDER_REGISTRY.find(row => row.id === rename.provider);
    expect(entry, `registry entry missing for ${rename.provider}`).toBeDefined();
    const seeded = {
      providers: { [rename.provider]: providerConfigSeed(entry!) },
    } as unknown as OcxConfig;

    const { changed, warnings } = projectModelRenames(seeded, [rename]);

    expect(warnings).toEqual([]);
    expect(changed).toBe(false);
  });
});
