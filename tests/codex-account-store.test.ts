import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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
    expect(existsSync(ACCOUNTS_PATH)).toBe(true);
    const loaded = getCodexAccountCredential("work");
    expect(loaded).toEqual(cred);
  });

  test("legacy flat credential JSON loads through the compatibility projection", async () => {
    const { getCodexAccountCredential, loadCodexAccountStore, readCodexAccountRecord } = await import("../src/codex-account-store");
    const cred = { accessToken: "legacy_tk", refreshToken: "legacy_rf", expiresAt: Date.now() + 3600_000, chatgptAccountId: "legacy_acc" };
    writeFileSync(ACCOUNTS_PATH, JSON.stringify({ legacy: cred }, null, 2));

    expect(getCodexAccountCredential("legacy")).toEqual(cred);
    expect(loadCodexAccountStore()).toEqual({ legacy: cred });
    expect(readCodexAccountRecord("legacy")).toMatchObject({ credential: cred, generation: 0 });
  });

  test("new saves write generation wrapper records", async () => {
    const { readCodexAccountRecord, saveCodexAccountCredential } = await import("../src/codex-account-store");
    const cred = { accessToken: "tk_a", refreshToken: "rf_a", expiresAt: Date.now() + 3600_000, chatgptAccountId: "acc_a" };
    saveCodexAccountCredential("wrapped", cred);

    const raw = JSON.parse(readFileSync(ACCOUNTS_PATH, "utf-8")) as Record<string, unknown>;
    expect(raw.wrapped).toMatchObject({ credential: cred, generation: 1 });
    expect(readCodexAccountRecord("wrapped")).toMatchObject({ credential: cred, generation: 1 });
  });

  test("remove credential deletes entry", async () => {
    const { saveCodexAccountCredential, removeCodexAccountCredential, getCodexAccountCredential, listCodexAccountIds, readCodexAccountRecord } = await import("../src/codex-account-store");
    saveCodexAccountCredential("temp", { accessToken: "t", refreshToken: "r", expiresAt: 0, chatgptAccountId: "c" });
    removeCodexAccountCredential("temp");
    expect(getCodexAccountCredential("temp")).toBeNull();
    expect(listCodexAccountIds()).not.toContain("temp");
    expect(readCodexAccountRecord("temp")).toMatchObject({ generation: 2 });
    expect(readCodexAccountRecord("temp")?.deletedAt).toBeNumber();
  });

  test("tokenful tombstone is treated as absent", async () => {
    const { getCodexAccountCredential, listCodexAccountIds, loadCodexAccountStore } = await import("../src/codex-account-store");
    const cred = { accessToken: "deleted_tk", refreshToken: "deleted_rf", expiresAt: Date.now() + 3600_000, chatgptAccountId: "deleted_acc" };
    writeFileSync(ACCOUNTS_PATH, JSON.stringify({
      deleted: { credential: cred, generation: 2, deletedAt: Date.now() },
    }, null, 2));

    expect(getCodexAccountCredential("deleted")).toBeNull();
    expect(loadCodexAccountStore()).toEqual({});
    expect(listCodexAccountIds()).not.toContain("deleted");
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

  test("generation CAS accepts only the current live generation", async () => {
    const {
      getCodexAccountCredential,
      readCodexAccountRecord,
      saveCodexAccountCredential,
      saveCodexAccountCredentialIfGeneration,
    } = await import("../src/codex-account-store");
    const first = { accessToken: "first", refreshToken: "first-r", expiresAt: 1, chatgptAccountId: "acc" };
    const second = { accessToken: "second", refreshToken: "second-r", expiresAt: 2, chatgptAccountId: "acc" };
    saveCodexAccountCredential("cas", first);
    const generation = readCodexAccountRecord("cas")!.generation;

    expect(saveCodexAccountCredentialIfGeneration("cas", generation, second)).toBe(true);
    expect(getCodexAccountCredential("cas")).toEqual(second);
    expect(readCodexAccountRecord("cas")!.generation).toBe(generation + 1);
    expect(saveCodexAccountCredentialIfGeneration("cas", generation, first)).toBe(false);
    expect(getCodexAccountCredential("cas")).toEqual(second);
  });

  test("stale generation cannot overwrite replacement", async () => {
    const {
      getCodexAccountCredential,
      readCodexAccountRecord,
      saveCodexAccountCredential,
      saveCodexAccountCredentialIfGeneration,
    } = await import("../src/codex-account-store");
    const original = { accessToken: "original", refreshToken: "original-r", expiresAt: 1, chatgptAccountId: "acc" };
    const replacement = { accessToken: "replacement", refreshToken: "replacement-r", expiresAt: 2, chatgptAccountId: "acc" };
    const stale = { accessToken: "stale", refreshToken: "stale-r", expiresAt: 3, chatgptAccountId: "acc" };
    saveCodexAccountCredential("replace-race", original);
    const generation = readCodexAccountRecord("replace-race")!.generation;
    saveCodexAccountCredential("replace-race", replacement);

    expect(saveCodexAccountCredentialIfGeneration("replace-race", generation, stale)).toBe(false);
    expect(getCodexAccountCredential("replace-race")).toEqual(replacement);
  });

  test("stale generation cannot recreate after tombstone", async () => {
    const {
      getCodexAccountCredential,
      readCodexAccountRecord,
      removeCodexAccountCredential,
      saveCodexAccountCredential,
      saveCodexAccountCredentialIfGeneration,
    } = await import("../src/codex-account-store");
    const original = { accessToken: "original", refreshToken: "original-r", expiresAt: 1, chatgptAccountId: "acc" };
    const stale = { accessToken: "stale", refreshToken: "stale-r", expiresAt: 2, chatgptAccountId: "acc" };
    saveCodexAccountCredential("delete-race", original);
    const generation = readCodexAccountRecord("delete-race")!.generation;
    removeCodexAccountCredential("delete-race");

    expect(saveCodexAccountCredentialIfGeneration("delete-race", generation, stale)).toBe(false);
    expect(getCodexAccountCredential("delete-race")).toBeNull();
    expect(readCodexAccountRecord("delete-race")?.deletedAt).toBeNumber();
  });

  test("refresh finishing after delete does not recreate credential", async () => {
    const {
      CodexCredentialGenerationConflictError,
      getCodexAccountCredential,
      getValidCodexToken,
      readCodexAccountRecord,
      removeCodexAccountCredential,
      saveCodexAccountCredential,
    } = await import("../src/codex-account-store");
    saveCodexAccountCredential("refresh-delete", { accessToken: "old", refreshToken: "old-r", expiresAt: 0, chatgptAccountId: "acc" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      removeCodexAccountCredential("refresh-delete");
      return new Response(JSON.stringify({ access_token: "stale", expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;

    try {
      await expect(getValidCodexToken("refresh-delete")).rejects.toBeInstanceOf(CodexCredentialGenerationConflictError);
      expect(getCodexAccountCredential("refresh-delete")).toBeNull();
      expect(readCodexAccountRecord("refresh-delete")?.deletedAt).toBeNumber();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("refresh finishing after replacement does not overwrite replacement", async () => {
    const {
      CodexCredentialGenerationConflictError,
      getCodexAccountCredential,
      getValidCodexToken,
      saveCodexAccountCredential,
    } = await import("../src/codex-account-store");
    const replacement = { accessToken: "replacement", refreshToken: "replacement-r", expiresAt: Date.now() + 3600_000, chatgptAccountId: "acc" };
    saveCodexAccountCredential("refresh-replace", { accessToken: "old", refreshToken: "old-r", expiresAt: 0, chatgptAccountId: "acc" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      saveCodexAccountCredential("refresh-replace", replacement);
      return new Response(JSON.stringify({ access_token: "stale", expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;

    try {
      await expect(getValidCodexToken("refresh-replace")).rejects.toBeInstanceOf(CodexCredentialGenerationConflictError);
      expect(getCodexAccountCredential("refresh-replace")).toEqual(replacement);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
