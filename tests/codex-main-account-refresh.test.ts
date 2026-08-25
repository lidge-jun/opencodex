import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCodexAccountUsable } from "../src/codex/account-usability";
import { clearAccountNeedsReauth, isAccountNeedsReauth } from "../src/codex/account-runtime-state";
import {
  TokenRefreshError,
  getCodexAccountCredential,
  readCodexAccountRecord,
  refreshGrantFingerprintForToken,
  saveCodexAccountCredential,
} from "../src/codex/account-store";
import { NATIVE_DAYBREAK_BLUE_MODEL } from "../src/codex/catalog/native-models";
import {
  MAIN_CODEX_ACCOUNT_ID,
  MainAuthJsonChangedDuringRefreshError,
  forceRefreshMainAccountToken,
  getValidMainAccountToken,
  setMainAuthJsonPublishHookForTests,
  setMainAuthJsonRenameHookForTests,
  setMainAuthJsonReplaceHookForTests,
} from "../src/codex/main-account";
import {
  entitledCodexAccountIdsForModel,
  resolveCodexModelEntitlements,
} from "../src/codex/model-entitlements";
import {
  CodexAuthContextError,
  materializeCodexUpstreamAuthAsync,
  resolveCodexAuthContext,
  type CodexAuthContext,
} from "../src/codex/auth-context";
import type { CodexModelEntitlementResolveOptions } from "../src/codex/model-entitlements";
import { ChatGPTTokenRefreshError } from "../src/oauth/chatgpt";
import type { OAuthCredentials } from "../src/oauth/types";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

let isolatedCodexHome: IsolatedCodexHome;
let opencodexHome: string;
let previousOpencodexHome: string | undefined;

beforeEach(() => {
  isolatedCodexHome = installIsolatedCodexHome("ocx-main-refresh-codex-");
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-main-refresh-store-"));
  process.env.OPENCODEX_HOME = opencodexHome;
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
});

afterEach(() => {
  setMainAuthJsonPublishHookForTests(null);
  setMainAuthJsonRenameHookForTests(null);
  setMainAuthJsonReplaceHookForTests(null);
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  isolatedCodexHome.restore();
  rmSync(opencodexHome, { recursive: true, force: true });
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
});

function jwt(name: string, expiresInSeconds: number, accountId = "main-account"): string {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    chatgpt_account_id: accountId,
    marker: name,
  })).toString("base64url");
  return `header.${payload}.signature`;
}

function authPath(): string {
  return join(isolatedCodexHome.path, "auth.json");
}

function writeAuth(tokens: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
  writeFileSync(authPath(), JSON.stringify({
    ...extra,
    tokens,
  }, null, 2));
}

function readAuth(): { tokens: Record<string, unknown>; untouched?: unknown } {
  return JSON.parse(readFileSync(authPath(), "utf-8")) as { tokens: Record<string, unknown>; untouched?: unknown };
}

function refreshed(accessToken: string, refreshToken = "fresh-refresh", accountId = "fresh-account"): OAuthCredentials {
  return {
    access: accessToken,
    refresh: refreshToken,
    expires: Date.now() + 3_600_000,
    accountId,
  };
}

function nativeRefreshLockPath(refreshToken: string): string {
  const lockKey = refreshGrantFingerprintForToken(refreshToken);
  const digest = createHash("sha256").update(lockKey).digest("hex").slice(0, 32);
  return join(opencodexHome, `codex-refresh-${digest}.lock`);
}

function writeNativeRefreshLock(refreshToken: string): string {
  const path = nativeRefreshLockPath(refreshToken);
  writeFileSync(path, JSON.stringify({ acquiredAt: Date.now(), pid: process.pid }) + "\n", { mode: 0o600 });
  return path;
}

function mainOnlyConfig(): OcxConfig {
  return {
    providers: {},
    codexAccounts: [],
    activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID,
    autoSwitchThreshold: 0,
  } as OcxConfig;
}

describe("native main auth.json refresh", () => {
  test("keeps a refresh-only auth.json selectable and refreshes before auth context materialization", async () => {
    const freshAccess = jwt("fresh", 3_600);
    writeAuth({ refresh_token: "refresh-only", account_id: "main-account" }, { untouched: true });

    expect(isCodexAccountUsable(mainOnlyConfig(), MAIN_CODEX_ACCOUNT_ID)).toBe(true);
    const ctx = await resolveCodexAuthContext(new Headers(), mainOnlyConfig(), "pool", {
      nativeMainRefreshDependencies: {
        refreshToken: async () => refreshed(freshAccess),
      },
    });

    expect(ctx).toMatchObject({
      kind: "main-pool",
      accountId: MAIN_CODEX_ACCOUNT_ID,
      accessToken: freshAccess,
      chatgptAccountId: "fresh-account",
    });
    const persisted = readAuth();
    expect(persisted.untouched).toBe(true);
    expect(persisted.tokens.access_token).toBe(freshAccess);
    expect(persisted.tokens.refresh_token).toBe("fresh-refresh");
    expect(persisted.tokens.account_id).toBe("fresh-account");
  });

  test("adopts an external auth.json writer instead of clobbering it after the refresh round trip", async () => {
    const expiredAccess = jwt("expired", -3_600);
    const externalAccess = jwt("external", 3_600, "external-account");
    const fetchedAccess = jwt("fetched", 3_600, "fetched-account");
    writeAuth({
      access_token: expiredAccess,
      refresh_token: "initial-refresh",
      account_id: "main-account",
    });

    const token = await forceRefreshMainAccountToken(expiredAccess, {
      dependencies: {
        refreshToken: async () => {
          writeAuth({
            access_token: externalAccess,
            refresh_token: "external-refresh",
            account_id: "external-account",
          });
          return refreshed(fetchedAccess, "fetched-refresh", "fetched-account");
        },
      },
    });

    expect(token).toEqual({ accessToken: externalAccess, chatgptAccountId: "external-account" });
    const persisted = readAuth();
    expect(persisted.tokens.access_token).toBe(externalAccess);
    expect(persisted.tokens.refresh_token).toBe("external-refresh");
    expect(persisted.tokens.account_id).toBe("external-account");
  });

  test("adopts an external auth.json writer instead of clobbering it during final publish", async () => {
    const expiredAccess = jwt("expired-final-race", -3_600);
    const externalAccess = jwt("external-final-race", 3_600, "external-final-account");
    const fetchedAccess = jwt("fetched-final-race", 3_600, "fetched-final-account");
    writeAuth({
      access_token: expiredAccess,
      refresh_token: "initial-final-race-refresh",
      account_id: "main-account",
    });
    setMainAuthJsonPublishHookForTests(() => {
      writeAuth({
        access_token: externalAccess,
        refresh_token: "external-final-refresh",
        account_id: "external-final-account",
      });
    });

    const token = await forceRefreshMainAccountToken(expiredAccess, {
      dependencies: {
        refreshToken: async () => refreshed(fetchedAccess, "fetched-final-refresh", "fetched-final-account"),
      },
    });

    expect(token).toEqual({ accessToken: externalAccess, chatgptAccountId: "external-final-account" });
    const persisted = readAuth();
    expect(persisted.tokens.access_token).toBe(externalAccess);
    expect(persisted.tokens.refresh_token).toBe("external-final-refresh");
    expect(persisted.tokens.account_id).toBe("external-final-account");
  });

  test("adopts an external auth.json writer instead of clobbering it after final validation", async () => {
    const expiredAccess = jwt("expired-rename-race", -3_600);
    const externalAccess = jwt("external-rename-race", 3_600, "external-rename-account");
    const fetchedAccess = jwt("fetched-rename-race", 3_600, "fetched-rename-account");
    writeAuth({
      access_token: expiredAccess,
      refresh_token: "initial-rename-race-refresh",
      account_id: "main-account",
    });
    setMainAuthJsonRenameHookForTests(() => {
      writeAuth({
        access_token: externalAccess,
        refresh_token: "external-rename-refresh",
        account_id: "external-rename-account",
      });
    });

    const token = await forceRefreshMainAccountToken(expiredAccess, {
      dependencies: {
        refreshToken: async () => refreshed(fetchedAccess, "fetched-rename-refresh", "fetched-rename-account"),
      },
    });

    expect(token).toEqual({ accessToken: externalAccess, chatgptAccountId: "external-rename-account" });
    const persisted = readAuth();
    expect(persisted.tokens.access_token).toBe(externalAccess);
    expect(persisted.tokens.refresh_token).toBe("external-rename-refresh");
    expect(persisted.tokens.account_id).toBe("external-rename-account");
  });

  test("adopts an external auth.json writer instead of clobbering it between final validation and replacement", async () => {
    const expiredAccess = jwt("expired-replace-race", -3_600);
    const externalAccess = jwt("external-replace-race", 3_600, "external-replace-account");
    const fetchedAccess = jwt("fetched-replace-race", 3_600, "fetched-replace-account");
    writeAuth({
      access_token: expiredAccess,
      refresh_token: "initial-replace-race-refresh",
      account_id: "main-account",
    });
    setMainAuthJsonReplaceHookForTests(() => {
      writeAuth({
        access_token: externalAccess,
        refresh_token: "external-replace-refresh",
        account_id: "external-replace-account",
      });
    });

    const token = await forceRefreshMainAccountToken(expiredAccess, {
      dependencies: {
        refreshToken: async () => refreshed(fetchedAccess, "fetched-replace-refresh", "fetched-replace-account"),
      },
    });

    expect(token).toEqual({ accessToken: externalAccess, chatgptAccountId: "external-replace-account" });
    const persisted = readAuth();
    expect(persisted.tokens.access_token).toBe(externalAccess);
    expect(persisted.tokens.refresh_token).toBe("external-replace-refresh");
    expect(persisted.tokens.account_id).toBe("external-replace-account");
  });

  test("publishes a native refresh to stored credentials that share the old refresh grant", async () => {
    const expiredAccess = jwt("expired-shared", -3_600, "native-account");
    const freshAccess = jwt("fresh-shared", 3_600, "native-account");
    saveCodexAccountCredential("pool-shared", {
      accessToken: jwt("pool-expired", -3_600, "pool-account"),
      refreshToken: "shared-refresh",
      expiresAt: Date.now() - 3_600_000,
      chatgptAccountId: "pool-account",
    });
    const initialRecord = readCodexAccountRecord("pool-shared")!;
    writeAuth({
      access_token: expiredAccess,
      refresh_token: "shared-refresh",
      account_id: "native-account",
    });

    const token = await forceRefreshMainAccountToken(expiredAccess, {
      dependencies: {
        refreshToken: async () => refreshed(freshAccess, "shared-refresh-2", "native-account"),
      },
    });

    expect(token).toEqual({ accessToken: freshAccess, chatgptAccountId: "native-account" });
    const persisted = readAuth();
    expect(persisted.tokens.access_token).toBe(freshAccess);
    expect(persisted.tokens.refresh_token).toBe("shared-refresh-2");
    const stored = getCodexAccountCredential("pool-shared")!;
    expect(stored.accessToken).toBe(freshAccess);
    expect(stored.refreshToken).toBe("shared-refresh-2");
    expect(stored.chatgptAccountId).toBe("pool-account");
    expect(readCodexAccountRecord("pool-shared")!.generation).toBe(initialRecord.generation + 1);
    expect(readCodexAccountRecord("pool-shared")!.refreshGrantFingerprint)
      .toBe(refreshGrantFingerprintForToken("shared-refresh-2"));
  });

  test("adopts a fresh stored credential that shares the native refresh grant without a network refresh", async () => {
    const poolAccess = jwt("pool-shared-fresh", 3_600, "shared-account");
    saveCodexAccountCredential("pool-same-grant", {
      accessToken: poolAccess,
      refreshToken: "same-grant-refresh",
      expiresAt: Date.now() + 3_600_000,
      chatgptAccountId: "shared-account",
    });
    writeAuth({
      access_token: jwt("native-same-grant-expired", -3_600, "shared-account"),
      refresh_token: "same-grant-refresh",
      account_id: "shared-account",
    });
    let refreshCalls = 0;

    const token = await getValidMainAccountToken({
      dependencies: {
        refreshToken: async () => {
          refreshCalls += 1;
          throw new Error("network refresh should not run");
        },
      },
    });

    expect(refreshCalls).toBe(0);
    expect(token).toEqual({ accessToken: poolAccess, chatgptAccountId: "shared-account" });
    const persisted = readAuth();
    expect(persisted.tokens.access_token).toBe(poolAccess);
    expect(persisted.tokens.refresh_token).toBe("same-grant-refresh");
    expect(persisted.tokens.account_id).toBe("shared-account");
  });

  test("serializes concurrent native refreshes on the same grant and reuses the winner", async () => {
    const expiredAccess = jwt("expired-concurrent", -3_600, "main-account");
    const freshAccess = jwt("fresh-concurrent", 3_600, "main-account");
    let refreshCalls = 0;
    let releaseRefresh!: () => void;
    const refreshMayFinish = new Promise<void>(resolve => {
      releaseRefresh = resolve;
    });
    let firstRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>(resolve => {
      firstRefreshStarted = resolve;
    });
    writeAuth({
      access_token: expiredAccess,
      refresh_token: "concurrent-refresh",
      account_id: "main-account",
    });

    const first = forceRefreshMainAccountToken(expiredAccess, {
      dependencies: {
        refreshToken: async () => {
          refreshCalls += 1;
          firstRefreshStarted();
          await refreshMayFinish;
          return refreshed(freshAccess, "concurrent-refresh-2", "main-account");
        },
      },
    });
    await refreshStarted;
    const second = forceRefreshMainAccountToken(expiredAccess, {
      dependencies: {
        refreshToken: async () => {
          refreshCalls += 1;
          return refreshed(jwt("unexpected-concurrent", 3_600), "unexpected-refresh", "main-account");
        },
      },
    });
    releaseRefresh();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { accessToken: freshAccess, chatgptAccountId: "main-account" },
      { accessToken: freshAccess, chatgptAccountId: "main-account" },
    ]);
    expect(refreshCalls).toBe(1);
    const persisted = readAuth();
    expect(persisted.tokens.access_token).toBe(freshAccess);
    expect(persisted.tokens.refresh_token).toBe("concurrent-refresh-2");
  });

  test("normalizes transient errors for callers joining an active native refresh", async () => {
    const expiredAccess = jwt("expired-concurrent-transient", -3_600, "main-account");
    let releaseRefresh!: () => void;
    const refreshMayFinish = new Promise<void>(resolve => {
      releaseRefresh = resolve;
    });
    let firstRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>(resolve => {
      firstRefreshStarted = resolve;
    });
    let joinedRefreshCalls = 0;
    writeAuth({
      access_token: expiredAccess,
      refresh_token: "concurrent-transient-refresh",
      account_id: "main-account",
    });

    const owner = getValidMainAccountToken({
      dependencies: {
        refreshToken: async () => {
          firstRefreshStarted();
          await refreshMayFinish;
          throw new Error("temporary upstream failure while refreshing");
        },
      },
    }).catch((error: unknown) => error);
    await refreshStarted;
    const joined = resolveCodexAuthContext(new Headers(), mainOnlyConfig(), "pool", {
      nativeMainRefreshDependencies: {
        refreshToken: async () => {
          joinedRefreshCalls += 1;
          return refreshed(jwt("unexpected-joined-transient", 3_600), "unexpected-refresh", "main-account");
        },
      },
    }).catch((error: unknown) => error);
    releaseRefresh();

    const [ownerError, joinedError] = await Promise.all([owner, joined]);
    expect(ownerError).toBeInstanceOf(TokenRefreshError);
    expect((ownerError as TokenRefreshError).reason).toBe("unknown");
    expect(joinedError).toBeInstanceOf(CodexAuthContextError);
    expect((joinedError as Error).cause).toBeInstanceOf(TokenRefreshError);
    expect(((joinedError as Error).cause as TokenRefreshError).reason).toBe("unknown");
    expect(joinedRefreshCalls).toBe(0);
    expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
  });

  test("refreshes again when a joined flight returns the caller's rejected bearer", async () => {
    const expiredAccess = jwt("expired-concurrent-rejected", -3_600, "main-account");
    const rejectedFreshAccess = jwt("fresh-concurrent-rejected", 3_600, "main-account");
    const replayFreshAccess = jwt("fresh-concurrent-replay", 3_600, "main-account");
    let releaseRefresh!: () => void;
    const refreshMayFinish = new Promise<void>(resolve => {
      releaseRefresh = resolve;
    });
    let firstRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>(resolve => {
      firstRefreshStarted = resolve;
    });
    let firstRefreshCalls = 0;
    let secondRefreshCalls = 0;
    writeAuth({
      access_token: expiredAccess,
      refresh_token: "concurrent-rejected-refresh",
      account_id: "main-account",
    });

    const owner = forceRefreshMainAccountToken(expiredAccess, {
      dependencies: {
        refreshToken: async () => {
          firstRefreshCalls += 1;
          firstRefreshStarted();
          await refreshMayFinish;
          return refreshed(rejectedFreshAccess, "concurrent-rejected-refresh-2", "main-account");
        },
      },
    });
    await refreshStarted;
    const joined = forceRefreshMainAccountToken(rejectedFreshAccess, {
      dependencies: {
        refreshToken: async () => {
          secondRefreshCalls += 1;
          return refreshed(replayFreshAccess, "concurrent-rejected-refresh-3", "main-account");
        },
      },
    });
    releaseRefresh();

    await expect(Promise.all([owner, joined])).resolves.toEqual([
      { accessToken: rejectedFreshAccess, chatgptAccountId: "main-account" },
      { accessToken: replayFreshAccess, chatgptAccountId: "main-account" },
    ]);
    expect(firstRefreshCalls).toBe(1);
    expect(secondRefreshCalls).toBe(1);
    const persisted = readAuth();
    expect(persisted.tokens.access_token).toBe(replayFreshAccess);
    expect(persisted.tokens.refresh_token).toBe("concurrent-rejected-refresh-3");
    expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
  });

  test("fails retryably when the native refresh grant changes while waiting for the old grant lock", async () => {
    const grantAAccess = jwt("expired-grant-a", -3_600, "main-account");
    const grantBAccess = jwt("expired-grant-b", -3_600, "main-account");
    writeAuth({
      access_token: grantAAccess,
      refresh_token: "grant-a-refresh",
      account_id: "main-account",
    });
    const lockPath = writeNativeRefreshLock("grant-a-refresh");
    let refreshCalls = 0;

    const attempt = forceRefreshMainAccountToken(grantAAccess, {
      dependencies: {
        refreshToken: async () => {
          refreshCalls += 1;
          return refreshed(jwt("unexpected-grant-refresh", 3_600), "unexpected-refresh", "main-account");
        },
      },
    });
    writeAuth({
      access_token: grantBAccess,
      refresh_token: "grant-b-refresh",
      account_id: "main-account",
    });
    unlinkSync(lockPath);

    await expect(attempt).rejects.toBeInstanceOf(MainAuthJsonChangedDuringRefreshError);
    expect(refreshCalls).toBe(0);
    expect(readAuth().tokens.refresh_token).toBe("grant-b-refresh");
    expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
  });

  test("fails retryably instead of accepting a fresh replacement grant under the old grant lock", async () => {
    const grantAAccess = jwt("expired-grant-a-fresh-b", -3_600, "main-account");
    const grantBAccess = jwt("fresh-grant-b", 3_600, "main-account");
    writeAuth({
      access_token: grantAAccess,
      refresh_token: "grant-a-refresh",
      account_id: "main-account",
    });
    const lockPath = writeNativeRefreshLock("grant-a-refresh");
    let refreshCalls = 0;

    const attempt = forceRefreshMainAccountToken(grantAAccess, {
      dependencies: {
        refreshToken: async () => {
          refreshCalls += 1;
          return refreshed(jwt("unexpected-fresh-grant-refresh", 3_600), "unexpected-refresh", "main-account");
        },
      },
    });
    writeAuth({
      access_token: grantBAccess,
      refresh_token: "grant-b-refresh",
      account_id: "main-account",
    });
    unlinkSync(lockPath);

    await expect(attempt).rejects.toBeInstanceOf(MainAuthJsonChangedDuringRefreshError);
    expect(refreshCalls).toBe(0);
    expect(readAuth().tokens.access_token).toBe(grantBAccess);
    expect(readAuth().tokens.refresh_token).toBe("grant-b-refresh");
    expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
  });

  test("adopts one fresh stored credential for the same ChatGPT account when the match is unambiguous", async () => {
    const poolAccess = jwt("pool-main-fresh", 3_600, "main-account");
    saveCodexAccountCredential("pool-main", {
      accessToken: poolAccess,
      refreshToken: "pool-main-refresh",
      expiresAt: Date.now() + 3_600_000,
      chatgptAccountId: "main-account",
    });
    writeAuth({
      access_token: jwt("native-main-expired", -3_600, "main-account"),
      refresh_token: "native-main-refresh",
      account_id: "main-account",
    });
    let refreshCalls = 0;

    const token = await getValidMainAccountToken({
      dependencies: {
        refreshToken: async () => {
          refreshCalls += 1;
          throw new Error("network refresh should not run");
        },
      },
    });

    expect(refreshCalls).toBe(0);
    expect(token).toEqual({ accessToken: poolAccess, chatgptAccountId: "main-account" });
    const persisted = readAuth();
    expect(persisted.tokens.access_token).toBe(poolAccess);
    expect(persisted.tokens.refresh_token).toBe("pool-main-refresh");
    expect(persisted.tokens.account_id).toBe("main-account");
  });

  test("does not adopt an ambiguous same-account stored credential", async () => {
    const poolAccessOne = jwt("pool-main-one", 3_600, "main-account");
    const poolAccessTwo = jwt("pool-main-two", 3_600, "main-account");
    const networkAccess = jwt("network-main", 3_600, "main-account");
    saveCodexAccountCredential("pool-main-one", {
      accessToken: poolAccessOne,
      refreshToken: "pool-main-refresh-one",
      expiresAt: Date.now() + 3_600_000,
      chatgptAccountId: "main-account",
    });
    saveCodexAccountCredential("pool-main-two", {
      accessToken: poolAccessTwo,
      refreshToken: "pool-main-refresh-two",
      expiresAt: Date.now() + 3_600_000,
      chatgptAccountId: "main-account",
    });
    writeAuth({
      access_token: jwt("native-main-ambiguous-expired", -3_600, "main-account"),
      refresh_token: "native-main-refresh",
      account_id: "main-account",
    });
    let refreshCalls = 0;

    const token = await getValidMainAccountToken({
      dependencies: {
        refreshToken: async () => {
          refreshCalls += 1;
          return refreshed(networkAccess, "network-main-refresh", "main-account");
        },
      },
    });

    expect(refreshCalls).toBe(1);
    expect(token).toEqual({ accessToken: networkAccess, chatgptAccountId: "main-account" });
    const persisted = readAuth();
    expect(persisted.tokens.access_token).toBe(networkAccess);
    expect(persisted.tokens.refresh_token).toBe("network-main-refresh");
    expect(persisted.tokens.access_token).not.toBe(poolAccessOne);
    expect(persisted.tokens.access_token).not.toBe(poolAccessTwo);
  });

  test("refreshes a Direct admission substitution before returning upstream headers", async () => {
    const expiredAccess = jwt("expired-direct", -3_600);
    const freshAccess = jwt("fresh-direct", 3_600, "fresh-direct-account");
    writeAuth({
      access_token: expiredAccess,
      refresh_token: "direct-refresh",
      account_id: "main-account",
    });

    const headers = await materializeCodexUpstreamAuthAsync(
      new Headers({ authorization: "Bearer admission-secret" }),
      { kind: "main", accountId: null } satisfies CodexAuthContext,
      {
        substituteMainCredential: true,
        nativeMainRefreshDependencies: {
          refreshToken: async () => refreshed(freshAccess, "direct-refresh-2", "fresh-direct-account"),
        },
      },
    );

    expect(headers.get("authorization")).toBe(`Bearer ${freshAccess}`);
    expect(headers.get("chatgpt-account-id")).toBe("fresh-direct-account");
  });

  test("refreshes before native main account-gated model discovery", async () => {
    const expiredAccess = jwt("expired-entitlement", -3_600);
    const freshAccess = jwt("fresh-entitlement", 3_600, "fresh-entitlement-account");
    let seenAuthorization = "";
    writeAuth({
      access_token: expiredAccess,
      refresh_token: "entitlement-refresh",
      account_id: "main-account",
    });

    const snapshot = await resolveCodexModelEntitlements(mainOnlyConfig(), {
      fetcher: (async (_input, init) => {
        seenAuthorization = new Headers(init?.headers).get("authorization") ?? "";
        return Response.json({
          models: [{ slug: NATIVE_DAYBREAK_BLUE_MODEL, supported_in_api: true, visibility: "list" }],
        });
      }) as typeof fetch,
      nativeMainRefreshDependencies: {
        refreshToken: async () => refreshed(freshAccess, "entitlement-refresh-2", "fresh-entitlement-account"),
      },
    });

    expect(seenAuthorization).toBe(`Bearer ${freshAccess}`);
    expect([...entitledCodexAccountIdsForModel(snapshot, NATIVE_DAYBREAK_BLUE_MODEL)!]).toEqual([MAIN_CODEX_ACCOUNT_ID]);
  });

  test("marks the main account for reauthentication when the refresh grant is revoked", async () => {
    writeAuth({
      access_token: jwt("expired-revoked", -3_600),
      refresh_token: "revoked-refresh",
      account_id: "main-account",
    });

    await expect(getValidMainAccountToken({
      dependencies: {
        refreshToken: async () => {
          throw new TokenRefreshError("revoked", "revoked");
        },
      },
    })).rejects.toBeInstanceOf(TokenRefreshError);
    expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(true);
  });

  test("marks the main account for reauthentication on structured OAuth invalid_grant", async () => {
    writeAuth({
      access_token: jwt("expired-structured-revoked", -3_600),
      refresh_token: "structured-revoked-refresh",
      account_id: "main-account",
    });

    await expect(getValidMainAccountToken({
      dependencies: {
        refreshToken: async () => {
          throw new ChatGPTTokenRefreshError(
            400,
            "invalid_grant",
            "refresh token revoked",
            "ChatGPT refresh failed: 400 invalid_grant: refresh token revoked",
          );
        },
      },
    })).rejects.toBeInstanceOf(TokenRefreshError);
    expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(true);
  });

  test("does not mark the main account for reauthentication when native refresh fails transiently", async () => {
    writeAuth({
      access_token: jwt("expired-transient", -3_600),
      refresh_token: "transient-refresh",
      account_id: "main-account",
    });

    await expect(resolveCodexAuthContext(new Headers(), mainOnlyConfig(), "pool", {
      nativeMainRefreshDependencies: {
        refreshToken: async () => {
          throw new TokenRefreshError("unknown", "transient");
        },
      },
    })).rejects.toThrow();
    expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
  });

  test("does not mark the main account for reauthentication from generic expired transport errors", async () => {
    writeAuth({
      access_token: jwt("expired-generic-error", -3_600),
      refresh_token: "generic-error-refresh",
      account_id: "main-account",
    });

    await expect(resolveCodexAuthContext(new Headers(), mainOnlyConfig(), "pool", {
      nativeMainRefreshDependencies: {
        refreshToken: async () => {
          throw new Error("TLS certificate expired while refreshing token");
        },
      },
    })).rejects.toThrow();
    expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
  });

  test("passes native refresh dependencies into account-gated auth-context entitlement discovery", async () => {
    const expiredAccess = jwt("expired-auth-context-entitlement", -3_600);
    const freshAccess = jwt("fresh-auth-context-entitlement", 3_600, "entitled-main-account");
    const signal = new AbortController().signal;
    let seenOptions: Pick<
      CodexModelEntitlementResolveOptions,
      "nativeMainRefreshDependencies" | "signal"
    > | undefined;
    writeAuth({
      access_token: expiredAccess,
      refresh_token: "auth-context-entitlement-refresh",
      account_id: "main-account",
    });

    const ctx = await resolveCodexAuthContext(new Headers(), mainOnlyConfig(), "pool", {
      modelId: NATIVE_DAYBREAK_BLUE_MODEL,
      signal,
      nativeMainRefreshDependencies: {
        refreshToken: async () => refreshed(freshAccess, "auth-context-entitlement-refresh-2", "entitled-main-account"),
      },
      resolveCodexModelEntitlements: async (_config, options) => {
        seenOptions = options;
        const token = await getValidMainAccountToken({
          dependencies: options?.nativeMainRefreshDependencies,
          signal: options?.signal,
        });
        expect(token).toEqual({ accessToken: freshAccess, chatgptAccountId: "entitled-main-account" });
        return {
          modelsByAccount: new Map([[MAIN_CODEX_ACCOUNT_ID, new Set([NATIVE_DAYBREAK_BLUE_MODEL])]]),
          confirmedAccountIds: new Set([MAIN_CODEX_ACCOUNT_ID]),
          credentialIdentities: new Map([[MAIN_CODEX_ACCOUNT_ID, "main:entitled-main-account"]]),
        };
      },
    });

    expect(seenOptions?.signal).toBe(signal);
    expect(seenOptions?.nativeMainRefreshDependencies).toBeDefined();
    expect(ctx).toMatchObject({
      kind: "main-pool",
      accountId: MAIN_CODEX_ACCOUNT_ID,
      accessToken: freshAccess,
      chatgptAccountId: "entitled-main-account",
    });
  });
});
