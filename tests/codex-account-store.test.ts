import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-accounts-test");
const ACCOUNTS_PATH = join(TEST_DIR, "codex-accounts.json");

describe("codex-account-store CRUD", () => {
  beforeEach(() => {
    process.env.OPENCODEX_HOME = TEST_DIR;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    delete process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("save and load credential round-trip", async () => {
    const { saveCodexAccountCredential, getCodexAccountCredential } = await import("../src/codex-account-store");
    const cred = { accessToken: "tk_a", refreshToken: "rf_a", expiresAt: Date.now() + 3600_000, chatgptAccountId: "acc_a" };
    saveCodexAccountCredential("work", cred);
    const loaded = getCodexAccountCredential("work");
    expect(loaded).toEqual(cred);
  });

  test("remove credential deletes entry", async () => {
    const { saveCodexAccountCredential, removeCodexAccountCredential, getCodexAccountCredential } = await import("../src/codex-account-store");
    saveCodexAccountCredential("temp", { accessToken: "t", refreshToken: "r", expiresAt: 0, chatgptAccountId: "c" });
    removeCodexAccountCredential("temp");
    expect(getCodexAccountCredential("temp")).toBeNull();
  });

  test("listCodexAccountIds returns stored ids", async () => {
    const { saveCodexAccountCredential, listCodexAccountIds } = await import("../src/codex-account-store");
    saveCodexAccountCredential("a", { accessToken: "1", refreshToken: "1", expiresAt: 0, chatgptAccountId: "1" });
    saveCodexAccountCredential("b", { accessToken: "2", refreshToken: "2", expiresAt: 0, chatgptAccountId: "2" });
    expect(listCodexAccountIds()).toContain("a");
    expect(listCodexAccountIds()).toContain("b");
  });

  test("getValidCodexToken returns cached token when not expired", async () => {
    const { saveCodexAccountCredential, getValidCodexToken } = await import("../src/codex-account-store");
    const future = Date.now() + 3600_000;
    saveCodexAccountCredential("fresh", { accessToken: "valid_tk", refreshToken: "rf", expiresAt: future, chatgptAccountId: "acc_id" });
    const result = await getValidCodexToken("fresh");
    expect(result.accessToken).toBe("valid_tk");
    expect(result.chatgptAccountId).toBe("acc_id");
  });

  test("getValidCodexToken throws when account not found", async () => {
    const { getValidCodexToken } = await import("../src/codex-account-store");
    expect(getValidCodexToken("nonexistent")).rejects.toThrow("not found");
  });

  test("resolves OPENCODEX_HOME at write time, not import time", async () => {
    const store = await import("../src/codex-account-store");
    const otherDir = `${TEST_DIR}-other`;
    if (existsSync(otherDir)) rmSync(otherDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    try {
      process.env.OPENCODEX_HOME = otherDir;

      store.saveCodexAccountCredential("late", { accessToken: "t", refreshToken: "r", expiresAt: 0, chatgptAccountId: "c" });

      expect(existsSync(join(otherDir, "codex-accounts.json"))).toBe(true);
      expect(existsSync(ACCOUNTS_PATH)).toBe(false);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
