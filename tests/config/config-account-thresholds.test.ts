import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, getDefaultConfig, loadConfig, readConfigDiagnostics, saveConfig, validateConfigCandidate } from "../../src/config";
import { removeTreeWithRetry } from "../helpers/remove-tree";
let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-config-"));
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

  test("config candidates preserve valid account thresholds and reject malformed maps", () => {
    const base = getDefaultConfig();

    expect(validateConfigCandidate({
      ...base,
      codexAccountAutoSwitchThresholds: { work: 0, __main__: 100 },
    })).toMatchObject({
      ok: true,
      config: expect.objectContaining({
        codexAccountAutoSwitchThresholds: { work: 0, __main__: 100 },
      }),
    });
    for (const thresholds of [
      { work: -1 },
      { work: 101 },
      { work: 1.5 },
      { work: "80" },
      { work: 80, broken: "90" },
      { "bad id!": 80 },
      [],
    ]) {
      expect(validateConfigCandidate({
        ...base,
        codexAccountAutoSwitchThresholds: thresholds,
      })).toMatchObject({
        ok: false,
        error: expect.stringContaining("codexAccountAutoSwitchThresholds"),
      });
    }
  });


describe("codex account usage-threshold overrides", () => {
  function writeThresholdConfig(codexAccountAutoSwitchThresholds: unknown): void {
    writeConfig({
      port: 10100,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
      defaultProvider: "openai",
      codexAccountAutoSwitchThresholds,
    });
  }

  test("round-trips pool and main-account thresholds including zero", () => {
    const thresholds = { work: 0, __main__: 100 };
    writeThresholdConfig(thresholds);

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.error).toBeNull();
    expect(diagnostics.source).toBe("file");
    expect(diagnostics.config.codexAccountAutoSwitchThresholds).toEqual(thresholds);
  });

  test("degrades a malformed map without discarding providers", () => {
    writeThresholdConfig({ work: 101 });

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("file");
    expect(diagnostics.error).toBeNull();
    expect(diagnostics.config.codexAccountAutoSwitchThresholds).toBeUndefined();
    expect(Object.keys(diagnostics.config.providers)).toContain("openai");
    expect(backupNames()).toHaveLength(0);
    expect(diagnostics.warnings).toContainEqual(expect.stringContaining("per-account usage thresholds are disabled"));
  });

  test("retains valid thresholds after a malformed neighbor and unrelated port save", () => {
    writeThresholdConfig({ work: 80, broken: "90" });

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.config.codexAccountAutoSwitchThresholds).toEqual({ work: 80 });
    expect(diagnostics.warnings).toContainEqual(expect.stringContaining("invalid entries were ignored"));

    const loaded = loadConfig();
    loaded.port = 10101;
    saveConfig(loaded);
    const persisted = JSON.parse(readFileSync(getConfigPath(), "utf-8"));
    expect(persisted.port).toBe(10101);
    expect(persisted.codexAccountAutoSwitchThresholds).toEqual({ work: 80 });
    expect(backupNames()).toHaveLength(0);
  });

  test("rejects non-boolean priority failback writes but degrades hand edits to false", () => {
    expect(validateConfigCandidate({ ...getDefaultConfig(), codexAccountPriorityFailback: true }).ok).toBe(true);
    const candidate = { ...getDefaultConfig(), codexAccountPriorityFailback: "true" };
    expect(validateConfigCandidate(candidate)).toEqual({
      ok: false,
      error: "schema_invalid: codexAccountPriorityFailback: must be a boolean or omitted",
    });

    writeConfig(candidate);
    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("file");
    expect(diagnostics.error).toBeNull();
    expect(diagnostics.config.codexAccountPriorityFailback).toBe(false);
    expect(Object.keys(diagnostics.config.providers)).toContain("openai");
    expect(backupNames()).toHaveLength(0);
  });
});
