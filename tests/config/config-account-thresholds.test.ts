import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, getDefaultConfig, readConfigDiagnostics, validateConfigCandidate } from "../../src/config";
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
});
