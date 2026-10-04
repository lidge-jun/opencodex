import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportModel } from "../../src/clients/config-export";
import { droidConfigPath } from "../../src/clients/config-export";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { readIntegrationState, readOwnedDroidReasoningDefaults } from "../../src/integrations/state";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { applyIntegration, overwriteIntegration } from "../../src/integrations/writer";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const CONFIG = {
  port: 10100, hostname: "127.0.0.1", defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;
const MODELS: ExportModel[] = [
  {
    namespaced: "mock/swe-2", provider: "mock", id: "swe-2", displayName: "SWE-2",
    reasoningEfforts: ["low", "medium", "high", "max"], inputModalities: ["text"],
  },
  {
    namespaced: "mock/spark", provider: "mock", id: "spark", displayName: "Spark",
    reasoningEfforts: ["low", "medium", "high", "max"], inputModalities: ["text"],
  },
];
const MAX_DEFAULTS = { "mock/swe-2": "max", "mock/spark": "max" };
const HEADER = "x-opencodex-droid-default-effort";
type DroidDocument = { customModels: Array<Record<string, unknown>> };
let home: string;
let store: IntegrationStateStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-droid-normalized-home-"));
  store = createIntegrationStateStore(mkdtempSync(join(tmpdir(), "ocx-droid-normalized-store-")));
});

afterEach(() => {
  removeTreeWithRetry(home);
  removeTreeWithRetry(store.root);
});

function input(
  models: readonly ExportModel[] = MODELS,
  extra: Partial<{ port: number; config: OcxConfig; droidReasoningDefaults: Record<string, string> }> = {},
) {
  const port = extra.port ?? 10100;
  return {
    clientId: "droid" as const, models, config: extra.config ?? CONFIG, port,
    env: {}, home, store,
    ...(extra.droidReasoningDefaults === undefined ? {} : { droidReasoningDefaults: extra.droidReasoningDefaults }),
  };
}

function install(): string {
  mkdirSync(INTEGRATION_CLIENTS.droid.detectDir({}, home), { recursive: true });
  const path = droidConfigPath({}, home);
  writeFileSync(path, '{"customModels":[]}\n');
  return path;
}

function settings(path: string): DroidDocument {
  return JSON.parse(readFileSync(path, "utf8")) as DroidDocument;
}

function writeSettings(path: string, document: DroidDocument): void {
  writeFileSync(path, `${JSON.stringify(document)}\n`);
}

function addDroidRowMetadata(path: string): void {
  const document = settings(path);
  document.customModels = document.customModels.map((row, index) => ({
    ...row, id: `custom:opencodex:${index}`, index,
  }));
  writeSettings(path, document);
}

function stripOptionalOwnershipMetadata(): void {
  const record = store.readRecords().droid;
  if (!record) throw new Error("Droid apply did not create an ownership record");
  const legacy = { ...record };
  delete legacy.semanticBlockFingerprint;
  delete legacy.protectedBlockFingerprint;
  delete legacy.semanticProtectedBlockFingerprint;
  delete legacy.refreshablePaths;
  store.putRecord(legacy);
}

function changedInput() {
  const models = MODELS.map(model => ({ ...model, displayName: `${model.displayName} refreshed` }));
  const config = { ...CONFIG, port: 10101 };
  return input(models, { port: 10101, config });
}

function expectMaxDefaults(document: DroidDocument): void {
  expect(document.customModels).toHaveLength(MODELS.length);
  for (const model of MODELS) {
    const row = document.customModels.find(candidate => candidate.model === model.namespaced);
    expect(row?.extraHeaders).toEqual({ [HEADER]: "max" });
  }
}

describe("Droid normalized reasoning defaults", () => {
  test("keeps max defaults current through Droid id/index normalization and overwrite", () => {
    const path = install();
    expect(applyIntegration({ ...input(), droidReasoningDefaults: MAX_DEFAULTS }).ok).toBe(true);
    addDroidRowMetadata(path);

    expect(readIntegrationState(input()).state).toBe("current");
    expect(readOwnedDroidReasoningDefaults(input())).toEqual(MAX_DEFAULTS);

    expect(overwriteIntegration(changedInput())).toMatchObject({ ok: true, changed: true, state: "current" });
    expectMaxDefaults(settings(path));
    expect(settings(path).customModels.map(row => row.baseUrl)).toEqual([
      "http://127.0.0.1:10101/v1", "http://127.0.0.1:10101/v1",
    ]);
  });

  test("legacy ownership projects normalized rows before catalog and port drift", () => {
    const path = install();
    expect(applyIntegration({ ...input(), droidReasoningDefaults: MAX_DEFAULTS }).ok).toBe(true);
    addDroidRowMetadata(path);
    stripOptionalOwnershipMetadata();

    const changed = changedInput();
    expect(readOwnedDroidReasoningDefaults(changed)).toEqual(MAX_DEFAULTS);
    expect(readIntegrationState(changed).state).toBe("stale");
    expect(overwriteIntegration(changed)).toMatchObject({ ok: true, changed: true, state: "current" });
    expectMaxDefaults(settings(path));
  });

  test.each([
    ["an arbitrary row field", (row: Record<string, unknown>) => { row.notes = "foreign"; }],
    ["the endpoint", (row: Record<string, unknown>) => { row.baseUrl = "http://foreign.invalid/v1"; }],
    ["an api key", (row: Record<string, unknown>) => { row.apiKey = "foreign-secret"; }],
    ["the effort header", (row: Record<string, unknown>) => { row.extraHeaders = { [HEADER]: "high" }; }],
    ["an unrelated header", (row: Record<string, unknown>) => {
      row.extraHeaders = { [HEADER]: "max", "x-user-header": "foreign" };
    }],
  ] as const)("keeps %s as a conflict and does not adopt its default", (_kind, edit) => {
    const path = install();
    expect(applyIntegration({ ...input(), droidReasoningDefaults: MAX_DEFAULTS }).ok).toBe(true);
    addDroidRowMetadata(path);
    const document = settings(path);
    edit(document.customModels[0]!);
    writeSettings(path, document);

    expect(readIntegrationState(input()).state).toBe("conflict");
    expect(readOwnedDroidReasoningDefaults(input())).toEqual({});
    expect(applyIntegration(input())).toMatchObject({ ok: false, reason: "conflict" });
  });
});
