import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  CODEX_SHIM_AUTO_RESTORE_ENV,
  codexAutoStartEnabled,
  codexShimAutoRestoreEnabled,
  getConfigPath,
  getDefaultConfig,
  getPidPath,
  getRuntimePortPath,
  isValidProviderName,
  isOcxStartCommandLine,
  loadConfig,
  multiAgentGuidanceEnabled,
  parsePidFile,
  positiveIntegerConfigError,
  positiveIntegerRecordConfigError,
  readConfigDiagnostics,
  readPid,
  readRuntimePort,
  removePid,
  removeRuntimePort,
  ocxStartProcessCacheSizeForTests,
  setOcxStartProcessCacheForTests,
  setProcessCommandLineExecForTests,
  setProcessCommandLinePlatformForTests,
  validateConfigCandidate,
  writeRuntimePort,
  writePid,
} from "../src/config";

import * as windowsAcl from "../src/lib/windows-secret-acl";
import { setTrustedWindowsSystemDirectoryResolverForTests } from "../src/lib/windows-elevation";
import { AtomicWriteResidualTempError, atomicWriteFile, atomicWriteFileAsync, hardenConfigDir, hardenExistingSecret, renameAtomicFile, saveConfig } from "../src/config";
import { nextAtomicTempSequence } from "../src/config/atomic-write";
import { providerManagementConfigError } from "../src/server/auth-cors";
let testDir = "";

/**
 * Windows without Developer Mode or admin cannot create a file symlink (EPERM).
 * Detect once so the dotfiles cases below report a visible skip there rather than
 * a spurious failure in the fixture, before the writer under test is ever called.
 * Mirrors the probe in codex-service-manager-probe and claude-agents-inject.
 */
const canSymlink = (() => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-config-symlink-probe-"));
  try {
    symlinkSync(join(dir, "probe-target"), join(dir, "probe-link"));
    return true;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") return false;
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-config-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  delete process.env.OPENCODEX_HOME;
  if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
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

function writeResponsesPathConfig(responsesPath: string): void {
  writeConfig({
    port: 12345,
    providers: {
      custom: {
        adapter: "openai-responses",
        baseUrl: "https://example.test/api/v3",
        responsesPath,
      },
    },
    defaultProvider: "custom",
  });
}

function writeAccountNamespaceConfig(
  codexAccountNamespaces: unknown,
  overrides: Record<string, unknown> = {},
): void {
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
    codexAccountNamespaces,
    ...overrides,
  });
}

describe("opencodex config defaults", () => {
  test("malformed classifier config is normalized at load, even with subagentEffort absent (#1697)", () => {
    // normalizePersistedClaudeCode used to be reached only through a subagentEffort short-circuit,
    // so a config whose ONLY defect was elsewhere in claudeCode was never normalized. These
    // fixtures deliberately omit subagentEffort, which is what the old path skipped on.
    writeConfig({
      port: 10100,
      providers: { p1: { adapter: "openai-chat", baseUrl: "https://p1.example/v1" } },
      claudeCode: { classifierFallbacks: "RelayC/claude-opus-5", classifierModel: "   " },
    });
    const loaded = loadConfig() as Record<string, any>;
    expect(loaded.claudeCode?.classifierFallbacks).toBeUndefined();
    expect(loaded.claudeCode?.classifierModel).toBeUndefined();
    expect(loaded.providers.p1).toBeDefined();
  });

  test("classifier fallback entries are filtered rather than trusted (#1697)", () => {
    writeConfig({
      port: 10100,
      providers: { p1: { adapter: "openai-chat", baseUrl: "https://p1.example/v1" } },
      claudeCode: { classifierFallbacks: [1, "  RelayC/claude-opus-5  ", "", null] },
    });
    const loaded = loadConfig() as Record<string, any>;
    expect(loaded.claudeCode?.classifierFallbacks).toEqual(["RelayC/claude-opus-5"]);
  });

  test("empty-completion retry is an explicit top-level opt-in", () => {
    const defaults = getDefaultConfig();
    expect(defaults.emptyCompletionRetry).toBe(false);
    expect(validateConfigCandidate({ ...defaults, emptyCompletionRetry: true })).toMatchObject({
      ok: true,
      config: { emptyCompletionRetry: true },
    });
    expect(validateConfigCandidate({ ...defaults, emptyCompletionRetry: "true" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("emptyCompletionRetry"),
    });
  });

  test("usage and MCP config overrides change the effective bound while defaults remain compatible", () => {
    const defaults = getDefaultConfig();
    expect(defaults.managementUsageMaxReadBytes).toBe(64 * 1024 * 1024);
    const valid = validateConfigCandidate({
      ...defaults,
      managementUsageMaxReadBytes: 1024,
      providers: { ...defaults.providers, openai: { ...defaults.providers.openai!, mcpMaxTools: 1, mcpMaxSchemaBytes: 2, mcpMaxResultBytes: 3 } },
    });
    expect(valid).toMatchObject({ ok: true, config: { managementUsageMaxReadBytes: 1024, providers: { openai: { mcpMaxTools: 1, mcpMaxSchemaBytes: 2, mcpMaxResultBytes: 3 } } } });
    for (const value of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(validateConfigCandidate({ ...defaults, managementUsageMaxReadBytes: value }).ok).toBe(false);
      expect(validateConfigCandidate({ ...defaults, providers: { ...defaults.providers, openai: { ...defaults.providers.openai!, mcpMaxTools: value } } }).ok).toBe(false);
    }
  });
  test("atomic rename retries transient Windows sharing violations", () => {
    const sleeps: number[] = [];
    let attempts = 0;
    renameAtomicFile("source.tmp", "config.json", {
      platform: "win32",
      rename: () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("locked"), { code: "EPERM" });
      },
      sleep: ms => sleeps.push(ms),
    });

    expect(attempts).toBe(3);
    expect(sleeps).toEqual([25, 50]);
  });

  test("atomic rename does not retry non-transient errors", () => {
    let attempts = 0;
    expect(() => renameAtomicFile("source.tmp", "config.json", {
      platform: "win32",
      rename: () => {
        attempts += 1;
        throw Object.assign(new Error("invalid"), { code: "EINVAL" });
      },
      sleep: () => {},
    })).toThrow("invalid");
    expect(attempts).toBe(1);
  });
  test("Codex autostart is enabled by default", () => {
    expect(getDefaultConfig().codexAutoStart).toBe(true);
    expect(codexAutoStartEnabled({})).toBe(true);
  });

  test("appOwnedMemoryBudgetMb defaults to 256 MiB", () => {
    expect(getDefaultConfig().appOwnedMemoryBudgetMb).toBe(256);
    expect(validateConfigCandidate({ ...getDefaultConfig(), appOwnedMemoryBudgetMb: undefined })).toMatchObject({
      ok: true,
      config: { appOwnedMemoryBudgetMb: 256 },
    });
  });

  test("appOwnedMemoryBudgetMb accepts integer bounds and rejects raw invalid candidates before normalization", () => {
    expect(validateConfigCandidate({ ...getDefaultConfig(), appOwnedMemoryBudgetMb: 64 }).ok).toBe(true);
    expect(validateConfigCandidate({ ...getDefaultConfig(), appOwnedMemoryBudgetMb: 4096 }).ok).toBe(true);
    for (const value of [63, 4097, 64.5, "64", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateConfigCandidate({ ...getDefaultConfig(), appOwnedMemoryBudgetMb: value }).ok).toBe(false);
    }
  });

  test("Antigravity static-catalog migration marker is schema-safe but not default-injected", () => {
    expect(getDefaultConfig().googleAntigravityStaticCatalogVersion).toBeUndefined();

    writeConfig({
      port: 12345,
      defaultProvider: "custom",
      googleAntigravityStaticCatalogVersion: 1,
      providers: { custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } },
    });
    expect(loadConfig().googleAntigravityStaticCatalogVersion).toBe(1);

    writeConfig({
      port: 12345,
      defaultProvider: "custom",
      googleAntigravityStaticCatalogVersion: 2,
      providers: { custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } },
    });
    expect(loadConfig().googleAntigravityStaticCatalogVersion).toBe(2);
    expect(backupNames()).toEqual([]);

    expect(validateConfigCandidate({
      ...getDefaultConfig(),
      googleAntigravityStaticCatalogVersion: 3,
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining("googleAntigravityStaticCatalogVersion"),
    });
  });

  test("Codex autostart can be disabled explicitly", () => {
    expect(codexAutoStartEnabled({ codexAutoStart: false })).toBe(false);
    expect(codexAutoStartEnabled({ codexAutoStart: true })).toBe(true);
  });

  test("config candidates reject blank server hostnames", () => {
    const base = getDefaultConfig();

    expect(validateConfigCandidate({ ...base, hostname: "" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("hostname"),
    });
    expect(validateConfigCandidate({ ...base, hostname: "   " })).toMatchObject({
      ok: false,
      error: expect.stringContaining("hostname"),
    });
    expect(validateConfigCandidate({ ...base, hostname: "127.0.0.1" })).toMatchObject({
      ok: true,
      config: expect.objectContaining({ hostname: "127.0.0.1" }),
    });
  });

  // A write must not inherit the read path's degrade-to-undefined: dropping a malformed
  // map on load leaves the raw entries in the file to be repaired by hand, but dropping
  // it on a write erases every order the user had set and still reports success.
  test("config candidates reject a malformed selection-order map instead of erasing it", () => {
    const base = getDefaultConfig();

    expect(validateConfigCandidate({ ...base, codexAccountPriorities: { work: 2, side: 200 } })).toMatchObject({
      ok: false,
      error: expect.stringContaining("codexAccountPriorities"),
    });
    expect(validateConfigCandidate({ ...base, codexAccountPriorities: { "bad id!": 1 } })).toMatchObject({
      ok: false,
      error: expect.stringContaining("codexAccountPriorities"),
    });
    expect(validateConfigCandidate({ ...base, activeCodexAccountPinned: "not a valid id" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("activeCodexAccountPinned"),
    });
    // A coercing guard lets these through — String(123) matches the id pattern — and the
    // schema's .catch(undefined) then drops the pin while reporting the write as a success.
    for (const pin of [123, true, ["work"]]) {
      expect(validateConfigCandidate({ ...base, activeCodexAccountPinned: pin })).toMatchObject({
        ok: false,
        error: expect.stringContaining("activeCodexAccountPinned"),
      });
    }
    expect(validateConfigCandidate({
      ...base,
      codexAccountPriorities: { work: 2, __main__: -2 },
      activeCodexAccountPinned: "work",
    })).toMatchObject({
      ok: true,
      config: expect.objectContaining({
        codexAccountPriorities: { work: 2, __main__: -2 },
        activeCodexAccountPinned: "work",
      }),
    });
  });

  test("config candidates validate Claude Code subagent effort levels", () => {
    const base = getDefaultConfig();
    for (const subagentEffort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(validateConfigCandidate({
        ...base,
        claudeCode: { ...base.claudeCode, subagentEffort },
      })).toMatchObject({
        ok: true,
        config: { claudeCode: { subagentEffort } },
      });
    }
    expect(validateConfigCandidate({
      ...base,
      claudeCode: { ...base.claudeCode, subagentEffort: "ultra" },
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining("claudeCode.subagentEffort"),
    });
  });

  test("an invalid persisted Claude Code subagent effort is ignored without wiping config or logging its value", () => {
    const invalidEffort = "credential-like-value";
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({
      port: 12345,
      defaultProvider: "custom",
      providers: { custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "upstream-secret" } },
      apiKeys: [{ id: "key-1", name: "default", key: "ocx_persisted", createdAt: "2026-07-28T00:00:00.000Z" }],
      claudeCode: { subagentEffort: invalidEffort },
    });

    const config = loadConfig();
    const diagnostics = readConfigDiagnostics();

    expect(config.claudeCode?.subagentEffort).toBeUndefined();
    expect(config).toMatchObject({
      port: 12345,
      defaultProvider: "custom",
      providers: { custom: { baseUrl: "https://example.test/v1", apiKey: "upstream-secret" } },
      apiKeys: [expect.objectContaining({ id: "key-1", key: "ocx_persisted" })],
    });
    expect(diagnostics).toMatchObject({
      source: "file",
      error: null,
      warnings: [expect.stringContaining("claudeCode.subagentEffort ignored")],
    });
    expect(diagnostics.config.claudeCode?.subagentEffort).toBeUndefined();
    expect(backupNames()).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.flat().join(" ")).not.toContain(invalidEffort);
    warnSpy.mockRestore();
  });

  test("a blank hostname already on disk degrades without wiping providers or keys", () => {
    // Regression: rejecting a blank hostname in the schema made loadConfig fail twice
    // (getDefaultConfig() has no hostname key, so the merge-defaults repair cannot fix
    // one), which backed the file up and returned defaults — resetting providers and
    // apiKeys for exactly the users the blank-hostname hardening was meant to protect.
    writeConfig({
      port: 12345,
      hostname: "",
      defaultProvider: "custom",
      providers: { custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "upstream-secret" } },
      apiKeys: [{ id: "key-1", name: "default", key: "ocx_persisted", createdAt: "2026-07-28T00:00:00.000Z" }],
    });

    const config = loadConfig();

    expect(config.hostname).toBeUndefined();
    expect(config).toMatchObject({
      port: 12345,
      defaultProvider: "custom",
      providers: { custom: { baseUrl: "https://example.test/v1", apiKey: "upstream-secret" } },
      apiKeys: [expect.objectContaining({ id: "key-1", key: "ocx_persisted" })],
    });
    expect(backupNames()).toEqual([]);
  });

  test("an inherited FastWire conflict warns without wiping persisted providers or keys", () => {
    writeConfig({
      port: 12345,
      defaultProvider: "openai-apikey",
      providers: {
        "openai-apikey": {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authMode: "key",
          fastWire: null,
        },
      },
      apiKeys: [{ id: "key-1", name: "default", key: "ocx_persisted", createdAt: "2026-07-28T00:00:00.000Z" }],
    });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const loaded = loadConfig();
      const diagnostics = readConfigDiagnostics();

      expect(loaded).toMatchObject({
        port: 12345,
        defaultProvider: "openai-apikey",
        providers: { "openai-apikey": { fastWire: null } },
        apiKeys: [expect.objectContaining({ id: "key-1", key: "ocx_persisted" })],
      });
      expect(diagnostics).toMatchObject({
        source: "file",
        error: null,
        warnings: [expect.stringContaining("fastWire=null overrides service-tier capability")],
      });
      expect(backupNames()).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("persisted providers and API keys were preserved"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("a non-string experimentalRealtimeWsBaseUrl degrades to unset without wiping config", () => {
    // The sideband builder calls overrideBaseUrl?.trim(); a boolean here would crash
    // it, so the schema degrades the field instead of rejecting the whole config.
    writeConfig({
      port: 12345,
      defaultProvider: "custom",
      providers: { custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "upstream-secret" } },
      experimentalRealtimeWsBaseUrl: true,
    });

    const config = loadConfig();

    expect(config.experimentalRealtimeWsBaseUrl).toBeUndefined();
    expect(config).toMatchObject({
      port: 12345,
      providers: { custom: { baseUrl: "https://example.test/v1", apiKey: "upstream-secret" } },
    });
    expect(backupNames()).toEqual([]);
  });

  test("a string experimentalRealtimeWsBaseUrl round-trips through loadConfig", () => {
    writeConfig({
      port: 12345,
      defaultProvider: "custom",
      providers: { custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } },
      experimentalRealtimeWsBaseUrl: "https://realtime.example.test/v1",
    });

    expect(loadConfig().experimentalRealtimeWsBaseUrl).toBe("https://realtime.example.test/v1");
  });

  test("a whitespace hostname on disk is treated the same as a blank one", () => {
    writeConfig({
      port: 12345,
      hostname: "   ",
      defaultProvider: "custom",
      providers: { custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } },
    });

    const config = loadConfig();

    expect(config.hostname).toBeUndefined();
    expect(config.providers.custom.baseUrl).toBe("https://example.test/v1");
    expect(backupNames()).toEqual([]);
  });

  test("Codex shim auto-restore defaults on with config and environment opt-out precedence", () => {
    expect(getDefaultConfig().codexShimAutoRestore).toBe(true);
    expect(codexShimAutoRestoreEnabled({}, {})).toBe(true);
    expect(codexShimAutoRestoreEnabled({ codexShimAutoRestore: true }, {})).toBe(true);
    expect(codexShimAutoRestoreEnabled({ codexShimAutoRestore: false }, {})).toBe(false);
    expect(codexShimAutoRestoreEnabled(
      { codexShimAutoRestore: false },
      { [CODEX_SHIM_AUTO_RESTORE_ENV]: "1" },
    )).toBe(false);
    expect(codexShimAutoRestoreEnabled({}, { [CODEX_SHIM_AUTO_RESTORE_ENV]: "0" })).toBe(false);
    expect(codexShimAutoRestoreEnabled(
      { codexShimAutoRestore: true },
      { [CODEX_SHIM_AUTO_RESTORE_ENV]: "0" },
    )).toBe(false);
  });

  test("codexShimAutoRestore loads false and rejects non-booleans", () => {
    const base = {
      port: 10100,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
      defaultProvider: "openai",
    };
    writeConfig({ ...base, codexShimAutoRestore: false });
    expect(readConfigDiagnostics().config.codexShimAutoRestore).toBe(false);

    for (const invalid of [null, "false", 0]) {
      writeConfig({ ...base, codexShimAutoRestore: invalid });
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.source).toBe("fallback");
      expect(diagnostics.error).toContain("codexShimAutoRestore");
    }
  });

  test("multi-agent guidance is default-on and false is the only off state", () => {
    expect(getDefaultConfig().multiAgentGuidanceEnabled).toBe(true);
    expect(multiAgentGuidanceEnabled({})).toBe(true);
    expect(multiAgentGuidanceEnabled({ multiAgentGuidanceEnabled: true })).toBe(true);
    expect(multiAgentGuidanceEnabled({ multiAgentGuidanceEnabled: false })).toBe(false);
  });

  test("multiAgentGuidanceEnabled loads false and rejects non-booleans", () => {
    const base = {
      port: 10100,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
      defaultProvider: "openai",
    };
    writeConfig({ ...base, multiAgentGuidanceEnabled: false });
    expect(loadConfig().multiAgentGuidanceEnabled).toBe(false);

    for (const invalid of [null, "false"]) {
      writeConfig({ ...base, multiAgentGuidanceEnabled: invalid });
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.source).toBe("fallback");
      expect(diagnostics.error).toContain("multiAgentGuidanceEnabled");
    }
  });

  test("agentTaskRecovery is explicit, bounded, and degrades invalid hand edits", () => {
    const base = {
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
        },
      },
      defaultProvider: "custom",
    };
    expect(getDefaultConfig().agentTaskRecovery).toBeUndefined();

    const recovery = {
      enabled: true,
      model: "gpt-5.6-sol",
      timeoutMs: 45_000,
      cacheEntries: 200,
    };
    writeConfig({ ...base, agentTaskRecovery: recovery });
    expect(loadConfig()).toMatchObject({ ...base, agentTaskRecovery: recovery });
    expect(validateConfigCandidate({ ...base, agentTaskRecovery: recovery })).toMatchObject({
      ok: true,
      config: { agentTaskRecovery: recovery },
    });

    for (const invalid of [
      true,
      { enabled: "true" },
      { enabled: true, model: " " },
      { enabled: true, timeoutMs: 999 },
      { enabled: true, timeoutMs: 120_001 },
      { enabled: true, cacheEntries: 0 },
      { enabled: true, cacheEntries: 513 },
      { enabled: true, url: "https://attacker.example/responses" },
    ]) {
      writeConfig({ ...base, agentTaskRecovery: invalid });
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics).toMatchObject({
        source: "file",
        error: null,
        config: base,
      });
      expect(diagnostics.config.agentTaskRecovery).toBeUndefined();
      expect(diagnostics.warnings?.some(warning => warning.startsWith("agentTaskRecovery"))).toBe(true);
      expect(loadConfig()).toMatchObject(base);
      expect(loadConfig().agentTaskRecovery).toBeUndefined();
      expect(validateConfigCandidate({ ...base, agentTaskRecovery: invalid })).toMatchObject({
        ok: false,
        error: expect.stringContaining("agentTaskRecovery"),
      });
      expect(backupNames()).toEqual([]);
    }
  });

  test("native subagent-default sync is opt-in and ignores malformed opt-ins without falling back", () => {
    const base = {
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
        },
      },
      defaultProvider: "custom",
      codexAccounts: [{ id: "account-1", email: "owner@example.test", isMain: true }],
      injectionModel: "gpt-5.6-terra",
    };
    expect(getDefaultConfig().syncCodexSubagentDefaults).toBeUndefined();

    for (const enabled of [true, false]) {
      writeConfig({ ...base, syncCodexSubagentDefaults: enabled });
      expect(loadConfig().syncCodexSubagentDefaults).toBe(enabled);
    }

    for (const invalid of [null, "true", 1]) {
      writeConfig({ ...base, syncCodexSubagentDefaults: invalid });
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics).toMatchObject({
        source: "file",
        error: null,
        config: {
          port: 12345,
          defaultProvider: "custom",
          providers: { custom: { baseUrl: "https://example.test/v1" } },
          codexAccounts: [{ id: "account-1", email: "owner@example.test", isMain: true }],
          injectionModel: "gpt-5.6-terra",
        },
      });
      expect(diagnostics.config.syncCodexSubagentDefaults).toBeUndefined();
      expect(diagnostics.warnings).toContain("syncCodexSubagentDefaults ignored: expected a boolean");
      expect(loadConfig()).toMatchObject({
        port: 12345,
        defaultProvider: "custom",
        providers: { custom: { baseUrl: "https://example.test/v1" } },
        codexAccounts: [{ id: "account-1", email: "owner@example.test", isMain: true }],
      });
      expect(backupNames()).toEqual([]);
    }
  });

  test("validates disk injection selections and safely normalizes a model-less sync opt-in", () => {
    const base = {
      port: 10100,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
      defaultProvider: "openai",
    };
    writeConfig({
      ...base,
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "ultra",
      syncCodexSubagentDefaults: true,
    });
    expect(loadConfig()).toMatchObject({
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "ultra",
      syncCodexSubagentDefaults: true,
    });

    for (const invalid of ["", "   "]) {
      writeConfig({ ...base, injectionModel: invalid, syncCodexSubagentDefaults: true });
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.source).toBe("file");
      expect(diagnostics.error).toBeNull();
      expect(diagnostics.config.injectionModel).toBe(invalid);
      expect(diagnostics.config.syncCodexSubagentDefaults).toBeUndefined();
      expect(diagnostics.warnings).toContain("syncCodexSubagentDefaults ignored: a nonblank injectionModel is required");
    }

    for (const invalid of ["", "turbo"]) {
      writeConfig({
        ...base,
        injectionModel: "gpt-5.6-terra",
        injectionEffort: invalid,
        syncCodexSubagentDefaults: true,
      });
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.source).toBe("file");
      expect(diagnostics.error).toBeNull();
      expect(diagnostics.config.injectionEffort).toBe(invalid);
      expect(diagnostics.config.syncCodexSubagentDefaults).toBeUndefined();
      expect(diagnostics.warnings).toContain("syncCodexSubagentDefaults ignored: injectionEffort must be a supported Codex reasoning effort");
    }

    for (const [field, invalid] of [["injectionModel", 1], ["injectionEffort", 1]] as const) {
      writeConfig({
        ...base,
        injectionModel: "gpt-5.6-terra",
        syncCodexSubagentDefaults: true,
        [field]: invalid,
      });
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.source).toBe("file");
      expect(diagnostics.error).toBeNull();
      expect(diagnostics.config.port).toBe(10100);
      expect(diagnostics.config.defaultProvider).toBe("openai");
      expect(diagnostics.config.providers.openai.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
      expect(diagnostics.config[field]).toBeUndefined();
      expect(diagnostics.config.syncCodexSubagentDefaults).toBeUndefined();
      expect(diagnostics.warnings).toContain(`${field} ignored: expected a string`);
      expect(diagnostics.warnings?.some(warning => warning.startsWith("syncCodexSubagentDefaults ignored:"))).toBe(true);
      expect(loadConfig()).toMatchObject({
        port: 10100,
        defaultProvider: "openai",
        providers: { openai: { baseUrl: "https://chatgpt.com/backend-api/codex" } },
      });
      expect(backupNames()).toEqual([]);
    }

    // Guidance-only values retain their pre-existing compatibility. They are
    // constrained only when the native Codex config mutation is opted into.
    writeConfig({ ...base, injectionModel: "legacy/model", injectionEffort: "provider-specific" });
    expect(readConfigDiagnostics()).toMatchObject({
      source: "file",
      error: null,
      config: { injectionModel: "legacy/model", injectionEffort: "provider-specific" },
    });

    writeConfig({ ...base, syncCodexSubagentDefaults: true });
    const normalized = readConfigDiagnostics();
    expect(normalized.source).toBe("file");
    expect(normalized.error).toBeNull();
    expect(normalized.config.syncCodexSubagentDefaults).toBeUndefined();
    expect(loadConfig().syncCodexSubagentDefaults).toBeUndefined();
  });

  test("paused Codex account ids persist and reject malformed values", () => {
    const base = {
      port: 10100,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
      defaultProvider: "openai",
    };
    writeConfig({ ...base, pausedCodexAccountIds: ["__main__", "pool-a"] });
    expect(loadConfig().pausedCodexAccountIds).toEqual(["__main__", "pool-a"]);

    for (const invalid of ["pool-a", ["bad/account"], [1]]) {
      writeConfig({ ...base, pausedCodexAccountIds: invalid });
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.source).toBe("fallback");
      expect(diagnostics.error).toContain("pausedCodexAccountIds");
    }
  });

  test("loads valid config from OPENCODEX_HOME", () => {
    writeConfig({
      port: 12345,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      defaultProvider: "custom",
      codexAutoStart: false,
    });

    expect(loadConfig()).toMatchObject({
      port: 12345,
      defaultProvider: "custom",
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      codexAutoStart: false,
    });
  });

  test("accepts OpenAI account mode only on the canonical forward provider", () => {
    for (const codexAccountMode of ["pool", "direct"] as const) {
      writeConfig({
        port: 12345,
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authMode: "forward",
            codexAccountMode,
          },
        },
        defaultProvider: "openai",
        openaiProviderTierVersion: 2,
      });
      expect(readConfigDiagnostics().config.providers.openai.codexAccountMode).toBe(codexAccountMode);
      expect(readConfigDiagnostics().error).toBeNull();
    }
  });

  test("rejects invalid or noncanonical codexAccountMode placements", () => {
    for (const [name, provider] of [
      ["custom", { adapter: "openai-chat", baseUrl: "https://example.test/v1", codexAccountMode: "pool" }],
      ["openai", { adapter: "openai-chat", baseUrl: "https://example.test/v1", codexAccountMode: "direct" }],
      ["openai", { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "random" }],
    ] as const) {
      writeConfig({ port: 12345, providers: { [name]: provider }, defaultProvider: name });
      expect(readConfigDiagnostics().source).toBe("fallback");
      expect(readConfigDiagnostics().error).toContain("codexAccountMode");
    }
  });

  test("accepts both codexToolMode values and rejects a misspelled one (#2106)", () => {
    for (const codexToolMode of ["code_mode_only", "shell"] as const) {
      writeConfig({
        port: 12345,
        providers: {
          custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1", codexToolMode },
        },
        defaultProvider: "custom",
      });
      expect(readConfigDiagnostics().config.providers.custom.codexToolMode).toBe(codexToolMode);
      expect(readConfigDiagnostics().error).toBeNull();
    }

    // The regression this guards: `providerConfigSchema` ends in `.passthrough()`, so an
    // undeclared key survives verbatim. Before the enum was declared, "shel" was accepted,
    // persisted, and then silently resolved to the `code_mode_only` default — the operator
    // asked for shell mode, got code mode, and was told nothing.
    writeConfig({
      port: 12345,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1", codexToolMode: "shel" },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("codexToolMode");
  });

  test("accepts the exact responsesItemIdRepair shape and rejects the old nested placeholderIds proposal", () => {
    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
          responsesItemIdRepair: {
            reasoning: ["rs_0"],
            message: ["msg_0"],
            repairMissingTerminalIds: true,
          },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().error).toBeNull();
    expect(readConfigDiagnostics().config.providers.custom.responsesItemIdRepair).toEqual({
      reasoning: ["rs_0"],
      message: ["msg_0"],
      repairMissingTerminalIds: true,
    });

    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
          responsesItemIdRepair: {
            placeholderIds: { reasoning: ["rs_0"] },
          },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("responsesItemIdRepair");
  });

  test("accepts only a boolean responsesSnapshotRepair opt-in", () => {
    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
          responsesSnapshotRepair: true,
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().error).toBeNull();
    expect(readConfigDiagnostics().config.providers.custom.responsesSnapshotRepair).toBe(true);

    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
          responsesSnapshotRepair: { enabled: true },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("responsesSnapshotRepair");
  });

  test("accepts only a boolean xaiResponsesXSearch provider opt-in", () => {
    const provider = {
      adapter: "openai-responses",
      baseUrl: "https://cli-chat-proxy.grok.com/v1",
    };
    writeConfig({
      port: 12345,
      providers: { xai: { ...provider, xaiResponsesXSearch: true } },
      defaultProvider: "xai",
    });
    expect(readConfigDiagnostics().error).toBeNull();
    expect(readConfigDiagnostics().config.providers.xai.xaiResponsesXSearch).toBe(true);
    expect(providerManagementConfigError("xai", { ...provider, xaiResponsesXSearch: true })).toBeNull();

    writeConfig({
      port: 12345,
      providers: { xai: { ...provider, xaiResponsesXSearch: { enabled: true } } },
      defaultProvider: "xai",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("xaiResponsesXSearch");
    expect(providerManagementConfigError("xai", { ...provider, xaiResponsesXSearch: "true" }))
      .toBe("provider xai xaiResponsesXSearch must be a boolean");
  });

  test("direct Gemini wire rename opt-out is a boolean and round-trips", () => {
    const base = {
      port: 12345,
      providers: {
        google: {
          adapter: "google",
          baseUrl: "https://generativelanguage.googleapis.com",
        },
      },
      defaultProvider: "google",
    };
    writeConfig({
      ...base,
      providers: {
        google: { ...base.providers.google, directGeminiWireRenames: false },
      },
    });
    const config = loadConfig();
    expect(config.providers.google.directGeminiWireRenames).toBe(false);
    saveConfig(config);
    expect(loadConfig().providers.google.directGeminiWireRenames).toBe(false);

    writeConfig({
      ...base,
      providers: {
        google: { ...base.providers.google, directGeminiWireRenames: "false" },
      },
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("directGeminiWireRenames");
  });

  test("accepts a relative responsesPath", () => {
    writeResponsesPathConfig("/responses");

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("file");
    expect(diagnostics.error).toBeNull();
    expect(diagnostics.config.providers.custom.responsesPath).toBe("/responses");
  });

  test("rejects responsesPath without a leading slash", () => {
    writeResponsesPathConfig("responses");

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.error).toContain("responsesPath must start with /");
  });

  test("rejects responsesPath containing a URL scheme, query, or fragment", () => {
    for (const [responsesPath, expectedError] of [
      ["https://other-origin.example/responses", "responsesPath must be a relative path without a URL scheme"],
      ["/https://other-origin.example/responses", "responsesPath must be a relative path without a URL scheme"],
      ["/responses?api-version=v1", "responsesPath must not include query strings or fragments"],
      ["/responses#section", "responsesPath must not include query strings or fragments"],
    ] as const) {
      writeResponsesPathConfig(responsesPath);

      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.source).toBe("fallback");
      expect(diagnostics.error).toContain(expectedError);
    }
  });

  test("reads valid config diagnostics without mutation", () => {
    writeConfig({
      port: 12345,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      defaultProvider: "custom",
      codexAutoStart: false,
    });

    const diagnostics = readConfigDiagnostics();

    expect(diagnostics.source).toBe("file");
    expect(diagnostics.error).toBeNull();
    expect(diagnostics.config).toMatchObject({
      port: 12345,
      defaultProvider: "custom",
      codexAutoStart: false,
    });
    expect(backupNames()).toHaveLength(0);
  });

  test("missing config diagnostics use defaults without creating files", () => {
    const beforeFiles = readdirSync(testDir).sort();
    const diagnostics = readConfigDiagnostics();
    const afterFiles = readdirSync(testDir).sort();

    expect(diagnostics).toEqual({
      config: getDefaultConfig(),
      source: "default",
      error: null,
    });
    expect(afterFiles).toEqual(beforeFiles);
  });

  test("malformed config diagnostics fall back without backup or raw content", () => {
    writeConfig('{ "apiKey": "sk-secret-leak", invalid json');
    const beforeFiles = readdirSync(testDir).sort();

    const diagnostics = readConfigDiagnostics();
    const afterFiles = readdirSync(testDir).sort();

    expect(diagnostics.config).toEqual(getDefaultConfig());
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.error).toBe("invalid_json");
    expect(JSON.stringify(diagnostics)).not.toContain("sk-secret-leak");
    expect(afterFiles).toEqual(beforeFiles);
    expect(backupNames()).toHaveLength(0);
  });

  test("resolves relative OPENCODEX_HOME once to an absolute config directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-parent-"));
    const oldCwd = process.cwd();
    try {
      process.env.OPENCODEX_HOME = "relative-home";
      process.chdir(parent);
      const firstPath = getConfigPath();
      const expectedConfigDir = resolve("relative-home");

      process.chdir(tmpdir());

      expect(firstPath).toBe(join(expectedConfigDir, "config.json"));
      expect(getConfigPath()).toBe(firstPath);
      expect(getPidPath()).toBe(join(expectedConfigDir, "ocx.pid"));
    } finally {
      process.chdir(oldCwd);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("uses the default home when OPENCODEX_HOME is unset", () => {
    delete process.env.OPENCODEX_HOME;

    expect(getConfigPath()).toBe(join(homedir(), ".opencodex", "config.json"));
    expect(getPidPath()).toBe(join(homedir(), ".opencodex", "ocx.pid"));
  });

  test("loads UTF-8 BOM config files written by Windows tools", () => {
    writeFileSync(
      getConfigPath(),
      `\uFEFF${JSON.stringify({
        port: 23456,
        providers: {
          custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
        },
        defaultProvider: "custom",
      })}`,
      "utf-8",
    );

    expect(loadConfig()).toMatchObject({
      port: 23456,
      defaultProvider: "custom",
    });
  });

  test("backs up invalid JSON config before falling back to defaults", () => {
    writeConfig("{ invalid json");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const loaded = loadConfig();

      expect(loaded).toEqual(getDefaultConfig());
      const backups = backupNames();
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(testDir, backups[0]), "utf-8")).toBe("{ invalid json");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Could not load opencodex config"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("repairs structurally incomplete config by merging defaults instead of rejecting", () => {
    writeConfig({ port: 10100 });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const loaded = loadConfig();

      // Merge should fill in missing providers and defaultProvider from defaults
      expect(loaded.port).toBe(10100);
      expect(loaded.defaultProvider).toBe("openai");
      expect(loaded.providers).toBeDefined();
      // No backup created — config was repaired, not rejected
      const backups = backupNames();
      expect(backups).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("repaired"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("backs up config when defaultProvider is absent from providers", () => {
    writeConfig({
      port: 10100,
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex" },
      },
      defaultProvider: "missing",
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const loaded = loadConfig();

      expect(loaded).toEqual(getDefaultConfig());
      const backups = backupNames();
      expect(backups).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("defaultProvider must exist in providers"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("diagnoses config with unsafe provider URLs or sensitive headers", () => {
    for (const provider of [
      { adapter: "openai-chat", baseUrl: "file:///tmp/provider" },
      { adapter: "openai-chat", baseUrl: "https://user:pass@example.test/v1" },
      { adapter: "openai-chat", baseUrl: "https://example.test/v1?token=secret" },
      { adapter: "openai-chat", baseUrl: "https://example.test/v1", headers: { Authorization: "Bearer secret" } },
      { adapter: "openai-chat", baseUrl: "https://example.test/v1", headers: { "X-Custom": "ok\r\nInjected: yes" } },
    ]) {
      rmSync(testDir, { recursive: true, force: true });
      mkdirSync(testDir, { recursive: true });
      writeConfig({
        port: 10100,
        providers: { custom: provider },
        defaultProvider: "custom",
      });

      const diagnostics = readConfigDiagnostics();

      expect(diagnostics.config).toEqual(getDefaultConfig());
      expect(diagnostics.source).toBe("fallback");
      expect(diagnostics.error).toContain("providers.custom");
      expect(JSON.stringify(diagnostics)).not.toContain("Bearer secret");
    }
  });

  test("accepts bearer transport only for Anthropic API-key providers", () => {
    const base = { port: 10100, defaultProvider: "gateway" };
    writeConfig({
      ...base,
      providers: {
        gateway: { adapter: "anthropic", baseUrl: "https://gateway.example/v1", authMode: "key", apiKeyTransport: "bearer" },
      },
    });
    expect(readConfigDiagnostics().error).toBeNull();

    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          modelAdapters: { "provider-image-model": "openai-responses" },
          modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().error).toBeNull();

    for (const provider of [
      { adapter: "openai-chat", baseUrl: "https://gateway.example/v1", authMode: "key", apiKeyTransport: "bearer" },
      { adapter: "anthropic", baseUrl: "https://gateway.example/v1", authMode: "oauth", apiKeyTransport: "bearer" },
    ]) {
      writeConfig({ ...base, providers: { gateway: provider } });
      expect(readConfigDiagnostics().source).toBe("fallback");
      expect(readConfigDiagnostics().error).toContain("apiKeyTransport");
    }
  });

  test("validates provider context cap maps explicitly", () => {
    writeConfig({
      port: 10100,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      defaultProvider: "custom",
      providerContextCaps: { custom: 350_000 },
    });

    expect(loadConfig().providerContextCaps).toEqual({ custom: 350_000 });

    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    writeConfig({
      port: 10100,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      defaultProvider: "custom",
      providerContextCaps: { custom: -1 },
    });

    const diagnostics = readConfigDiagnostics();

    expect(diagnostics.config).toEqual(getDefaultConfig());
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.error).toContain("providerContextCaps");
  });

  test("modelMaxInputTokens accepts only plain positive finite integer records", () => {
    expect(positiveIntegerRecordConfigError({ "gpt-5.6-sol": 922_000 }, "modelMaxInputTokens")).toBeNull();
    expect(positiveIntegerRecordConfigError(Object.create({ inherited: 1 }), "modelMaxInputTokens")).toContain("own properties");
    for (const invalid of [null, [], { model: 0 }, { model: -1 }, { model: 1.5 }, { model: "1" }, { model: Number.POSITIVE_INFINITY }]) {
      expect(positiveIntegerRecordConfigError(invalid, "modelMaxInputTokens")).not.toBeNull();
    }
  });

  test("modelSupportsReasoningSummaries accepts only plain boolean records", () => {
    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
          modelSupportsReasoningSummaries: { strict: false, normal: true },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().error).toBeNull();

    for (const invalid of [[], { strict: "false" }, { "": false }]) {
      writeConfig({
        port: 12345,
        providers: {
          custom: {
            adapter: "openai-responses",
            baseUrl: "https://example.test/v1",
            modelSupportsReasoningSummaries: invalid,
          },
        },
        defaultProvider: "custom",
      });
      expect(readConfigDiagnostics().source).toBe("fallback");
      expect(readConfigDiagnostics().error).toContain("modelSupportsReasoningSummaries");
    }
  });

  test("modelSupportsVerbosity accepts only plain boolean records", () => {
    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
          modelSupportsVerbosity: { strict: false, normal: true },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().error).toBeNull();

    for (const invalid of [[], { strict: "false" }, { "": false }]) {
      writeConfig({
        port: 12345,
        providers: {
          custom: {
            adapter: "openai-responses",
            baseUrl: "https://example.test/v1",
            modelSupportsVerbosity: invalid,
          },
        },
        defaultProvider: "custom",
      });
      expect(readConfigDiagnostics().source).toBe("fallback");
      expect(readConfigDiagnostics().error).toContain("modelSupportsVerbosity");
    }

  });

  test("modelReasoningSummaryDelivery validates known values and rejects summary opt-out conflicts (#538)", () => {
    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
          modelSupportsReasoningSummaries: { strict: true },
          modelReasoningSummaryDelivery: {
            strict: "sequential",
            concurrent: "concurrent_cutoff",
          },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().error).toBeNull();

    for (const modelReasoningSummaryDelivery of [
      [],
      { strict: "serial" },
      { "": "sequential" },
    ]) {
      writeConfig({
        port: 12345,
        providers: {
          custom: {
            adapter: "openai-responses",
            baseUrl: "https://example.test/v1",
            modelReasoningSummaryDelivery,
          },
        },
        defaultProvider: "custom",
      });
      expect(readConfigDiagnostics().source).toBe("fallback");
      expect(readConfigDiagnostics().error).toContain("modelReasoningSummaryDelivery");
    }

    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
          modelSupportsReasoningSummaries: { STRICT: false },
          modelReasoningSummaryDelivery: { strict: "sequential" },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("conflicts with modelSupportsReasoningSummaries=false");
  });

  test("modelPreferHostedTools accepts only supported hosted-tool arrays", () => {
    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
          modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().error).toBeNull();

    // A registry `modelWireDefaults` entry that selects openai-responses for a
    // Responses inbound must be honored by validation, exactly as the runtime
    // honors it. DeepSeek's preset routes `deepseek-v4-flash` over native
    // Responses for a Responses inbound while the provider-wide wire stays
    // openai-chat; validating from `registry.adapter` alone rejected a
    // preference the runtime would have accepted.
    writeConfig({
      port: 12345,
      providers: {
        deepseek: {
          adapter: "openai-chat",
          baseUrl: "https://api.deepseek.com/v1",
          modelPreferHostedTools: { "deepseek-v4-flash": ["image_generation"] },
        },
      },
      defaultProvider: "deepseek",
    });
    expect(readConfigDiagnostics().error).toBeNull();

    // The mirror of the case above. `volcengine-agent-plan` is a Responses registry row
    // with `preserveCustomDestination`, so a config reusing that id while pointing at a
    // different endpoint keeps its own transport at runtime —
    // `providerMatchesRegistryTransport()` returns false and `routedProviderConfig()`
    // preserves the configured `openai-chat` adapter. Validating from `registry.adapter`
    // unconditionally would accept a preference that the Responses adapter never sees.
    writeConfig({
      port: 12345,
      providers: {
        "volcengine-agent-plan": {
          adapter: "openai-chat",
          baseUrl: "https://custom.example.test/v1",
          modelPreferHostedTools: { "some-model": ["image_generation"] },
        },
      },
      defaultProvider: "volcengine-agent-plan",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("requires the openai-responses wire");

    // The forward-auth half of the same effective-transport question. A
    // `preserveCustomDestination` registry row reused under a different endpoint keeps
    // its OWN auth at runtime, not the registry's, because `routedProviderConfig()`
    // honors `providerMatchesRegistryTransport()`. Deciding forward-auth from
    // `registry.authKind` alone accepted a preference the adapter never applies:
    // `preferConfiguredHostedTools()` runs only on the non-forward branch.
    writeConfig({
      port: 12345,
      providers: {
        "volcengine-agent-plan": {
          adapter: "openai-responses",
          authMode: "forward",
          baseUrl: "https://custom.example.test/v1",
          modelPreferHostedTools: { "some-model": ["image_generation"] },
        },
      },
      defaultProvider: "volcengine-agent-plan",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("not supported on forward-auth");

    // Registry providers route through their registry wire, not this persisted adapter.
    writeConfig({
      port: 12345,
      providers: {
        "openai-apikey": {
          adapter: "openai-chat",
          baseUrl: "https://api.openai.com/v1",
          modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
        },
      },
      defaultProvider: "openai-apikey",
    });
    expect(readConfigDiagnostics().error).toBeNull();

    writeConfig({
      port: 12345,
      providers: {
        "openai-apikey": {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          modelAdapters: { "gpt-5.6-sol": "openai-chat" },
          modelPreferHostedTools: { "gpt-5.6-sol-pro": ["image_generation"] },
        },
      },
      defaultProvider: "openai-apikey",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("requires the openai-responses wire");

    for (const modelPreferHostedTools of [
      [],
      { "": ["image_generation"] },
      { model: [] },
      { model: "image_generation" },
      { model: ["web_search"] },
    ]) {
      writeConfig({
        port: 12345,
        providers: {
          custom: {
            adapter: "openai-responses",
            baseUrl: "https://example.test/v1",
            modelPreferHostedTools,
          },
        },
        defaultProvider: "custom",
      });
      expect(readConfigDiagnostics().source).toBe("fallback");
      expect(readConfigDiagnostics().error).toContain("modelPreferHostedTools");
    }

    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("requires the openai-responses wire");

    writeConfig({
      port: 12345,
      providers: {
        openrouter: {
          adapter: "openai-responses",
          baseUrl: "https://openrouter.ai/api/v1",
          modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
        },
      },
      defaultProvider: "openrouter",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("requires the openai-responses wire");

    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
          modelAdapters: { "provider-image-model": "openai-chat" },
          modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("requires the openai-responses wire");

    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
          modelPreferHostedTools: { "gpt-5.3-codex-spark": ["image_generation"] },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("does not support");

    writeConfig({
      port: 12345,
      providers: {
        openai: {
          adapter: "openai-responses",
          authMode: "forward",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
        },
      },
      defaultProvider: "openai",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("not supported on forward-auth");
  });

  test("modelAdapters accepts only allowed wires on eligible providers (#404)", () => {
    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          modelAdapters: { "grok-4.5": "openai-responses" },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().error).toBeNull();

    for (const invalid of [
      [],
      { "grok-4.5": true },
      { "": "openai-chat" },
      // Provider-specific adapters carry their own credential semantics.
      { "grok-4.5": "cursor" },
      { "grok-4.5": "anthropic" },
    ]) {
      writeConfig({
        port: 12345,
        providers: {
          custom: {
            adapter: "openai-chat",
            baseUrl: "https://example.test/v1",
            modelAdapters: invalid,
          },
        },
        defaultProvider: "custom",
      });
      expect(readConfigDiagnostics().source).toBe("fallback");
      expect(readConfigDiagnostics().error).toContain("modelAdapters");
    }
  });

  test("modelAdapters rejects wire-pinned models rather than ignoring them (#404)", () => {
    writeConfig({
      port: 12345,
      providers: {
        "opencode-go": {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          modelAdapters: { "minimax-m3": "openai-chat" },
        },
      },
      defaultProvider: "opencode-go",
    });

    // The resolver would silently ignore this; failing load tells the user why.
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("modelAdapters");
  });

  test("modelAdapters is rejected on the canonical forward provider (#404)", () => {
    writeConfig({
      port: 12345,
      providers: {
        openai: {
          adapter: "openai-responses",
          authMode: "forward",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          modelAdapters: { "gpt-5.5": "openai-chat" },
        },
      },
      defaultProvider: "openai",
    });

    // Switching that provider to the chat wire would drop the forwarded credential.
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("modelAdapters");
  });

  test("output token defaults accept only positive finite integers", () => {
    expect(positiveIntegerConfigError(128_000, "defaultMaxOutputTokens")).toBeNull();
    for (const invalid of [null, [], {}, 0, -1, 1.5, "128000", Number.POSITIVE_INFINITY]) {
      expect(positiveIntegerConfigError(invalid, "defaultMaxOutputTokens")).not.toBeNull();
    }

    expect(positiveIntegerRecordConfigError({ "glm-5.2": 128_000 }, "modelMaxOutputTokens")).toBeNull();
    expect(positiveIntegerRecordConfigError({ "glm-5.2": 0 }, "modelMaxOutputTokens")).not.toBeNull();
  });

  test("disk config rejects malformed output token defaults", () => {
    writeConfig({
      port: 10100,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1", defaultMaxOutputTokens: 1.5 },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("providers.custom.defaultMaxOutputTokens");

    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    writeConfig({
      port: 10100,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1", modelMaxOutputTokens: { model: 0 } },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("providers.custom.modelMaxOutputTokens");
  });

  test("disk config rejects malformed modelMaxInputTokens", () => {
    writeConfig({
      port: 10100,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1", modelMaxInputTokens: { model: 1.5 } },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("providers.custom.modelMaxInputTokens");
  });

  test("disk config validates per-model auto-compaction budgets with native exact ids", () => {
    writeConfig({
      port: 10100,
      providers: {
        custom: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          modelAutoCompactTokenLimits: { model: 1.5 },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("providers.custom.modelAutoCompactTokenLimits");

    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    writeConfig({
      port: 10100,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
          modelAutoCompactTokenLimits: { "team/gpt-5.6-sol": 64_000 },
        },
      },
      defaultProvider: "openai",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("exact supported native model id");
  });

  test("disk config preserves valid OpenRouter routing and rejects invalid destinations", () => {
    writeConfig({
      port: 10100,
      providers: {
        openrouter: {
          adapter: "openai-chat",
          baseUrl: "https://openrouter.ai/api/v1",
          openRouterRouting: { order: ["deepseek"], allowFallbacks: false },
          modelOpenRouterRouting: { "anthropic/claude-sonnet-5": { only: ["anthropic"] } },
        },
      },
      defaultProvider: "openrouter",
    });
    expect(loadConfig().providers.openrouter).toMatchObject({
      openRouterRouting: { order: ["deepseek"], allowFallbacks: false },
      modelOpenRouterRouting: { "anthropic/claude-sonnet-5": { only: ["anthropic"] } },
    });

    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    writeConfig({
      port: 10100,
      providers: {
        custom: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          openRouterRouting: { only: ["deepseek"] },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics()).toMatchObject({
      source: "fallback",
      error: expect.stringContaining("canonical https://openrouter.ai/api/v1"),
    });
  });

  test("disk config rejects forged registry-only virtual model maps", () => {
    writeConfig({
      port: 10100,
      providers: {
        "openai-apikey": {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          virtualModels: { "gpt-evil-pro": { wireModelId: "gpt-evil", reasoningMode: "pro" } },
        },
      },
      defaultProvider: "openai-apikey",
    });
    expect(readConfigDiagnostics()).toMatchObject({ source: "fallback", error: expect.stringContaining("virtualModels") });
  });

  test("validates the global context cap value", () => {
    writeConfig({
      port: 10100,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      defaultProvider: "custom",
      contextCapValue: 500_000,
    });

    expect(loadConfig().contextCapValue).toBe(500_000);

    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    writeConfig({
      port: 10100,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      defaultProvider: "custom",
      contextCapValue: -5,
    });

    const diagnostics = readConfigDiagnostics();

    expect(diagnostics.config).toEqual(getDefaultConfig());
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.error).toContain("contextCapValue");
  });

  test("backs up config when provider validation fails during load", () => {
    writeConfig({
      port: 10100,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1", headers: { Authorization: "Bearer secret" } },
      },
      defaultProvider: "custom",
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const loaded = loadConfig();

      expect(loaded).toEqual(getDefaultConfig());
      expect(backupNames()).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("providers.custom.headers"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  describe("one bad entry in an independent section does not discard the config (#1785)", () => {
    /** Two usable providers, a disabled one, prices, and a profile worth keeping. */
    function configWith(extra: Record<string, unknown>): void {
      writeConfig({
        port: 10100,
        providers: {
          TR:    { adapter: "openai-chat", baseUrl: "https://tr.example/v1", disabled: true },
          keep1: { adapter: "openai-chat", baseUrl: "https://keep1.example/v1" },
          keep2: { adapter: "openai-chat", baseUrl: "https://keep2.example/v1" },
        },
        modelCosts: { "keep1/m": { input: 1, output: 2 } },
        ...extra,
      });
    }

    test("a candidate naming a disabled provider drops only its profile", () => {
      configWith({
        routingProfiles: {
          good: { candidates: [{ provider: "keep1", model: "m" }] },
          bad:  { candidates: [{ provider: "TR", model: "moonshotai/kimi-k3" }] },
        },
      });
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const loaded = loadConfig() as Record<string, any>;

        // The reported symptom was 11 providers on disk and 1 served.
        expect(Object.keys(loaded.providers)).toEqual(expect.arrayContaining(["TR", "keep1", "keep2"]));
        expect(loaded.modelCosts).toHaveProperty("keep1/m");
        expect(Object.keys(loaded.routingProfiles)).toEqual(["good"]);

        // Naming both the profile and why, so the operator can act on it.
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("routingProfiles.bad"));
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("is disabled"));
      } finally {
        errorSpy.mockRestore();
      }
    });

    test("salvaging is not a fallback, so no invalid-* backup piles up", () => {
      // The reporter accumulated 10 of these before noticing anything was wrong;
      // a backup on every load is the signal that the config was discarded.
      configWith({ routingProfiles: { bad: { candidates: [{ provider: "TR", model: "m" }] } } });
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        loadConfig();
        expect(backupNames()).toEqual([]);
      } finally {
        errorSpy.mockRestore();
      }
    });


    test("diagnostics keep the operator's config instead of reporting defaults", () => {
      // The salvage in loadConfig was not enough on its own. readConfigDiagnostics returned
      // getDefaultConfig(), and a config command writing that result back would have persisted
      // built-in defaults over the operator's providers, keys and prices.
      //
      // The failure is still REPORTED -- source stays "fallback" and error keeps the schema
      // message, which is what provider reload, catalog sync, cost reconcile and codex admission
      // gate on. Only the config payload changes.
      configWith({
        routingProfiles: {
          good: { candidates: [{ provider: "keep1", model: "m" }] },
          bad:  { candidates: [{ provider: "TR", model: "moonshotai/kimi-k3" }] },
        },
      });
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const diagnostics = readConfigDiagnostics();

        // Still invalid, and still says why.
        expect(diagnostics.source).toBe("fallback");
        expect(diagnostics.error).toContain("is disabled");

        // But the payload is the operator's config, not the factory defaults.
        const config = diagnostics.config as Record<string, any>;
        expect(Object.keys(config.providers)).toEqual(expect.arrayContaining(["TR", "keep1", "keep2"]));
        expect(config.modelCosts).toHaveProperty("keep1/m");
        expect(Object.keys(config.routingProfiles ?? {})).toEqual(["good"]);
      } finally {
        errorSpy.mockRestore();
      }
    });

    test("salvage repeats when dropping one entry exposes a new failure", () => {
      // Sections are not independent of each other: a profile alias is validated against the
      // combo map, so removing an invalid combo can surface a NEW failure in a profile that
      // was fine while that combo existed. A single-pass salvage saw that second failure and
      // discarded the whole config -- the outcome this exists to stop.
      configWith({
        combos: {
          badCombo: { members: [{ provider: "nope-not-configured", model: "m" }] },
        },
        routingProfiles: {
          alsoBad: { candidates: [{ provider: "TR", model: "m" }] },
          good:    { candidates: [{ provider: "keep2", model: "m" }] },
        },
      });
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const loaded = loadConfig() as Record<string, any>;

        // Everything unrelated survives, and both bad entries are gone.
        expect(Object.keys(loaded.providers)).toEqual(expect.arrayContaining(["TR", "keep1", "keep2"]));
        expect(loaded.modelCosts).toHaveProperty("keep1/m");
        expect(Object.keys(loaded.combos ?? {})).not.toContain("badCombo");
        expect(Object.keys(loaded.routingProfiles ?? {})).toEqual(["good"]);
      } finally {
        errorSpy.mockRestore();
      }
    });

    test("a token-shaped entry id is not echoed into the warning", () => {
      // Entry ids are operator-chosen and can be pasted secrets. The warning names the
      // section so the operator knows where to look, but nothing dynamic goes out raw.
      const tokenId = "sk-ant-api03-" + "A".repeat(40);
      configWith({
        routingProfiles: {
          [tokenId]: { candidates: [{ provider: "TR", model: "m" }] },
        },
      });
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        loadConfig();
        const logged = errorSpy.mock.calls.map(call => String(call[0])).join("\n");
        expect(logged).toContain("routingProfiles.");
        expect(logged).not.toContain(tokenId);
      } finally {
        errorSpy.mockRestore();
      }
    });
    test("combos are salvaged the same way", () => {
      configWith({
        combos: {
          good: { members: [{ provider: "keep1", model: "m" }] },
          bad:  { members: [{ provider: "nope-not-configured", model: "m" }] },
        },
      });
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const loaded = loadConfig() as Record<string, any>;
        expect(Object.keys(loaded.providers)).toEqual(expect.arrayContaining(["keep1", "keep2"]));
        expect(Object.keys(loaded.combos ?? {})).not.toContain("bad");
      } finally {
        errorSpy.mockRestore();
      }
    });

    test("every bad profile is dropped, not just the first", () => {
      configWith({
        routingProfiles: {
          bad1: { candidates: [{ provider: "TR", model: "m" }] },
          good: { candidates: [{ provider: "keep1", model: "m" }] },
          bad2: { candidates: [{ provider: "also-not-configured", model: "m" }] },
        },
      });
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(Object.keys((loadConfig() as Record<string, any>).routingProfiles)).toEqual(["good"]);
      } finally {
        errorSpy.mockRestore();
      }
    });

    test("a failure outside those sections still falls back, unchanged", () => {
      // The salvage path must not become a way to load configs that are broken
      // somewhere it cannot reason about.
      writeConfig({
        port: 10100,
        providers: {
          custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1", headers: { Authorization: "Bearer secret" } },
        },
        routingProfiles: { bad: { candidates: [{ provider: "nope", model: "m" }] } },
      });
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(loadConfig()).toEqual(getDefaultConfig());
        expect(backupNames()).toHaveLength(1);
      } finally {
        errorSpy.mockRestore();
      }
    });

    test("a malformed container is not an entry, so it is not salvaged", () => {
      configWith({ routingProfiles: [] });
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(loadConfig()).toEqual(getDefaultConfig());
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  test("provider names reject namespace-breaking and reserved object keys", () => {
    expect(isValidProviderName("openrouter")).toBe(true);
    expect(isValidProviderName("ollama-cloud")).toBe(true);
    expect(isValidProviderName("openrouter/custom")).toBe(false);
    expect(isValidProviderName("__proto__")).toBe(false);
    expect(isValidProviderName("constructor")).toBe(false);
  });

  test("persists an explicit Codex account selector map without adding one to defaults", () => {
    const selectors = {
      desktop: "@main",
      work: "work-account",
      legacy: "work-account",
      poolNamedMain: "main",
    };
    writeAccountNamespaceConfig(selectors);

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.error).toBeNull();
    expect(diagnostics.config.codexAccountNamespaces).toEqual(selectors);
    expect(Object.hasOwn(getDefaultConfig(), "codexAccountNamespaces")).toBe(false);
  });

  test("persists the optional picker override without adding it to defaults", () => {
    for (const enabled of [true, false]) {
      writeAccountNamespaceConfig({ desktop: "@main" }, { codexAccountPickerEnabled: enabled });

      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.error).toBeNull();
      expect(diagnostics.config.codexAccountPickerEnabled).toBe(enabled);
    }

    expect(Object.hasOwn(getDefaultConfig(), "codexAccountPickerEnabled")).toBe(false);
  });

  test("malformed persisted picker visibility fails closed without discarding accounts or providers", () => {
    writeAccountNamespaceConfig({ desktop: "@main", side: "stored-account" }, {
      codexAccountPickerEnabled: "yes",
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "stored-account", email: "side@example.test", isMain: false },
      ],
    });

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics).toMatchObject({
      source: "file",
      error: null,
      config: {
        defaultProvider: "openai",
        providers: { openai: { baseUrl: "https://chatgpt.com/backend-api/codex" } },
        codexAccounts: [
          { id: "main", email: "main@example.test", isMain: true },
          { id: "stored-account", email: "side@example.test", isMain: false },
        ],
        codexAccountNamespaces: { desktop: "@main", side: "stored-account" },
        codexAccountPickerEnabled: false,
      },
    });
    expect(diagnostics.warnings).toContain(
      "codexAccountPickerEnabled ignored: expected a boolean",
    );
    expect(backupNames()).toEqual([]);

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(loadConfig()).toMatchObject({
        codexAccountPickerEnabled: false,
        codexAccountNamespaces: { desktop: "@main", side: "stored-account" },
        providers: { openai: { baseUrl: "https://chatgpt.com/backend-api/codex" } },
      });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("codexAccountPickerEnabled ignored"));
    } finally {
      warnSpy.mockRestore();
    }

    for (const invalid of [null, "false", 1]) {
      expect(validateConfigCandidate({
        ...getDefaultConfig(),
        codexAccountPickerEnabled: invalid,
      })).toMatchObject({
        ok: false,
        error: expect.stringContaining("codexAccountPickerEnabled"),
      });
    }

    const inherited = Object.assign(
      Object.create({ codexAccountPickerEnabled: true }) as Record<string, unknown>,
      getDefaultConfig(),
    );
    expect(validateConfigCandidate(inherited)).toMatchObject({
      ok: false,
      error: expect.stringContaining("own boolean data property"),
    });

    let getterCalls = 0;
    const accessor = { ...getDefaultConfig() } as Record<string, unknown>;
    Object.defineProperty(accessor, "codexAccountPickerEnabled", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return true;
      },
    });
    expect(validateConfigCandidate(accessor)).toMatchObject({
      ok: false,
      error: expect.stringContaining("own boolean data property"),
    });
    expect(getterCalls).toBe(0);
  });

  test("validates Claude Desktop profiles and Codex account selectors independently", () => {
    const desktopProfile = {
      version: 1,
      assignments: {},
      defaults: { opus: null, fable: null, sonnet: null, haiku: null },
    };
    writeAccountNamespaceConfig({ main: "@main" }, { claudeCode: { desktopProfile } });
    expect(readConfigDiagnostics()).toMatchObject({
      error: null,
      config: { claudeCode: { desktopProfile }, codexAccountNamespaces: { main: "@main" } },
    });

    writeAccountNamespaceConfig({ main: "@main" }, {
      claudeCode: { desktopProfile: { ...desktopProfile, version: 2 } },
    });
    expect(readConfigDiagnostics().error).toContain("claudeCode.desktopProfile");

    writeAccountNamespaceConfig({ "bad/selector": "account-id" }, { claudeCode: { desktopProfile } });
    expect(readConfigDiagnostics().error).toContain("codexAccountNamespaces.bad/selector");
  });

  test.each([
    ["null", null],
    ["an array", []],
    ["a string", "main"],
  ] as const)("rejects Codex account selectors stored as %s", (_label, selectors) => {
    writeAccountNamespaceConfig(selectors);

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.error).toContain("codexAccountNamespaces must be a plain object");
  });

  test.each([
    ["blank", "", "side-account"],
    ["surrounding whitespace", " side", "side-account"],
    ["a slash", "side/account", "side-account"],
    ["a reserved prototype key", "__proto__", "side-account"],
    ["a reserved constructor key", "constructor", "side-account"],
    ["an empty target", "side", ""],
    ["the internal main account id", "side", "__main__"],
    ["a reserved prototype target", "side", "__proto__"],
    ["a reserved prototype-name target", "side", "prototype"],
    ["a reserved constructor target", "side", "Constructor"],
    ["a target with whitespace", "side", "side account"],
    ["a target with a slash", "side", "account/id"],
    ["an overlong target", "side", "a".repeat(65)],
    ["a non-string target", "side", 42],
  ] as const)("rejects %s in the Codex account selector map", (_label, selector, target) => {
    writeAccountNamespaceConfig(Object.fromEntries([[selector, target]]));

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.error).toContain(`codexAccountNamespaces.${selector}`);
  });

  test.each([
    [
      "a configured provider",
      { side: "side-account" },
      {
        providers: {
          side: { adapter: "openai-chat", baseUrl: "https://side.example.test/v1" },
        },
        defaultProvider: "side",
      },
      "must not collide",
    ],
    [
      "a configured provider with different casing",
      { SIDE: "side-account" },
      {
        providers: {
          side: { adapter: "openai-chat", baseUrl: "https://side.example.test/v1" },
        },
        defaultProvider: "side",
      },
      "must not collide",
    ],
    ["the combo namespace", { combo: "side-account" }, {}, "must not collide"],
    ["the combo namespace with different casing", { Combo: "side-account" }, {}, "must not collide"],
    ["the routing policy namespace", { policy: "side-account" }, {}, "must not collide"],
    ["the routing policy namespace with different casing", { Policy: "side-account" }, {}, "must not collide"],
    ["the canonical OpenAI namespace with different casing", { OpenAI: "side-account" }, {}, "must not collide"],
    [
      "the canonical OpenAI provider namespace before legacy migration",
      { openai: "side-account" },
      {
        providers: {
          "openai-multi": {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authMode: "forward",
          },
        },
        defaultProvider: "openai-multi",
      },
      "must not collide",
    ],
    [
      "a combo alias prefix",
      { side: "side-account" },
      {
        combos: {
          intentional: {
            alias: "side/gpt-5.5",
            targets: [{ provider: "openai", model: "gpt-5.5" }],
          },
        },
      },
      "combo alias must not use a configured Codex account namespace",
    ],
    [
      "a whitespace-padded combo alias prefix",
      { side: "side-account" },
      {
        combos: {
          intentional: {
            alias: " side/gpt-5.5 ",
            targets: [{ provider: "openai", model: "gpt-5.5" }],
          },
        },
      },
      "combo alias must not use a configured Codex account namespace",
    ],
    [
      "a configured pool account id",
      { work: "pool-a" },
      {
        codexAccounts: [{
          id: "work",
          email: "work@example.test",
          isMain: false,
        }],
      },
      "must not collide with configured Codex pool-account ids or account selector targets",
    ],
    [
      "another selector target",
      { primary: "side", side: "pool-a" },
      {},
      "must not collide with configured Codex pool-account ids or account selector targets",
    ],
  ] as const)("rejects a Codex account selector colliding with %s", (_label, selectors, overrides, error) => {
    writeAccountNamespaceConfig(selectors, overrides);

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.error).toContain(error);
  });

  test("backs up config when defaultProvider only exists on Object prototype", () => {
    writeConfig({
      port: 10100,
      providers: {},
      defaultProvider: "constructor",
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const loaded = loadConfig();

      expect(loaded).toEqual(getDefaultConfig());
      expect(backupNames()).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("defaultProvider must exist in providers"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("warns and backs up once per invalid config path", () => {
    writeConfig("{ invalid json");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(loadConfig()).toEqual(getDefaultConfig());
      expect(loadConfig()).toEqual(getDefaultConfig());

      expect(backupNames()).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("parses pid files", () => {
    expect(parsePidFile("12345")).toBe(12345);
    expect(parsePidFile("0")).toBeNull();
    expect(parsePidFile("12x")).toBeNull();
    expect(parsePidFile("not-json")).toBeNull();
  });

  test("recognizes opencodex start command lines", () => {
    expect(isOcxStartCommandLine('bun run src/cli.ts start')).toBe(true);
    expect(isOcxStartCommandLine('"C:/tools/bun/bin/bun.exe" "run" "src/cli/index.ts" "start"')).toBe(true);
    expect(isOcxStartCommandLine('bun C:/tools/bun/install/global/node_modules/@bitkyc08/opencodex/src/cli.ts start')).toBe(true);
    // npm's in-place rename during `npm install -g` (Windows service wrapper respawn mid-update).
    expect(isOcxStartCommandLine(
      'bun C:/nvm/node_modules/@bitkyc08/.opencodex-1JejBqbZ/src/cli/index.ts start --port 10100',
    )).toBe(true);
    expect(isOcxStartCommandLine("opencodex start")).toBe(true);

    expect(isOcxStartCommandLine("bun run src/cli.ts status")).toBe(false);
    expect(isOcxStartCommandLine("bun test C:/work/opencodex/tests/config.test.ts")).toBe(false);
    expect(isOcxStartCommandLine("notepad.exe")).toBe(false);
  });

  test("writes pid file as a numeric pid", () => {
    writePid(process.pid);

    expect(readFileSync(getPidPath(), "utf-8")).toBe(String(process.pid));
  });

  test("pid validation does not execute ps from PATH", () => {
    const attackerDir = join(testDir, "attacker-bin");
    const fakePs = join(attackerDir, "ps");
    const markerPath = `${fakePs}.executed`;
    const previousPath = process.env.PATH;
    const probes: string[] = [];
    mkdirSync(attackerDir);
    writeFileSync(fakePs, `#!/bin/sh\ntouch "$0.executed"\necho 'ocx start'\n`, { mode: 0o755 });

    setOcxStartProcessCacheForTests([]);
    try {
      setProcessCommandLinePlatformForTests("darwin");
      setProcessCommandLineExecForTests((executable) => {
        probes.push(executable);
        throw new Error("fixed ps probe unavailable");
      });
      process.env.PATH = `${attackerDir}${delimiter}${previousPath ?? ""}`;
      writePid(process.pid);

      expect(readPid()).toBeNull();
      expect(probes).toEqual(["/bin/ps", "/usr/bin/ps"]);
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      setProcessCommandLineExecForTests(null);
      setProcessCommandLinePlatformForTests(null);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      setOcxStartProcessCacheForTests([]);
    }

    expect(process.env.PATH).toBe(previousPath);
    expect(ocxStartProcessCacheSizeForTests()).toBe(0);
  });

  test("pid validation selects only trusted Windows process probes", () => {
    const previousSystemRoot = process.env.SystemRoot;
    const previousWindir = process.env.WINDIR;
    const trustedSystem32 = join(testDir, "trusted", "System32");
    const trustedWmic = join(trustedSystem32, "wbem", "WMIC.exe");
    const trustedPowerShell = join(
      trustedSystem32,
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const attackerRoot = join(testDir, "attacker-windows");
    const calls: string[] = [];

    try {
      mkdirSync(dirname(trustedPowerShell), { recursive: true });
      writeFileSync(trustedPowerShell, "", { mode: 0o755 });
      setProcessCommandLinePlatformForTests("win32");
      setTrustedWindowsSystemDirectoryResolverForTests(() => trustedSystem32);
      process.env.SystemRoot = attackerRoot;
      process.env.WINDIR = attackerRoot;
      writeFileSync(getPidPath(), String(process.pid), "utf-8");
      setOcxStartProcessCacheForTests([]);

      setProcessCommandLineExecForTests((executable) => {
        calls.push(executable);
        if (executable === trustedWmic) return "CommandLine=ocx start\r\n";
        throw new Error(`unexpected process probe: ${executable}`);
      });
      expect(readPid()).toBe(process.pid);
      expect(calls).toEqual([trustedWmic]);

      calls.length = 0;
      setOcxStartProcessCacheForTests([]);
      setProcessCommandLineExecForTests((executable) => {
        calls.push(executable);
        if (executable === trustedWmic) throw new Error("WMIC unavailable");
        if (executable === trustedPowerShell) return "ocx start\n";
        throw new Error(`unexpected process probe: ${executable}`);
      });
      expect(readPid()).toBe(process.pid);
      expect(calls).toEqual([trustedWmic, trustedPowerShell]);
      expect(calls.every(executable => !executable.startsWith(attackerRoot))).toBe(true);
    } finally {
      setProcessCommandLineExecForTests(null);
      setProcessCommandLinePlatformForTests(null);
      setTrustedWindowsSystemDirectoryResolverForTests(null);
      setOcxStartProcessCacheForTests([]);
      if (previousSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousSystemRoot;
      if (previousWindir === undefined) delete process.env.WINDIR;
      else process.env.WINDIR = previousWindir;
    }

    expect(ocxStartProcessCacheSizeForTests()).toBe(0);
  });

  test("removes pid file only when the expected pid still matches", () => {
    writeFileSync(getPidPath(), "111", "utf-8");
    removePid(222);
    expect(existsSync(getPidPath())).toBe(true);

    removePid(111);
    expect(existsSync(getPidPath())).toBe(false);
  });

  test("runtime port metadata round-trips and validates expected pid", () => {
    const attestationSecret = "A".repeat(43);
    writeRuntimePort({ pid: 1234, port: 58195, hostname: "0.0.0.0", attestationSecret });

    expect(readRuntimePort()).toEqual({ pid: 1234, port: 58195, hostname: "0.0.0.0", attestationSecret });
    expect(readRuntimePort(1234)).toEqual({ pid: 1234, port: 58195, hostname: "0.0.0.0", attestationSecret });
    expect(readRuntimePort(9999)).toBeNull();
  });

  test("runtime port metadata removal preserves newer pid state", () => {
    writeRuntimePort({ pid: 1234, port: 58195 });

    removeRuntimePort(9999);
    expect(existsSync(getRuntimePortPath())).toBe(true);

    removeRuntimePort(1234);
    expect(existsSync(getRuntimePortPath())).toBe(false);
  });

  test("invalid runtime port metadata returns null", () => {
    writeFileSync(getRuntimePortPath(), JSON.stringify({ pid: 1234, port: 99999 }), "utf-8");

    expect(readRuntimePort()).toBeNull();

    writeFileSync(getRuntimePortPath(), JSON.stringify({ pid: 1234, port: 58195, attestationSecret: "too-short" }), "utf-8");
    expect(readRuntimePort()).toBeNull();
  });
});

describe("config.ts – Windows ACL hardening integration", () => {
  /**
   * Assert temp privacy through the mechanism THIS platform actually uses.
   *
   * POSIX mode bits are the POSIX mechanism. Windows has no POSIX mode: the
   * filesystem reports a synthesized value, and production knows it -- the
   * `(mode & 0o777) !== 0o600` check in `assertPrivateTempDescriptor` is
   * explicitly skipped on win32, where privacy comes from `hardenSecretPath`
   * instead. So this assertion was testing a property production never claims
   * there, and it failed with `Received: 54` while the ACL work it is named after
   * had already succeeded.
   *
   * The Windows branch is not weaker: reaching `afterTempWrite` at all means
   * `writePrivateTempFile` already ran `hardenSecretPath(..., required: true)`,
   * which throws rather than soft-failing. The bytes being readable here is the
   * evidence that the hardened descriptor is the one we hold.
   */
  function expectPrivateTempMode(tempPath: string): void {
    if (process.platform === "win32") {
      expect(lstatSync(tempPath).isFile()).toBe(true);
      return;
    }
    expect(statSync(tempPath).mode & 0o077).toBe(0);
  }

  test("secret temp bytes are private at first observation and a pre-existing temp is refused", () => {
    const destination = join(testDir, "atomic-private-secret.json");
    let observedSecret = false;
    atomicWriteFile(destination, "new-secret", undefined, {
      afterTempWrite: tempPath => {
        expect(readFileSync(tempPath, "utf8")).toBe("new-secret");
        expectPrivateTempMode(tempPath);
        observedSecret = true;
      },
    });
    expect(observedSecret).toBe(true);

    const occupiedSequence = nextAtomicTempSequence() + 1;
    const occupiedTemp = `${destination}.ocx.${process.pid}.${occupiedSequence}.tmp`;
    writeFileSync(occupiedTemp, "pre-existing", { encoding: "utf8", mode: 0o644 });
    expect(() => atomicWriteFile(destination, "replacement-secret", undefined, {
      afterTempWrite: tempPath => {
        expect(readFileSync(tempPath, "utf8")).not.toBe("replacement-secret");
        expectPrivateTempMode(tempPath);
      },
    })).toThrow();
    expect(readFileSync(occupiedTemp, "utf8")).toBe("pre-existing");
  });

  test("Windows ACL hardening completes before secret temp bytes are observable", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const hardenSpy = spyOn(windowsAcl, "hardenSecretPath").mockReturnValue({ ok: true });
    try {
      atomicWriteFile(join(testDir, "atomic-private-windows.json"), "windows-secret", undefined, {
        afterTempWrite: tempPath => {
          expect(readFileSync(tempPath, "utf8")).toBe("windows-secret");
          expect(hardenSpy).toHaveBeenCalled();
        },
      });
    } finally {
      hardenSpy.mockRestore();
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  test("successive atomic temps for one destination are each hardened and then forgotten", () => {
    const destination = join(testDir, "atomic-secret.json");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    windowsAcl.resetHardenedStateForTests();
    windowsAcl.setPlatformForTests("win32");
    let grants = 0;
    windowsAcl.setIcaclsRunnerForTests(args => {
      if (args.includes("/grant:r")) grants += 1;
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    const io = {
      write: (path: string, content: string) => writeFileSync(path, content, { mode: 0o600 }),
      harden: (path: string) => {
        chmodSync(path, 0o600);
        windowsAcl.hardenSecretPath(path, { required: true });
      },
      rename: renameSync,
      truncate: (path: string) => truncateSync(path, 0),
      unlink: unlinkSync,
    };
    try {
      atomicWriteFile(destination, "first", io);
      expect(windowsAcl.hardenedSecretPathCountForTests()).toBe(0);
      atomicWriteFile(destination, "second", io);
      expect(readFileSync(destination, "utf8")).toBe("second");
      expect(grants).toBe(2);
      expect(windowsAcl.hardenedSecretPathCountForTests()).toBe(0);
    } finally {
      windowsAcl.setIcaclsRunnerForTests(null);
      windowsAcl.setPlatformForTests(null);
      windowsAcl.resetHardenedStateForTests();
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
    }
  });

  test("failed residual unlink retains the exact temp memo until later cleanup", () => {
    const destination = join(testDir, "residual-secret.json");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    windowsAcl.resetHardenedStateForTests();
    windowsAcl.setPlatformForTests("win32");
    windowsAcl.setIcaclsRunnerForTests(() => ({
      success: true,
      exitCode: 0,
      timedOut: false,
      stdout: "",
    }));
    let residual: string | null = null;
    try {
      atomicWriteFile(destination, "secret", {
        write: (path, content) => writeFileSync(path, content, { mode: 0o600 }),
        harden: path => { windowsAcl.hardenSecretPath(path, { required: true }); },
        rename: () => {
          const error = new Error("rename failed") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        },
        truncate: path => truncateSync(path, 0),
        unlink: path => {
          residual = path;
          const error = new Error("unlink failed") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        },
      });
      throw new Error("expected residual error");
    } catch (error) {
      expect(error).toBeInstanceOf(AtomicWriteResidualTempError);
      expect(windowsAcl.hardenedSecretPathCountForTests()).toBe(1);
      expect(residual).not.toBeNull();
      unlinkSync(residual!);
      windowsAcl.forgetHardenedSecretPath(residual!);
      expect(windowsAcl.hardenedSecretPathCountForTests()).toBe(0);
    } finally {
      windowsAcl.setIcaclsRunnerForTests(null);
      windowsAcl.setPlatformForTests(null);
      windowsAcl.resetHardenedStateForTests();
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
    }
  });

  test("hardenConfigDir delegates to hardenSecretDir with required:false on win32", () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const spy = spyOn(windowsAcl, "hardenSecretDir").mockReturnValue({ ok: true });
      mkdirSync(testDir, { recursive: true });
      hardenConfigDir();
      expect(spy).toHaveBeenCalledWith(testDir, { required: false });
      spy.mockRestore();
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });

  test("hardenConfigDir does not call hardenSecretDir on non-Windows", () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const spy = spyOn(windowsAcl, "hardenSecretDir");
      mkdirSync(testDir, { recursive: true });
      hardenConfigDir();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });

  test("hardenExistingSecret delegates to hardenSecretPath with required:false on win32", () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const spy = spyOn(windowsAcl, "hardenSecretPath").mockReturnValue({ ok: true });
      const filePath = join(testDir, "auth.json");
      writeFileSync(filePath, "{}", "utf-8");
      hardenExistingSecret(filePath);
      expect(spy).toHaveBeenCalledWith(filePath, { required: false });
      spy.mockRestore();
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });

  test("hardenExistingSecret does not throw when ACL helper returns ok:false on win32", () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const spy = spyOn(windowsAcl, "hardenSecretPath").mockReturnValue({
        ok: false,
        diagnostics: "ACL hardening not supported on this filesystem",
      });
      const filePath = join(testDir, "auth.json");
      writeFileSync(filePath, "{}", "utf-8");
      expect(() => hardenExistingSecret(filePath)).not.toThrow();
      spy.mockRestore();
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });

  test("saveConfig applies hardenSecretDir with required:true on win32", () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const spy = spyOn(windowsAcl, "hardenSecretDir").mockReturnValue({ ok: true });
      saveConfig(getDefaultConfig());
      expect(spy).toHaveBeenCalledWith(testDir, {
        required: true,
        timeoutMemoKey: `${testDir}::config-mutation`,
      });
      expect(existsSync(getConfigPath())).toBe(true);
      spy.mockRestore();
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });

  test("saveConfig degrades when config-mutation directory hardening fails on win32", () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const spy = spyOn(windowsAcl, "hardenSecretDir").mockImplementation((_path, opts) => {
        if (opts?.required) throw new Error("ACL hardening failed: access denied");
        return { ok: true };
      });
      expect(() => saveConfig(getDefaultConfig())).not.toThrow();
      expect(existsSync(getConfigPath())).toBe(true);
      spy.mockRestore();
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });

  test("loadConfig does not throw when ACL helper fails non-fatally on win32", () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const spy1 = spyOn(windowsAcl, "hardenSecretDir").mockReturnValue({
      ok: false,
      diagnostics: "ACL hardening failed — filesystem may not support per-user ACLs",
    });
    const spy2 = spyOn(windowsAcl, "hardenSecretPath").mockReturnValue({ ok: false, diagnostics: "ACL unavailable" });
    try {
      const config = loadConfig();
      expect(config).toEqual(getDefaultConfig());
    } finally {
      spy1.mockRestore();
      spy2.mockRestore();
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });

  test("saveConfig does not call hardenSecretDir on non-Windows", () => {
    if (process.platform === "win32") return;
    const spy = spyOn(windowsAcl, "hardenSecretDir");
    saveConfig(getDefaultConfig());
    expect(spy).not.toHaveBeenCalled();
    expect(existsSync(getConfigPath())).toBe(true);
    spy.mockRestore();
  });
});

describe("config.ts – sync writer timeout keying (#840 refinement)", () => {
  test("the production sync harden keys timeouts by destination", () => {
    const destination = join(testDir, "sync-timeout-key.json");
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const hardenSpy = spyOn(windowsAcl, "hardenSecretPath").mockReturnValue({ ok: true });
    try {
      atomicWriteFile(destination, "secret");
      expect(hardenSpy).toHaveBeenCalledWith(
        expect.stringContaining(".tmp"),
        { required: true, timeoutMemoKey: destination },
      );
    } finally {
      hardenSpy.mockRestore();
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  test("timed-out write with a RESIDUAL temp retains both memos (fail-closed)", () => {
    const destination = join(testDir, "residual-timeout.json");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    windowsAcl.resetHardenedStateForTests();
    windowsAcl.setPlatformForTests("win32");
    windowsAcl.setIcaclsRunnerForTests(() => ({ success: false, exitCode: null, timedOut: true, stdout: "" }));
    const io = {
      write: (path: string, content: string) => writeFileSync(path, content, { mode: 0o600 }),
      harden: (path: string) => {
        chmodSync(path, 0o600);
        windowsAcl.hardenSecretPath(path, { required: true, timeoutMemoKey: destination });
      },
      rename: renameSync,
      truncate: (path: string) => truncateSync(path, 0),
      unlink: () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      },
    };
    try {
      expect(() => atomicWriteFile(destination, "secret", io)).toThrow();
      // Destination timeout memo retained (anti-restall) while the residual
      // temp remains on disk.
      expect(windowsAcl.timedOutSecretPathCountForTests()).toBe(1);
    } finally {
      windowsAcl.setIcaclsRunnerForTests(null);
      windowsAcl.setPlatformForTests(null);
      windowsAcl.resetHardenedStateForTests();
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
    }
  });
});

describe("config.ts – atomic writes preserve symlinked destinations", () => {
  test.skipIf(!canSymlink)("a symlinked destination survives the write and the real file receives it", () => {
    // Dotfiles shape: ~/.codex/config.toml -> ~/dotfiles/.codex/config.toml
    const repoDir = join(testDir, "dotfiles");
    mkdirSync(repoDir, { recursive: true });
    const realFile = join(repoDir, "config.toml");
    writeFileSync(realFile, "original", "utf-8");
    const link = join(testDir, "config.toml");
    symlinkSync(realFile, link);

    atomicWriteFile(link, "rewritten");

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(realFile);
    expect(readFileSync(realFile, "utf8")).toBe("rewritten");
    expect(readFileSync(link, "utf8")).toBe("rewritten");
  });

  test.skipIf(!canSymlink)("no temp file is left beside the link or its target", () => {
    const repoDir = join(testDir, "dotfiles-clean");
    mkdirSync(repoDir, { recursive: true });
    const realFile = join(repoDir, "config.toml");
    writeFileSync(realFile, "original", "utf-8");
    const link = join(testDir, "config-clean.toml");
    symlinkSync(realFile, link);

    atomicWriteFile(link, "rewritten");

    expect(readdirSync(repoDir).filter(name => name.includes(".ocx."))).toEqual([]);
    expect(readdirSync(testDir).filter(name => name.includes(".ocx."))).toEqual([]);
  });

  test("a plain destination is unaffected", () => {
    const destination = join(testDir, "plain.toml");
    atomicWriteFile(destination, "first");
    atomicWriteFile(destination, "second");

    expect(lstatSync(destination).isSymbolicLink()).toBe(false);
    expect(readFileSync(destination, "utf8")).toBe("second");
  });

  test("a destination that does not exist yet is created at the literal path", () => {
    const destination = join(testDir, "created.toml");
    expect(existsSync(destination)).toBe(false);

    atomicWriteFile(destination, "fresh");

    expect(readFileSync(destination, "utf8")).toBe("fresh");
  });

  test.skipIf(!canSymlink)("a dangling symlink is preserved and the write is refused", () => {
    const link = join(testDir, "dangling.toml");
    symlinkSync(join(testDir, "gone", "config.toml"), link);

    // The target volume may only be temporarily unavailable; replacing the link
    // would recreate the dotfiles divergence this fix exists to prevent.
    expect(() => atomicWriteFile(link, "recovered")).toThrow(/unresolvable symlinked write target/);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(testDir, "gone"))).toBe(false);
  });
});

describe("config.ts – async atomic writes preserve symlinked destinations", () => {
  test.skipIf(!canSymlink)("a symlinked destination survives the write and the real file receives it", async () => {
    const repoDir = join(testDir, "dotfiles-async");
    mkdirSync(repoDir, { recursive: true });
    const realFile = join(repoDir, "config.toml");
    writeFileSync(realFile, "original", "utf-8");
    const link = join(testDir, "config-async.toml");
    symlinkSync(realFile, link);

    await atomicWriteFileAsync(link, "rewritten");

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(realFile);
    expect(readFileSync(realFile, "utf8")).toBe("rewritten");
    expect(readFileSync(link, "utf8")).toBe("rewritten");
  });

  test.skipIf(!canSymlink)("no temp file is left beside the link or its target", async () => {
    const repoDir = join(testDir, "dotfiles-async-clean");
    mkdirSync(repoDir, { recursive: true });
    const realFile = join(repoDir, "config.toml");
    writeFileSync(realFile, "original", "utf-8");
    const link = join(testDir, "config-async-clean.toml");
    symlinkSync(realFile, link);

    await atomicWriteFileAsync(link, "rewritten");

    expect(readdirSync(repoDir).filter(name => name.includes(".ocx."))).toEqual([]);
    expect(readdirSync(testDir).filter(name => name.includes(".ocx."))).toEqual([]);
  });

  test("a plain destination is unaffected", async () => {
    const destination = join(testDir, "plain-async.toml");
    await atomicWriteFileAsync(destination, "first");
    await atomicWriteFileAsync(destination, "second");

    expect(lstatSync(destination).isSymbolicLink()).toBe(false);
    expect(readFileSync(destination, "utf8")).toBe("second");
  });

  test.skipIf(!canSymlink)("a dangling symlink is preserved and the write is refused", async () => {
    const link = join(testDir, "dangling-async.toml");
    symlinkSync(join(testDir, "gone-async", "config.toml"), link);

    await expect(atomicWriteFileAsync(link, "recovered")).rejects.toThrow(/unresolvable symlinked write target/);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(testDir, "gone-async"))).toBe(false);
  });
});

describe("codex account selection order", () => {
  function writePriorityConfig(
    codexAccountPriorities: unknown,
    overrides: Record<string, unknown> = {},
  ): void {
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
      codexAccountPriorities,
      ...overrides,
    });
  }

  test("round-trips pool ids, the main account, and negative order", () => {
    const priorities = { work: 2, side: 1, __main__: -2 };
    writePriorityConfig(priorities);

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.error).toBeNull();
    expect(diagnostics.source).toBe("file");
    expect(diagnostics.config.codexAccountPriorities).toEqual(priorities);
    expect(Object.hasOwn(getDefaultConfig(), "codexAccountPriorities")).toBe(false);
  });

  test.each([
    ["null", null],
    ["an array", []],
    ["a string", "work"],
    ["a fractional value", { work: 1.5 }],
    ["a stringified number", { work: "2" }],
    ["a boolean", { work: true }],
    ["an above-range value", { work: 101 }],
    ["a below-range value", { work: -101 }],
    ["a reserved constructor key", { constructor: 1 }],
    ["a slash in the key", { "work/account": 1 }],
  ] as const)("degrades %s to no ordering without discarding the rest of the config", (_label, priorities) => {
    writePriorityConfig(priorities);

    const diagnostics = readConfigDiagnostics();
    // Selection order is a preference: a malformed map must never trip the
    // backup-and-defaults repair path that would reset providers.
    expect(diagnostics.source).toBe("file");
    expect(diagnostics.error).toBeNull();
    expect(diagnostics.config.codexAccountPriorities).toBeUndefined();
    expect(Object.keys(diagnostics.config.providers)).toContain("openai");
    expect(backupNames()).toHaveLength(0);
    expect(diagnostics.warnings).toContainEqual(expect.stringContaining("account selection order is disabled"));
  });

  test("degrades a literal __proto__ entry, which JSON.parse materializes as an own key", () => {
    writeConfig(
      '{"port":10100,"providers":{"openai":{"adapter":"openai-responses",'
      + '"baseUrl":"https://chatgpt.com/backend-api/codex","authMode":"forward"}},'
      + '"defaultProvider":"openai","codexAccountPriorities":{"__proto__":1,"work":2}}',
    );

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("file");
    expect(diagnostics.config.codexAccountPriorities).toBeUndefined();
    expect(Object.keys(diagnostics.config.providers)).toContain("openai");
    expect(diagnostics.warnings).toContainEqual(expect.stringContaining("account selection order is disabled"));
  });

  test("warns when load degrades a malformed selection-order map", () => {
    writePriorityConfig({ work: 101 });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const loaded = loadConfig();
      expect(loaded.codexAccountPriorities).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("account selection order is disabled"));
      expect(backupNames()).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("keeps a valid pin and degrades a malformed one", () => {
    writePriorityConfig({ work: 1 }, { activeCodexAccountPinned: "work" });
    expect(readConfigDiagnostics().config.activeCodexAccountPinned).toBe("work");

    writePriorityConfig({ work: 1 }, { activeCodexAccountPinned: "work/account" });
    const degraded = readConfigDiagnostics();
    expect(degraded.source).toBe("file");
    expect(degraded.config.activeCodexAccountPinned).toBeUndefined();
    expect(degraded.config.codexAccountPriorities).toEqual({ work: 1 });
    expect(degraded.warnings).toContainEqual(expect.stringContaining("no longer pinned"));
  });
});
