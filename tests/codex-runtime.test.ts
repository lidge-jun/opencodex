import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  clearCodexRuntimeResolveCache,
  compareCodexVersions,
  displayCodexRuntimePath,
  effortClampAppliesToRuntime,
  loadLastEffortClamp,
  loadPersistedCodexRuntime,
  parseCodexVersionOutput,
  peekCodexRuntimeProcessCache,
  persistCodexRuntime,
  persistEffortClamp,
  resolveAndPersistCodexRuntime,
  resolveCodexRuntime,
  resetCodexRuntimeResolveCacheForTests,
  setCodexRuntimeResolveCacheForTests,
  type RuntimeExecFile,
} from "../src/codex/runtime";
import {
  bundledCatalogCacheState,
  invalidateBundledCatalogCache,
  peekCodexRuntimeForCatalogGather,
  resetBundledCatalogCacheForTests,
  resolveCatalogSourceForGather,
  setBundledCatalogCacheForTests,
  type CatalogGatherEvidenceSession,
} from "../src/codex/catalog/bundled";

function tempConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "ocx-runtime-"));
}

function persistedRuntimeBytes(
  command: string,
  version: string | null = "0.145.0",
): Uint8Array {
  return Buffer.from(JSON.stringify({
    version: 1,
    command,
    source: "environment",
    selectedVersion: version,
    updatedAt: "2026-08-04T00:00:00.000Z",
  }));
}

function gatherEvidence(
  sources: Partial<Record<Parameters<CatalogGatherEvidenceSession["readSource"]>[0], Uint8Array>> = {},
): CatalogGatherEvidenceSession {
  return {
    readSource: role => sources[role] ?? null,
  };
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

describe("observe-only Codex catalog gather caches", () => {
  test("cold gather returns typed misses without spawning or probing an executable", () => {
    const home = tempConfigDir();
    const launcher = process.platform === "win32"
      ? join(home, "codex.cmd")
      : join(home, "codex");
    const spawnLog = join(home, "spawn.log");
    if (process.platform === "win32") {
      writeFileSync(launcher, [
        "@echo off",
        `echo spawn>>"${spawnLog}"`,
        "echo codex-cli 0.145.0",
        "",
      ].join("\r\n"));
    } else {
      writeFileSync(launcher, [
        "#!/bin/sh",
        `printf '%s\\n' spawn >> '${spawnLog}'`,
        "printf '%s\\n' 'codex-cli 0.145.0'",
        "",
      ].join("\n"));
      chmodSync(launcher, 0o755);
    }

    const previousHome = process.env.OPENCODEX_HOME;
    const previousCli = process.env.CODEX_CLI_PATH;
    const previousPath = process.env.PATH;
    process.env.OPENCODEX_HOME = home;
    process.env.CODEX_CLI_PATH = launcher;
    process.env.PATH = "";
    resetCodexRuntimeResolveCacheForTests();
    resetBundledCatalogCacheForTests();

    try {
      const evidence = gatherEvidence();
      expect(peekCodexRuntimeForCatalogGather(evidence)).toEqual({
        kind: "runtime-unavailable",
        processLocal: { state: "unused" },
      });
      expect(resolveCatalogSourceForGather(evidence, "default")).toEqual({
        kind: "catalog-unavailable",
        processLocal: {
          runtime: { state: "unused" },
          bundledCatalog: { state: "unused" },
        },
      });
      expect(existsSync(spawnLog) ? readFileSync(spawnLog, "utf8").trim().split("\n").length : 0).toBe(0);
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

  test("runtime cache reads are detached and recursively frozen", () => {
    const deps = { env: { PATH: "" }, discoverAlternatives: false };
    resetCodexRuntimeResolveCacheForTests();
    setCodexRuntimeResolveCacheForTests({
      runtime: { command: "codex", version: null, source: "fallback" },
      failures: [{ command: "missing", source: "path", reason: "not found" }],
    }, deps);

    const first = resolveCodexRuntime(deps);
    const second = resolveCodexRuntime(deps);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.runtime)).toBe(true);
    expect(Object.isFrozen(first.failures)).toBe(true);
    expect(Object.isFrozen(first.failures[0])).toBe(true);
    expect(() => {
      (first.failures as Array<{ reason: string }>)[0]!.reason = "mutated";
    }).toThrow();
    expect(resolveCodexRuntime(deps).failures[0]?.reason).toBe("not found");
  });

  test("bundled gather reads are detached and recursively frozen", () => {
    const runtime = { command: "/tmp/codex", version: "0.145.0", source: "environment" as const };
    resetBundledCatalogCacheForTests();
    setBundledCatalogCacheForTests(runtime, {
      models: [{
        slug: "gpt-5.5",
        base_instructions: "private",
        supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
      }],
    });
    const evidence = gatherEvidence({
      "runtime-selection": persistedRuntimeBytes(runtime.command, runtime.version),
    });

    const first = resolveCatalogSourceForGather(evidence, "default");
    const second = resolveCatalogSourceForGather(evidence, "default");
    expect(first.kind).toBe("available");
    expect(second.kind).toBe("available");
    if (first.kind !== "available" || second.kind !== "available") return;
    expect(first.catalog).not.toBe(second.catalog);
    expect(Object.isFrozen(first.catalog)).toBe(true);
    expect(Object.isFrozen(first.catalog.models)).toBe(true);
    expect(Object.isFrozen(first.catalog.models?.[0])).toBe(true);
    expect(Object.isFrozen(first.catalog.models?.[0]?.supported_reasoning_levels)).toBe(true);
    expect(() => {
      (first.catalog.models as Array<Record<string, unknown>>)[0]!.base_instructions = "mutated";
    }).toThrow();
    expect(() => {
      (first.catalog.models?.[0]?.supported_reasoning_levels as unknown[]).push({ effort: "high" });
    }).toThrow();
    expect(second.catalog.models?.[0]?.base_instructions).toBe("private");
    expect(second.catalog.models?.[0]?.supported_reasoning_levels).toHaveLength(1);
  });

  test("custom catalog content stays authoritative while bundled runtime support is observed", () => {
    const runtime = { command: "/tmp/codex", version: "0.145.0", source: "environment" as const };
    resetBundledCatalogCacheForTests();
    setBundledCatalogCacheForTests(runtime, {
      models: [{
        slug: "gpt-5.5",
        base_instructions: "bundled metadata",
        supported_reasoning_levels: [{ effort: "xhigh", description: "xhigh" }],
      }],
    });
    const cacheState = bundledCatalogCacheState();
    const evidence = gatherEvidence({
      "runtime-selection": persistedRuntimeBytes(runtime.command, runtime.version),
      "active-catalog-merge": Buffer.from(JSON.stringify({
        models: [{
          slug: "gpt-5.5",
          base_instructions: "custom metadata",
          supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
        }],
      })),
    });

    try {
      const custom = resolveCatalogSourceForGather(evidence, "custom");
      expect(custom.kind).toBe("available");
      if (custom.kind !== "available") return;
      expect(custom.source).toBe("active-catalog-merge");
      expect(custom.catalog.models?.[0]?.base_instructions).toBe("custom metadata");
      expect(custom.runtimeSupport.kind).toBe("available");
      if (custom.runtimeSupport.kind === "available") {
        expect(custom.runtimeSupport.catalog.models?.[0]?.base_instructions)
          .toBe("bundled metadata");
      }
      expect(custom.processLocal).toEqual({
        runtime: { state: "unused" },
        bundledCatalog: {
          state: "used",
          epoch: cacheState.epoch,
          valueIdentity: cacheState.valueIdentity,
        },
      });

      const bundled = resolveCatalogSourceForGather(evidence, "default");
      expect(bundled.kind).toBe("available");
      if (bundled.kind === "available") {
        expect(bundled.source).toBe("bundled-catalog-template");
        expect(bundled.catalog.models?.[0]?.base_instructions).toBe("bundled metadata");
      }
    } finally {
      resetBundledCatalogCacheForTests();
    }
  });

  test("a routed-only active custom catalog stays authoritative over a native backup", () => {
    const runtime = { command: "/tmp/codex", version: "0.145.0", source: "environment" as const };
    resetBundledCatalogCacheForTests();
    setBundledCatalogCacheForTests(runtime, {
      models: [{
        slug: "gpt-5.5",
        base_instructions: "bundled runtime metadata",
      }],
    });
    const evidence = gatherEvidence({
      "runtime-selection": persistedRuntimeBytes(runtime.command, runtime.version),
      "active-catalog-merge": Buffer.from(JSON.stringify({
        root_marker: "active-custom",
        models: [{
          slug: "vendor/routed-only",
          base_instructions: "active routed metadata",
        }],
      })),
      "hashed-backup-fallback": Buffer.from(JSON.stringify({
        root_marker: "stale-backup",
        models: [{
          slug: "gpt-5.5",
          base_instructions: "backup native metadata",
        }],
      })),
    });

    try {
      const source = resolveCatalogSourceForGather(evidence, "custom");
      expect(source.kind).toBe("available");
      if (source.kind !== "available") return;
      expect(source.source).toBe("active-catalog-merge");
      expect(source.catalog.root_marker).toBe("active-custom");
      expect(source.catalog.models?.map(entry => entry.slug)).toEqual(["vendor/routed-only"]);
      expect(source.runtimeSupport.kind).toBe("available");

      const fallback = resolveCatalogSourceForGather(gatherEvidence({
        "runtime-selection": persistedRuntimeBytes(runtime.command, runtime.version),
        "hashed-backup-fallback": Buffer.from(JSON.stringify({
          root_marker: "routed-backup",
          models: [{
            slug: "vendor/backup-only",
            base_instructions: "routed backup metadata",
          }],
        })),
      }), "custom");
      expect(fallback.kind).toBe("available");
      if (fallback.kind === "available") {
        expect(fallback.source).toBe("hashed-backup-fallback");
        expect(fallback.catalog.root_marker).toBe("routed-backup");
      }
    } finally {
      resetBundledCatalogCacheForTests();
    }
  });

  test("gather consumes a persisted runtime observation and observed disk fallback", () => {
    resetCodexRuntimeResolveCacheForTests();
    resetBundledCatalogCacheForTests();
    const evidence = gatherEvidence({
      "runtime-selection": persistedRuntimeBytes("/tmp/persisted-codex"),
      "active-catalog-merge": Buffer.from(JSON.stringify({
        models: [{ slug: "gpt-5.5", base_instructions: "observed" }],
      })),
    });

    const runtime = peekCodexRuntimeForCatalogGather(evidence);
    expect(runtime.kind).toBe("available");
    if (runtime.kind === "available") {
      expect(runtime.origin).toBe("persisted");
      expect(runtime.runtime.command).toBe("/tmp/persisted-codex");
      expect(runtime.processLocal).toEqual({ state: "unused" });
    }

    const source = resolveCatalogSourceForGather(evidence, "custom");
    expect(source.kind).toBe("available");
    if (source.kind === "available") {
      expect(source.source).toBe("active-catalog-merge");
      expect(source.catalog.models?.[0]?.base_instructions).toBe("observed");
      expect(source.runtimeSupport).toEqual({ kind: "unavailable" });
      expect(source.processLocal).toEqual({
        runtime: { state: "unused" },
        bundledCatalog: { state: "unused" },
      });
    }
  });

  test("runtime epoch advances on population and replacement", () => {
    const deps = { env: { PATH: "" }, discoverAlternatives: false };
    resetCodexRuntimeResolveCacheForTests();
    const beforePopulation = peekCodexRuntimeProcessCache().epoch;
    setCodexRuntimeResolveCacheForTests({
      runtime: { command: "codex-a", version: "1.0.0", source: "path" },
      failures: [],
    }, deps);
    const afterPopulation = peekCodexRuntimeProcessCache().epoch;
    expect(afterPopulation).toBeGreaterThan(beforePopulation);

    setCodexRuntimeResolveCacheForTests({
      runtime: { command: "codex-b", version: "2.0.0", source: "path" },
      failures: [],
    }, deps);
    expect(peekCodexRuntimeProcessCache().epoch).toBeGreaterThan(afterPopulation);
  });

  test("bundled epoch advances on population, replacement, and negative-cache publication", () => {
    const runtime = { command: "/tmp/codex", version: "0.145.0", source: "environment" as const };
    resetBundledCatalogCacheForTests();
    const beforePopulation = bundledCatalogCacheState().epoch;
    setBundledCatalogCacheForTests(runtime, { models: [{ slug: "first" }] });
    const afterPopulation = bundledCatalogCacheState().epoch;
    expect(afterPopulation).toBeGreaterThan(beforePopulation);

    setBundledCatalogCacheForTests(runtime, { models: [{ slug: "replacement" }] });
    const afterReplacement = bundledCatalogCacheState().epoch;
    expect(afterReplacement).toBeGreaterThan(afterPopulation);

    setBundledCatalogCacheForTests(runtime, null);
    expect(bundledCatalogCacheState().epoch).toBeGreaterThan(afterReplacement);
  });

  test("runtime epoch advances on clear", () => {
    const before = peekCodexRuntimeProcessCache().epoch;
    clearCodexRuntimeResolveCache();
    expect(peekCodexRuntimeProcessCache().epoch).toBeGreaterThan(before);
  });

  test("bundled epoch advances on invalidation", () => {
    const before = bundledCatalogCacheState().epoch;
    invalidateBundledCatalogCache();
    expect(bundledCatalogCacheState().epoch).toBeGreaterThan(before);
  });

  test("runtime epoch advances on persisted-runtime write", () => {
    const before = peekCodexRuntimeProcessCache().epoch;
    persistCodexRuntime({
      command: "/tmp/codex",
      version: "0.145.0",
      source: "configured",
    }, { configDir: tempConfigDir() });
    expect(peekCodexRuntimeProcessCache().epoch).toBeGreaterThan(before);
  });

  test("both epochs advance on test reset", () => {
    const runtimeBefore = peekCodexRuntimeProcessCache().epoch;
    const bundledBefore = bundledCatalogCacheState().epoch;
    resetCodexRuntimeResolveCacheForTests();
    resetBundledCatalogCacheForTests();
    expect(peekCodexRuntimeProcessCache().epoch).toBeGreaterThan(runtimeBefore);
    expect(bundledCatalogCacheState().epoch).toBeGreaterThan(bundledBefore);
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

  test("probe runs with a sandboxed CODEX_HOME, never the caller's", () => {
    // A real Codex CLI writes state (tmp/) under CODEX_HOME even for --version;
    // the probe must redirect it so read-only commands stay read-only.
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const execFileSync: RuntimeExecFile = (_file, _args, options) => {
      seenEnv = options.env;
      return "codex-cli 0.145.0";
    };
    const result = resolveCodexRuntime({
      configDir: tempConfigDir(),
      env: { CODEX_CLI_PATH: "C:\\new\\codex.exe", PATH: "", CODEX_HOME: "C:\\Users\\real\\.codex" },
      platform: "win32",
      existsSync: () => true,
      execFileSync,
    });
    expect(result.runtime.version).toBe("0.145.0");
    expect(seenEnv).toBeDefined();
    expect(seenEnv?.CODEX_HOME).toBeDefined();
    expect(seenEnv?.CODEX_HOME).not.toBe("C:\\Users\\real\\.codex");
    expect(seenEnv?.PATH).toBe("");
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

  test("repeated catalog reads reuse the runtime probe instead of respawning it", async () => {
    const { chmodSync, mkdirSync } = await import("node:fs");
    const {
      loadBundledCodexCatalog,
      resetBundledCatalogCacheForTests,
    } = await import("../src/codex/catalog/bundled");

    const home = tempConfigDir();
    const binDir = join(home, "bin");
    mkdirSync(binDir, { recursive: true });
    const bin = process.platform === "win32" ? join(binDir, "codex.cmd") : join(binDir, "codex");

    // Count --version probes by having the launcher append a line per invocation.
    const probeLog = join(binDir, "probes.log");
    const catalog = JSON.stringify({
      models: [{
        slug: "gpt-5.5",
        base_instructions: "x",
        supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
        default_reasoning_level: "medium",
      }],
    });
    writeFileSync(join(binDir, "catalog.json"), `${catalog}\n`, "utf8");
    if (process.platform === "win32") {
      writeFileSync(bin, [
        "@echo off",
        `if "%~1"=="--version" (`,
        `  echo probe>>"%~dp0probes.log"`,
        "  echo codex-cli 0.145.0-alpha.30",
        "  exit /b 0",
        ")",
        `type "%~dp0catalog.json"`,
        "",
      ].join("\r\n"), "utf8");
    } else {
      writeFileSync(bin, [
        "#!/bin/sh",
        "d=${0%/*}",
        `if [ "$1" = "--version" ]; then`,
        `  printf "%s\\n" probe >> "$d/probes.log"`,
        `  printf "%s\\n" "codex-cli 0.145.0-alpha.30"`,
        "  exit 0",
        "fi",
        `while IFS= read -r line || [ -n "$line" ]; do`,
        `  printf "%s\\n" "$line"`,
        `done < "$d/catalog.json"`,
        "",
      ].join("\n"), "utf8");
      chmodSync(bin, 0o755);
    }

    const countProbes = (): number => {
      if (!existsSync(probeLog)) return 0;
      return readFileSync(probeLog, "utf8").split("\n").filter(line => line.trim().length > 0).length;
    };

    const previousHome = process.env.OPENCODEX_HOME;
    const previousCli = process.env.CODEX_CLI_PATH;
    const previousPath = process.env.PATH;
    process.env.OPENCODEX_HOME = home;
    process.env.CODEX_CLI_PATH = bin;
    process.env.PATH = "";
    resetCodexRuntimeResolveCacheForTests();
    resetBundledCatalogCacheForTests();

    try {
      expect(loadBundledCodexCatalog()?.models?.[0]?.slug).toBe("gpt-5.5");
      expect(countProbes()).toBeGreaterThan(0);

      // The first read has no persisted selection yet, so it legitimately writes one and the
      // write clears the resolve memo — the second read re-probes once and then persists
      // nothing. From there the count must STOP GROWING.
      expect(loadBundledCodexCatalog()?.models?.[0]?.slug).toBe("gpt-5.5");
      const warm = countProbes();

      // Warm reads must not respawn the probe. Two regressions broke this and made the count
      // grow once per read: (1) loadBundledCodexCatalog forwarding its own already-defaulted
      // execFileSync, which opts resolveCacheKey() out of memoizing, and (2) an unconditional
      // persist whose `updatedAt` both clears the memo and rekeys it. Either one made every
      // catalog read spawn `codex --version` (~1s), pushing /api/claude-code past the 3s
      // budget ocx claude allows and silently skipping the gateway-model cache refresh.
      for (let i = 0; i < 4; i++) {
        expect(loadBundledCodexCatalog()?.models?.[0]?.slug).toBe("gpt-5.5");
      }
      expect(countProbes()).toBe(warm);
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

  test("repeat resolveAndPersistCodexRuntime keeps an unchanged selection's persisted stamp", () => {
    const configDir = tempConfigDir();
    let now = 0;
    const deps = {
      configDir,
      env: { CODEX_CLI_PATH: "C:\\keep\\codex.exe", PATH: "" },
      platform: "win32" as const,
      existsSync: () => true,
      execFileSync: (() => "codex-cli 0.145.0-alpha.30") as RuntimeExecFile,
      now: () => ++now,
    };

    const first = resolveAndPersistCodexRuntime(deps);
    expect(first.persistError).toBeUndefined();
    const firstStamp = loadPersistedCodexRuntime({ configDir })?.updatedAt;
    expect(typeof firstStamp).toBe("string");

    // An identical selection must not rewrite the file: the write clears the resolve memo
    // and its `updatedAt` feeds the memo cache key, so rewriting defeats caching entirely.
    const second = resolveAndPersistCodexRuntime(deps);
    expect(second.runtime.command).toBe(first.runtime.command);
    expect(second.runtime.version).toBe(first.runtime.version);
    expect(loadPersistedCodexRuntime({ configDir })?.updatedAt).toBe(firstStamp);
  });

  test("treats missing persisted and resolved versions as the same selection", () => {
    const configDir = tempConfigDir();
    const statePath = join(configDir, "codex-runtime.json");
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      command: "codex",
      source: "environment",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));

    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = configDir;
    resetCodexRuntimeResolveCacheForTests();
    const deps = { env: { PATH: "" }, discoverAlternatives: false };

    try {
      const cached = resolveCodexRuntime(deps);
      expect(cached.runtime.source).toBe("fallback");
      setCodexRuntimeResolveCacheForTests({
        runtime: { command: "codex", version: null, source: "environment" },
        failures: cached.failures,
      }, deps);
      const before = readFileSync(statePath, "utf8");

      resolveAndPersistCodexRuntime(deps);

      expect(readFileSync(statePath, "utf8")).toBe(before);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      resetCodexRuntimeResolveCacheForTests();
    }
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
