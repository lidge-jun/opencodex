import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setIcaclsRunnerForTests } from "../src/lib/windows-secret-acl";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-accounts-test");
const ACCOUNTS_PATH = join(TEST_DIR, "codex-accounts.json");

function refreshGrantFingerprint(refreshToken: string): string {
  return createHash("sha256").update(`codex-refresh-grant:${refreshToken}`).digest("hex");
}

function refreshLockPathForToken(refreshToken: string): string {
  const digest = createHash("sha256").update(refreshGrantFingerprint(refreshToken)).digest("hex").slice(0, 32);
  return join(TEST_DIR, `codex-refresh-${digest}.lock`);
}

/** Minimal unsigned JWT carrying the plan claim the store reconciles from. */
function planJwt(plan: string, accountId = "acct-plan-flight"): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({
    chatgpt_account_id: accountId,
    chatgpt_plan_type: plan,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: plan },
  })).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("codex-account-store CRUD", () => {
  beforeEach(() => {
    // These exercises cover credential-store contention, not Windows ACL behavior.
    // Avoid spawning icacls for every fixture write; its lingering handle makes
    // the fixed fixture directory flaky under `bun test --isolate` on Windows.
    setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
    process.env.OPENCODEX_HOME = TEST_DIR;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    setIcaclsRunnerForTests(null);
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

  test("validation metadata survives credential replacement and CAS refresh saves", async () => {
    const {
      markCodexAccountValidated,
      readCodexAccountRecord,
      saveCodexAccountCredential,
      saveCodexAccountCredentialIfGeneration,
    } = await import("../src/codex/account-store");
    const first = { accessToken: "first", refreshToken: "first-r", expiresAt: 1, chatgptAccountId: "acc" };
    const second = { accessToken: "second", refreshToken: "second-r", expiresAt: 2, chatgptAccountId: "acc" };
    const third = { accessToken: "third", refreshToken: "third-r", expiresAt: 3, chatgptAccountId: "acc" };

    saveCodexAccountCredential("validated", first);
    markCodexAccountValidated("validated", 1234);
    saveCodexAccountCredential("validated", second);
    expect(readCodexAccountRecord("validated")).toMatchObject({
      credential: second,
      lastCodexValidatedAt: 1234,
      lastCodexValidationStatus: "ok",
    });

    const generation = readCodexAccountRecord("validated")!.generation;
    expect(saveCodexAccountCredentialIfGeneration("validated", generation, third)).toBe(true);
    expect(readCodexAccountRecord("validated")).toMatchObject({
      credential: third,
      lastCodexValidatedAt: 1234,
      lastCodexValidationStatus: "ok",
    });
  });

  test("validation failure records a redacted reason without changing the last successful validation", async () => {
    const {
      markCodexAccountValidated,
      markCodexAccountValidationFailed,
      readCodexAccountRecord,
      saveCodexAccountCredential,
    } = await import("../src/codex/account-store");
    saveCodexAccountCredential("failed-warmup", { accessToken: "sensitive-access", refreshToken: "sensitive-refresh", expiresAt: 1, chatgptAccountId: "sensitive-account" });
    markCodexAccountValidated("failed-warmup", 1234);
    markCodexAccountValidationFailed("failed-warmup", "http_status:401");

    const record = readCodexAccountRecord("failed-warmup")!;
    expect(record.lastCodexValidatedAt).toBe(1234);
    expect(record.lastCodexValidationStatus).toBe("failed");
    expect(record.lastCodexValidationError).toBe("http_status:401");
    expect(JSON.stringify(record)).not.toContain("sensitive-access revoked");
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

  test("refresh with a non-finite expires_in falls back to the 3600s default", async () => {
    const {
      getCodexAccountCredential,
      getValidCodexToken,
      saveCodexAccountCredential,
    } = await import("../src/codex/account-store");
    saveCodexAccountCredential("refresh-bad-expiry", { accessToken: "old", refreshToken: "old-r", expiresAt: 0, chatgptAccountId: "acc" });
    const originalFetch = globalThis.fetch;
    // JSON.stringify turns NaN into null; hand-write 1e999 so JSON.parse yields Infinity,
    // the realistic corrupt shape that would previously produce expiresAt: NaN.
    globalThis.fetch = (async () => new Response(
      '{"access_token":"new","refresh_token":"new-r","expires_in":1e999}',
      { status: 200 },
    )) as typeof fetch;

    try {
      const before = Date.now();
      await getValidCodexToken("refresh-bad-expiry");
      const stored = getCodexAccountCredential("refresh-bad-expiry")!;
      expect(Number.isFinite(stored.expiresAt)).toBe(true);
      expect(stored.expiresAt).toBeGreaterThan(before);
      expect(Math.abs(stored.expiresAt - (before + 3600 * 1000))).toBeLessThan(30_000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("refresh with an overflowing expires_in falls back to the 3600s default", async () => {
    const {
      getCodexAccountCredential,
      getValidCodexToken,
      saveCodexAccountCredential,
    } = await import("../src/codex/account-store");
    saveCodexAccountCredential("refresh-overflow-expiry", { accessToken: "old", refreshToken: "old-r", expiresAt: 0, chatgptAccountId: "acc" });
    const originalFetch = globalThis.fetch;
    // Number.MAX_VALUE passes Number.isFinite but overflows to Infinity when
    // multiplied by 1000 — the computed expiresAt must still be guarded.
    globalThis.fetch = (async () => new Response(
      '{"access_token":"new","refresh_token":"new-r","expires_in":1.7976931348623157e308}',
      { status: 200 },
    )) as typeof fetch;

    try {
      const before = Date.now();
      await getValidCodexToken("refresh-overflow-expiry");
      const stored = getCodexAccountCredential("refresh-overflow-expiry")!;
      expect(Number.isFinite(stored.expiresAt)).toBe(true);
      expect(stored.expiresAt).toBeGreaterThan(before);
      expect(Math.abs(stored.expiresAt - (before + 3600 * 1000))).toBeLessThan(30_000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("refresh with a negative expires_in falls back to the 3600s default", async () => {
    const {
      getCodexAccountCredential,
      getValidCodexToken,
      saveCodexAccountCredential,
    } = await import("../src/codex/account-store");
    saveCodexAccountCredential("refresh-negative-expiry", { accessToken: "old", refreshToken: "old-r", expiresAt: 0, chatgptAccountId: "acc" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ access_token: "new", refresh_token: "new-r", expires_in: -1 }),
      { status: 200 },
    )) as typeof fetch;

    try {
      const before = Date.now();
      await getValidCodexToken("refresh-negative-expiry");
      const stored = getCodexAccountCredential("refresh-negative-expiry")!;
      expect(Number.isFinite(stored.expiresAt)).toBe(true);
      expect(stored.expiresAt).toBeGreaterThan(before);
      expect(Math.abs(stored.expiresAt - (before + 3600 * 1000))).toBeLessThan(30_000);
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

  test("same refresh grant joins a live flight", async () => {
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

  test("33rd distinct refresh grant is rejected before file lock and fetch", async () => {
    const {
      CodexCredentialRefreshBusyError,
      getValidCodexToken,
      saveCodexAccountCredential,
    } = await import("../src/codex/account-store");
    for (let index = 0; index < 33; index++) {
      saveCodexAccountCredential(`flight-${index}`, {
        accessToken: `old-${index}`,
        refreshToken: `refresh-${index}`,
        expiresAt: 0,
        chatgptAccountId: `account-${index}`,
      });
    }
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      await gate;
      return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;
    try {
      const admitted = Array.from({ length: 32 }, (_, index) => getValidCodexToken(`flight-${index}`));
      await Promise.resolve();
      await expect(getValidCodexToken("flight-32")).rejects.toBeInstanceOf(CodexCredentialRefreshBusyError);
      expect(fetchCalls).toBe(32);
      release();
      await Promise.all(admitted);
    } finally {
      release();
      globalThis.fetch = originalFetch;
    }
  });

  test("stale refresh flight is aborted and replaced without deleting the replacement", async () => {
    const {
      CodexCredentialRefreshStaleError,
      getValidCodexToken,
      saveCodexAccountCredential,
    } = await import("../src/codex/account-store");
    saveCodexAccountCredential("stale-flight", {
      accessToken: "old",
      refreshToken: "stale-refresh",
      expiresAt: 0,
      chatgptAccountId: "account",
    });
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (_input, init) => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return new Response(JSON.stringify({ access_token: "replacement", expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;
    const first = getValidCodexToken("stale-flight");
    try {
      while (fetchCalls === 0) await Promise.resolve();
      const now = Date.now();
      const clock = spyOn(Date, "now").mockReturnValue(now + 120_001);
      try {
        const replacement = getValidCodexToken("stale-flight");
        await expect(first).rejects.toBeInstanceOf(CodexCredentialRefreshStaleError);
        expect((await replacement).accessToken).toBe("replacement");
      } finally {
        clock.mockRestore();
      }
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

  test("a forced refresh rotates a time-valid credential that upstream rejected (#2887)", async () => {
    const { forceRefreshCodexPoolToken, readCodexAccountRecord, saveCodexAccountCredential } =
      await import("../src/codex/account-store");
    // Far beyond the refresh skew: getValidCodexToken would return this untouched, which is
    // exactly why a 401 on it was unrecoverable.
    saveCodexAccountCredential("forced", {
      accessToken: "rejected",
      refreshToken: "grant",
      expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "acc",
    });
    const generation = readCodexAccountRecord("forced")!.generation;
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({ access_token: "rotated", refresh_token: "grant2", expires_in: 3600 });
    }) as typeof fetch;

    try {
      const result = await forceRefreshCodexPoolToken("forced", {
        rejectedGeneration: generation,
        rejectedAccessToken: "rejected",
      });
      expect(calls).toBe(1);
      expect(result.accessToken).toBe("rotated");
      expect(result.rotated).toBe(true);
      expect(result.generation).toBe(generation + 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a forced refresh whose generation was already superseded spends no rotation (#2887)", async () => {
    const { forceRefreshCodexPoolToken, saveCodexAccountCredential, readCodexAccountRecord } =
      await import("../src/codex/account-store");
    saveCodexAccountCredential("forced-stale", {
      accessToken: "rejected",
      refreshToken: "grant",
      expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "acc",
    });
    const rejectedGeneration = readCodexAccountRecord("forced-stale")!.generation;
    // An operator re-authenticated while the request was in flight.
    saveCodexAccountCredential("forced-stale", {
      accessToken: "replacement",
      refreshToken: "grant-new",
      expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "acc",
    });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({ access_token: "should-not-happen", expires_in: 3600 });
    }) as typeof fetch;

    try {
      const result = await forceRefreshCodexPoolToken("forced-stale", {
        rejectedGeneration,
        rejectedAccessToken: "rejected",
      });
      // The replacement is handed back untouched: no token call, no generation bump.
      expect(calls).toBe(0);
      expect(result.accessToken).toBe("replacement");
      expect(result.generation).toBe(rejectedGeneration + 1);
      expect(readCodexAccountRecord("forced-stale")!.credential!.accessToken).toBe("replacement");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("concurrent forced refreshes of one rejected generation collapse to a single token call (#2887)", async () => {
    const { forceRefreshCodexPoolToken, readCodexAccountRecord, saveCodexAccountCredential } =
      await import("../src/codex/account-store");
    saveCodexAccountCredential("forced-concurrent", {
      accessToken: "rejected",
      refreshToken: "grant",
      expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "acc",
    });
    const generation = readCodexAccountRecord("forced-concurrent")!.generation;
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return Response.json({ access_token: "rotated", refresh_token: "grant2", expires_in: 3600 });
    }) as typeof fetch;

    try {
      const both = await Promise.allSettled([
        forceRefreshCodexPoolToken("forced-concurrent", { rejectedGeneration: generation, rejectedAccessToken: "rejected" }),
        forceRefreshCodexPoolToken("forced-concurrent", { rejectedGeneration: generation, rejectedAccessToken: "rejected" }),
      ]);
      expect(calls).toBe(1);
      // One generation increment, not two: a second bump would invalidate the affinity the
      // first caller just handed forward.
      expect(readCodexAccountRecord("forced-concurrent")!.generation).toBe(generation + 1);
      expect(both.some(r => r.status === "fulfilled" && r.value.accessToken === "rotated")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /*
   * #2892 gap 2. Flights are shared: a later caller on the same grant joins the
   * running promise instead of opening its own. The flight's abort signal used to
   * include the INITIATING caller's signal, so one cancelled request aborted the
   * token fetch every other waiter depended on — and a joiner cannot tell that
   * apart from a real upstream failure, so a cancelled Codex tab could get a
   * healthy account marked for reauthentication on behalf of a live request.
   */
  test("cancelling the caller that opened a refresh flight does not cancel a live joiner (#2892)", async () => {
    const { forceRefreshCodexPoolToken, readCodexAccountRecord, saveCodexAccountCredential } =
      await import("../src/codex/account-store");
    saveCodexAccountCredential("cancel-owner", {
      accessToken: "rejected",
      refreshToken: "cancel-grant",
      expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "acc",
    });
    const generation = readCodexAccountRecord("cancel-owner")!.generation;

    const originalFetch = globalThis.fetch;
    let sawAbort = false;
    let calls = 0;
    let releaseFetch: (() => void) | undefined;
    const fetchStarted = new Promise<void>(resolve => {
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        calls += 1;
        resolve();
        await new Promise<void>(release => { releaseFetch = release; });
        // The flight must still be alive after the initiating caller gave up.
        if (init?.signal?.aborted) sawAbort = true;
        return Response.json({ access_token: "rotated", refresh_token: "cancel-grant2", expires_in: 3600 });
      }) as typeof fetch;
    });

    try {
      const owner = new AbortController();
      const ownerCall = forceRefreshCodexPoolToken("cancel-owner", {
        rejectedGeneration: generation,
        rejectedAccessToken: "rejected",
        signal: owner.signal,
      });
      await fetchStarted;
      // A joiner arrives on the same grant while the flight is parked in fetch.
      const joinerCall = forceRefreshCodexPoolToken("cancel-owner", {
        rejectedGeneration: generation,
        rejectedAccessToken: "rejected",
      });
      // The client that started it goes away.
      owner.abort(new Error("client disconnected"));
      await expect(ownerCall).rejects.toThrow("client disconnected");

      releaseFetch?.();
      const joined = await joinerCall;

      // The joiner gets the rotated credential, not an abort.
      expect(sawAbort).toBe(false);
      expect(joined.accessToken).toBe("rotated");
      expect(calls).toBe(1);
      expect(readCodexAccountRecord("cancel-owner")!.credential!.accessToken).toBe("rotated");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a joined flight cannot copy a sibling account's replacement credential (#2887 review)", async () => {
    // Flights are keyed by refresh GRANT and shared across every account holding it. If the
    // owner's own credential is externally replaced BEFORE it takes the file lock, the
    // grant-mismatch branch hands back that replacement. Without provenance on the result, a
    // joiner CAS-writes another account's access AND refresh tokens onto itself.
    //
    // The replacement has to land before the lock body reads the record, which is why it is
    // written from the lock-acquisition hook rather than from inside `fetch`: by fetch time
    // the grant comparison has already happened and a different branch handles the case.
    const { forceRefreshCodexPoolToken, readCodexAccountRecord, saveCodexAccountCredential } =
      await import("../src/codex/account-store");
    const shared = { refreshToken: "shared-grant", expiresAt: Date.now() + 3600_000, chatgptAccountId: "acc" };
    saveCodexAccountCredential("owner", { ...shared, accessToken: "owner-rejected" });
    saveCodexAccountCredential("joiner", { ...shared, accessToken: "joiner-rejected" });
    const ownerGeneration = readCodexAccountRecord("owner")!.generation;
    const joinerGeneration = readCodexAccountRecord("joiner")!.generation;

    const originalFetch = globalThis.fetch;
    // Hold the shared grant's file lock so the owner's flight is parked BEFORE its lock body
    // reads the record. Replacing the owner's credential now means the lock body observes a
    // different grant and returns that replacement, which is the branch under test.
    const lockPath = refreshLockPathForToken("shared-grant");
    writeFileSync(lockPath, JSON.stringify({ acquiredAt: Date.now(), pid: process.pid }) + "\n");
    globalThis.fetch = (async () => Response.json({ access_token: "unused", expires_in: 3600 })) as typeof fetch;

    try {
      const ownerFlight = forceRefreshCodexPoolToken("owner", {
        rejectedGeneration: ownerGeneration,
        rejectedAccessToken: "owner-rejected",
      }).catch(() => undefined);
      // Let the owner reach the lock wait, then re-authenticate it onto a DIFFERENT grant
      // and release the lock so its body runs against the replacement.
      await new Promise(resolve => setTimeout(resolve, 20));
      saveCodexAccountCredential("owner", {
        accessToken: "owner-secret",
        refreshToken: "owner-new-grant",
        expiresAt: Date.now() + 3600_000,
        chatgptAccountId: "acc-owner",
      });
      unlinkSync(lockPath);

      const joiner = await forceRefreshCodexPoolToken("joiner", {
        rejectedGeneration: joinerGeneration,
        rejectedAccessToken: "joiner-rejected",
      }).catch(() => undefined);
      await ownerFlight;

      // The joiner must never end up holding the owner's credential, and the owner's own
      // replacement must survive untouched.
      const joinerRecord = readCodexAccountRecord("joiner");
      expect(joinerRecord?.credential?.accessToken).not.toBe("owner-secret");
      expect(joinerRecord?.credential?.refreshToken).not.toBe("owner-new-grant");
      expect(readCodexAccountRecord("owner")!.credential!.accessToken).toBe("owner-secret");
      expect(joiner?.accessToken).not.toBe("owner-secret");
    } finally {
      globalThis.fetch = originalFetch;
      if (existsSync(lockPath)) unlinkSync(lockPath);
    }
  });

  test("a successful refresh that returns the SAME access token reports rotated=false at its real generation (#2887 review)", async () => {
    // Upstream may rotate only the refresh grant. The store commits G+1 either way, so a
    // caller that quarantines on rotated===false must fence on the RETURNED generation —
    // fencing on the one it rejected silently suppresses its own quarantine.
    const { forceRefreshCodexPoolToken, readCodexAccountRecord, saveCodexAccountCredential } =
      await import("../src/codex/account-store");
    saveCodexAccountCredential("same-bearer", {
      accessToken: "still-rejected",
      refreshToken: "grant",
      expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "acc",
    });
    const generation = readCodexAccountRecord("same-bearer")!.generation;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      access_token: "still-rejected",
      refresh_token: "grant-rotated",
      expires_in: 3600,
    })) as typeof fetch;

    try {
      const result = await forceRefreshCodexPoolToken("same-bearer", {
        rejectedGeneration: generation,
        rejectedAccessToken: "still-rejected",
      });
      expect(result.rotated).toBe(false);
      // The generation reported must be where the credential actually is, not where it was.
      expect(result.generation).toBe(readCodexAccountRecord("same-bearer")!.generation);
      expect(result.generation).toBe(generation + 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("an ordinary joiner does not bump the generation a second time (#2887 review)", async () => {
    // The forced owner commits G+1 and hands its affinity forward to G+1. An ordinary
    // same-account joiner that re-writes the identical credential would move it to G+2 and
    // invalidate that handoff.
    const { forceRefreshCodexPoolToken, getValidCodexToken, readCodexAccountRecord, saveCodexAccountCredential } =
      await import("../src/codex/account-store");
    saveCodexAccountCredential("double-bump", {
      accessToken: "rejected",
      refreshToken: "grant",
      // Expired, so the ordinary caller actually joins the flight instead of taking the
      // freshness shortcut — that shortcut is why an ordinary caller normally never sees
      // a 401-driven refresh at all.
      expiresAt: 0,
      chatgptAccountId: "acc",
    });
    const generation = readCodexAccountRecord("double-bump")!.generation;
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      // Same refresh grant retained, so an ordinary caller joins this very flight.
      return Response.json({ access_token: "rotated", refresh_token: "grant", expires_in: 3600 });
    }) as typeof fetch;

    try {
      const forced = forceRefreshCodexPoolToken("double-bump", {
        rejectedGeneration: generation,
        rejectedAccessToken: "rejected",
      });
      await new Promise(resolve => setTimeout(resolve, 2));
      const ordinary = getValidCodexToken("double-bump");
      const [forcedResult, ordinaryResult] = await Promise.all([forced, ordinary]);

      expect(calls).toBe(1);
      expect(forcedResult.generation).toBe(generation + 1);
      expect(ordinaryResult.generation).toBe(generation + 1);
      expect(readCodexAccountRecord("double-bump")!.generation).toBe(generation + 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a bare invalid_grant is terminal, not transient (#2887 review)", async () => {
    // Upstream sends invalid_grant with no description. Classified "unknown" it reads as
    // transient, so a dead grant is never retired and every request repeats the refresh.
    const { forceRefreshCodexPoolToken, readCodexAccountRecord, saveCodexAccountCredential, TokenRefreshError } =
      await import("../src/codex/account-store");
    saveCodexAccountCredential("dead-grant", {
      accessToken: "rejected",
      refreshToken: "grant",
      expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "acc",
    });
    const generation = readCodexAccountRecord("dead-grant")!.generation;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as typeof fetch;

    try {
      await forceRefreshCodexPoolToken("dead-grant", {
        rejectedGeneration: generation,
        rejectedAccessToken: "rejected",
      });
      throw new Error("expected a TokenRefreshError");
    } catch (error) {
      expect(error).toBeInstanceOf(TokenRefreshError);
      expect((error as InstanceType<typeof TokenRefreshError>).reason).toBe("revoked");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a replacement landing mid-refresh is not reported as this call's own lineage (#2887 review)", async () => {
    // `selfRefreshed` is what gates the affinity handoff. An external replacement must not
    // set it: that credential may be a different upstream identity, so inheriting the
    // rejected credential's thread bindings would silently move traffic onto it. Deriving
    // lineage from the stored record instead is tautological — the caller reads the same
    // record the check would re-read.
    const { forceRefreshCodexPoolToken, readCodexAccountRecord, saveCodexAccountCredential } =
      await import("../src/codex/account-store");
    saveCodexAccountCredential("external", {
      accessToken: "rejected",
      refreshToken: "grant",
      expiresAt: 0,
      chatgptAccountId: "acc",
    });
    const rejectedGeneration = readCodexAccountRecord("external")!.generation;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      // An operator re-authenticates while the token call is in flight.
      saveCodexAccountCredential("external", {
        accessToken: "external-access",
        refreshToken: "external-grant",
        expiresAt: Date.now() + 3600_000,
        chatgptAccountId: "acc",
      });
      return Response.json({ access_token: "rotated", refresh_token: "grant2", expires_in: 3600 });
    }) as typeof fetch;

    try {
      const result = await forceRefreshCodexPoolToken("external", {
        rejectedGeneration,
        rejectedAccessToken: "rejected",
      }).catch(error => error as Error);
      // Either the CAS is refused outright, or the replacement is returned without claiming
      // this call produced it. What must never happen is selfRefreshed on someone else's write.
      if (!(result instanceof Error)) {
        expect(result.selfRefreshed).toBe(false);
      }
      // The replacement survives regardless.
      expect(readCodexAccountRecord("external")!.credential!.accessToken).toBe("external-access");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a transient error merely mentioning invalid_grant stays transient (#2887 review 2)", async () => {
    // Matching the phrase anywhere in the combined code+description text would retire a
    // healthy account on an upstream blip — reintroducing the defect this path fixes.
    const { forceRefreshCodexPoolToken, readCodexAccountRecord, saveCodexAccountCredential, TokenRefreshError } =
      await import("../src/codex/account-store");
    saveCodexAccountCredential("blip", {
      accessToken: "rejected",
      refreshToken: "grant",
      expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "acc",
    });
    const generation = readCodexAccountRecord("blip")!.generation;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      error: "server_error",
      error_description: "upstream failed while validating invalid_grant handling",
    }, { status: 503 })) as typeof fetch;

    try {
      await forceRefreshCodexPoolToken("blip", {
        rejectedGeneration: generation,
        rejectedAccessToken: "rejected",
      });
      throw new Error("expected a TokenRefreshError");
    } catch (error) {
      expect(error).toBeInstanceOf(TokenRefreshError);
      expect((error as InstanceType<typeof TokenRefreshError>).reason).toBe("unknown");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a successful refresh advances an untouched dormant same-grant alias in the same write (#2892 gap 3)", async () => {
    const { getValidCodexToken, readCodexAccountRecord, saveCodexAccountCredential } =
      await import("../src/codex/account-store");
    const expiresAt = 0;
    const shared = { refreshToken: "dormant-grant", expiresAt, chatgptAccountId: "acc" };
    // Owner drives the refresh. `dormant` is an untouched duplicate that never calls in — the
    // record the rotated grant used to skip, leaving it to send a dead grant on its next refresh.
    saveCodexAccountCredential("dormant-owner", { accessToken: "shared-old", ...shared });
    saveCodexAccountCredential("dormant-alias", { accessToken: "shared-old", ...shared });
    // Negative cases: each must be left strictly alone.
    saveCodexAccountCredential("alias-other-account", {
      accessToken: "shared-old",
      refreshToken: "dormant-grant",
      expiresAt,
      chatgptAccountId: "different-acc",
    });
    saveCodexAccountCredential("alias-moved-on", { accessToken: "already-newer", ...shared });
    saveCodexAccountCredential("alias-other-grant", {
      accessToken: "shared-old",
      refreshToken: "unrelated-grant",
      expiresAt,
      chatgptAccountId: "acc",
    });
    const aliasGeneration = readCodexAccountRecord("dormant-alias")!.generation;
    const otherAccountGeneration = readCodexAccountRecord("alias-other-account")!.generation;
    const movedOnGeneration = readCodexAccountRecord("alias-moved-on")!.generation;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      access_token: "rotated-access",
      refresh_token: "rotated-grant",
      expires_in: 3600,
    })) as typeof fetch;

    try {
      await getValidCodexToken("dormant-owner");

      const owner = readCodexAccountRecord("dormant-owner")!;
      expect(owner.credential).toMatchObject({ accessToken: "rotated-access", refreshToken: "rotated-grant" });

      // The dormant alias adopts the rotated credential WHOLE — access token, refresh token, and
      // expiry together — so its bumped generation still means "newer JWT", which is what the
      // plan-from-token fence reads it as.
      const alias = readCodexAccountRecord("dormant-alias")!;
      expect(alias.credential?.refreshToken).toBe("rotated-grant");
      expect(alias.credential?.accessToken).toBe("rotated-access");
      expect(alias.credential?.expiresAt).toBe(owner.credential!.expiresAt);
      expect(alias.credential?.chatgptAccountId).toBe("acc");
      expect(alias.generation).toBe(aliasGeneration + 1);
      expect(alias.refreshGrantFingerprint).toBe(owner.refreshGrantFingerprint);

      // A same-grant record on a DIFFERENT chatgpt account is not provably the same identity: a
      // fingerprint is sha256 of the refresh token and carries no identity claim.
      const otherAccount = readCodexAccountRecord("alias-other-account")!;
      expect(otherAccount.credential?.refreshToken).toBe("dormant-grant");
      expect(otherAccount.generation).toBe(otherAccountGeneration);

      // An alias whose access token already moved on must NOT be given a generation bump with a
      // stale JWT, and must not be handed back a possibly-rejected bearer.
      const movedOn = readCodexAccountRecord("alias-moved-on")!;
      expect(movedOn.credential?.accessToken).toBe("already-newer");
      expect(movedOn.credential?.refreshToken).toBe("dormant-grant");
      expect(movedOn.generation).toBe(movedOnGeneration);

      expect(readCodexAccountRecord("alias-other-grant")!.credential?.refreshToken).toBe("unrelated-grant");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a tombstoned same-grant record is not resurrected by grant propagation (#2892 gap 3)", async () => {
    const { getValidCodexToken, readCodexAccountRecord, saveCodexAccountCredential, tombstoneCodexAccount } =
      await import("../src/codex/account-store");
    const shared = { accessToken: "tomb-old", refreshToken: "tomb-grant", expiresAt: 0, chatgptAccountId: "acc" };
    saveCodexAccountCredential("tomb-owner", { ...shared });
    saveCodexAccountCredential("tomb-deleted", { ...shared });
    tombstoneCodexAccount("tomb-deleted");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      access_token: "tomb-new",
      refresh_token: "tomb-rotated",
      expires_in: 3600,
    })) as typeof fetch;
    try {
      await getValidCodexToken("tomb-owner");
      const deleted = readCodexAccountRecord("tomb-deleted")!;
      expect(deleted.deletedAt).toBeGreaterThan(0);
      expect(deleted.credential).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a TOKENFUL tombstone is not resurrected either, isolating the deletedAt guard (#2892 gap 3)", async () => {
    // The sibling test above cannot prove the `deletedAt` check is load-bearing: `tombstoneCodexAccount`
    // drops the credential, so the separate `!alias.credential` guard already skips that record and the
    // assertion passes with `deletedAt` removed. A tombstone that still CARRIES a credential is the only
    // shape that reaches the `deletedAt` check, and it is reachable — a store written by an older build,
    // or a tombstone raced by a concurrent save, produces exactly this record. `tokenful tombstone is
    // treated as absent` earlier in this file pins the same shape for the read path.
    const { getValidCodexToken, readCodexAccountRecord, saveCodexAccountCredential } =
      await import("../src/codex/account-store");
    const shared = {
      accessToken: "tokenful-old",
      refreshToken: "tokenful-grant",
      expiresAt: 0,
      chatgptAccountId: "tokenful-acc",
    };
    saveCodexAccountCredential("tokenful-owner", { ...shared });
    const ownerGeneration = readCodexAccountRecord("tokenful-owner")!.generation;
    // Written directly: no public API produces a tombstone that retains its credential.
    writeFileSync(ACCOUNTS_PATH, JSON.stringify({
      "tokenful-owner": { credential: { ...shared }, generation: ownerGeneration },
      "tokenful-deleted": { credential: { ...shared }, generation: ownerGeneration, deletedAt: Date.now() },
    }, null, 2));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      access_token: "tokenful-new",
      refresh_token: "tokenful-rotated",
      expires_in: 3600,
    })) as typeof fetch;
    try {
      await getValidCodexToken("tokenful-owner");
      // The owner rotated.
      expect(readCodexAccountRecord("tokenful-owner")!.credential!.refreshToken).toBe("tokenful-rotated");
      // The tombstone kept its stale grant and stayed deleted: propagation skipped it on `deletedAt`
      // alone, since its credential was present and every other eligibility field matched the owner.
      const deleted = readCodexAccountRecord("tokenful-deleted")!;
      expect(deleted.deletedAt).toBeGreaterThan(0);
      expect(deleted.credential!.refreshToken).toBe("tokenful-grant");
      expect(deleted.generation).toBe(ownerGeneration);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });


  test("a same-grant sibling on a DIFFERENT upstream identity is never adopted (#2892 review)", async () => {
    const { forceRefreshCodexPoolToken, getCodexAccountCredential, readCodexAccountRecord, saveCodexAccountCredential } =
      await import("../src/codex/account-store");
    // Both records share one stored grant, but they claim different upstream accounts. Adoption
    // copies BOTH tokens, so treating a shared fingerprint as proof of identity would hand this
    // caller another account's credential.
    saveCodexAccountCredential("foreign-caller", {
      accessToken: "rejected-token",
      refreshToken: "foreign-grant",
      expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "acct-one",
    });
    saveCodexAccountCredential("foreign-sibling", {
      accessToken: "sibling-fresh",
      refreshToken: "foreign-grant",
      expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "acct-two",
    });
    const generation = readCodexAccountRecord("foreign-caller")!.generation;

    const originalFetch = globalThis.fetch;
    let tokenCalls = 0;
    globalThis.fetch = (async () => {
      tokenCalls += 1;
      return Response.json({ access_token: "own-new", refresh_token: "own-rotated", expires_in: 3600 });
    }) as typeof fetch;
    try {
      const result = await forceRefreshCodexPoolToken("foreign-caller", {
        rejectedGeneration: generation,
        rejectedAccessToken: "rejected-token",
      });
      // A real refresh must have run instead of adopting the foreign sibling.
      expect(tokenCalls).toBe(1);
      expect(result.accessToken).toBe("own-new");
      expect(getCodexAccountCredential("foreign-caller")?.accessToken).not.toBe("sibling-fresh");
      // The sibling is untouched: this path must not write to another identity's record.
      expect(getCodexAccountCredential("foreign-sibling")?.accessToken).toBe("sibling-fresh");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

});

describe("shared refresh flight plan reconciliation (#2892 gap 2 follow-up)", () => {
  beforeEach(() => {
    setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
    process.env.OPENCODEX_HOME = TEST_DIR;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    setIcaclsRunnerForTests(null);
    delete process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("an aborted owner still reconciles the refreshed plan for the shared flight", async () => {
    // The flight deliberately outlives the caller that opened it, so plan reconciliation
    // must not hang off that caller's wait: a rotated token carrying a NEW
    // chatgpt_plan_type would otherwise commit while codexAccounts[].plan stayed stale
    // for the rest of the process, skewing plan-selected quota projection.
    const { forceRefreshCodexPoolToken, readCodexAccountRecord, saveCodexAccountCredential } =
      await import("../src/codex/account-store");
    const { loadConfig, saveConfig } = await import("../src/config");
    const { resetJwtPlanNotesForTests } = await import("../src/codex/plan-from-token");
    resetJwtPlanNotesForTests();

    saveConfig({
      port: 10199,
      providers: {},
      defaultProvider: "openai",
      codexAccounts: [{ id: "plan-flight", email: "flight@example.test", plan: "plus", isMain: false }],
    });
    saveCodexAccountCredential("plan-flight", {
      accessToken: planJwt("plus"),
      refreshToken: "plan-grant",
      expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "acct-plan-flight",
    });
    const generation = readCodexAccountRecord("plan-flight")!.generation;

    const originalFetch = globalThis.fetch;
    let releaseFetch: (() => void) | undefined;
    const fetchStarted = new Promise<void>(resolve => {
      globalThis.fetch = (async () => {
        resolve();
        await new Promise<void>(release => { releaseFetch = release; });
        return Response.json({
          access_token: planJwt("pro"),
          refresh_token: "plan-grant2",
          expires_in: 3600,
        });
      }) as typeof fetch;
    });

    try {
      const owner = new AbortController();
      const ownerCall = forceRefreshCodexPoolToken("plan-flight", {
        rejectedGeneration: generation,
        rejectedAccessToken: planJwt("plus"),
        signal: owner.signal,
      });
      await fetchStarted;
      owner.abort(new Error("client disconnected"));
      await expect(ownerCall).rejects.toThrow("client disconnected");

      releaseFetch?.();
      // The flight is detached from every caller now, so there is nothing to await. Poll
      // for the persisted outcome under a deadline instead of a fixed delay: a fixed
      // sleep can pass before the flight commits on a loaded worker and let teardown race
      // unfinished work, and it never proves the reconciliation actually ran.
      const deadline = Date.now() + 5_000;
      let persisted = loadConfig().codexAccounts?.[0];
      while ((persisted?.plan !== "pro" || persisted?.planSource !== "jwt") && Date.now() < deadline) {
        await Bun.sleep(10);
        persisted = loadConfig().codexAccounts?.[0];
      }

      expect(persisted?.plan).toBe("pro");
      expect(persisted?.planSource).toBe("jwt");
      expect(readCodexAccountRecord("plan-flight")!.credential!.accessToken).toBe(planJwt("pro"));
    } finally {
      globalThis.fetch = originalFetch;
      resetJwtPlanNotesForTests();
    }
  });

  test("records with EMPTY account ids are never treated as the same identity (#2892 review)", async () => {
    const { getValidCodexToken, readCodexAccountRecord, saveCodexAccountCredential } =
      await import("../src/codex/account-store");
    // Grant fingerprint, access token and expiry all match, and both ids are "". Two empty strings
    // compare equal but prove nothing about which upstream account either record was meant to use,
    // so propagation must fail closed rather than write a credential into an unidentified record.
    const shared = { accessToken: "anon-old", refreshToken: "anon-grant", expiresAt: 0, chatgptAccountId: "" };
    saveCodexAccountCredential("anon-owner", { ...shared });
    saveCodexAccountCredential("anon-alias", { ...shared });
    const aliasGeneration = readCodexAccountRecord("anon-alias")!.generation;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      access_token: "anon-new",
      refresh_token: "anon-rotated",
      expires_in: 3600,
    })) as typeof fetch;
    try {
      await getValidCodexToken("anon-owner");

      // The owner still rotates normally.
      expect(readCodexAccountRecord("anon-owner")!.credential?.refreshToken).toBe("anon-rotated");
      // The unidentified record is untouched, generation included.
      const alias = readCodexAccountRecord("anon-alias")!;
      expect(alias.credential?.accessToken).toBe("anon-old");
      expect(alias.credential?.refreshToken).toBe("anon-grant");
      expect(alias.generation).toBe(aliasGeneration);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

});
