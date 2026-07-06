import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-accounts-test");
const ACCOUNTS_PATH = join(TEST_DIR, "codex-accounts.json");

function refreshGrantFingerprint(refreshToken: string): string {
  return createHash("sha256").update(`codex-refresh-grant:${refreshToken}`).digest("hex");
}

function refreshLockPathForToken(refreshToken: string): string {
  const digest = createHash("sha256").update(refreshGrantFingerprint(refreshToken)).digest("hex").slice(0, 32);
  return join(TEST_DIR, `codex-refresh-${digest}.lock`);
}

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
    const { saveCodexAccountCredential, getCodexAccountCredential } = await import("../src/codex/account-store");
    const cred = { accessToken: "tk_a", refreshToken: "rf_a", expiresAt: Date.now() + 3600_000, chatgptAccountId: "acc_a" };
    saveCodexAccountCredential("work", cred);
    expect(existsSync(ACCOUNTS_PATH)).toBe(true);
    const loaded = getCodexAccountCredential("work");
    expect(loaded).toEqual(cred);
  });

  test("legacy flat credential JSON loads through the compatibility projection", async () => {
    const { getCodexAccountCredential, loadCodexAccountStore, readCodexAccountRecord } = await import("../src/codex/account-store");
    const cred = { accessToken: "legacy_tk", refreshToken: "legacy_rf", expiresAt: Date.now() + 3600_000, chatgptAccountId: "legacy_acc" };
    writeFileSync(ACCOUNTS_PATH, JSON.stringify({ legacy: cred }, null, 2));

    expect(getCodexAccountCredential("legacy")).toEqual(cred);
    expect(loadCodexAccountStore()).toEqual({ legacy: cred });
    expect(readCodexAccountRecord("legacy")).toMatchObject({ credential: cred, generation: 0 });
  });

  test("malformed credential store is backed up before a new save overwrites it", async () => {
    const { saveCodexAccountCredential } = await import("../src/codex/account-store");
    writeFileSync(ACCOUNTS_PATH, "{not valid json", "utf8");

    saveCodexAccountCredential("fresh", {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "new-account",
    });

    const backups = readdirSync(TEST_DIR).filter(name => name.startsWith("codex-accounts.json.invalid-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(TEST_DIR, backups[0]), "utf8")).toBe("{not valid json");
  });

  test("new saves write generation wrapper records", async () => {
    const { readCodexAccountRecord, saveCodexAccountCredential } = await import("../src/codex/account-store");
    const cred = { accessToken: "tk_a", refreshToken: "rf_a", expiresAt: Date.now() + 3600_000, chatgptAccountId: "acc_a" };
    saveCodexAccountCredential("wrapped", cred);

    const raw = JSON.parse(readFileSync(ACCOUNTS_PATH, "utf-8")) as Record<string, unknown>;
    expect(raw.wrapped).toMatchObject({ credential: cred, generation: 1 });
    expect(readCodexAccountRecord("wrapped")).toMatchObject({ credential: cred, generation: 1 });
  });

  test("remove credential deletes entry", async () => {
    const { saveCodexAccountCredential, removeCodexAccountCredential, getCodexAccountCredential, listCodexAccountIds, readCodexAccountRecord } = await import("../src/codex/account-store");
    saveCodexAccountCredential("temp", { accessToken: "t", refreshToken: "r", expiresAt: 0, chatgptAccountId: "c" });
    removeCodexAccountCredential("temp");
    expect(getCodexAccountCredential("temp")).toBeNull();
    expect(listCodexAccountIds()).not.toContain("temp");
    expect(readCodexAccountRecord("temp")).toMatchObject({ generation: 2 });
    expect(readCodexAccountRecord("temp")?.deletedAt).toBeNumber();
  });

  test("tokenful tombstone is treated as absent", async () => {
    const { getCodexAccountCredential, listCodexAccountIds, loadCodexAccountStore } = await import("../src/codex/account-store");
    const cred = { accessToken: "deleted_tk", refreshToken: "deleted_rf", expiresAt: Date.now() + 3600_000, chatgptAccountId: "deleted_acc" };
    writeFileSync(ACCOUNTS_PATH, JSON.stringify({
      deleted: { credential: cred, generation: 2, deletedAt: Date.now() },
    }, null, 2));

    expect(getCodexAccountCredential("deleted")).toBeNull();
    expect(loadCodexAccountStore()).toEqual({});
    expect(listCodexAccountIds()).not.toContain("deleted");
  });

  test("listCodexAccountIds returns stored ids", async () => {
    const { saveCodexAccountCredential, listCodexAccountIds } = await import("../src/codex/account-store");
    saveCodexAccountCredential("a", { accessToken: "1", refreshToken: "1", expiresAt: 0, chatgptAccountId: "1" });
    saveCodexAccountCredential("b", { accessToken: "2", refreshToken: "2", expiresAt: 0, chatgptAccountId: "2" });
    expect(listCodexAccountIds()).toContain("a");
    expect(listCodexAccountIds()).toContain("b");
  });

  test("getValidCodexToken returns cached token when not expired", async () => {
    const { saveCodexAccountCredential, getValidCodexToken } = await import("../src/codex/account-store");
    const future = Date.now() + 3600_000;
    saveCodexAccountCredential("fresh", { accessToken: "valid_tk", refreshToken: "rf", expiresAt: future, chatgptAccountId: "acc_id" });
    const result = await getValidCodexToken("fresh");
    expect(result.accessToken).toBe("valid_tk");
    expect(result.chatgptAccountId).toBe("acc_id");
    expect(result.generation).toBe(1);
  });

  test("getValidCodexToken throws when account not found", async () => {
    const { getValidCodexToken } = await import("../src/codex/account-store");
    try {
      await getValidCodexToken("nonexistent-local-alias");
      throw new Error("expected getValidCodexToken to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("credential is unavailable");
      expect((err as Error).message).not.toContain("nonexistent-local-alias");
    }
  });

  test("refresh failure errors do not expose aliases or upstream descriptions", async () => {
    const {
      getValidCodexToken,
      saveCodexAccountCredential,
      TokenRefreshError,
    } = await import("../src/codex/account-store");
    saveCodexAccountCredential("sensitive-local-alias", {
      accessToken: "sensitive-access-token",
      refreshToken: "sensitive-refresh-token",
      expiresAt: 0,
      chatgptAccountId: "sensitive-account-id",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: "invalid_grant",
      error_description: "sensitive-refresh-token was revoked for sensitive-account-id",
    }), { status: 400 })) as typeof fetch;

    try {
      await getValidCodexToken("sensitive-local-alias");
      throw new Error("expected getValidCodexToken to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(TokenRefreshError);
      const message = (err as Error).message;
      expect(message).toContain("Codex token refresh failed");
      expect(message).not.toContain("sensitive-local-alias");
      expect(message).not.toContain("sensitive-access-token");
      expect(message).not.toContain("sensitive-refresh-token");
      expect(message).not.toContain("sensitive-account-id");
      expect(message).not.toContain("invalid_grant");
      expect(message).not.toContain("revoked for");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("generation CAS accepts only the current live generation", async () => {
    const {
      getCodexAccountCredential,
      readCodexAccountRecord,
      saveCodexAccountCredential,
      saveCodexAccountCredentialIfGeneration,
    } = await import("../src/codex/account-store");
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

  test("successful refresh returns bumped generation and persists rotated refresh token", async () => {
    const {
      getCodexAccountCredential,
      getValidCodexToken,
      readCodexAccountRecord,
      saveCodexAccountCredential,
      refreshGrantFingerprintForToken,
    } = await import("../src/codex/account-store");
    saveCodexAccountCredential("refresh-success", { accessToken: "old", refreshToken: "old-r", expiresAt: 0, chatgptAccountId: "acc" });
    const startGeneration = readCodexAccountRecord("refresh-success")!.generation;
    const startFingerprint = readCodexAccountRecord("refresh-success")!.refreshGrantFingerprint;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: "new",
      refresh_token: "new-r",
      expires_in: 3600,
    }), { status: 200 })) as typeof fetch;

    try {
      const result = await getValidCodexToken("refresh-success");
      expect(result).toEqual({ accessToken: "new", chatgptAccountId: "acc", generation: startGeneration + 1 });
      expect(getCodexAccountCredential("refresh-success")).toMatchObject({ accessToken: "new", refreshToken: "new-r" });
      expect(readCodexAccountRecord("refresh-success")!.refreshGrantFingerprint).not.toBe(startFingerprint);
      expect(readCodexAccountRecord("refresh-success")!.refreshGrantFingerprint).toBe(refreshGrantFingerprintForToken("new-r"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("refresh waits behind file lock and reuses credential refreshed by another process", async () => {
    const {
      getValidCodexToken,
      readCodexAccountRecord,
      saveCodexAccountCredential,
      saveCodexAccountCredentialIfGeneration,
    } = await import("../src/codex/account-store");
    saveCodexAccountCredential("refresh-wait", { accessToken: "old", refreshToken: "old-r", expiresAt: 0, chatgptAccountId: "acc" });
    const generation = readCodexAccountRecord("refresh-wait")!.generation;
    const lockPath = refreshLockPathForToken("old-r");
    writeFileSync(lockPath, JSON.stringify({ acquiredAt: Date.now(), pid: 12345 }) + "\n");
    const refreshed = { accessToken: "other-process", refreshToken: "other-r", expiresAt: Date.now() + 3600_000, chatgptAccountId: "acc" };
    const release = setTimeout(() => {
      saveCodexAccountCredentialIfGeneration("refresh-wait", generation, refreshed);
      unlinkSync(lockPath);
    }, 20);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("fetch should not be called after another process refreshed");
    }) as typeof fetch;

    try {
      const result = await getValidCodexToken("refresh-wait");
      expect(result.accessToken).toBe("other-process");
      expect(result.chatgptAccountId).toBe("acc");
      expect(result.generation).toBe(2);
    } finally {
      clearTimeout(release);
      globalThis.fetch = originalFetch;
    }
  });

  test("stale refresh lock is reclaimed", async () => {
    const { getValidCodexToken, saveCodexAccountCredential } = await import("../src/codex/account-store");
    saveCodexAccountCredential("refresh-stale-lock", { accessToken: "old", refreshToken: "old-r", expiresAt: 0, chatgptAccountId: "acc" });
    writeFileSync(refreshLockPathForToken("old-r"), JSON.stringify({ acquiredAt: Date.now() - 61_000, pid: 12345 }) + "\n");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), { status: 200 })) as typeof fetch;

    try {
      const result = await getValidCodexToken("refresh-stale-lock");
      expect(result.accessToken).toBe("new");
      expect(result.generation).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("duplicate aliases sharing a refresh grant use one in-process refresh", async () => {
    const {
      getCodexAccountCredential,
      getValidCodexToken,
      saveCodexAccountCredential,
    } = await import("../src/codex/account-store");
    saveCodexAccountCredential("alias-a", { accessToken: "old-a", refreshToken: "shared-r", expiresAt: 0, chatgptAccountId: "acc" });
    saveCodexAccountCredential("alias-b", { accessToken: "old-b", refreshToken: "shared-r", expiresAt: 0, chatgptAccountId: "acc" });
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return new Response(JSON.stringify({
        access_token: "shared-new",
        refresh_token: "shared-rotated",
        expires_in: 3600,
      }), { status: 200 });
    }) as typeof fetch;

    try {
      const [first, second] = await Promise.all([
        getValidCodexToken("alias-a"),
        getValidCodexToken("alias-b"),
      ]);
      expect(fetchCalls).toBe(1);
      expect(first.accessToken).toBe("shared-new");
      expect(second.accessToken).toBe("shared-new");
      expect(getCodexAccountCredential("alias-a")).toMatchObject({ accessToken: "shared-new", refreshToken: "shared-rotated" });
      expect(getCodexAccountCredential("alias-b")).toMatchObject({ accessToken: "shared-new", refreshToken: "shared-rotated" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("stale generation cannot overwrite replacement", async () => {
    const {
      getCodexAccountCredential,
      readCodexAccountRecord,
      saveCodexAccountCredential,
      saveCodexAccountCredentialIfGeneration,
    } = await import("../src/codex/account-store");
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
    } = await import("../src/codex/account-store");
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
    } = await import("../src/codex/account-store");
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
    } = await import("../src/codex/account-store");
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
