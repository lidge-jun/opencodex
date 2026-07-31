import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  readRuntimePort,
  removePid,
  removeRuntimePort,
  validateConfigCandidate,
  writeRuntimePort,
  writePid,
} from "../src/config";

import * as windowsAcl from "../src/lib/windows-secret-acl";
import { hardenConfigDir, hardenExistingSecret, renameAtomicFile, saveConfig } from "../src/config";
let testDir = "";

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

  test("provider names reject namespace-breaking and reserved object keys", () => {
    expect(isValidProviderName("openrouter")).toBe(true);
    expect(isValidProviderName("ollama-cloud")).toBe(true);
    expect(isValidProviderName("openrouter/custom")).toBe(false);
    expect(isValidProviderName("__proto__")).toBe(false);
    expect(isValidProviderName("constructor")).toBe(false);
  });

  test("persists an explicit Codex account selector map without enabling it by default", () => {
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
    expect(isOcxStartCommandLine("opencodex start")).toBe(true);

    expect(isOcxStartCommandLine("bun run src/cli.ts status")).toBe(false);
    expect(isOcxStartCommandLine("bun test C:/work/opencodex/tests/config.test.ts")).toBe(false);
    expect(isOcxStartCommandLine("notepad.exe")).toBe(false);
  });

  test("writes pid file as a numeric pid", () => {
    writePid(process.pid);

    expect(readFileSync(getPidPath(), "utf-8")).toBe(String(process.pid));
  });

  test("removes pid file only when the expected pid still matches", () => {
    writeFileSync(getPidPath(), "111", "utf-8");
    removePid(222);
    expect(existsSync(getPidPath())).toBe(true);

    removePid(111);
    expect(existsSync(getPidPath())).toBe(false);
  });

  test("runtime port metadata round-trips and validates expected pid", () => {
    writeRuntimePort({ pid: 1234, port: 58195, hostname: "0.0.0.0" });

    expect(readRuntimePort()).toEqual({ pid: 1234, port: 58195, hostname: "0.0.0.0" });
    expect(readRuntimePort(1234)).toEqual({ pid: 1234, port: 58195, hostname: "0.0.0.0" });
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
  });
});

describe("config.ts – Windows ACL hardening integration", () => {
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
      expect(spy).toHaveBeenCalledWith(testDir, { required: true });
      expect(existsSync(getConfigPath())).toBe(true);
      spy.mockRestore();
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });

  test("saveConfig throws when hardenSecretDir fails in required mode on win32", () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const spy = spyOn(windowsAcl, "hardenSecretDir").mockImplementation((_path, opts) => {
        if (opts?.required) throw new Error("ACL hardening failed: access denied");
        return { ok: true };
      });
      expect(() => saveConfig(getDefaultConfig())).toThrow(/ACL/i);
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
