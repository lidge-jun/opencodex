import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as accountStoreModule from "../src/codex/account-store";
import {
  getCodexAccountCredential,
  saveCodexAccountCredential,
} from "../src/codex/account-store";
import {
  CodexAccountCleanupRetryConflictError,
  CodexAccountDeleteCleanupError,
  deleteCodexAccount,
} from "../src/codex/account-lifecycle";
import {
  isAccountNeedsReauth,
  markAccountNeedsReauth,
} from "../src/codex/account-runtime-state";
import {
  getAccountQuota,
  updateAccountQuota,
} from "../src/codex/quota";
import {
  ConfigMutationLockError,
  getConfigPath,
  loadConfig,
  observeConfigGeneration,
  saveConfig,
} from "../src/config";
import * as configModule from "../src/config";
import type { OcxConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-account-delete-atomicity");
const ACCOUNT_ID = "delete-atomicity";
let previousHome: string | undefined;

function seededConfig(): OcxConfig {
  const config = loadConfig();
  config.codexAccounts = [{
    id: ACCOUNT_ID,
    email: "delete-atomicity@example.test",
    isMain: false,
  }];
  config.codexAccountNamespaces = { stable: ACCOUNT_ID };
  config.codexAccountPickerEnabled = true;
  config.pausedCodexAccountIds = [ACCOUNT_ID];
  config.codexAccountPriorities = { [ACCOUNT_ID]: 7 };
  config.activeCodexAccountPinned = ACCOUNT_ID;
  config.activeCodexAccountId = ACCOUNT_ID;
  saveConfig(config);
  saveCodexAccountCredential(ACCOUNT_ID, {
    accessToken: "delete-access",
    refreshToken: "delete-refresh",
    expiresAt: Date.now() + 60_000,
    chatgptAccountId: "delete-chatgpt-id",
  });
  markAccountNeedsReauth(ACCOUNT_ID);
  updateAccountQuota(ACCOUNT_ID, 42);
  return config;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("Codex account delete persistence ordering", () => {
  test("a persistence-owning delete creates a missing config exactly once before cleanup", () => {
    const config = loadConfig();
    config.codexAccounts = [{
      id: ACCOUNT_ID,
      email: "delete-atomicity@example.test",
      isMain: false,
    }];
    saveCodexAccountCredential(ACCOUNT_ID, {
      accessToken: "delete-access",
      refreshToken: "delete-refresh",
      expiresAt: Date.now() + 60_000,
      chatgptAccountId: "delete-chatgpt-id",
    });
    let saveCalls = 0;
    const realSave = configModule.saveConfigPreservingClaudeCode;
    const saveSpy = spyOn(configModule, "saveConfigPreservingClaudeCode")
      .mockImplementation(candidate => {
        saveCalls += 1;
        realSave(candidate);
      });

    try {
      expect(deleteCodexAccount(config, ACCOUNT_ID, { persistMissingConfig: true })).toBe(false);
    } finally {
      saveSpy.mockRestore();
    }

    expect(saveCalls).toBe(1);
    expect(loadConfig().codexAccounts).toEqual([]);
    expect(getCodexAccountCredential(ACCOUNT_ID)).toBeNull();
  });

  test("a post-write failure restores a previously missing config to absence", () => {
    const config = loadConfig();
    config.codexAccounts = [{
      id: ACCOUNT_ID,
      email: "delete-atomicity@example.test",
      isMain: false,
    }];
    const before = structuredClone(config);
    saveCodexAccountCredential(ACCOUNT_ID, {
      accessToken: "delete-access",
      refreshToken: "delete-refresh",
      expiresAt: Date.now() + 60_000,
      chatgptAccountId: "delete-chatgpt-id",
    });
    const realSave = configModule.saveConfigPreservingClaudeCode;
    const saveSpy = spyOn(configModule, "saveConfigPreservingClaudeCode")
      .mockImplementation(candidate => {
        realSave(candidate);
        throw new Error("forced first-config post-write failure");
      });

    try {
      expect(() => deleteCodexAccount(config, ACCOUNT_ID, { persistMissingConfig: true }))
        .toThrow("forced first-config post-write failure");
    } finally {
      saveSpy.mockRestore();
    }

    expect(config).toEqual(before);
    expect(existsSync(getConfigPath())).toBe(false);
    expect(getCodexAccountCredential(ACCOUNT_ID)).not.toBeNull();
  });

  test("a config persistence failure leaves the account and destructive state intact", () => {
    const config = seededConfig();
    const before = structuredClone(config);
    const saveSpy = spyOn(configModule, "saveConfigPreservingClaudeCode")
      .mockImplementation(() => { throw new Error("forced config write failure"); });

    try {
      expect(() => deleteCodexAccount(config, ACCOUNT_ID)).toThrow("forced config write failure");

      expect(config).toEqual(before);
      expect(loadConfig().codexAccounts?.some(account => account.id === ACCOUNT_ID)).toBe(true);
      expect(getCodexAccountCredential(ACCOUNT_ID)).not.toBeNull();
      expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(true);
      expect(getAccountQuota(ACCOUNT_ID)).not.toBeNull();
    } finally {
      saveSpy.mockRestore();
    }
  });

  test("a cleanup-only retry refuses a live row before mutation", () => {
    const config = seededConfig();
    const before = structuredClone(config);
    const beforeConfigBytes = readFileSync(getConfigPath(), "utf8");

    expect(() => deleteCodexAccount(config, ACCOUNT_ID, {
      persistMissingConfig: true,
      cleanupOnly: true,
    })).toThrow(CodexAccountCleanupRetryConflictError);

    expect(config).toEqual(before);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeConfigBytes);
    expect(getCodexAccountCredential(ACCOUNT_ID)).not.toBeNull();
    expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(true);
    expect(getAccountQuota(ACCOUNT_ID)).not.toBeNull();
  });

  test("a cleanup-only retry trusts the persisted row over a stale runtime snapshot", () => {
    const liveConfig = seededConfig();
    const staleRuntime = structuredClone(liveConfig);
    staleRuntime.codexAccounts = [];
    const beforeRuntime = structuredClone(staleRuntime);
    const beforeConfigBytes = readFileSync(getConfigPath(), "utf8");

    expect(() => deleteCodexAccount(staleRuntime, ACCOUNT_ID, { cleanupOnly: true }))
      .toThrow(CodexAccountCleanupRetryConflictError);

    expect(staleRuntime).toEqual(beforeRuntime);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeConfigBytes);
    expect(getCodexAccountCredential(ACCOUNT_ID)).not.toBeNull();
    expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(true);
    expect(getAccountQuota(ACCOUNT_ID)).not.toBeNull();
  });

  test("cleanup-only changes no config bytes or fields while removing an orphan credential", () => {
    const liveConfig = seededConfig();
    const staleRuntime = structuredClone(liveConfig);
    staleRuntime.codexAccounts = [];
    const persisted = loadConfig();
    persisted.codexAccounts = [];
    persisted.port = 54321;
    saveConfig(persisted);
    const beforeRuntime = structuredClone(staleRuntime);
    const beforeConfigBytes = readFileSync(getConfigPath(), "utf8");

    expect(deleteCodexAccount(staleRuntime, ACCOUNT_ID, { cleanupOnly: true })).toBe(false);

    expect(staleRuntime).toEqual(beforeRuntime);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeConfigBytes);
    expect(loadConfig().port).toBe(54321);
    expect(getCodexAccountCredential(ACCOUNT_ID)).toBeNull();
    expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(false);
    expect(getAccountQuota(ACCOUNT_ID)).toBeNull();
  });

  test("a coordinator reader blocks deletion before any external state changes", () => {
    const config = seededConfig();
    const beforeConfig = structuredClone(config);
    const beforeConfigBytes = readFileSync(getConfigPath(), "utf8");
    const credentialPath = join(TEST_DIR, "codex-accounts.json");
    const beforeCredentialBytes = readFileSync(credentialPath, "utf8");
    const beforeGeneration = observeConfigGeneration();
    const reader = new Database(join(TEST_DIR, "config-mutation.sqlite"));
    reader.exec("PRAGMA busy_timeout = 0; BEGIN");
    reader.query("SELECT value FROM config_generation WHERE singleton = 1").get();

    try {
      const startedAt = performance.now();
      expect(() => deleteCodexAccount(config, ACCOUNT_ID)).toThrow(ConfigMutationLockError);
      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(config).toEqual(beforeConfig);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeConfigBytes);
      expect(readFileSync(credentialPath, "utf8")).toBe(beforeCredentialBytes);
      expect(getCodexAccountCredential(ACCOUNT_ID)).not.toBeNull();
      expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(true);
      expect(getAccountQuota(ACCOUNT_ID)).not.toBeNull();
      expect(observeConfigGeneration()).toEqual(beforeGeneration);
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
    }

    expect(deleteCodexAccount(config, ACCOUNT_ID)).toBe(true);
    expect(getCodexAccountCredential(ACCOUNT_ID)).toBeNull();
    const afterGeneration = observeConfigGeneration();
    expect(beforeGeneration.kind).toBe("ready");
    expect(afterGeneration.kind).toBe("ready");
    if (beforeGeneration.kind === "ready" && afterGeneration.kind === "ready") {
      expect(afterGeneration.generation.value).toBe(beforeGeneration.generation.value + 1);
    }
  });

  test("a failure after durable config replacement restores the prior config", () => {
    const config = seededConfig();
    const before = structuredClone(config);
    const beforeBytes = readFileSync(getConfigPath(), "utf8");
    const realSave = configModule.saveConfigPreservingClaudeCode;
    const saveSpy = spyOn(configModule, "saveConfigPreservingClaudeCode")
      .mockImplementation(candidate => {
        realSave(candidate);
        throw new Error("forced post-write failure");
      });

    try {
      expect(() => deleteCodexAccount(config, ACCOUNT_ID)).toThrow("forced post-write failure");

      expect(config).toEqual(before);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeBytes);
      expect(loadConfig().codexAccounts?.some(account => account.id === ACCOUNT_ID)).toBe(true);
      expect(getCodexAccountCredential(ACCOUNT_ID)).not.toBeNull();
      expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(true);
      expect(getAccountQuota(ACCOUNT_ID)).not.toBeNull();
    } finally {
      saveSpy.mockRestore();
    }
  });

  test("the durable config deletion happens before credential and runtime cleanup", () => {
    const config = seededConfig();
    const realSave = configModule.saveConfigPreservingClaudeCode;
    const saveSpy = spyOn(configModule, "saveConfigPreservingClaudeCode")
      .mockImplementation(candidate => {
        expect(getCodexAccountCredential(ACCOUNT_ID)).not.toBeNull();
        expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(true);
        expect(getAccountQuota(ACCOUNT_ID)).not.toBeNull();
        realSave(candidate);
      });

    try {
      expect(deleteCodexAccount(config, ACCOUNT_ID)).toBe(true);
    } finally {
      saveSpy.mockRestore();
    }

    const persisted = loadConfig();
    expect(persisted.codexAccounts?.some(account => account.id === ACCOUNT_ID)).toBe(false);
    expect(persisted.codexAccountNamespaces).toEqual({ stable: ACCOUNT_ID });
    expect(config.codexAccounts?.some(account => account.id === ACCOUNT_ID)).toBe(false);
    expect(config.pausedCodexAccountIds).toBeUndefined();
    expect(config.codexAccountPriorities).toBeUndefined();
    expect(config.activeCodexAccountPinned).toBeUndefined();
    expect(config.activeCodexAccountId).toBeUndefined();
    expect(getCodexAccountCredential(ACCOUNT_ID)).toBeNull();
    expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(false);
    expect(getAccountQuota(ACCOUNT_ID)).toBeNull();
  });

  test("a cleanup failure keeps the deletion durable and exposes only a fixed recovery error", () => {
    const config = seededConfig();
    const removeSpy = spyOn(accountStoreModule, "removeCodexAccountCredential")
      .mockImplementation(() => {
        throw new Error("private cleanup detail /private/codex-accounts.json Bearer secret-token");
      });

    try {
      let thrown: unknown;
      try {
        deleteCodexAccount(config, ACCOUNT_ID);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CodexAccountDeleteCleanupError);
      expect(String((thrown as Error).message)).toBe(
        "Account deletion was saved, but local credential cleanup did not complete. Retry removal.",
      );
      expect(String((thrown as Error).message)).not.toContain("private");
      expect(String((thrown as Error).message)).not.toContain("secret-token");
      expect(loadConfig().codexAccounts?.some(account => account.id === ACCOUNT_ID)).toBe(false);
      expect(config.codexAccounts?.some(account => account.id === ACCOUNT_ID)).toBe(false);
      expect(getCodexAccountCredential(ACCOUNT_ID)).not.toBeNull();
      expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(false);
      expect(getAccountQuota(ACCOUNT_ID)).toBeNull();
      expect((thrown as CodexAccountDeleteCleanupError).pickerVisibilityChanged).toBe(true);
    } finally {
      removeSpy.mockRestore();
    }

    // The route is retry-safe even after the durable row is gone: a second delete can finish the
    // tombstone/runtime cleanup without recreating the account or selector mapping.
    expect(deleteCodexAccount(config, ACCOUNT_ID)).toBe(false);
    expect(getCodexAccountCredential(ACCOUNT_ID)).toBeNull();
    expect(loadConfig().codexAccountNamespaces).toEqual({ stable: ACCOUNT_ID });
  });
});
