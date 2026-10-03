import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportModel } from "../../src/clients/config-export";
import { droidConfigPath } from "../../src/clients/config-export";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { readIntegrationState, readOwnedDroidReasoningDefaults } from "../../src/integrations/state";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { refreshOwnedCatalogIntegrations } from "../../src/integrations/catalog-refresh";
import { applyIntegration, disableIntegration, overwriteIntegration, restoreIntegration } from "../../src/integrations/writer";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const CONFIG = {
  port: 10100, hostname: "127.0.0.1", defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;
const MODEL: ExportModel = {
  namespaced: "mock/chat", provider: "mock", id: "chat", displayName: "Chat Model",
  reasoningEfforts: ["low", "high"], inputModalities: ["text"],
};
const HEADER = "x-opencodex-droid-default-effort";
let home: string;
let store: IntegrationStateStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-droid-effort-home-"));
  store = createIntegrationStateStore(mkdtempSync(join(tmpdir(), "ocx-droid-effort-store-")));
});

afterEach(() => {
  removeTreeWithRetry(home);
  removeTreeWithRetry(store.root);
});

function input(models: readonly ExportModel[] = [MODEL], extra: Partial<{ port: number; config: OcxConfig; droidReasoningDefaults: Record<string, string> }> = {}) {
  const port = extra.port ?? 10100;
  return {
    clientId: "droid" as const, models, config: extra.config ?? CONFIG, port,
    env: {}, home, store, ...("droidReasoningDefaults" in extra ? { droidReasoningDefaults: extra.droidReasoningDefaults } : {}),
  };
}

function install(): string {
  mkdirSync(INTEGRATION_CLIENTS.droid.detectDir({}, home), { recursive: true });
  const path = droidConfigPath({}, home);
  writeFileSync(path, '{"customModels":[]}\n');
  return path;
}

function settings(path: string): { customModels: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("Droid managed reasoning defaults", () => {
  test("persists on the owned row, clears explicitly, and restores with the prior settings", () => {
    const path = install();
    expect(applyIntegration({ ...input(), droidReasoningDefaults: { "mock/chat": "high" } }).ok).toBe(true);
    expect(settings(path).customModels[0]).toMatchObject({ extraHeaders: { [HEADER]: "high" } });
    expect(readIntegrationState(input()).state).toBe("current");
    expect(readOwnedDroidReasoningDefaults(input())).toEqual({ "mock/chat": "high" });

    expect(overwriteIntegration({ ...input(), droidReasoningDefaults: {} }).ok).toBe(true);
    expect(settings(path).customModels[0]).not.toHaveProperty("extraHeaders");
    const overwriteId = store.listOperations("droid")[0]!.opId;
    expect(restoreIntegration({ ...input(), opId: overwriteId })).toMatchObject({ ok: true, state: "current" });
    expect(settings(path).customModels[0]).toMatchObject({ extraHeaders: { [HEADER]: "high" } });
    expect(disableIntegration(input()).ok).toBe(true);
    expect(settings(path).customModels).toEqual([]);
    const disableId = store.listOperations("droid")[0]!.opId;
    expect(restoreIntegration({ ...input(), opId: disableId })).toMatchObject({ ok: true, state: "current" });
    expect(readIntegrationState(input()).state).toBe("current");
  });

  test("refresh keeps a selected effort through port, label, and capability changes", async () => {
    const path = install();
    expect(applyIntegration({ ...input(), droidReasoningDefaults: { "mock/chat": "high" } }).ok).toBe(true);
    const changedModel: ExportModel = {
      ...MODEL, displayName: "Renamed Chat", inputModalities: ["text", "image"], reasoningEfforts: ["high"],
    };
    const config = { ...CONFIG, port: 10101 };
    const results = await refreshOwnedCatalogIntegrations({
      models: [changedModel], config, port: 10101, env: {}, home, store,
    }, ["droid"]);
    expect(results).toEqual([{ client: "droid", ok: true, changed: true }]);
    expect(settings(path).customModels).toEqual([{
      model: "mock/chat", displayName: "OpenCodex: Renamed Chat", baseUrl: "http://127.0.0.1:10101/v1",
      provider: "generic-chat-completion-api", noImageSupport: false,
      extraHeaders: { [HEADER]: "high" },
    }]);
    expect(readOwnedDroidReasoningDefaults(input([changedModel], { port: 10101, config }))).toEqual({ "mock/chat": "high" });
  });

  test.each([
    ["incompatible", ["low"]],
    ["empty", []],
    ["unknown", undefined],
  ] as const)("refresh drops inherited defaults for a %s effort ladder and preserves compatible peers", async (_kind, efforts) => {
    const path = install();
    const peer: ExportModel = { ...MODEL, namespaced: "mock/peer", id: "peer" };
    expect(applyIntegration({ ...input([MODEL, peer]), droidReasoningDefaults: {
      "mock/chat": "high", "mock/peer": "low",
    } }).ok).toBe(true);
    const changedModel: ExportModel = { ...MODEL, reasoningEfforts: efforts === undefined ? undefined : [...efforts] };
    const models = [changedModel, peer];
    expect(readOwnedDroidReasoningDefaults(input(models))).toEqual({ "mock/peer": "low" });
    expect(readIntegrationState(input(models)).state).toBe("stale");

    expect(await refreshOwnedCatalogIntegrations({
      models, config: CONFIG, port: 10100, env: {}, home, store,
    }, ["droid"])).toEqual([{ client: "droid", ok: true, changed: true }]);
    const rows = settings(path).customModels;
    expect(rows.find(row => row.model === "mock/chat")).not.toHaveProperty("extraHeaders");
    expect(rows.find(row => row.model === "mock/peer")).toMatchObject({ extraHeaders: { [HEADER]: "low" } });
    expect(readOwnedDroidReasoningDefaults(input(models))).toEqual({ "mock/peer": "low" });
    expect(readIntegrationState(input(models)).state).toBe("current");
  });

  test.each([
    ["provider", { ...MODEL, namespaced: "renamed/chat", provider: "renamed" }],
    ["model", { ...MODEL, namespaced: "mock/renamed", id: "renamed" }],
    ["combo alias", { ...MODEL, namespaced: "combo/renamed", provider: "combo", id: "renamed" }],
  ] as const)("refresh clears a selected effort after a %s selector rename", async (_kind, changedModel) => {
    const path = install();
    expect(applyIntegration({ ...input(), droidReasoningDefaults: { "mock/chat": "high" } }).ok).toBe(true);

    const results = await refreshOwnedCatalogIntegrations({
      models: [changedModel], config: CONFIG, port: 10100, env: {}, home, store,
    }, ["droid"]);

    expect(results).toEqual([{ client: "droid", ok: true, changed: true }]);
    expect(settings(path).customModels).toEqual([{
      model: changedModel.namespaced, displayName: "OpenCodex: Chat Model",
      baseUrl: "http://127.0.0.1:10100/v1", provider: "generic-chat-completion-api",
      noImageSupport: true,
    }]);
    expect(readOwnedDroidReasoningDefaults(input([changedModel]))).toEqual({});
  });

  test("a changed owned header remains a conflict and is not projected as ours", () => {
    const path = install();
    expect(applyIntegration({ ...input(), droidReasoningDefaults: { "mock/chat": "high" } }).ok).toBe(true);
    const document = settings(path);
    document.customModels[0]!.extraHeaders = { [HEADER]: "low" };
    writeFileSync(path, JSON.stringify(document));

    expect(readIntegrationState(input()).state).toBe("conflict");
    expect(readOwnedDroidReasoningDefaults(input())).toEqual({});
    expect(applyIntegration(input()).ok).toBe(false);
    expect(settings(path).customModels[0]).toMatchObject({ extraHeaders: { [HEADER]: "low" } });
  });

  test.each(["model", "endpoint"])("ambiguous legacy %s rows suppress defaults for resolved and unresolved paths", (collision) => {
    const path = install();
    expect(applyIntegration({ ...input(), droidReasoningDefaults: { "mock/chat": "high" } }).ok).toBe(true);
    const detectDir = INTEGRATION_CLIENTS.droid.detectDir({}, home);
    writeFileSync(join(detectDir, "config.json"), JSON.stringify({ custom_models: [{
      display_name: "Personal",
      model: collision === "model" ? "mock/chat" : "another/model",
      base_url: collision === "endpoint" ? "http://localhost:10100/v1" : "http://localhost:11434/v1",
    }] }));
    for (const target of [input(), { ...input(), resolvedPaths: { configPath: path, detectDir } }]) {
      expect(readIntegrationState(target).state).toBe("unsafe");
      expect(readOwnedDroidReasoningDefaults(target)).toEqual({});
    }
  });

  test("foreign rows with a matching model name do not supply inherited defaults", () => {
    const path = install();
    const foreign = {
      model: "mock/chat", displayName: "Personal", baseUrl: "http://localhost:11434/v1",
      provider: "generic-chat-completion-api", extraHeaders: { [HEADER]: "high" },
    };
    writeFileSync(path, JSON.stringify({ customModels: [foreign] }));
    expect(readOwnedDroidReasoningDefaults(input())).toEqual({});
    expect(readIntegrationState(input()).state).toBe("absent");
  });
});
