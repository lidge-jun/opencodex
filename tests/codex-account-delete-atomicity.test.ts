import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync} from "node:fs";
import { join } from "node:path";
import * as accountStoreModule from "../src/codex/account-store";
import {
  getCodexAccountCredential,
  saveCodexAccountCredential,
} from "../src/codex/account-store";
import {
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
import { getConfigPath, loadConfig, saveConfig } from "../src/config";
import * as configModule from "../src/config";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

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
