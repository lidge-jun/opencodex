import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as fsModule from "node:fs";
import * as accountStoreModule from "../../src/codex/account-store";
import * as websocketRegistryModule from "../../src/codex/websocket-registry";
import * as quotaAutoRefreshStateModule from "../../src/codex/quota-auto-refresh-state";
import {
  getCodexAccountCredential,
  saveCodexAccountCredential,
} from "../../src/codex/account-store";
import {
  CodexAccountDeleteCleanupError,
  CodexAccountDeleteRollbackError,
  deleteCodexAccount,
} from "../../src/codex/account-lifecycle";
import {
  isAccountNeedsReauth,
  markAccountNeedsReauth,
} from "../../src/codex/account-runtime-state";
import {
  getAccountQuota,
  updateAccountQuota,
} from "../../src/codex/quota";
import { getConfigPath, loadConfig, saveConfig } from "../../src/config";
import * as configModule from "../../src/config";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

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
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

describe("Codex account delete persistence ordering", () => {
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

  test("a failure before durable config replacement rethrows while disk remains unchanged", () => {
    const config = seededConfig();
    const before = structuredClone(config);
    const beforeBytes = readFileSync(getConfigPath(), "utf8");
    const saveSpy = spyOn(configModule, "saveConfigPreservingClaudeCode")
      .mockImplementation(() => { throw new Error("forced pre-write failure"); });

    try {
      expect(() => deleteCodexAccount(config, ACCOUNT_ID)).toThrow("forced pre-write failure");
      expect(config).toEqual(before);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeBytes);
      expect(getCodexAccountCredential(ACCOUNT_ID)).not.toBeNull();
      expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(true);
      expect(getAccountQuota(ACCOUNT_ID)).not.toBeNull();
    } finally {
      saveSpy.mockRestore();
    }
  });

  test("a failure after durable config replacement leaves changed disk untouched", () => {
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
      expect(() => deleteCodexAccount(config, ACCOUNT_ID)).toThrow(CodexAccountDeleteRollbackError);

      expect(config).toEqual(before);
      expect(readFileSync(getConfigPath(), "utf8")).not.toBe(beforeBytes);
      expect(loadConfig().codexAccounts?.some(account => account.id === ACCOUNT_ID)).toBe(false);
      expect(getCodexAccountCredential(ACCOUNT_ID)).not.toBeNull();
      expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(true);
      expect(getAccountQuota(ACCOUNT_ID)).not.toBeNull();
    } finally {
      saveSpy.mockRestore();
    }
  });

  test("a concurrent external edit remains byte-identical after uncertain failure", () => {
    const config = seededConfig();
    const before = structuredClone(config);
    let replacementBytes: Buffer | undefined;
    const realSave = configModule.saveConfigPreservingClaudeCode;
    const saveSpy = spyOn(configModule, "saveConfigPreservingClaudeCode")
      .mockImplementation(candidate => {
        realSave(candidate);
        const external = loadConfig();
        external.port = 12345;
        replacementBytes = Buffer.from(JSON.stringify(external, null, 2) + "\n", "utf8");
        writeFileSync(getConfigPath(), replacementBytes);
        throw new Error("forced concurrent failure");
      });

    try {
      expect(() => deleteCodexAccount(config, ACCOUNT_ID)).toThrow(CodexAccountDeleteRollbackError);
      expect(replacementBytes).toBeDefined();
      expect(readFileSync(getConfigPath())).toEqual(replacementBytes);
      const persisted = loadConfig();
      expect(persisted.port).toBe(12345);
      expect(persisted.codexAccounts?.some(account => account.id === ACCOUNT_ID)).toBe(false);
      expect(config).toEqual(before);
      expect(getCodexAccountCredential(ACCOUNT_ID)).not.toBeNull();
      expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(true);
      expect(getAccountQuota(ACCOUNT_ID)).not.toBeNull();
    } finally {
      saveSpy.mockRestore();
    }
  });

  test("distinct bytes with the same decoded text are treated as changed", () => {
    const config = seededConfig();
    const before = structuredClone(config);
    const validBytes = Buffer.from('{"value":"\uFFFD"}\n', "utf8");
    const malformedBytes = Buffer.concat([
      Buffer.from('{"value":"', "utf8"),
      Buffer.from([0x80]),
      Buffer.from('"}\n', "utf8"),
    ]);
    expect(validBytes.equals(malformedBytes)).toBe(false);
    expect(validBytes.toString("utf8")).toBe(malformedBytes.toString("utf8"));
    writeFileSync(getConfigPath(), validBytes);
    const saveSpy = spyOn(configModule, "saveConfigPreservingClaudeCode")
      .mockImplementation(() => {
        writeFileSync(getConfigPath(), malformedBytes);
        throw new Error("forced byte-alias failure");
      });

    try {
      expect(() => deleteCodexAccount(config, ACCOUNT_ID)).toThrow(CodexAccountDeleteRollbackError);
      expect(readFileSync(getConfigPath()).equals(malformedBytes)).toBe(true);
      expect(config).toEqual(before);
      expect(getCodexAccountCredential(ACCOUNT_ID)).not.toBeNull();
      expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(true);
      expect(getAccountQuota(ACCOUNT_ID)).not.toBeNull();
    } finally {
      saveSpy.mockRestore();
    }
  });

  test("a missing config after uncertain failure is not recreated", () => {
    const config = seededConfig();
    const before = structuredClone(config);
    const realSave = configModule.saveConfigPreservingClaudeCode;
    const saveSpy = spyOn(configModule, "saveConfigPreservingClaudeCode")
      .mockImplementation(candidate => {
        realSave(candidate);
        unlinkSync(getConfigPath());
        throw new Error("forced missing-file failure");
      });

    try {
      expect(() => deleteCodexAccount(config, ACCOUNT_ID)).toThrow(CodexAccountDeleteRollbackError);
      expect(existsSync(getConfigPath())).toBe(false);
      expect(config).toEqual(before);
      expect(getCodexAccountCredential(ACCOUNT_ID)).not.toBeNull();
      expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(true);
      expect(getAccountQuota(ACCOUNT_ID)).not.toBeNull();
    } finally {
      saveSpy.mockRestore();
    }
  });

  test("an unreadable config after uncertain failure preserves state and sanitizes errors", () => {
    const config = seededConfig();
    const before = structuredClone(config);
    const configPath = getConfigPath();
    const beforeBytes = readFileSync(configPath);
    const readSpy = spyOn(fsModule, "readFileSync");
    const removeSpy = spyOn(accountStoreModule, "removeCodexAccountCredential");
    const invalidateSpy = spyOn(websocketRegistryModule, "invalidateCodexWebSocketsForAccount");
    const forgetSpy = spyOn(quotaAutoRefreshStateModule, "forgetCodexQuotaAutoRefreshAccount");
    const saveSpy = spyOn(configModule, "saveConfigPreservingClaudeCode")
      .mockImplementation(() => {
        readSpy.mockImplementationOnce(() => {
          throw new Error("EACCES /private/config.json Bearer read-secret-token");
        });
        throw new Error("write failed /private/config.json Bearer write-secret-token");
      });

    try {
      let thrown: unknown;
      try {
        deleteCodexAccount(config, ACCOUNT_ID);
      } catch (error) {
        thrown = error;
      }
      expect(readSpy).toHaveBeenLastCalledWith(configPath);
      expect(thrown).toBeInstanceOf(CodexAccountDeleteRollbackError);
      expect((thrown as Error).message).toBe(
        "Account deletion failed and the previous config could not be restored. Restart before retrying.",
      );
      expect(String(thrown)).not.toContain("/private/config.json");
      expect(String(thrown)).not.toContain("secret-token");
      expect((thrown as Error).cause).toBeUndefined();
      expect(config).toEqual(before);
      expect(readFileSync(configPath)).toEqual(beforeBytes);
      expect(getCodexAccountCredential(ACCOUNT_ID)).not.toBeNull();
      expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(true);
      expect(getAccountQuota(ACCOUNT_ID)).not.toBeNull();
      expect(removeSpy).not.toHaveBeenCalled();
      expect(invalidateSpy).not.toHaveBeenCalled();
      expect(forgetSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
      saveSpy.mockRestore();
      removeSpy.mockRestore();
      invalidateSpy.mockRestore();
      forgetSpy.mockRestore();
    }
  });

  test("a transient config skips persistence but still removes credentials and runtime state", () => {
    const config = seededConfig();
    const configPath = getConfigPath();
    unlinkSync(configPath);
    const saveSpy = spyOn(configModule, "saveConfigPreservingClaudeCode");
    const removeSpy = spyOn(accountStoreModule, "removeCodexAccountCredential");
    const invalidateSpy = spyOn(websocketRegistryModule, "invalidateCodexWebSocketsForAccount");
    const forgetSpy = spyOn(quotaAutoRefreshStateModule, "forgetCodexQuotaAutoRefreshAccount");

    try {
      expect(deleteCodexAccount(config, ACCOUNT_ID)).toBe(true);
      expect(saveSpy).not.toHaveBeenCalled();
      expect(existsSync(configPath)).toBe(false);
      expect(config.codexAccounts).toEqual([]);
      expect(config.codexAccountNamespaces).toEqual({ stable: ACCOUNT_ID });
      expect(config.pausedCodexAccountIds).toBeUndefined();
      expect(config.codexAccountPriorities).toBeUndefined();
      expect(config.activeCodexAccountPinned).toBeUndefined();
      expect(config.activeCodexAccountId).toBeUndefined();
      expect(getCodexAccountCredential(ACCOUNT_ID)).toBeNull();
      expect(isAccountNeedsReauth(ACCOUNT_ID)).toBe(false);
      expect(getAccountQuota(ACCOUNT_ID)).toBeNull();
      expect(removeSpy).toHaveBeenCalledWith(ACCOUNT_ID);
      expect(invalidateSpy).toHaveBeenCalledWith(ACCOUNT_ID);
      expect(forgetSpy).toHaveBeenCalledWith(ACCOUNT_ID);
    } finally {
      saveSpy.mockRestore();
      removeSpy.mockRestore();
      invalidateSpy.mockRestore();
      forgetSpy.mockRestore();
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
