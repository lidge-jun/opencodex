import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configStore from "../../src/config";
import { getConfigPath, getDefaultConfig, loadConfig, readConfigDiagnostics, saveConfig } from "../../src/config";
import { DEFAULT_SUBAGENT_MODELS, migrateSubagentModels } from "../../src/config/subagent-models";
import { migrateStartupSubagentModels } from "../../src/server/subagent-models-startup";
import { runClaudeAuthModeMigration } from "../../src/claude/auth-mode-migration";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Moved from config.test.ts, which sits at its file-size cap.
let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-subagent-roster-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  delete process.env.OPENCODEX_HOME;
  if (testDir && existsSync(testDir)) removeTreeWithRetry(testDir);
  testDir = "";
});

function backupNames(): string[] {
  return readdirSync(testDir).filter(name => name.startsWith("config.json.invalid-"));
}

function writeConfig(content: unknown): void {
  writeFileSync(
    getConfigPath(),
    typeof content === "string" ? content : JSON.stringify(content),
    "utf-8",
  );
}

describe("subagent roster defaults and one-time upgrades", () => {
  const defaults = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"];
  const v1Defaults = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"];

  test("fresh defaults are the GPT-6 trio, already marked", () => {
    const config = getDefaultConfig();
    expect(DEFAULT_SUBAGENT_MODELS).toEqual(defaults);
    expect(config.subagentModels).toEqual(defaults);
    expect(config.subagentModelsVersion).toBe(2);
    expect(migrateSubagentModels(config)).toBe(false);
    config.subagentModels!.pop();
    expect(DEFAULT_SUBAGENT_MODELS).toEqual(defaults);
  });

  test.each([
    // The Astra step turns this pre-Astra default into the v1 default, which continues to the trio.
    [["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini"], defaults],
    [["one", "two", "three", "four", "five"], ["gpt-6-astra", "one", "two", "three", "four"]],
    [["one", "two", "three", "four", "gpt-5.5"], ["gpt-6-astra", "one", "two", "three", "four"]],
    [["one", "gpt-6-astra", "gpt-6-astra", "gpt-5.5", "two"], ["gpt-6-astra", "one", "two"]],
    [["pool/gpt-6-astra", "gpt-5.5"], ["gpt-6-astra", "pool/gpt-6-astra"]],
    [[], ["gpt-6-astra"]],
  ])("upgrades legacy roster %j once", (before, expected) => {
    const config = getDefaultConfig();
    delete config.subagentModelsVersion;
    config.subagentModels = [...before];
    expect(migrateSubagentModels(config)).toBe(true);
    expect(config.subagentModels).toEqual(expected);
    expect(config.subagentModelsVersion).toBe(2);
    expect(migrateSubagentModels(config)).toBe(false);
    expect(config.subagentModels).toEqual(expected);
  });

  test("the untouched version-1 default moves to the GPT-6 trio once", () => {
    const config = { ...getDefaultConfig(), subagentModels: [...v1Defaults], subagentModelsVersion: 1 };
    expect(migrateSubagentModels(config)).toBe(true);
    expect(config.subagentModels).toEqual(defaults);
    expect(config.subagentModelsVersion).toBe(2);
    config.subagentModels = [...v1Defaults];
    expect(migrateSubagentModels(config)).toBe(false);
    expect(config.subagentModels).toEqual(v1Defaults);
  });

  test.each([
    // Sol and Luna move to their GPT-6 rows in place; Terra and 5.5 leave.
    [["gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"], ["gpt-6-sol", "gpt-6-astra", "gpt-6-luna"]],
    // A successor already on the list is not added twice; every 5.5/5.6 variant leaves.
    [["gpt-6-astra", "gpt-5.6-sol", "gpt-6-sol", "gpt-5.5-pro"], ["gpt-6-astra", "gpt-6-sol"]],
    // Routed and account-qualified ids keep their exact spelling, 5.x suffix or not.
    [["gpt-6-astra", "custom/model", "cursor/gpt-5.6-sol", "pool/gpt-5.5"], ["gpt-6-astra", "custom/model", "cursor/gpt-5.6-sol", "pool/gpt-5.5"]],
    // A list of only retired rows receives the defaults rather than becoming empty.
    [["gpt-5.5", "gpt-5.6-terra"], ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]],
    // Ids that name Object.prototype members are ordinary strings, not lookup hits.
    [["constructor", "toString", "gpt-5.5"], ["constructor", "toString"]],
    // An explicitly empty roster stays empty.
    [[], []],
  ])("a version-1 roster %j sheds retired 5.x rows as %j", (before, expected) => {
    const config = { ...getDefaultConfig(), subagentModels: [...before], subagentModelsVersion: 1 };
    expect(migrateSubagentModels(config)).toBe(true);
    expect(config.subagentModels).toEqual(expected);
    expect(config.subagentModelsVersion).toBe(2);
    expect(migrateSubagentModels(config)).toBe(false);
  });

  test("unset legacy roster uses the new defaults", () => {
    const config = getDefaultConfig();
    delete config.subagentModels;
    delete config.subagentModelsVersion;
    expect(migrateSubagentModels(config)).toBe(true);
    expect(config.subagentModels).toEqual(defaults);
  });

  test.each([2, 3])("version %i preserves later user choices across save/load", version => {
    for (const chosen of [[], ["gpt-5.5", "custom/model"]]) {
      saveConfig({ ...getDefaultConfig(), subagentModels: chosen, subagentModelsVersion: version });
      const config = loadConfig();
      migrateStartupSubagentModels(config);
      expect(config.subagentModels).toEqual(chosen);
      expect(loadConfig().subagentModels).toEqual(chosen);
      expect(loadConfig().subagentModelsVersion).toBe(version);
    }
  });

  test.each([null, "bad", ["one", 2], [""]].map(roster => ({ roster })))("invalid roster %j does not discard providers", ({ roster }) => {
    writeConfig({ ...getDefaultConfig(), subagentModels: roster, subagentModelsVersion: "invalid" });
    const config = loadConfig();
    expect(config.providers.openai).toEqual(getDefaultConfig().providers.openai);
    expect(config.subagentModels).toBeUndefined();
    expect(migrateSubagentModels(config)).toBe(true);
    expect(config.subagentModels).toEqual(defaults);
    expect(backupNames()).toEqual([]);
  });

  test.each([undefined, 1, 2])("repair does not invent migration version %j", version => {
    writeConfig({ subagentModels: ["one", "two"], subagentModelsVersion: version });
    for (const config of [loadConfig(), readConfigDiagnostics().config]) {
      expect(config.subagentModelsVersion).toBe(version);
      expect(migrateSubagentModels(config)).toBe(version !== 2);
      expect(config.subagentModels).toEqual(version === undefined ? ["gpt-6-astra", "one", "two"] : ["one", "two"]);
    }
  });

  test("picker preset provenance round-trips independently of the roster", () => {
    const config = { ...getDefaultConfig(), subagentModels: ["saved/model"],
      modelPickerOrder: ["provider/two", "provider/one"], modelPickerOrderMode: "most-used" as const };
    saveConfig(config);
    const loaded = loadConfig();
    expect(loaded.modelPickerOrder).toEqual(config.modelPickerOrder);
    expect(loaded.modelPickerOrderMode).toBe("most-used");
    expect(loaded.subagentModels).toEqual(["saved/model"]);
    delete loaded.modelPickerOrder;
    delete loaded.modelPickerOrderMode;
    saveConfig(loaded);
    expect(loadConfig().modelPickerOrder).toBeUndefined();
    expect(loadConfig().modelPickerOrderMode).toBeUndefined();
    expect(loadConfig().subagentModels).toEqual(["saved/model"]);
  });

  test("startup upgrades the newest disk roster and preserves unrelated disk edits", () => {
    const legacy = { ...getDefaultConfig(), subagentModelsVersion: undefined, subagentModels: ["old"], claudeCode: {}, modelPickerOrder: ["old/model"] };
    saveConfig(legacy);
    const stale = loadConfig();
    saveConfig({ ...legacy, subagentModels: ["new", "gpt-5.5"], port: 23456, modelPickerOrder: undefined });
    const migrated = migrateStartupSubagentModels(stale);
    expect(migrated.subagentModels).toEqual(["gpt-6-astra", "new"]);
    expect(loadConfig().subagentModels).toEqual(migrated.subagentModels);
    expect(loadConfig().subagentModelsVersion).toBe(2);
    expect(loadConfig().port).toBe(23456);
    // Another process loaded before the first upgrade; it must not shift again.
    expect(migrateStartupSubagentModels(legacy).subagentModels).toEqual(migrated.subagentModels);
    // The real subsequent startup migration saves the returned whole document.
    expect(runClaudeAuthModeMigration(migrated)).toBe(true);
    saveConfig(migrated);
    expect(loadConfig().port).toBe(23456);
    expect(loadConfig().modelPickerOrder).toBeUndefined();
    expect(loadConfig().subagentModels).toEqual(migrated.subagentModels);
  });

  test("unavailable persistence leaves malformed disk bytes untouched", () => {
    const legacy = { ...getDefaultConfig(), subagentModelsVersion: undefined, subagentModels: ["one"] };
    writeConfig("{ invalid");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const migrated = migrateStartupSubagentModels(legacy);
      expect(migrated.subagentModels).toEqual(["gpt-6-astra", "one"]);
      expect(readFileSync(getConfigPath(), "utf8")).toBe("{ invalid");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("a failed persistence transaction does not abort startup", () => {
    const legacy = { ...getDefaultConfig(), subagentModelsVersion: undefined, subagentModels: ["one"] };
    saveConfig(legacy);
    const before = readFileSync(getConfigPath(), "utf8");
    const mutation = spyOn(configStore, "mutatePersistedConfig").mockImplementation(() => {
      throw new Error("private filesystem path must not be logged");
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const migrated = migrateStartupSubagentModels(legacy);
      expect(migrated.subagentModels).toEqual(["gpt-6-astra", "one"]);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
      expect(warn).toHaveBeenCalledWith("[subagent-models-migration] Persistence failed; using the upgraded roster in memory only.");
    } finally {
      mutation.mockRestore();
      warn.mockRestore();
    }
  });
});
