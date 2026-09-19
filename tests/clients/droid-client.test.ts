import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPORT_CLIENTS,
  buildClientConfig,
  buildClientConfigText,
  buildClientContribution,
  droidConfigPath,
  droidHomeDir,
  summarizeDroid,
  type DroidGeneratedConfig,
  type ExportContext,
  type ExportModel,
} from "../../src/clients/config-export";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { refreshOwnedCatalogIntegrations } from "../../src/integrations/catalog-refresh";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import {
  applyIntegration,
  disableIntegration,
  restoreIntegration,
} from "../../src/integrations/writer";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const CONFIG = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;

const MODELS: ExportModel[] = [
  {
    namespaced: "anthropic/claude-fable-5-1",
    provider: "anthropic",
    id: "claude-fable-5-1",
    contextWindow: 200_000,
    inputModalities: ["text", "image"],
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
  },
  {
    namespaced: "cursor/composer-2.5-fast",
    provider: "cursor",
    id: "composer-2.5-fast",
    inputModalities: ["text"],
  },
  {
    namespaced: "mock/unknown",
    provider: "mock",
    id: "unknown",
    reasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "max",
  },
];

function context(models: readonly ExportModel[] = MODELS): ExportContext {
  return { baseUrl: "http://127.0.0.1:10100/v1", config: CONFIG, models };
}

let home: string;
let store: IntegrationStateStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-droid-"));
  store = createIntegrationStateStore(mkdtempSync(join(tmpdir(), "ocx-droid-store-")));
});

afterEach(() => {
  removeTreeWithRetry(home);
  removeTreeWithRetry(store.root);
});

function installDroid(seed?: string): string {
  const spec = INTEGRATION_CLIENTS.droid;
  mkdirSync(spec.detectDir({}, home), { recursive: true });
  const configPath = spec.configPath({}, home);
  if (seed !== undefined) writeFileSync(configPath, seed);
  return configPath;
}

function request(models: readonly ExportModel[] = MODELS) {
  return { clientId: "droid" as const, models, config: CONFIG, port: 10100, env: {}, home, store };
}

function readSettings(configPath: string): Record<string, unknown> & DroidGeneratedConfig {
  return JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown> & DroidGeneratedConfig;
}

describe("Factory Droid client config", () => {
  test("maps authoritative catalog metadata onto Factory customModels", () => {
    const document = buildClientConfig("droid", context()) as DroidGeneratedConfig;
    const fable = document.customModels.find(model => model.model === "anthropic/claude-fable-5-1")!;
    expect(fable).toEqual({
      id: "custom:opencodex:anthropic/claude-fable-5-1",
      model: "anthropic/claude-fable-5-1",
      displayName: "OpenCodex: Claude Fable 5.1",
      baseUrl: "http://127.0.0.1:10100/v1",
      provider: "generic-chat-completion-api",
      maxOutputTokens: 16_384,
      maxContextLimit: 200_000,
      noImageSupport: false,
      enableThinking: true,
      supportedReasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
      reasoningEffort: "medium",
    });
    const composer = document.customModels.find(model => model.model === "cursor/composer-2.5-fast")!;
    expect(composer.noImageSupport).toBe(true);
    expect("maxContextLimit" in composer).toBe(false);
    expect("enableThinking" in composer).toBe(false);
    const unknown = document.customModels.find(model => model.model === "mock/unknown")!;
    expect(unknown.supportedReasoningEfforts).toEqual(["low", "high"]);
    expect("defaultReasoningEffort" in unknown).toBe(false);
    expect("reasoningEffort" in unknown).toBe(false);
    for (const model of document.customModels) {
      expect("apiKey" in model).toBe(false);
      expect(model.maxOutputTokens).toBe(16_384);
    }
  });

  test("serializes JSON, summarizes limits, and never carries a configured secret", () => {
    const sentinel = ["sk", "live", "droid", "sentinel"].join("-");
    const built = buildClientConfigText("droid", {
      ...context(),
      config: { ...CONFIG, apiKeys: [{ key: sentinel }] } as OcxConfig,
    });
    expect(built.format).toBe("json");
    expect(JSON.parse(built.text)).toEqual(built.document);
    expect(built.text).not.toContain(sentinel);
    expect(summarizeDroid(built.document)).toEqual({ modelCount: 3, modelsWithoutLimits: 2 });
    expect(summarizeDroid(null)).toEqual({ modelCount: 0, modelsWithoutLimits: 0 });
  });

  test("owns one exact customModels row per stable id", () => {
    const contribution = buildClientContribution("droid", context());
    expect(contribution.clientId).toBe("droid");
    expect(contribution.fragments.map(fragment => fragment.path)).toEqual([
      ["customModels", "[id=custom:opencodex:anthropic/claude-fable-5-1]"],
      ["customModels", "[id=custom:opencodex:cursor/composer-2.5-fast]"],
      ["customModels", "[id=custom:opencodex:mock/unknown]"],
    ]);
  });

  test("uses Factory's canonical settings path and stays loopback-only", () => {
    expect(droidHomeDir({}, home)).toBe(join(home, ".factory"));
    expect(droidConfigPath({}, home)).toBe(join(home, ".factory", "settings.json"));
    expect(INTEGRATION_CLIENTS.droid.configPath({}, home)).toBe(droidConfigPath({}, home));
    expect(INTEGRATION_CLIENTS.droid.detectDir({}, home)).toBe(droidHomeDir({}, home));
    expect(EXPORT_CLIENTS.droid).toMatchObject({
      filename: "factory-settings.json",
      apiKeyEnv: "",
      format: "json",
      loopbackOnly: true,
    });
  });

  test("apply, default catalog refresh and disable preserve user settings and user models", async () => {
    const userModel = {
      id: "custom:user:local",
      model: "local",
      displayName: "Local",
      baseUrl: "http://127.0.0.1:11434/v1",
      provider: "generic-chat-completion-api",
    };
    const seed = JSON.stringify({ theme: "dark", customModels: [userModel] }, null, 2) + "\n";
    const configPath = installDroid(seed);
    expect(applyIntegration(request()).ok).toBe(true);
    expect(readSettings(configPath).customModels.map(model => model.id)).toEqual([
      userModel.id,
      ...MODELS.map(model => "custom:opencodex:" + model.namespaced).sort(),
    ]);
    const fewer = MODELS.slice(0, 2);
    expect(await refreshOwnedCatalogIntegrations({
      models: fewer,
      config: CONFIG,
      port: 10100,
      env: {},
      home,
      store,
    })).toEqual([{ client: "droid", ok: true, changed: true }]);
    const refreshed = readSettings(configPath);
    expect(refreshed.theme).toBe("dark");
    expect(refreshed.customModels[0]).toEqual(userModel);
    expect(refreshed.customModels.map(model => model.id)).not.toContain("custom:opencodex:mock/unknown");
    expect(disableIntegration(request(fewer)).ok).toBe(true);
    expect(readSettings(configPath)).toEqual({ theme: "dark", customModels: [userModel] });
  });

  test("restore returns the exact bytes that preceded apply", () => {
    const seed = '{\n  "theme": "dark",\n  "customModels": []\n}\n';
    const configPath = installDroid(seed);
    expect(applyIntegration(request()).ok).toBe(true);
    const opId = store.listOperations("droid")[0]!.opId;
    expect(restoreIntegration({ ...request(), opId }).ok).toBe(true);
    expect(readFileSync(configPath, "utf8")).toBe(seed);
  });

  test("refuses unsafe containers and non-loopback binds without changing the file", () => {
    const seed = '{"customModels":{}}\n';
    const configPath = installDroid(seed);
    expect(applyIntegration(request())).toMatchObject({ ok: false, reason: "unsafe" });
    expect(readFileSync(configPath, "utf8")).toBe(seed);
    expect(applyIntegration({
      ...request(),
      config: { ...CONFIG, hostname: "0.0.0.0" },
    })).toMatchObject({ ok: false, reason: "non_loopback" });
    expect(readFileSync(configPath, "utf8")).toBe(seed);
  });
});
