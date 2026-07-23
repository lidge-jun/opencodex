import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  compareCodexVersions,
  displayCodexRuntimePath,
  effortClampAppliesToRuntime,
  loadLastEffortClamp,
  loadPersistedCodexRuntime,
  parseCodexVersionOutput,
  persistCodexRuntime,
  persistEffortClamp,
  resolveAndPersistCodexRuntime,
  resolveCodexRuntime,
  resetCodexRuntimeResolveCacheForTests,
  type RuntimeExecFile,
} from "../src/codex/runtime";

function tempConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "ocx-runtime-"));
}

describe("parseCodexVersionOutput / compareCodexVersions", () => {
  test("parses dotted and prerelease versions", () => {
    expect(parseCodexVersionOutput("codex-cli 0.133.0")).toBe("0.133.0");
    expect(parseCodexVersionOutput("0.145.0-alpha.30")).toBe("0.145.0-alpha.30");
  });

  test("orders prerelease identifiers numerically", () => {
    expect(compareCodexVersions("0.133.0", "0.145.0-alpha.30")).toBeLessThan(0);
    expect(compareCodexVersions("0.145.0", "0.145.0-alpha.30")).toBeGreaterThan(0);
    expect(compareCodexVersions("0.145.0-alpha.9", "0.145.0-alpha.30")).toBeLessThan(0);
    expect(compareCodexVersions("0.145.0-alpha-1", "0.145.0-alpha-2")).toBeLessThan(0);
    expect(compareCodexVersions("0.145.0-alpha.1.beta", "0.145.0-alpha.1.beta.1")).toBeLessThan(0);
  });
});

describe("resolveCodexRuntime", () => {
  test("CODEX_CLI_PATH overrides all other sources when valid", () => {
    const configDir = tempConfigDir();
    writeFileSync(join(configDir, "codex-runtime.json"), JSON.stringify({
      version: 1,
      command: "C:\\old\\codex.exe",
      source: "configured",
      selectedVersion: "0.133.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));
    const execFileSync: RuntimeExecFile = (file) => {
      if (String(file).includes("new")) return "codex-cli 0.145.0-alpha.30";
      return "codex-cli 0.133.0";
    };
    const result = resolveCodexRuntime({
      configDir,
      env: { CODEX_CLI_PATH: "C:\\new\\codex.exe", PATH: "" },
      platform: "win32",
      existsSync: () => true,
      execFileSync,
    });
    expect(result.runtime.command).toBe("C:\\new\\codex.exe");
    expect(result.runtime.source).toBe("environment");
    expect(result.runtime.version).toBe("0.145.0-alpha.30");
  });

  test("invalid CODEX_CLI_PATH records a diagnostic and continues", () => {
    const result = resolveCodexRuntime({
      configDir: tempConfigDir(),
      env: { CODEX_CLI_PATH: "C:\\missing\\codex.exe", PATH: "" },
      platform: "win32",
      existsSync: () => false,
      execFileSync: () => "codex-cli 0.145.0",
    });
    expect(result.failures.some(item => item.source === "environment")).toBe(true);
    expect(result.runtime.source).not.toBe("environment");
  });

  test("valid configured runtime beats shim and PATH", () => {
    const configDir = tempConfigDir();
    persistCodexRuntime({
      command: "C:\\configured\\codex.exe",
      version: "0.145.0-alpha.30",
      source: "configured",
    }, { configDir });
    writeFileSync(join(configDir, "codex-shim.json"), JSON.stringify({
      backupPath: "C:\\shim\\codex.exe",
      originalPath: "C:\\shim\\codex.exe",
      wrapperPath: "C:\\shim\\wrapper.cmd",
    }));
    const execFileSync: RuntimeExecFile = (file) => {
      const text = String(file);
      if (text.includes("configured")) return "codex-cli 0.145.0-alpha.30";
      if (text.includes("shim")) return "codex-cli 0.140.0";
      return "codex-cli 0.133.0";
    };
    const result = resolveCodexRuntime({
      configDir,
      env: { PATH: "C:\\path-old" },
      platform: "win32",
      existsSync: () => true,
      execFileSync,
    });
    expect(result.runtime.command).toBe("C:\\configured\\codex.exe");
    expect(result.runtime.source).toBe("configured");
  });

  test("stale shim path is rejected", () => {
    const configDir = tempConfigDir();
    writeFileSync(join(configDir, "codex-shim.json"), JSON.stringify({
      backupPath: "C:\\gone\\codex.exe",
    }));
    const result = resolveCodexRuntime({
      configDir,
      env: { PATH: "" },
      platform: "win32",
      existsSync: (path) => !String(path).includes("gone"),
      execFileSync: () => "codex-cli 0.145.0",
    });
    expect(result.failures.some(item => item.source === "shim" && item.reason.includes("does not exist"))).toBe(true);
  });

  test("persisted valid runtime survives a new resolve when PATH has an older binary", () => {
    const configDir = tempConfigDir();
    const execFileSync: RuntimeExecFile = (file) => {
      const text = String(file);
      if (text.includes("keep")) return "codex-cli 0.145.0-alpha.30";
      return "codex-cli 0.133.0";
    };
    resolveAndPersistCodexRuntime({
      configDir,
      env: { CODEX_CLI_PATH: "C:\\keep\\codex.exe", PATH: "C:\\old" },
      platform: "win32",
      existsSync: () => true,
      execFileSync,
    });
    const persisted = loadPersistedCodexRuntime({ configDir });
    expect(persisted?.command).toBe("C:\\keep\\codex.exe");

    const again = resolveCodexRuntime({
      configDir,
      env: { PATH: "C:\\old" },
      platform: "win32",
      existsSync: () => true,
      execFileSync,
    });
    expect(again.runtime.command).toBe("C:\\keep\\codex.exe");
    expect(again.runtime.source).toBe("configured");
    expect(again.newerAvailable?.version).toBeUndefined();
  });

  test("reports newerAvailable when an older runtime is selected", () => {
    const configDir = tempConfigDir();
    persistCodexRuntime({
      command: "C:\\old\\codex.exe",
      version: "0.133.0",
      source: "configured",
    }, { configDir });
    const execFileSync: RuntimeExecFile = (file) => {
      const text = String(file);
      if (text.includes("old")) return "codex-cli 0.133.0";
      if (text.includes("new")) return "codex-cli 0.145.0-alpha.30";
      return "codex-cli 0.120.0";
    };
    const result = resolveCodexRuntime({
      configDir,
      env: { PATH: "C:\\new" },
      platform: "win32",
      existsSync: () => true,
      execFileSync,
    });
    expect(result.runtime.command).toBe("C:\\old\\codex.exe");
    expect(result.newerAvailable?.command).toContain("new");
    expect(result.newerAvailable?.version).toBe("0.145.0-alpha.30");
  });

  test("display path redacts user home segments", () => {
    const shown = displayCodexRuntimePath("C:\\Users\\Alice\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe");
    expect(shown.toLowerCase()).not.toContain("alice");
  });

  test("unrecognized --version output is rejected", () => {
    const result = resolveCodexRuntime({
      configDir: tempConfigDir(),
      env: { CODEX_CLI_PATH: "C:\\weird\\codex.exe", PATH: "" },
      platform: "win32",
      existsSync: () => true,
      execFileSync: () => "not a codex binary",
    });
    expect(result.failures.some(item => item.source === "environment" && item.reason.includes("unrecognized"))).toBe(true);
    expect(result.runtime.source).not.toBe("environment");
  });

  test("CODEX_CLI_PATH equal to persisted path does not fabricate replacedConfigured", () => {
    const configDir = tempConfigDir();
    persistCodexRuntime({
      command: "C:\\same\\codex.exe",
      version: "0.145.0-alpha.30",
      source: "configured",
    }, { configDir });
    const result = resolveCodexRuntime({
      configDir,
      env: { CODEX_CLI_PATH: "C:\\same\\codex.exe", PATH: "" },
      platform: "win32",
      existsSync: () => true,
      execFileSync: () => "codex-cli 0.145.0-alpha.30",
    });
    expect(result.runtime.source).toBe("environment");
    expect(result.replacedConfigured).toBeUndefined();
  });

  test("persists and clears effort clamp diagnostics", () => {
    const configDir = tempConfigDir();
    persistEffortClamp({
      runtimePath: "C:\\Users\\Bob\\codex.exe",
      runtimeVersion: "0.133.0",
      removedEfforts: ["max", "ultra"],
      affectedModels: ["gpt-5.6-sol"],
    }, { configDir });
    const loaded = loadLastEffortClamp({ configDir });
    expect(loaded?.removedEfforts).toEqual(["max", "ultra"]);
    expect(loaded?.affectedModels).toEqual(["gpt-5.6-sol"]);
    expect(effortClampAppliesToRuntime(loaded, {
      command: "C:\\Users\\Bob\\codex.exe",
      version: "0.133.0",
    })).toBe(true);
    expect(effortClampAppliesToRuntime(loaded, {
      command: "C:\\Users\\Bob\\newer\\codex.exe",
      version: "0.145.0-alpha.30",
    })).toBe(false);
    persistEffortClamp(null, { configDir });
    expect(loadLastEffortClamp({ configDir })).toBeNull();
  });

  test("creates missing config directory on first runtime/clamp persist", () => {
    const parent = tempConfigDir();
    const configDir = join(parent, "nested", "opencodex-home");
    expect(existsSync(configDir)).toBe(false);
    persistCodexRuntime({
      command: "C:\\keep\\codex.exe",
      version: "0.145.0-alpha.30",
      source: "configured",
    }, { configDir });
    persistEffortClamp({
      runtimePath: "C:\\keep\\codex.exe",
      runtimeVersion: "0.145.0-alpha.30",
      removedEfforts: ["max"],
      affectedModels: ["gpt-5.6-sol"],
    }, { configDir });
    expect(existsSync(configDir)).toBe(true);
    expect(loadPersistedCodexRuntime({ configDir })?.command).toBe("C:\\keep\\codex.exe");
    expect(loadLastEffortClamp({ configDir })?.removedEfforts).toEqual(["max"]);
  });

  test("resolveAndPersistCodexRuntime surfaces persistence failures", () => {
    const blocker = join(tempConfigDir(), "blocker-file");
    writeFileSync(blocker, "not-a-directory");
    const failed = resolveAndPersistCodexRuntime({
      configDir: blocker,
      env: { CODEX_CLI_PATH: "C:\\keep\\codex.exe", PATH: "" },
      platform: "win32",
      existsSync: () => true,
      execFileSync: () => "codex-cli 0.145.0-alpha.30",
    });
    expect(failed.runtime.command).toBe("C:\\keep\\codex.exe");
    expect(typeof failed.persistError).toBe("string");
    expect(failed.persistError!.length).toBeGreaterThan(0);
  });

  test("catalog clamp clears diagnostics inside deps.configDir when probe fails", async () => {
    const { clampCatalogModelsToCodexSupport } = await import("../src/codex/catalog/effort");
    const nested = join(tempConfigDir(), "nested", "opencodex-home");
    const configured = join(nested, "codex.exe");
    persistEffortClamp({
      runtimePath: configured,
      runtimeVersion: "0.133.0",
      removedEfforts: ["max"],
      affectedModels: ["gpt-5.6-sol"],
    }, { configDir: nested });
    expect(loadLastEffortClamp({ configDir: nested })?.removedEfforts).toEqual(["max"]);

    let probeCalls = 0;
    clampCatalogModelsToCodexSupport([], {
      configDir: nested,
      env: { CODEX_CLI_PATH: configured, PATH: "" },
      platform: "win32",
      existsSync: (path) => path === configured,
      execFileSync: () => {
        probeCalls += 1;
        throw new Error("catalog probe failed");
      },
    });
    expect(probeCalls).toBeGreaterThan(0);
    expect(loadLastEffortClamp({ configDir: nested })).toBeNull();
  });

  test("persisted runtime stamp busts resolve memo; catalog cache keys by runtime", async () => {
    const { chmodSync, mkdirSync } = await import("node:fs");
    const {
      loadBundledCodexCatalog,
      resetBundledCatalogCacheForTests,
    } = await import("../src/codex/catalog/bundled");

    const home = tempConfigDir();
    const oldDir = join(home, "old");
    const newDir = join(home, "new");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    const oldBin = process.platform === "win32" ? join(oldDir, "codex.cmd") : join(oldDir, "codex");
    const newBin = process.platform === "win32" ? join(newDir, "codex.cmd") : join(newDir, "codex");

    const writeLauncher = (path: string, version: string, efforts: string[]) => {
      const catalog = JSON.stringify({
        models: [{
          slug: "gpt-5.5",
          base_instructions: "x",
          supported_reasoning_levels: efforts.map(effort => ({ effort, description: effort })),
          default_reasoning_level: "medium",
        }],
      });
      const catalogPath = join(dirname(path), "catalog.json");
      writeFileSync(catalogPath, `${catalog}\n`, "utf8");
      if (process.platform === "win32") {
        writeFileSync(path, [
          "@echo off",
          `if "%~1"=="--version" (`,
          `  echo codex-cli ${version}`,
          "  exit /b 0",
          ")",
          `type "%~dp0catalog.json"`,
          "",
        ].join("\r\n"), "utf8");
      } else {
        writeFileSync(path, [
          "#!/bin/sh",
          `if [ "$1" = "--version" ]; then`,
          `  echo "codex-cli ${version}"`,
          "  exit 0",
          "fi",
          `cat "$(dirname "$0")/catalog.json"`,
          "",
        ].join("\n"), "utf8");
        chmodSync(path, 0o755);
      }
    };
    writeLauncher(oldBin, "0.133.0", ["low", "medium", "high"]);
    writeLauncher(newBin, "0.145.0-alpha.30", ["low", "medium", "high", "max", "ultra"]);

    const previousHome = process.env.OPENCODEX_HOME;
    const previousCli = process.env.CODEX_CLI_PATH;
    const previousPath = process.env.PATH;
    process.env.OPENCODEX_HOME = home;
    process.env.PATH = "";
    resetCodexRuntimeResolveCacheForTests();
    resetBundledCatalogCacheForTests();

    try {
      process.env.CODEX_CLI_PATH = oldBin;
      const first = resolveAndPersistCodexRuntime();
      expect(first.runtime.version).toBe("0.133.0");

      const oldCatalog = loadBundledCodexCatalog();
      expect(oldCatalog?.models?.[0]?.supported_reasoning_levels?.some(
        level => (level as { effort?: string }).effort === "max",
      )).toBe(false);

      // Doctor-style upgrade: persist newer runtime and drop env override.
      delete process.env.CODEX_CLI_PATH;
      persistCodexRuntime({
        command: newBin,
        version: "0.145.0-alpha.30",
        source: "configured",
      }, { configDir: home });

      const second = resolveCodexRuntime();
      expect(second.runtime.command).toBe(newBin);
      expect(second.runtime.version).toBe("0.145.0-alpha.30");

      const newCatalog = loadBundledCodexCatalog();
      expect(newCatalog?.models?.[0]?.supported_reasoning_levels?.some(
        level => (level as { effort?: string }).effort === "max",
      )).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      if (previousCli === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = previousCli;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      resetCodexRuntimeResolveCacheForTests();
      resetBundledCatalogCacheForTests();
    }
  });

  test("clamp diagnostics include unsupported default_reasoning_level changes", async () => {
    const { clampCatalogModelsToCodexSupport } = await import("../src/codex/catalog/effort");
    const diagnostics: Array<{ removedEfforts: string[]; affectedModels: string[] }> = [];
    const models = [{
      slug: "openrouter/example",
      supported_reasoning_levels: [
        { effort: "low", description: "low" },
        { effort: "medium", description: "medium" },
        { effort: "high", description: "high" },
      ],
      default_reasoning_level: "ultra",
    }];
    clampCatalogModelsToCodexSupport(models, {
      commandCandidates: () => ["stub"],
      execFileSync: () => JSON.stringify({
        models: [{
          slug: "gpt-5.5",
          base_instructions: "x",
          supported_reasoning_levels: [
            { effort: "low", description: "low" },
            { effort: "medium", description: "medium" },
            { effort: "high", description: "high" },
          ],
          default_reasoning_level: "medium",
        }],
      }),
      onEffortClamp: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(models[0]!.default_reasoning_level).toBe("high");
    expect(diagnostics[0]?.removedEfforts).toContain("ultra");
    expect(diagnostics[0]?.affectedModels).toEqual(["openrouter/example"]);
  });
});
