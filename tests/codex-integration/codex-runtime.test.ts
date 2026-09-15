import { describe, expect, test } from "bun:test";

/**
 * PATH for tests that must stop PATH-based codex DISCOVERY while keeping their
 * fake launchers runnable.
 *
 * These tests write `/bin/sh` scripts that call `dirname` and `cat`, so the
 * child still needs the standard utilities. `PATH=""` used to work by accident:
 * Bun 1.3.14 ignored an empty PATH and handed the child the parent's real one.
 * Bun 1.4 passes the empty value through faithfully — the correct behaviour —
 * and the scripts then die with "dirname: No such file or directory".
 *
 * `/usr/bin:/bin` keeps the utilities reachable and contains no `codex`, which
 * is the only property these tests depend on. Found during Bun 1.4 canary
 * qualification (#1691).
 */
const NO_CODEX_PATH = "/usr/bin:/bin";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  clearCodexRuntimeResolveCache,
  compareCodexVersions,
  CODEX_PROGRAM_NOT_FOUND_REASON,
  displayCodexRuntimePath,
  effortClampAppliesToRuntime,
  liveRemovedEfforts,
  loadLastEffortClamp,
  loadPersistedCodexRuntime,
  parseCodexVersionOutput,
  parsePersistedCodexRuntime,
  persistedCodexRuntimeIsPinned,
  peekCodexRuntimeProcessCache,
  persistCodexRuntime,
  persistEffortClamp,
  resolveAndPersistCodexRuntime,
  resolveCodexRuntime,
  resetCodexRuntimeResolveCacheForTests,
  setCodexRuntimeResolveCacheForTests,
  type RuntimeExecFile,
} from "../../src/codex/runtime";
import {
  bundledCatalogCacheState,
  invalidateBundledCatalogCache,
  peekCodexRuntimeForCatalogGather,
  resetBundledCatalogCacheForTests,
  resolveCatalogSourceForGather,
  setBundledCatalogCacheForTests,
  type CatalogGatherEvidenceSession,
} from "../../src/codex/catalog/bundled";

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
    process.env.PATH = NO_CODEX_PATH;
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
      removedEfforts: ["xhigh"],
      affectedModels: ["gpt-5.6-sol"],
    }, { configDir });
    const loaded = loadLastEffortClamp({ configDir });
    expect(loaded?.removedEfforts).toEqual(["xhigh"]);
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

  // The binary that produced the diagnostic is upgraded in place. Windows does exactly this, so
  // path equality alone kept a 0.135.0 observation alive for a 0.154.0 runtime whose own bundled
  // catalog carried the rungs the file claimed were missing.
  test("a same-path runtime at a different version no longer inherits the diagnostic", () => {
    const configDir = tempConfigDir();
    persistEffortClamp({
      runtimePath: "C:\\Users\\Bob\\codex.exe",
      runtimeVersion: "0.135.0",
      removedEfforts: ["xhigh"],
      affectedModels: ["gpt-6-astra"],
    }, { configDir });
    const loaded = loadLastEffortClamp({ configDir });
    expect(effortClampAppliesToRuntime(loaded, {
      command: "C:\\Users\\Bob\\codex.exe",
      version: "0.154.0",
    })).toBe(false);
    // Same path, same version is still the runtime that produced it.
    expect(effortClampAppliesToRuntime(loaded, {
      command: "C:\\Users\\Bob\\codex.exe",
      version: "0.135.0",
    })).toBe(true);
    // An unknown version on either side is not evidence of an upgrade: stay conservative.
    expect(effortClampAppliesToRuntime(loaded, {
      command: "C:\\Users\\Bob\\codex.exe",
      version: null,
    })).toBe(true);
  });

  // max and ultra are exempt from the observed-runtime intersection, so a file naming only those
  // describes a policy that no longer exists and must not keep the warning alive until the next
  // sync unlinks it.
  test("a diagnostic naming only max and ultra is inert", () => {
    const configDir = tempConfigDir();
    persistEffortClamp({
      runtimePath: "C:\\Users\\Bob\\codex.exe",
      runtimeVersion: "0.135.0",
      removedEfforts: ["max", "ultra"],
      affectedModels: ["gpt-6-astra"],
    }, { configDir });
    const loaded = loadLastEffortClamp({ configDir });
    expect(loaded?.removedEfforts).toEqual(["max", "ultra"]);
    expect(liveRemovedEfforts(loaded)).toEqual([]);
    expect(effortClampAppliesToRuntime(loaded, {
      command: "C:\\Users\\Bob\\codex.exe",
      version: "0.135.0",
    })).toBe(false);
  });

  test("a mixed diagnostic still reports the rungs that are genuinely clamped", () => {
    const configDir = tempConfigDir();
    persistEffortClamp({
      runtimePath: "C:\\Users\\Bob\\codex.exe",
      runtimeVersion: "0.135.0",
      removedEfforts: ["max", "ultra", "xhigh"],
      affectedModels: ["gpt-6-astra"],
    }, { configDir });
    const loaded = loadLastEffortClamp({ configDir });
    expect(liveRemovedEfforts(loaded)).toEqual(["xhigh"]);
    expect(effortClampAppliesToRuntime(loaded, {
      command: "C:\\Users\\Bob\\codex.exe",
      version: "0.135.0",
    })).toBe(true);
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
    } = await import("../../src/codex/catalog/bundled");

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
    process.env.PATH = NO_CODEX_PATH;
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
    const { clampCatalogModelsToCodexSupport } = await import("../../src/codex/catalog/effort");
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
    } = await import("../../src/codex/catalog/bundled");

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
    process.env.PATH = NO_CODEX_PATH;
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
    const { clampCatalogModelsToCodexSupport } = await import("../../src/codex/catalog/effort");
    const diagnostics: Array<{ removedEfforts: string[]; affectedModels: string[] }> = [];
    // A genuinely unsupported (and clampable) default rung: xhigh. The exempt rungs
    // (max/ultra) are covered by the no-diagnostic case below.
    const models = [{
      slug: "openrouter/example",
      supported_reasoning_levels: [
        { effort: "low", description: "low" },
        { effort: "medium", description: "medium" },
        { effort: "high", description: "high" },
      ],
      default_reasoning_level: "xhigh",
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
    expect(diagnostics[0]?.removedEfforts).toContain("xhigh");
    expect(diagnostics[0]?.affectedModels).toEqual(["openrouter/example"]);
  });

  // An exempt default only survives when the surviving ladder advertises it; an orphaned ultra
  // default (no ultra rung in the ladder) is repaired down for catalog coherence, and because
  // nothing was removed from the offering the repair produces no clamp diagnostic.
  test("an orphaned ultra default is repaired without a clamp diagnostic", async () => {
    const { clampCatalogModelsToCodexSupport } = await import("../../src/codex/catalog/effort");
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
    expect(diagnostics).toEqual([]);
  });
});

describe("dead configured pin recovery (#4035)", () => {
  test("a dead configured pin is cleared when resolution degrades to fallback", () => {
    // A Codex App update deletes the hashed plugin directory the pin names. The probe
    // rejects the vanished absolute path ("path does not exist"), no PATH candidate
    // exists, and resolution degrades to `fallback` — which the persist guard skipped,
    // so the dead pin survived forever and every later resolve re-probed a path that
    // cannot exist.
    const configDir = tempConfigDir();
    const dead = join(configDir, "gone", "codex");
    persistCodexRuntime({ command: dead, version: "0.153.0", source: "configured" }, { configDir });
    expect(loadPersistedCodexRuntime({ configDir })?.command).toBe(dead);

    const result = resolveAndPersistCodexRuntime({
      configDir,
      env: { PATH: "" },
      platform: "linux",
      existsSync: (path) => !String(path).includes("gone"),
      execFileSync: () => { throw new Error("ENOENT"); },
    });

    expect(result.runtime.source).toBe("fallback");
    expect(existsSync(join(configDir, "codex-runtime.json"))).toBe(false);
    expect(loadPersistedCodexRuntime({ configDir })).toBeNull();
  });

  test("a fallback resolve with no persisted pin writes nothing", () => {
    const configDir = tempConfigDir();
    const result = resolveAndPersistCodexRuntime({
      configDir,
      env: { PATH: "" },
      platform: "linux",
      existsSync: () => false,
      execFileSync: () => { throw new Error("ENOENT"); },
    });
    expect(result.runtime.source).toBe("fallback");
    expect(existsSync(join(configDir, "codex-runtime.json"))).toBe(false);
  });

  test("a live configured pin is NOT cleared when the resolve succeeds", () => {
    // The clear is bound to a dead pin, not to every fallback-shaped result.
    const configDir = tempConfigDir();
    const live = join(configDir, "bin", "codex");
    persistCodexRuntime({ command: live, version: "0.153.0", source: "configured" }, { configDir });
    const result = resolveAndPersistCodexRuntime({
      configDir,
      env: { PATH: "" },
      platform: "linux",
      existsSync: () => true,
      execFileSync: () => "codex-cli 0.153.0",
    });
    expect(result.runtime.source).toBe("configured");
    expect(loadPersistedCodexRuntime({ configDir })?.command).toBe(live);
  });

  test("a pin rejected for a NON-path reason is left alone", () => {
    // "unrecognized --version output" means the file is present but unusable; that is a
    // different failure than a vanished path and is not this issue's recovery case.
    const configDir = tempConfigDir();
    const weird = join(configDir, "weird", "codex");
    persistCodexRuntime({ command: weird, version: "0.153.0", source: "configured" }, { configDir });
    resolveAndPersistCodexRuntime({
      configDir,
      env: { PATH: "" },
      platform: "linux",
      existsSync: () => true,
      execFileSync: () => "not a codex binary",
    });
    expect(loadPersistedCodexRuntime({ configDir })?.command).toBe(weird);
  });

  test("a case-different missing path does not retire a live pin on linux", () => {
    // sameRuntimeCommand() lowercases, so on a case-sensitive filesystem it reports
    // /plugins/Codex and /plugins/codex as the same command. They are different files.
    // If CODEX_CLI_PATH names the missing lowercase one, its PATH_MISSING failure must
    // not retire the uppercase pin that is still live (review finding on #4035).
    const configDir = tempConfigDir();
    const live = join(configDir, "plugins", "Codex");
    const missing = join(configDir, "plugins", "codex");
    persistCodexRuntime({ command: live, version: "0.153.0", source: "configured" }, { configDir });
    resolveAndPersistCodexRuntime({
      configDir,
      env: { PATH: "", CODEX_CLI_PATH: missing },
      platform: "linux",
      existsSync: (p: string) => String(p) === live,
      execFileSync: () => "codex-cli 0.153.0",
    });
    expect(loadPersistedCodexRuntime({ configDir })?.command).toBe(live);
  });

});

describe("installed Codex discovery and deferred version probes", () => {
  test("discovers the newest Windows Codex App install from an injected listing", () => {
    const localAppData = "C:\\Users\\test\\AppData\\Local";
    const root = join(localAppData, "OpenAI", "Codex", "bin");
    const older = join(root, "older", "codex.exe");
    const newer = join(root, "newer", "codex.exe");
    const result = resolveCodexRuntime({
      configDir: tempConfigDir(),
      env: { LOCALAPPDATA: localAppData, PATH: NO_CODEX_PATH },
      platform: "win32",
      existsSync: path => path === older || path === newer,
      readdirSync: path => path === root ? ["older", "newer"] : [],
      statSync: path => {
        if (path === join(root, "older")) return { mtimeMs: 1_000, isDirectory: () => true };
        if (path === join(root, "newer")) return { mtimeMs: 2_000, isDirectory: () => true };
        return { mtimeMs: 0, isDirectory: () => false };
      },
      execFileSync: file => {
        expect(String(file)).toBe(newer);
        return "codex-cli 0.154.0-alpha.6.2";
      },
      discoverAlternatives: false,
    });
    expect(result.runtime.command).toBe(newer);
    expect(result.runtime.source).toBe("installed");
    expect(result.runtime.version).toBe("0.154.0-alpha.6.2");
  });

  test("orders equal-mtime Windows App directories by name", () => {
    const localAppData = "C:\\Users\\test\\AppData\\Local";
    const root = join(localAppData, "OpenAI", "Codex", "bin");
    const alpha = join(root, "alpha", "codex.exe");
    const zeta = join(root, "zeta", "codex.exe");
    const probed: string[] = [];
    const result = resolveCodexRuntime({
      configDir: tempConfigDir(),
      env: { LOCALAPPDATA: localAppData, PATH: NO_CODEX_PATH },
      platform: "win32",
      existsSync: path => path === alpha || path === zeta,
      readdirSync: path => path === root ? ["zeta", "alpha"] : [],
      statSync: path => {
        if (path === join(root, "alpha") || path === join(root, "zeta")) {
          return { mtimeMs: 1_000, isDirectory: () => true };
        }
        return { mtimeMs: 0, isDirectory: () => false };
      },
      execFileSync: file => {
        probed.push(String(file));
        return "codex-cli 0.154.0-alpha.6.2";
      },
    });
    expect(result.runtime.command).toBe(alpha);
    expect(result.runtime.source).toBe("installed");
    expect(probed.slice(0, 2)).toEqual([alpha, zeta]);
  });

  test("can select a runtime without synchronously probing its version", () => {
    let probeCalls = 0;
    const result = resolveCodexRuntime({
      configDir: tempConfigDir(),
      env: { CODEX_CLI_PATH: "C:\\codex\\codex.exe", PATH: "" },
      platform: "win32",
      existsSync: () => true,
      execFileSync: () => {
        probeCalls += 1;
        return "codex-cli 0.154.0";
      },
      probeVersion: false,
    });
    expect(result.runtime.command).toBe("C:\\codex\\codex.exe");
    expect(result.runtime.version).toBeNull();
    expect(probeCalls).toBe(0);
  });

  test("a deferred resolve does not publish a null version into process authority", () => {
    const deps = { env: { PATH: "" }, discoverAlternatives: false as const };
    resetCodexRuntimeResolveCacheForTests();
    try {
      setCodexRuntimeResolveCacheForTests({
        runtime: { command: "validated-codex", version: "0.154.0", source: "path" },
        failures: [],
      }, deps);
      const before = peekCodexRuntimeProcessCache();
      expect(before.kind).toBe("available");

      const selected = resolveCodexRuntime({ ...deps, probeVersion: false });
      expect(selected.runtime.version).toBeNull();
      expect(peekCodexRuntimeProcessCache()).toEqual(before);

      resetCodexRuntimeResolveCacheForTests();
      resolveCodexRuntime({ ...deps, probeVersion: false });
      const peeked = peekCodexRuntimeProcessCache();
      expect(peeked.kind === "available" && peeked.value.runtime.version === null).toBe(false);
    } finally {
      resetCodexRuntimeResolveCacheForTests();
    }
  });

  test("classifies a missing-program ENOENT distinctly from a generic version-probe failure", () => {
    const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const result = resolveCodexRuntime({
      configDir: tempConfigDir(),
      env: { CODEX_CLI_PATH: "C:\\missing-bin\\codex.exe", PATH: "" },
      platform: "win32",
      existsSync: () => true,
      execFileSync: () => {
        throw error;
      },
    });
    expect(result.failures.some(item => item.reason === CODEX_PROGRAM_NOT_FOUND_REASON)).toBe(true);
    expect(result.failures.some(item => item.reason.includes("failed --version"))).toBe(false);
  });

  test("PATH still outranks an installed candidate when both are valid", () => {
    const localAppData = "C:\\Users\\test\\AppData\\Local";
    const root = join(localAppData, "OpenAI", "Codex", "bin");
    const installed = join(root, "app", "codex.exe");
    // A colon-free PATH entry. pathCandidates splits PATH on node's delimiter,
    // which is ":" on the POSIX runners this suite also runs on, so a drive
    // letter here splits into two directories that match no candidate at all —
    // every PATH candidate then fails and the installed runtime wins, which is
    // the opposite of what this test is for.
    const pathDir = "/opt/on-path";
    const pathCommand = join(pathDir, "codex.exe");
    const result = resolveCodexRuntime({
      configDir: tempConfigDir(),
      env: { LOCALAPPDATA: localAppData, PATH: pathDir },
      platform: "win32",
      existsSync: path => path === pathCommand || path === installed,
      readdirSync: path => path === root ? ["app"] : [],
      statSync: path => path === join(root, "app")
        ? { mtimeMs: 2_000, isDirectory: () => true }
        : { mtimeMs: 0, isDirectory: () => false },
      execFileSync: file => {
        const text = String(file);
        if (text === pathCommand || text === installed) return "codex-cli 0.154.0";
        throw new Error(`unexpected probe: ${text}`);
      },
      discoverAlternatives: false,
    });
    expect(result.runtime.command).toBe(pathCommand);
    expect(result.runtime.source).toBe("path");
  });

  test("restores the established Unix Codex install locations", () => {
    const home = "/home/test";
    const installed = join(home, ".codex", "packages", "standalone", "current", "bin", "codex");
    const result = resolveCodexRuntime({
      configDir: tempConfigDir(),
      env: { HOME: home, PATH: NO_CODEX_PATH },
      platform: "linux",
      existsSync: path => String(path) === installed,
      execFileSync: file => {
        expect(String(file)).toBe(installed);
        return "codex-cli 0.154.0-alpha.6.2";
      },
      discoverAlternatives: false,
    });
    expect(result.runtime.command).toBe(installed);
    expect(result.runtime.source).toBe("installed");
    expect(result.runtime.version).toBe("0.154.0-alpha.6.2");
  });
});

describe("unpinned discovered runtime handover (issue 4204)", () => {
  function writeLegacyPersisted(
    configDir: string,
    command: string,
    selectedVersion: string,
    origin?: "pinned" | "discovered",
  ): void {
    const payload: Record<string, unknown> = {
      version: 1,
      command,
      source: "configured",
      selectedVersion,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    if (origin !== undefined) payload.origin = origin;
    writeFileSync(join(configDir, "codex-runtime.json"), JSON.stringify(payload));
  }

  test("a still-runnable persisted 0.135.0 with no origin yields to 0.153.4 and reports supersededDiscovered", () => {
    // Issue 4204: resolveAndPersistCodexRuntime wrote every automatic selection
    // without an origin, so a still-runnable 0.135.0 CLI kept winning over a
    // 0.153.4 Desktop runtime sitting on PATH. The catalog clamp then observed
    // the old ladder and stripped max/ultra.
    const configDir = tempConfigDir();
    writeLegacyPersisted(configDir, "C:\\old\\codex.exe", "0.135.0");
    expect(persistedCodexRuntimeIsPinned(loadPersistedCodexRuntime({ configDir }))).toBe(false);
    const execFileSync: RuntimeExecFile = (file) => {
      const text = String(file);
      if (text.includes("old")) return "codex-cli 0.135.0";
      if (text.includes("new")) return "codex-cli 0.153.4";
      return "codex-cli 0.120.0";
    };
    const result = resolveCodexRuntime({
      configDir,
      env: { PATH: "C:\\new" },
      platform: "win32",
      existsSync: () => true,
      execFileSync,
    });
    expect(result.runtime.command).toContain("new");
    expect(result.runtime.version).toBe("0.153.4");
    expect(result.supersededDiscovered?.from).toEqual({
      command: "C:\\old\\codex.exe",
      version: "0.135.0",
      source: "configured",
    });
    expect(result.supersededDiscovered?.to.command).toContain("new");
    expect(result.supersededDiscovered?.to.version).toBe("0.153.4");
    expect(result.supersededDiscovered?.reason).toBe(
      "discovered runtime 0.135.0 superseded by newer runtime 0.153.4",
    );
    expect(result.replacedConfigured).toBeUndefined();
  });

  test("origin pinned still resolves to 0.135.0 and reports no handover", () => {
    const configDir = tempConfigDir();
    writeLegacyPersisted(configDir, "C:\\old\\codex.exe", "0.135.0", "pinned");
    expect(persistedCodexRuntimeIsPinned(loadPersistedCodexRuntime({ configDir }))).toBe(true);
    const execFileSync: RuntimeExecFile = (file) => {
      const text = String(file);
      if (text.includes("old")) return "codex-cli 0.135.0";
      if (text.includes("new")) return "codex-cli 0.153.4";
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
    expect(result.runtime.version).toBe("0.135.0");
    expect(result.supersededDiscovered).toBeUndefined();
    expect(result.newerAvailable?.command).toContain("new");
    expect(result.newerAvailable?.version).toBe("0.153.4");
  });

  test("origin discovered still yields to a strictly newer runtime", () => {
    const configDir = tempConfigDir();
    writeLegacyPersisted(configDir, "C:\\old\\codex.exe", "0.135.0", "discovered");
    const execFileSync: RuntimeExecFile = (file) => {
      const text = String(file);
      if (text.includes("old")) return "codex-cli 0.135.0";
      if (text.includes("new")) return "codex-cli 0.153.4";
      return "codex-cli 0.120.0";
    };
    const result = resolveCodexRuntime({
      configDir,
      env: { PATH: "C:\\new" },
      platform: "win32",
      existsSync: () => true,
      execFileSync,
    });
    expect(result.runtime.version).toBe("0.153.4");
    expect(result.supersededDiscovered?.reason).toBe(
      "discovered runtime 0.135.0 superseded by newer runtime 0.153.4",
    );
  });

  test("an unpinned persisted record with an equal-version alternative sticks", () => {
    const configDir = tempConfigDir();
    writeLegacyPersisted(configDir, "C:\\old\\codex.exe", "0.135.0");
    const execFileSync: RuntimeExecFile = (file) => {
      const text = String(file);
      if (text.includes("old")) return "codex-cli 0.135.0";
      if (text.includes("new")) return "codex-cli 0.135.0";
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
    expect(result.supersededDiscovered).toBeUndefined();
  });

  test("an unpinned persisted record whose alternative has an unknown version sticks", () => {
    // probeVersion === false yields null versions everywhere, so the strictly-
    // newer comparison cannot fire. Absence of a version is not evidence of an
    // upgrade — the same conservative rule as the in-place clamp diagnostic.
    const configDir = tempConfigDir();
    writeLegacyPersisted(configDir, "C:\\old\\codex.exe", "0.135.0");
    const result = resolveCodexRuntime({
      configDir,
      env: { PATH: "C:\\new" },
      platform: "win32",
      existsSync: () => true,
      execFileSync: () => "codex-cli 0.153.4",
      probeVersion: false,
    });
    expect(result.runtime.command).toBe("C:\\old\\codex.exe");
    expect(result.runtime.version).toBeNull();
    expect(result.supersededDiscovered).toBeUndefined();
  });

  test("resolveAndPersistCodexRuntime writes origin discovered; persistCodexRuntime writes pinned", () => {
    const discoveredDir = tempConfigDir();
    resolveAndPersistCodexRuntime({
      configDir: discoveredDir,
      env: { CODEX_CLI_PATH: "C:\\keep\\codex.exe", PATH: "" },
      platform: "win32",
      existsSync: () => true,
      execFileSync: () => "codex-cli 0.153.4",
    });
    const discovered = loadPersistedCodexRuntime({ configDir: discoveredDir });
    expect(discovered?.origin).toBe("discovered");
    expect(persistedCodexRuntimeIsPinned(discovered)).toBe(false);

    const pinnedDir = tempConfigDir();
    persistCodexRuntime({
      command: "C:\\keep\\codex.exe",
      version: "0.153.4",
      source: "configured",
    }, { configDir: pinnedDir });
    const pinned = loadPersistedCodexRuntime({ configDir: pinnedDir });
    expect(pinned?.origin).toBe("pinned");
    expect(persistedCodexRuntimeIsPinned(pinned)).toBe(true);
  });

  test("parsePersistedCodexRuntime accepts a missing origin and rejects a junk origin", () => {
    const base = {
      version: 1 as const,
      command: "C:\\old\\codex.exe",
      source: "configured",
      selectedVersion: "0.135.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const withoutOrigin = parsePersistedCodexRuntime(JSON.stringify(base));
    expect(withoutOrigin?.command).toBe("C:\\old\\codex.exe");
    expect(withoutOrigin?.origin).toBeUndefined();
    expect(persistedCodexRuntimeIsPinned(withoutOrigin)).toBe(false);

    expect(parsePersistedCodexRuntime(JSON.stringify({ ...base, origin: "pinned" }))?.origin).toBe("pinned");
    expect(parsePersistedCodexRuntime(JSON.stringify({ ...base, origin: "discovered" }))?.origin).toBe("discovered");
    expect(parsePersistedCodexRuntime(JSON.stringify({ ...base, origin: "accidental" }))).toBeNull();
  });
});

describe("Codex App handover without PATH-wide discovery (issue 4204)", () => {
  const LOCAL_APP_DATA = "C:\\Users\\test\\AppData\\Local";
  const APP_ROOT = join(LOCAL_APP_DATA, "OpenAI", "Codex", "bin");
  const APP_EXE = join(APP_ROOT, "0.153.4", "codex.exe");
  const STALE = "C:\\Users\\test\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";

  function appDeps(configDir: string) {
    return {
      configDir,
      env: { LOCALAPPDATA: LOCAL_APP_DATA, PATH: NO_CODEX_PATH },
      platform: "win32" as const,
      existsSync: (path: string) => path === STALE || path === APP_EXE,
      readdirSync: (path: string) => path === APP_ROOT ? ["0.153.4"] : [],
      statSync: (path: string) => path === join(APP_ROOT, "0.153.4")
        ? { mtimeMs: 2_000, isDirectory: () => true }
        : { mtimeMs: 0, isDirectory: () => false },
      execFileSync: ((file: string) => {
        if (String(file) === STALE) return "codex-cli 0.135.0";
        if (String(file) === APP_EXE) return "codex-cli 0.153.4";
        throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      }) as RuntimeExecFile,
      discoverAlternatives: false as const,
    };
  }

  function writePersisted(configDir: string, origin?: "pinned" | "discovered"): void {
    const payload: Record<string, unknown> = {
      version: 1,
      command: STALE,
      source: "configured",
      selectedVersion: "0.135.0",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    if (origin !== undefined) payload.origin = origin;
    writeFileSync(join(configDir, "codex-runtime.json"), JSON.stringify(payload));
  }

  test("an unpinned stale pin still yields to the Codex App runtime PATH never exposes", () => {
    // This is the arrangement issue 4204 actually reports. The catalog's bundled
    // loader passes discoverAlternatives: false, so before this the resolve
    // stopped at the still-runnable 0.135.0 under Programs\OpenAI and never
    // probed the 0.153.4 the Desktop app was running out of LOCALAPPDATA.
    const configDir = tempConfigDir();
    writePersisted(configDir);
    const result = resolveCodexRuntime(appDeps(configDir));
    expect(result.runtime.command).toBe(APP_EXE);
    expect(result.runtime.version).toBe("0.153.4");
    expect(result.runtime.source).toBe("installed");
    expect(result.supersededDiscovered?.from.version).toBe("0.135.0");
    expect(result.supersededDiscovered?.to.version).toBe("0.153.4");
  });

  test("a pinned stale selection is left alone even though the App runtime is newer", () => {
    const configDir = tempConfigDir();
    writePersisted(configDir, "pinned");
    const result = resolveCodexRuntime(appDeps(configDir));
    expect(result.runtime.command).toBe(STALE);
    expect(result.runtime.version).toBe("0.135.0");
    expect(result.supersededDiscovered).toBeUndefined();
  });

  test("with no persisted record the early stop still skips the installed roots", () => {
    // Nothing to supersede means nothing to compare against, so the hot path
    // keeps its original cost: first valid candidate wins and the scan ends.
    const configDir = tempConfigDir();
    const probed: string[] = [];
    const deps = appDeps(configDir);
    // A colon-free PATH entry: pathCandidates splits on node's path delimiter,
    // which is ":" on the POSIX runners this suite also runs on, so a drive
    // letter here would split into two directories that match nothing.
    const pathDir = "/opt/on-path";
    const pathExe = join(pathDir, "codex.exe");
    const result = resolveCodexRuntime({
      ...deps,
      env: { LOCALAPPDATA: LOCAL_APP_DATA, PATH: pathDir },
      existsSync: (path: string) => path === pathExe || path === APP_EXE,
      execFileSync: ((file: string) => {
        probed.push(String(file));
        return "codex-cli 0.140.0";
      }) as RuntimeExecFile,
    });
    expect(result.runtime.source).toBe("path");
    expect(result.runtime.command).toBe(pathExe);
    expect(probed).not.toContain(APP_EXE);
  });
});
