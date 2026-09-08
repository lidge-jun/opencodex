import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getConfigPath,
  loadConfig,
  saveConfig,
  setPersistedConfigMutationBeforeCommitForTests,
} from "../../src/config";
import { OAUTH_PROVIDERS, reconcileOAuthProviders, upsertOAuthProvider } from "../../src/oauth";
import { getCredential, saveCredential } from "../../src/oauth/store";
import { routeModel } from "../../src/router";
import { CURSOR_NO_VISION_MODELS, CURSOR_STATIC_MODELS, cursorModelIds } from "../../src/adapters/cursor/discovery";
import { modelInList } from "../../src/types";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalHome = process.env.OPENCODEX_HOME;
const homes: string[] = [];

afterEach(() => {
  setPersistedConfigMutationBeforeCommitForTests(null);
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  for (const home of homes.splice(0)) removeTreeWithRetry(home);
});

describe("OAuth provider reconciliation", () => {
  test("heals a stale Cursor all-models noVisionModels stamp down to the curated list", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-cursor-novision-reconcile-"));
    homes.push(home);
    process.env.OPENCODEX_HOME = home;
    const preset = OAUTH_PROVIDERS.cursor.providerConfig;
    const stale = cursorModelIds(CURSOR_STATIC_MODELS);
    expect(stale.length).toBeGreaterThan((preset.noVisionModels ?? []).length);
    const config = {
      port: 10100,
      defaultProvider: "cursor",
      providers: {
        cursor: {
          ...structuredClone(preset),
          authMode: "oauth",
          noVisionModels: [...stale],
        },
      },
    } satisfies OcxConfig;
    saveConfig(config);

    expect(reconcileOAuthProviders(config)).toBe(true);
    expect(config.providers.cursor.noVisionModels).toEqual(preset.noVisionModels);
    expect(config.providers.cursor.noVisionModels).toEqual([...CURSOR_NO_VISION_MODELS]);
    expect(config.providers.cursor.noVisionModels).not.toContain("grok-4.5");
    expect(config.providers.cursor.noVisionModels).toContain("auto");
    expect(modelInList(config.providers.cursor.noVisionModels, "composer-2.5")).toBe(true);
    expect(reconcileOAuthProviders(config)).toBe(false);
  });

  // RED on dev (#3524): dev mutates the live object then calls saveConfig(config), so the
  // startup snapshot overwrites whatever an operator wrote after loadConfig() returned.
  test("rebases startup reconciliation over a concurrent provider edit", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-oauth-reconcile-race-"));
    homes.push(home);
    process.env.OPENCODEX_HOME = home;
    const preset = OAUTH_PROVIDERS.cursor.providerConfig;
    const config = {
      port: 10100,
      defaultProvider: "cursor",
      providers: {
        cursor: {
          ...structuredClone(preset),
          authMode: "oauth",
          noVisionModels: cursorModelIds(CURSOR_STATIC_MODELS),
        },
      },
    } satisfies OcxConfig;
    saveConfig(config);
    setPersistedConfigMutationBeforeCommitForTests(() => {
      const concurrent = loadConfig();
      concurrent.providers.cursor.note = "concurrent-operator-edit";
      writeFileSync(getConfigPath(), JSON.stringify(concurrent, null, 2) + "\n");
    });

    expect(reconcileOAuthProviders(config)).toBe(true);

    expect(config.providers.cursor.noVisionModels).toEqual(preset.noVisionModels);
    expect(config.providers.cursor.note).toBe("concurrent-operator-edit");
    const persisted = loadConfig();
    expect(persisted.providers.cursor.noVisionModels).toEqual(preset.noVisionModels);
    expect(persisted.providers.cursor.note).toBe("concurrent-operator-edit");
  });

  // #3524 threw here, on a call site startServer() does not guard. Reconciliation is a
  // best-effort startup refresh: an unwritable config must degrade, never kill boot.
  test("a config removed between load and reconcile warns and degrades to an in-memory apply", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-oauth-reconcile-unavailable-"));
    homes.push(home);
    process.env.OPENCODEX_HOME = home;
    const preset = OAUTH_PROVIDERS.cursor.providerConfig;
    const config = {
      port: 10100,
      defaultProvider: "cursor",
      providers: {
        cursor: {
          ...structuredClone(preset),
          authMode: "oauth",
          noVisionModels: cursorModelIds(CURSOR_STATIC_MODELS),
        },
      },
    } satisfies OcxConfig;
    saveConfig(config);
    rmSync(getConfigPath());
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      let changed: boolean | undefined;
      expect(() => { changed = reconcileOAuthProviders(config); }).not.toThrow();
      expect(changed).toBe(true);
      // The running process still gets a correct catalog even though nothing was written.
      expect(config.providers.cursor.noVisionModels).toEqual(preset.noVisionModels);
      expect(warn.mock.calls.some(([first]) => typeof first === "string"
        && first.includes("OAuth provider reconciliation could not be persisted (missing)"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("a malformed config degrades without writing and without throwing", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-oauth-reconcile-invalid-"));
    homes.push(home);
    process.env.OPENCODEX_HOME = home;
    const preset = OAUTH_PROVIDERS.cursor.providerConfig;
    const config = {
      port: 10100,
      defaultProvider: "cursor",
      providers: {
        cursor: {
          ...structuredClone(preset),
          authMode: "oauth",
          noVisionModels: cursorModelIds(CURSOR_STATIC_MODELS),
        },
      },
    } satisfies OcxConfig;
    saveConfig(config);
    writeFileSync(getConfigPath(), "{ this is not json");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(reconcileOAuthProviders(config)).toBe(true);
      expect(config.providers.cursor.noVisionModels).toEqual(preset.noVisionModels);
      expect(warn.mock.calls.some(([first]) => typeof first === "string"
        && first.includes("OAuth provider reconciliation could not be persisted"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("a fresh install with nothing to reconcile neither writes nor warns", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-oauth-reconcile-fresh-"));
    homes.push(home);
    process.env.OPENCODEX_HOME = home;
    const config = {
      port: 10100,
      defaultProvider: "cursor",
      providers: { cursor: { ...structuredClone(OAUTH_PROVIDERS.cursor.providerConfig), authMode: "oauth" } },
    } satisfies OcxConfig;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // No config.json on disk at all: an unchanged projection must short-circuit before
      // persistence is ever consulted, so "missing" never becomes a startup warning.
      expect(reconcileOAuthProviders(config)).toBe(false);
      expect(warn.mock.calls.some(([first]) => typeof first === "string"
        && first.includes("OAuth provider reconciliation"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test("persist=false adopts the projection in memory and leaves the file untouched", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-oauth-reconcile-no-persist-"));
    homes.push(home);
    process.env.OPENCODEX_HOME = home;
    const preset = OAUTH_PROVIDERS.cursor.providerConfig;
    const config = {
      port: 10100,
      defaultProvider: "cursor",
      providers: {
        cursor: {
          ...structuredClone(preset),
          authMode: "oauth",
          noVisionModels: cursorModelIds(CURSOR_STATIC_MODELS),
        },
      },
    } satisfies OcxConfig;
    saveConfig(config);
    const before = Bun.file(getConfigPath());
    const beforeBytes = before.size;

    expect(reconcileOAuthProviders(config, false)).toBe(true);
    expect(config.providers.cursor.noVisionModels).toEqual(preset.noVisionModels);
    expect(Bun.file(getConfigPath()).size).toBe(beforeBytes);
  });

  test("an untouched provider row keeps its live object identity across reconciliation", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-oauth-reconcile-identity-"));
    homes.push(home);
    process.env.OPENCODEX_HOME = home;
    const preset = OAUTH_PROVIDERS.cursor.providerConfig;
    const config = {
      port: 10100,
      defaultProvider: "cursor",
      providers: {
        cursor: {
          ...structuredClone(preset),
          authMode: "oauth",
          noVisionModels: cursorModelIds(CURSOR_STATIC_MODELS),
        },
        untouched: {
          adapter: "openai",
          baseUrl: "http://127.0.0.1:9999/v1",
          allowPrivateNetwork: true,
          models: ["local-live"],
        },
      },
    } satisfies OcxConfig;
    saveConfig(config);
    const liveUntouched = config.providers.untouched;

    expect(reconcileOAuthProviders(config)).toBe(true);
    // A wholesale clear-and-reassign would silently detach every reference a caller still
    // holds; only the rows the projection actually changed may be replaced.
    expect(config.providers.untouched).toBe(liveUntouched);
  });
  test("refreshes a saved Antigravity live catalog without touching credentials or user fields", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-gemini-36-reconcile-"));
    homes.push(home);
    process.env.OPENCODEX_HOME = home;
    await saveCredential("google-antigravity", {
      access: "sentinel-access",
      refresh: "sentinel-refresh",
      expires: Date.now() + 60_000,
      projectId: "sentinel-project",
    });
    const config = {
      port: 10100,
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          authMode: "oauth",
          googleMode: "cloud-code-assist",
          defaultModel: "gemini-3.5-flash-low",
          models: ["gemini-3.5-flash-low", "gemini-3.5-flash-high"],
          modelContextWindows: { "gemini-3.5-flash-low": 1_048_576 },
          project: "config-project-sentinel",
          note: "user-owned-note",
          liveModels: true,
        },
      },
    } satisfies OcxConfig;
    saveConfig(config);

    expect(reconcileOAuthProviders(config)).toBe(true);
    const provider = config.providers["google-antigravity"];
    expect(provider.defaultModel).toBe("gemini-3.5-flash-low");
    expect(provider.models).toEqual([
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.1-pro",
      "gemini-3.1-flash-image",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ]);
    expect(provider.models).not.toContain("gemini-3.5-flash-low");
    expect(provider.models).not.toContain("gemini-3.6-flash");
    expect(provider.models).not.toContain("gemini-3.6-flash-low");
    expect(provider.models).not.toContain("gemini-3.6-flash-medium");
    expect(provider.models).not.toContain("gemini-3.6-flash-high");
    expect(provider.modelContextWindows?.["gemini-3.8-flash"]).toBe(1_048_576);
    expect(provider.modelContextWindows?.["gemini-3.7-flash"]).toBe(1_048_576);
    expect(provider.liveModels).toBe(true);
    expect(provider.project).toBe("config-project-sentinel");
    expect(provider.note).toBe("user-owned-note");
    expect(getCredential("google-antigravity")).toMatchObject({
      access: "sentinel-access",
      refresh: "sentinel-refresh",
      projectId: "sentinel-project",
    });

    const persisted = loadConfig();
    expect(persisted.providers["google-antigravity"]?.defaultModel).toBe("gemini-3.5-flash-low");
    expect(persisted.providers["google-antigravity"]?.liveModels).toBe(true);
    expect(reconcileOAuthProviders(config)).toBe(false);
  });

  test("migrates the version-1 canonical Antigravity static row to live discovery", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-antigravity-static-reconcile-"));
    homes.push(home);
    process.env.OPENCODEX_HOME = home;
    const config = {
      port: 10100,
      defaultProvider: "google-antigravity",
      googleAntigravityStaticCatalogVersion: 1,
      providers: {
        "google-antigravity": {
          // The literal v1 seed, not today's preset: the migration fingerprints the shape
          // that actually shipped in version 1, which is now a retired model list.
          ...structuredClone(OAUTH_PROVIDERS["google-antigravity"].providerConfig),
          defaultModel: "gemini-3.6-flash",
          models: [
            "gemini-3.6-flash",
            "gemini-3.1-pro",
            "gemini-3.1-flash-image",
            "claude-sonnet-4-6",
            "claude-opus-4-6-thinking",
            "gpt-oss-120b-medium",
          ],
          liveModels: false,
        },
      },
    } satisfies OcxConfig;
    saveConfig(config);

    expect(reconcileOAuthProviders(config)).toBe(true);
    expect(config.providers["google-antigravity"].liveModels).toBe(true);
    expect(config.googleAntigravityStaticCatalogVersion).toBe(2);

    upsertOAuthProvider(config, "google-antigravity");
    expect(config.providers["google-antigravity"].liveModels).toBe(true);
    expect(config.providers["google-antigravity"].models).toHaveLength(7);
  });

  test("an explicit 3.7 default survives the 3.8 launch while its capabilities refresh", () => {
    // The earlier live-discovery case preserves an id outside the static seed. This case
    // preserves a still-listed choice during an additive catalog rollout, while refreshing
    // its capability records.
    const home = mkdtempSync(join(tmpdir(), "ocx-antigravity-explicit-default-"));
    homes.push(home);
    process.env.OPENCODEX_HOME = home;
    saveCredential("google-antigravity", { access: "a", refresh: "r", projectId: "p" });
    const config = {
      port: 10100,
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          authMode: "oauth",
          googleMode: "cloud-code-assist",
          defaultModel: "gemini-3.7-flash",
          models: ["gemini-3.7-flash"],
          liveModels: true,
        },
      },
    } satisfies OcxConfig;
    saveConfig(config);

    reconcileOAuthProviders(config);
    const provider = config.providers["google-antigravity"];

    expect(provider.defaultModel).toBe("gemini-3.7-flash");
    expect(provider.models).toContain("gemini-3.7-flash");
    expect(provider.models).toContain("gemini-3.8-flash");
    // Capability records still refresh from the registry — preservation is about the
    // user's CHOICE, not about freezing the row.
    expect(provider.modelReasoningEfforts?.["gemini-3.8-flash"]).toEqual(["low", "medium", "high"]);
  });

  test("does not validate a live-models default against the static preset", () => {
    const config = {
      port: 10100,
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": {
          ...structuredClone(OAUTH_PROVIDERS["google-antigravity"].providerConfig),
          authMode: "oauth",
          liveModels: true,
          models: ["account-specific-model"],
          defaultModel: "account-specific-model",
        },
      },
    } satisfies OcxConfig;

    expect(reconcileOAuthProviders(config, false)).toBe(true);
    expect(config.providers["google-antigravity"].defaultModel).toBe("account-specific-model");

    upsertOAuthProvider(config, "google-antigravity");
    expect(config.providers["google-antigravity"].defaultModel).toBe("account-specific-model");
  });

  test.each(["reconcile", "upsert"] as const)("%s heals an obsolete static default without enabling live discovery", operation => {
    const preset = OAUTH_PROVIDERS["google-antigravity"].providerConfig;
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": {
          ...structuredClone(preset),
          liveModels: false,
          defaultModel: "retired-static-model",
          models: ["retired-static-model"],
        },
      },
    };

    if (operation === "reconcile") expect(reconcileOAuthProviders(config, false)).toBe(true);
    else upsertOAuthProvider(config, "google-antigravity");

    const provider = config.providers["google-antigravity"]!;
    expect(provider.liveModels).toBe(false);
    expect(provider.defaultModel).toBe(preset.defaultModel);
    expect(provider.models).toEqual(preset.models);
    expect(reconcileOAuthProviders(config, false)).toBe(false);
  });

  test("preserves an explicit Antigravity static opt-out without the legacy migration marker", () => {
    const config = {
      port: 10100,
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": {
          ...structuredClone(OAUTH_PROVIDERS["google-antigravity"].providerConfig),
          liveModels: false,
        },
      },
    } satisfies OcxConfig;

    expect(reconcileOAuthProviders(config)).toBe(false);
    upsertOAuthProvider(config, "google-antigravity");
    expect(config.providers["google-antigravity"].liveModels).toBe(false);
  });

  test("preserves explicit Antigravity live discovery when authMode is omitted or non-OAuth", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-antigravity-authmode-reconcile-"));
    homes.push(home);
    process.env.OPENCODEX_HOME = home;
    const preset = OAUTH_PROVIDERS["google-antigravity"].providerConfig;

    for (const authMode of [undefined, "key"] as const) {
      const provider = {
        ...structuredClone(preset),
        liveModels: true,
        defaultModel: "gemini-3.5-flash-low",
        models: ["gemini-3.5-flash-low", "gemini-3.5-flash-high"],
      };
      if (authMode === undefined) delete provider.authMode;
      else provider.authMode = authMode;
      const config = {
        port: 10100,
        defaultProvider: "google-antigravity",
        providers: { "google-antigravity": provider },
      } satisfies OcxConfig;

      expect(reconcileOAuthProviders(config)).toBe(false);
      const migrated = config.providers["google-antigravity"];
      expect(migrated.liveModels).toBe(true);
      expect(migrated.defaultModel).toBe("gemini-3.5-flash-low");
      expect(migrated.models).toEqual(["gemini-3.5-flash-low", "gemini-3.5-flash-high"]);
      expect(migrated.authMode).toBe(authMode);
    }
  });

  test("preserves Antigravity live discovery during re-login", () => {
    const config = {
      port: 10100,
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": {
          ...structuredClone(OAUTH_PROVIDERS["google-antigravity"].providerConfig),
          liveModels: true,
        },
      },
    } satisfies OcxConfig;

    upsertOAuthProvider(config, "google-antigravity");
    expect(config.providers["google-antigravity"].liveModels).toBe(true);

    config.providers["google-antigravity"].liveModels = true;
    config.providers["google-antigravity"].authMode = "key";
    upsertOAuthProvider(config, "google-antigravity");
    expect(config.providers["google-antigravity"].liveModels).toBe(true);

    config.providers["google-antigravity"].authMode = undefined;
    upsertOAuthProvider(config, "google-antigravity");
    expect(config.providers["google-antigravity"].liveModels).toBe(true);
  });

  test("preserves an explicit requiresReasoningPlaceholderModels opt-out on OAuth providers", () => {
    // No OAuth preset seeds the new field, so reconcile must never delete an
    // explicit `[]` opt-out on startup (chatgpt-codex-connector P2 on #1205).
    const config = {
      port: 10100,
      defaultProvider: "kimi",
      googleAntigravityStaticCatalogVersion: 1,
      providers: {
        kimi: {
          ...structuredClone(OAUTH_PROVIDERS.kimi.providerConfig),
          requiresReasoningPlaceholderModels: [],
        },
      },
    } satisfies OcxConfig;

    reconcileOAuthProviders(config, false);
    expect(config.providers.kimi.requiresReasoningPlaceholderModels).toEqual([]);
  });

  test("refreshes Grok 4.6 levels while runtime fills the default without overwriting user intent", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-grok-46-reconcile-"));
    homes.push(home);
    process.env.OPENCODEX_HOME = home;
    const staleXai = structuredClone(OAUTH_PROVIDERS.xai.providerConfig);
    staleXai.modelReasoningEfforts = {
      "grok-4.6": ["low", "medium", "high"],
      "grok-4.5": ["low", "medium", "high"],
    };
    delete staleXai.modelDefaultReasoningEfforts;
    const config = {
      port: 10100,
      defaultProvider: "xai",
      providers: {
        xai: {
          ...staleXai,
          note: "user-owned-note",
        },
      },
    } satisfies OcxConfig;
    saveConfig(config);

    expect(reconcileOAuthProviders(config)).toBe(true);
    expect(config.providers.xai.modelReasoningEfforts?.["grok-4.6"])
      .toEqual(["low", "medium", "high", "xhigh"]);
    expect(config.providers.xai.modelDefaultReasoningEfforts).toBeUndefined();
    expect(routeModel(config, "xai/grok-4.6").provider.modelDefaultReasoningEfforts?.["grok-4.6"])
      .toBe("high");
    expect(config.providers.xai.note).toBe("user-owned-note");
    expect(reconcileOAuthProviders(config)).toBe(false);

    config.providers.xai.modelDefaultReasoningEfforts = { "grok-4.6": "medium" };
    expect(reconcileOAuthProviders(config)).toBe(false);
    expect(routeModel(config, "xai/grok-4.6").provider.modelDefaultReasoningEfforts?.["grok-4.6"])
      .toBe("medium");
  });
});
