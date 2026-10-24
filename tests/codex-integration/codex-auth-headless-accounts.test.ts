import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCodexAccountCredential, saveCodexAccountCredential } from "../../src/codex/account-store";
import { resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { clearAccountNeedsReauth, isAccountNeedsReauth, markAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import type { CodexAuthAccountDto } from "../../src/codex/auth-api/account-list";
import { withNativeMainCredentialClaim } from "../../src/codex/auth-api/http";
import { handleCodexAuthAPI } from "../../src/codex/auth-api/routes";
import * as codexHome from "../../src/codex/home";
import {
  captureMainAccountIdentityGeneration, clearMainAccountInfoCache,
  getMainAccountCredentialPresence, getMainAccountInfoCache,
} from "../../src/codex/main-account-cache";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import { getCodexHome } from "../../src/codex/paths";
import { clearAccountQuota } from "../../src/codex/quota";
import { resetQuotaQueryBackoffForTests } from "../../src/codex/quota-query-backoff";
import { resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root: string;
let nativeHome: string;
let previousOcxHome: string | undefined;
let previousCodexHome: string | undefined;
let defaultHomeSpy: { mockRestore(): void } | undefined;
let originalFetch: typeof fetch;
const poolId = "headless-pool";
const originalDefaultCodexHome = codexHome.defaultCodexHome;

function isolateDefaultHome(userHome: string): void {
  // Keep real filesystem resolution while excluding unrelated Windows homes on WSL.
  defaultHomeSpy = spyOn(codexHome, "defaultCodexHome").mockImplementation(() => originalDefaultCodexHome({
    homedir: () => userHome, env: {}, procVersion: "", release: "",
  }));
}

function config(codexIntegration = false): OcxConfig {
  return {
    port: 10100, defaultProvider: "openai", providers: {},
    clientIntegrations: { codex: codexIntegration },
    codexAccounts: [{ id: poolId, email: "pool@example.test", plan: "plus", isMain: false }],
  };
}

function savePool() {
  saveCodexAccountCredential(poolId, {
    accessToken: "fixture-pool-access", refreshToken: "fixture-pool-refresh",
    chatgptAccountId: "fixture-pool-identity", expiresAt: Date.now() + 3_600_000,
  });
  return getCodexAccountCredential(poolId);
}

function usageResponse(): Response {
  return Response.json({
    plan_type: "plus",
    rate_limit: { primary_window: { used_percent: 17, limit_window_seconds: 18_000 } },
  });
}

async function listAccounts(cfg: OcxConfig, method = "GET", suffix = "") {
  const url = new URL(`http://localhost/api/codex-auth/accounts${suffix}`);
  const response = await handleCodexAuthAPI(new Request(url, { method }), url, cfg);
  expect(response?.status).toBe(200);
  return (await response!.json() as { accounts: CodexAuthAccountDto[] }).accounts;
}

function resetRuntimeState() {
  clearMainAccountInfoCache();
  clearAccountQuota();
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  clearAccountNeedsReauth(poolId);
  resetMainCodexAccountIdentityTrackingForTests();
  resetQuotaQueryBackoffForTests();
  resetLifecycleDrainStateForTests();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-headless-accounts-"));
  nativeHome = join(root, "missing-codex-home");
  previousOcxHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = join(root, "ocx");
  process.env.CODEX_HOME = nativeHome;
  mkdirSync(process.env.OPENCODEX_HOME);
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://chatgpt.com" || !url.pathname.endsWith("/wham/usage")) {
      throw new Error("unexpected fixture network request");
    }
    return usageResponse();
  }) as typeof fetch;
  resetRuntimeState();
});

afterEach(() => {
  defaultHomeSpy?.mockRestore();
  defaultHomeSpy = undefined;
  globalThis.fetch = originalFetch;
  resetRuntimeState();
  if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOcxHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(root);
});

describe("account listing without a native Codex home", () => {
  for (const integration of [false, true]) {
    for (const [method, suffix] of [["GET", ""], ["GET", "?refresh=1"], ["POST", "/refresh"]]) {
      test(`${method} accounts${suffix}, integration=${integration}: stored pool remains available`, async () => {
        const credential = savePool();
        const accounts = await listAccounts(config(integration), method, suffix);
        expect(accounts).toHaveLength(2);
        expect(accounts.find(account => account.id === poolId)).toMatchObject({
          hasCredential: true, needsReauth: false, plan: "plus", quota: { shortPercent: 17 },
        });
        expect(accounts.find(account => account.id === MAIN_CODEX_ACCOUNT_ID)).toMatchObject({
          hasCredential: false, needsReauth: false, quota: null,
        });
        expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
        expect(getCodexAccountCredential(poolId)).toEqual(credential);
        expect(existsSync(nativeHome)).toBe(false);
      });
    }
  }

  test("an explicit non-directory CODEX_HOME still refuses account listing", async () => {
    writeFileSync(nativeHome, "fixture-not-a-directory");
    const credential = savePool();
    await expect(listAccounts(config())).rejects.toThrow("not a directory");
    expect(getCodexAccountCredential(poolId)).toEqual(credential);
    expect(readFileSync(nativeHome, "utf8")).toBe("fixture-not-a-directory");
  });

  for (const [method, suffix] of [["GET", ""], ["GET", "?refresh=1"], ["POST", "/refresh"]]) {
    for (const kind of ["missing", "file", "dangling-link"] as const) {
      test(`${method} accounts${suffix}: default home ${kind} only tolerates proven absence`, async () => {
        const userHome = join(root, "user");
        mkdirSync(userHome);
        isolateDefaultHome(userHome);
        delete process.env.CODEX_HOME;
        nativeHome = join(userHome, ".codex");
        if (kind === "file") writeFileSync(nativeHome, "fixture-not-a-directory");
        if (kind === "dangling-link") symlinkSync(join(root, "missing-target"), nativeHome, "junction");
        expect(getCodexHome()).toBe(nativeHome);
        const credential = savePool();

        if (kind === "missing") {
          const accounts = await listAccounts(config(), method, suffix);
          expect(accounts.find(account => account.id === poolId)?.hasCredential).toBe(true);
          expect(existsSync(nativeHome)).toBe(false);
        } else {
          await expect(listAccounts(config(), method, suffix)).rejects.toMatchObject({ code: "CODEX_HOME_UNAVAILABLE" });
          if (kind === "file") expect(readFileSync(nativeHome, "utf8")).toBe("fixture-not-a-directory");
          else expect(lstatSync(nativeHome).isSymbolicLink()).toBe(true);
        }
        expect(getCodexAccountCredential(poolId)).toEqual(credential);
        expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
      });
    }
  }

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an inaccessible default home is not treated as absent", async () => {
    const userHome = join(root, "unreadable-user");
    mkdirSync(userHome);
    nativeHome = join(userHome, ".codex");
    mkdirSync(nativeHome);
    isolateDefaultHome(userHome);
    delete process.env.CODEX_HOME;
    const credential = savePool();
    chmodSync(userHome, 0o000);
    try {
      expect(getCodexHome()).toBe(nativeHome);
      await expect(listAccounts(config())).rejects.toMatchObject({ code: "CODEX_HOME_UNAVAILABLE" });
      expect(getCodexAccountCredential(poolId)).toEqual(credential);
      expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
    } finally {
      chmodSync(userHome, 0o700);
    }
  });

  test("a home removed during pool refresh does not fail final account projection", async () => {
    mkdirSync(nativeHome);
    savePool();
    globalThis.fetch = (async () => {
      removeTreeWithRetry(nativeHome);
      return usageResponse();
    }) as typeof fetch;
    const accounts = await listAccounts(config());
    expect(accounts.find(account => account.id === poolId)).toMatchObject({
      hasCredential: true, needsReauth: false, quota: { shortPercent: 17 },
    });
    expect(existsSync(nativeHome)).toBe(false);
  });

  test("disabled client integration still observes an existing native login", async () => {
    mkdirSync(nativeHome);
    const auth = JSON.stringify({ tokens: {
      access_token: "fixture-main-access", account_id: "fixture-main-identity",
    } });
    writeFileSync(join(nativeHome, "auth.json"), auth);
    savePool();
    const accounts = await listAccounts(config());
    expect(accounts.find(account => account.id === MAIN_CODEX_ACCOUNT_ID)).toMatchObject({
      hasCredential: true, needsReauth: false, plan: "plus", quota: { shortPercent: 17 },
    });
    expect(readFileSync(join(nativeHome, "auth.json"), "utf8")).toBe(auth);
  });

  test("a missing home preserves previously observed identity and reauth state", async () => {
    mkdirSync(nativeHome);
    writeFileSync(join(nativeHome, "auth.json"), JSON.stringify({ tokens: {
      access_token: "fixture-main-access", account_id: "fixture-main-identity",
    } }));
    savePool();
    await listAccounts(config());
    markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    const generation = captureMainAccountIdentityGeneration();
    const info = getMainAccountInfoCache();
    expect(info?.quota?.shortPercent).toBe(17);
    expect(getMainAccountCredentialPresence()).toBe(true);
    removeTreeWithRetry(nativeHome);

    const accounts = await listAccounts(config(), "GET", "?refresh=1");
    expect(accounts.find(account => account.id === MAIN_CODEX_ACCOUNT_ID)).toMatchObject({
      hasCredential: true, needsReauth: true, quota: null,
    });
    expect(accounts.find(account => account.id === poolId)).toMatchObject({
      hasCredential: true, needsReauth: false, quota: { shortPercent: 17 },
    });
    expect(captureMainAccountIdentityGeneration()).toBe(generation);
    expect(getMainAccountInfoCache()).toEqual(info);
    expect(getMainAccountCredentialPresence()).toBe(true);
    expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(true);
    expect(existsSync(nativeHome)).toBe(false);
  });

  for (const homeExists of [true, false]) {
    test(`an unsafe OpenCodex storage root refuses account listing, native home exists=${homeExists}`, async () => {
      if (homeExists) mkdirSync(nativeHome);
      const unsafeRoot = join(root, "not-a-config-directory");
      writeFileSync(unsafeRoot, "fixture-unsafe-root");
      process.env.OPENCODEX_HOME = unsafeRoot;
      await expect(listAccounts(config())).rejects.toMatchObject({ code: "PROFILE_STORAGE_UNSAFE" });
      expect(readFileSync(unsafeRoot, "utf8")).toBe("fixture-unsafe-root");
      expect(existsSync(nativeHome)).toBe(homeExists);
    });
  }

  test("a home removed during refresh does not hide an unsafe storage root at projection", async () => {
    mkdirSync(nativeHome);
    savePool();
    const unsafeRoot = join(root, "not-a-config-directory");
    writeFileSync(unsafeRoot, "fixture-unsafe-root");
    globalThis.fetch = (async () => {
      removeTreeWithRetry(nativeHome);
      process.env.OPENCODEX_HOME = unsafeRoot;
      return usageResponse();
    }) as typeof fetch;
    await expect(listAccounts(config())).rejects.toMatchObject({ code: "PROFILE_STORAGE_UNSAFE" });
    expect(readFileSync(unsafeRoot, "utf8")).toBe("fixture-unsafe-root");
    expect(existsSync(nativeHome)).toBe(false);
  });

  test("credential operations still refuse a missing native home before executing", async () => {
    const mutationPath = join(root, "must-not-be-written");
    await expect((async () => withNativeMainCredentialClaim(async () => {
      writeFileSync(mutationPath, "unexpected mutation");
    }))()).rejects.toMatchObject({ code: "CODEX_HOME_UNAVAILABLE" });
    expect(existsSync(mutationPath)).toBe(false);
    expect(existsSync(nativeHome)).toBe(false);
  });
});
