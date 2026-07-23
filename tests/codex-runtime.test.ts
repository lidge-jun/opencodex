import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareCodexVersions,
  displayCodexRuntimePath,
  loadLastEffortClamp,
  loadPersistedCodexRuntime,
  parseCodexVersionOutput,
  persistCodexRuntime,
  persistEffortClamp,
  resolveAndPersistCodexRuntime,
  resolveCodexRuntime,
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

  test("orders prerelease after matching core? actually alpha < release without pre for same core — compare treats bare > pre", () => {
    expect(compareCodexVersions("0.133.0", "0.145.0-alpha.30")).toBeLessThan(0);
    expect(compareCodexVersions("0.145.0", "0.145.0-alpha.30")).toBeGreaterThan(0);
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
    persistEffortClamp(null, { configDir });
    expect(loadLastEffortClamp({ configDir })).toBeNull();
  });
});
