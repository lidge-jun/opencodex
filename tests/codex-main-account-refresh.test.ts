import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAccountNeedsReauth, isAccountNeedsReauth } from "../src/codex/auth-api";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/account-id";
import {
  TokenRefreshError,
  getValidCodexToken,
  readCodexAccountRecord,
  refreshGrantFingerprintForToken,
  saveCodexAccountCredential,
  withCodexRefreshFileLock,
} from "../src/codex/account-store";
import {
  forceRefreshMainAccountToken,
  getValidMainAccountToken,
  isMainAccountCredentialUsable,
  type NativeMainRefreshDependencies,
} from "../src/codex/main-account";

let testDir: string;
let codexHome: string;
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

function jwt(expSecondsFromNow: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })).toString("base64url");
  return `header.${payload}.signature`;
}

function writeAuth(payload: Record<string, unknown>): void {
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify(payload, null, 2) + "\n");
}

function refreshDependencies(accessToken: string): NativeMainRefreshDependencies {
  return Object.freeze({
    refreshToken: async () => ({ access: accessToken, refresh: "rotated-refresh", expires: Date.now() + 3_600_000, accountId: "main-account" }),
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-main-refresh-"));
  codexHome = join(testDir, "codex");
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = testDir;
  process.env.CODEX_HOME = codexHome;
  mkdirSync(codexHome, { recursive: true });
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
});

afterEach(() => {
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  rmSync(testDir, { recursive: true, force: true });
});

describe("native main credential refresh", () => {
  test("keeps an expired credential selectable when its refresh grant is valid", () => {
    writeAuth({ tokens: { access_token: jwt(-60), refresh_token: "native-refresh", account_id: "main-account" } });
    expect(isMainAccountCredentialUsable()).toBe(true);
  });

  test("atomically persists rotated fields while preserving unrelated auth fields", async () => {
    const freshAccess = jwt(3_600);
    const grantFingerprint = refreshGrantFingerprintForToken("native-refresh");
    writeAuth({
      retained: { profile: "keep" },
      tokens: { access_token: jwt(-60), refresh_token: "native-refresh", account_id: "main-account", retained: "keep" },
    });
    const credential = await getValidMainAccountToken({ dependencies: refreshDependencies(freshAccess) });
    const persisted = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8")) as Record<string, any>;
    expect(credential).toEqual({ accessToken: freshAccess, chatgptAccountId: "main-account" });
    expect(persisted.retained).toEqual({ profile: "keep" });
    expect(persisted.tokens).toMatchObject({
      access_token: freshAccess,
      refresh_token: "rotated-refresh",
      refresh_grant_fingerprint: grantFingerprint,
      retained: "keep",
    });
    expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
  });

  test("does not partially overwrite malformed refresh results", async () => {
    const before = { tokens: { access_token: jwt(-60), refresh_token: "native-refresh", account_id: "main-account", retained: "keep" } };
    writeAuth(before);
    const dependencies: NativeMainRefreshDependencies = Object.freeze({
      refreshToken: async () => { throw new TokenRefreshError("unknown", "malformed refresh result"); },
    });
    await expect(getValidMainAccountToken({ dependencies })).rejects.toBeInstanceOf(TokenRefreshError);
    expect(JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"))).toEqual(before);
  });

  test("marks terminal revoked grants for reauthentication", async () => {
    writeAuth({ tokens: { access_token: jwt(-60), refresh_token: "native-refresh", account_id: "main-account" } });
    const dependencies: NativeMainRefreshDependencies = Object.freeze({
      refreshToken: async () => { throw new TokenRefreshError("revoked", "revoked"); },
    });
    await expect(getValidMainAccountToken({ dependencies })).rejects.toBeInstanceOf(TokenRefreshError);
    expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(true);
  });

  test("serializes native refresh behind the shared grant lock", async () => {
    writeAuth({ tokens: { access_token: jwt(-60), refresh_token: "native-refresh", account_id: "main-account" } });
    const entered = deferred();
    const release = deferred();
    const lock = withCodexRefreshFileLock({
      lockKey: refreshGrantFingerprintForToken("native-refresh"),
      signal: AbortSignal.timeout(5_000),
      run: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    let refreshCalls = 0;
    try {
      await expect(forceRefreshMainAccountToken(undefined, {
        signal: AbortSignal.timeout(20),
        dependencies: Object.freeze({
          refreshToken: async () => {
            refreshCalls += 1;
            return { access: jwt(3_600), refresh: "rotated-refresh", expires: Date.now() + 3_600_000, accountId: "main-account" };
          },
        }),
      })).rejects.toBeInstanceOf(DOMException);
      expect(refreshCalls).toBe(0);
    } finally {
      release.resolve();
      await lock;
    }
  });

  test("publishes native-first refreshes to stored accounts sharing the grant", async () => {
    const freshAccess = jwt(3_600);
    const secondFreshAccess = jwt(3_700);
    writeAuth({ tokens: { access_token: jwt(-60), refresh_token: "shared-refresh", account_id: "main-account" } });
    saveCodexAccountCredential("pool-shared", {
      accessToken: "expired-pool",
      refreshToken: "shared-refresh",
      expiresAt: Date.now() - 60_000,
      chatgptAccountId: "pool-account",
    });

    await forceRefreshMainAccountToken(undefined, { dependencies: refreshDependencies(freshAccess) });
    const poolToken = await getValidCodexToken("pool-shared");
    const persistedAfterFirst = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8")) as Record<string, any>;

    expect(poolToken.accessToken).toBe(freshAccess);
    expect(poolToken.chatgptAccountId).toBe("main-account");
    expect(persistedAfterFirst.tokens.refresh_grant_fingerprint).toBe(refreshGrantFingerprintForToken("shared-refresh"));

    writeAuth({
      tokens: {
        ...persistedAfterFirst.tokens,
        access_token: jwt(-60),
      },
    });
    const second = await forceRefreshMainAccountToken(undefined, {
      dependencies: Object.freeze({
        refreshToken: async () => ({ access: secondFreshAccess, refresh: "second-rotated-refresh", expires: Date.now() + 3_600_000, accountId: "main-account" }),
      }),
    });
    const poolAfterSecond = await getValidCodexToken("pool-shared");

    expect(second?.accessToken).toBe(freshAccess);
    expect(poolAfterSecond.accessToken).toBe(freshAccess);
  });

  test("adopts stored-first refreshes into native auth without another refresh", async () => {
    const freshAccess = jwt(3_600);
    writeAuth({ tokens: { access_token: jwt(-60), refresh_token: "shared-refresh", account_id: "main-account" } });
    saveCodexAccountCredential("pool-shared", {
      accessToken: "expired-pool",
      refreshToken: "shared-refresh",
      expiresAt: Date.now() - 60_000,
      chatgptAccountId: "pool-account",
    });
    const stored = await getValidCodexToken("pool-shared", {
      fetch: async () => Response.json({ access_token: freshAccess, refresh_token: "rotated-refresh", expires_in: 3600 }),
    });
    const record = readCodexAccountRecord("pool-shared");

    const refreshed = await forceRefreshMainAccountToken(undefined, {
      dependencies: Object.freeze({
        refreshToken: async () => {
          throw new Error("native refresh must not run when a stored same-grant credential is fresh");
        },
      }),
    });
    const persisted = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8")) as Record<string, any>;

    expect(stored.accessToken).toBe(freshAccess);
    expect(record?.refreshGrantFingerprint).toBe(refreshGrantFingerprintForToken("shared-refresh"));
    expect(refreshed).toEqual({ accessToken: freshAccess, chatgptAccountId: "pool-account" });
    expect(persisted.tokens).toMatchObject({
      access_token: freshAccess,
      refresh_token: "rotated-refresh",
      refresh_grant_fingerprint: refreshGrantFingerprintForToken("shared-refresh"),
      account_id: "pool-account",
    });
  });

  test("401 refresh ignores a same-grant stored credential carrying the rejected bearer", async () => {
    const freshAccess = jwt(3_600);
    const rejectedAccess = jwt(3_500);
    writeAuth({ tokens: { access_token: rejectedAccess, refresh_token: "shared-refresh", account_id: "main-account" } });
    saveCodexAccountCredential("pool-shared", {
      accessToken: rejectedAccess,
      refreshToken: "shared-refresh",
      expiresAt: Date.now() + 3_600_000,
      chatgptAccountId: "pool-account",
    });
    const refreshed = await forceRefreshMainAccountToken(rejectedAccess, {
      dependencies: refreshDependencies(freshAccess),
    });
    const persisted = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8")) as Record<string, any>;
    const record = readCodexAccountRecord("pool-shared");

    expect(refreshed?.accessToken).toBe(freshAccess);
    expect(persisted.tokens.access_token).toBe(freshAccess);
    expect(record?.credential?.accessToken).toBe(freshAccess);
    expect(record?.credential?.refreshToken).toBe("rotated-refresh");
    expect(record?.refreshGrantFingerprint).toBe(refreshGrantFingerprintForToken("shared-refresh"));
  });
});
