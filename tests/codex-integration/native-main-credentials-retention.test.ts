import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginNativeMainReauth,
  getMainAccountCredentialStatus,
  getValidMainAccountToken,
  MAIN_CODEX_ACCOUNT_ID,
  NativeMainReauthUnavailableError,
} from "../../src/codex/main-account";
import {
  beginNativeMainObservation,
  classifyNativeMainAuthText,
  invalidateRetainedNativeMainLogin,
  lastNativeMainRetentionInvalidationForTests,
  resetNativeMainRetentionForTests,
  retainNativeMainLogin,
  retainedNativeMainLogin,
} from "../../src/codex/native-main-credentials";
import {
  resolveNativeMainRefreshMode,
  setNativeMainRefreshResolutionForTests,
  type NativeMainRefreshResolution,
} from "../../src/codex/native-main-refresh-mode";
import { setCodexAccountPaused } from "../../src/codex/account-pause";
import { clearAccountNeedsReauth, markAccountNeedsReauth, markMainRefreshGrantRejected } from "../../src/codex/account-runtime-state";
import { retainNativeMainOwner } from "../../src/codex/native-main-owner";
import { resolveNativeProfileContext } from "../../src/codex/native-profile-store";
import { loadConfig, saveConfig } from "../../src/config";
import { advanceCodexCredentialMutationEpoch } from "../../src/codex/credential-mutation-epoch";
import { fakeChatGptJwt } from "../helpers/agent-task-recovery";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

/**
 * #7345, owner's second contract: the last complete, same-owner native-main login is kept only
 * while the login file is empty or partially written. Absence, explicit no-login, account
 * replacement, pause/revocation, a refresh-owner change and ownership loss end it regardless of
 * time, and an expired retained token still goes to the selected refresh owner.
 */

const OPENCODEX_MODE: NativeMainRefreshResolution = { mode: "opencodex", configured: "opencodex", reason: "configured-opencodex" };
const CODEX_MODE: NativeMainRefreshResolution = {
  mode: "codex", configured: "auto", reason: "codex-compatible", command: "/fake/codex", version: "0.162.1",
};

let root: string;
let home: string;
let authPath: string;
let previousCodexHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-native-retention-"));
  home = join(root, "codex-home");
  mkdirSync(home);
  authPath = join(home, "auth.json");
  previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  setNativeMainRefreshResolutionForTests(OPENCODEX_MODE);
  resetNativeMainRetentionForTests();
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
});

afterEach(() => {
  setNativeMainRefreshResolutionForTests(null);
  resetNativeMainRetentionForTests();
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(root);
});

function login(account: string, options: { expired?: boolean; refresh?: string } = {}): { raw: string; access: string } {
  const access = fakeChatGptJwt(account, options.expired ? { exp: Math.floor(Date.now() / 1000) - 60 } : {});
  const raw = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: access, ...(options.refresh ? { refresh_token: options.refresh } : {}), account_id: account },
  }, null, 2) + "\n";
  return { raw, access };
}

/** In-place rewrite, the way Codex writes: same inode, new bytes. */
function writeInPlace(text: string): void {
  writeFileSync(authPath, text, { flag: "w" });
}

function fileIdentity(path: string) {
  const stat = statSync(path, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
}

async function served(): Promise<string | null> {
  return (await getValidMainAccountToken())?.accessToken ?? null;
}

describe("native-main login retention (#7345)", () => {
  test("truncate then restore: the in-place rewrite window keeps the last complete login", async () => {
    const a = login("acct-a");
    writeInPlace(a.raw);
    expect(await served()).toBe(a.access);

    writeInPlace("");
    expect(await served()).toBe(a.access);
    expect(getMainAccountCredentialStatus().usable).toBe(true);
    writeInPlace(a.raw.slice(0, 40));
    expect(await served()).toBe(a.access);

    const restored = login("acct-a");
    writeInPlace(restored.raw);
    expect(await served()).toBe(restored.access);
  });

  test("delete then a different account: absence ends retention before the new login is readable", async () => {
    const a = login("acct-a");
    writeInPlace(a.raw);
    expect(await served()).toBe(a.access);

    rmSync(authPath);
    expect(await served()).toBeNull();
    expect(lastNativeMainRetentionInvalidationForTests()).toBe("missing");
    const b = login("acct-b");
    writeInPlace(b.raw.slice(0, 30));
    expect(await served()).toBeNull();
    writeInPlace(b.raw);
    expect(await served()).toBe(b.access);
  });

  test("a replaced file identity is another login even when the removal was never observed", async () => {
    const a = login("acct-a");
    writeInPlace(a.raw);
    expect(await served()).toBe(a.access);
    // Keep the old inode alive so the new file cannot reuse its number.
    renameSync(authPath, join(home, "auth.json.old"));
    writeInPlace(login("acct-b").raw.slice(0, 30));
    expect(await served()).toBeNull();
    expect(lastNativeMainRetentionInvalidationForTests()).toBe("account-replacement");
  });

  test("an authoritative logout during the rewrite window ends retention for good", async () => {
    const a = login("acct-a");
    writeInPlace(a.raw);
    expect(await served()).toBe(a.access);
    writeInPlace("");
    expect(await served()).toBe(a.access);

    writeInPlace(JSON.stringify({ auth_mode: "chatgpt", tokens: null }));
    expect(await served()).toBeNull();
    expect(lastNativeMainRetentionInvalidationForTests()).toBe("logout");
    writeInPlace("");
    expect(await served()).toBeNull();
    expect(getMainAccountCredentialStatus().usable).toBe(false);
  });

  test("repeated partial writes keep the same login, and a completed different login replaces it", async () => {
    const a = login("acct-a");
    writeInPlace(a.raw);
    expect(await served()).toBe(a.access);
    for (const cut of [0, 1, 12, 33, 71, a.raw.length - 2]) {
      writeInPlace(a.raw.slice(0, cut));
      expect(await served()).toBe(a.access);
    }
    const b = login("acct-b");
    writeInPlace(b.raw);
    expect(await served()).toBe(b.access);
    writeInPlace(b.raw.slice(0, 20));
    expect(await served()).toBe(b.access);
  });

  test("pausing the main account ends retention and resuming does not revive it", async () => {
    const a = login("acct-a");
    writeInPlace(a.raw);
    expect(await served()).toBe(a.access);
    writeInPlace("");
    expect(await served()).toBe(a.access);

    const config = { providers: {} } as unknown as OcxConfig;
    setCodexAccountPaused(config, MAIN_CODEX_ACCOUNT_ID, true);
    expect(await served()).toBeNull();
    expect(lastNativeMainRetentionInvalidationForTests()).toBe("pause");
    setCodexAccountPaused(config, MAIN_CODEX_ACCOUNT_ID, false);
    expect(await served()).toBeNull();
  });

  test("a revoked main credential ends retention", async () => {
    const a = login("acct-a");
    writeInPlace(a.raw);
    expect(await served()).toBe(a.access);
    writeInPlace("");
    markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    expect(await served()).toBeNull();
    expect(lastNativeMainRetentionInvalidationForTests()).toBe("revocation");
    clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    expect(await served()).toBeNull();
  });

  test("another OpenCodex credential publication counts as account replacement", async () => {
    const a = login("acct-a");
    writeInPlace(a.raw);
    expect(await served()).toBe(a.access);
    writeInPlace("");
    advanceCodexCredentialMutationEpoch();
    expect(await served()).toBeNull();
    expect(lastNativeMainRetentionInvalidationForTests()).toBe("account-replacement");
  });

  test("a refresh-owner change ends retention", async () => {
    const a = login("acct-a", { refresh: "grant-a" });
    writeInPlace(a.raw);
    await resolveNativeMainRefreshMode({});
    expect(getMainAccountCredentialStatus().usable).toBe(true);
    writeInPlace("");
    expect(getMainAccountCredentialStatus().usable).toBe(true);

    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    await resolveNativeMainRefreshMode({});
    expect(lastNativeMainRetentionInvalidationForTests()).toBe("refresh-mode-change");
    expect(getMainAccountCredentialStatus().usable).toBe(false);
  });

  test("a refresh that completes after ownership loss does not repopulate retention", async () => {
    const a = login("acct-a", { expired: true, refresh: "grant-a" });
    writeInPlace(a.raw);
    const b = fakeChatGptJwt("acct-a");
    const result = await getValidMainAccountToken({
      refreshToken: async () => {
        invalidateRetainedNativeMainLogin("ownership-loss");
        return { access: b, refresh: "grant-a2", expires: Date.now() + 3_600_000, accountId: "acct-a" } as never;
      },
    });
    expect(result?.accessToken).toBe(b);
    writeInPlace("");
    expect(getMainAccountCredentialStatus().usable).toBe(false);
    expect(await served()).toBeNull();
  });

  test("a refresh that completes under the same owner retains the published login", async () => {
    const a = login("acct-a", { expired: true, refresh: "grant-a" });
    writeInPlace(a.raw);
    const b = fakeChatGptJwt("acct-a");
    const result = await getValidMainAccountToken({
      refreshToken: async () => ({ access: b, refresh: "grant-a2", expires: Date.now() + 3_600_000, accountId: "acct-a" } as never),
    });
    expect(result?.accessToken).toBe(b);
    writeInPlace("");
    expect(await served()).toBe(b);
  });

  test("a stale observation ticket cannot retain after ownership loss", () => {
    writeInPlace(login("acct-a").raw);
    const owner = { codexHome: home, path: authPath };
    const identity = fileIdentity(authPath);
    const options = { fingerprint: "a", configuredRefreshMode: () => "auto" };
    const ticket = beginNativeMainObservation();
    invalidateRetainedNativeMainLogin("ownership-loss");
    expect(retainNativeMainLogin(ticket, owner, identity, { token: "a" }, options)).toBe(false);
    expect(retainedNativeMainLogin(owner, identity, () => "auto")).toBeUndefined();
    expect(retainNativeMainLogin(beginNativeMainObservation(), owner, identity, { token: "a" }, options)).toBe(true);
    expect(retainedNativeMainLogin(owner, identity, () => "auto")).toEqual({ token: "a" });
    expect(retainedNativeMainLogin({ codexHome: join(root, "other"), path: authPath }, identity, () => "auto")).toBeUndefined();
    expect(lastNativeMainRetentionInvalidationForTests()).toBe("ownership-loss");
  });

  test.skipIf(process.platform === "win32")("a reused inode number cannot revive a deleted login", () => {
    // Simulates ext4/XFS reuse: the path later reports the retained dev/ino, but the retained
    // file itself is gone. The held descriptor proves it is no longer linked.
    writeInPlace(login("acct-a").raw);
    const owner = { codexHome: home, path: authPath };
    const identity = fileIdentity(authPath);
    expect(retainNativeMainLogin(beginNativeMainObservation(), owner, identity, { token: "a" },
      { fingerprint: "a", configuredRefreshMode: () => "auto" })).toBe(true);
    rmSync(authPath);
    writeInPlace("");
    expect(fileIdentity(authPath)).not.toEqual(identity);
    expect(retainedNativeMainLogin(owner, identity, () => "auto")).toBeUndefined();
    expect(lastNativeMainRetentionInvalidationForTests()).toBe("account-replacement");
  });

  test("changing the configured refresh owner ends retention without a resolution", async () => {
    const a = login("acct-a");
    writeInPlace(a.raw);
    expect(await served()).toBe(a.access);
    writeInPlace("");
    expect(await served()).toBe(a.access);
    const config = loadConfig();
    saveConfig({ ...config, nativeMainRefresh: config.nativeMainRefresh === "codex" ? "opencodex" : "codex" });
    expect(getMainAccountCredentialStatus().usable).toBe(false);
    expect(lastNativeMainRetentionInvalidationForTests()).toBe("refresh-mode-change");
  });

  test("a rejected refresh grant ends retention", async () => {
    const a = login("acct-a");
    writeInPlace(a.raw);
    expect(await served()).toBe(a.access);
    writeInPlace("");
    markMainRefreshGrantRejected("unrelated-grant-key");
    expect(await served()).toBeNull();
    expect(lastNativeMainRetentionInvalidationForTests()).toBe("revocation");
  });

  test("releasing the held native-main owner lock ends retention", async () => {
    const owner = retainNativeMainOwner(resolveNativeProfileContext({ codexHome: home }), { retryMs: 10 });
    let released = false;
    try {
      for (let attempt = 0; attempt < 200 && owner.snapshot().status !== "held"; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(owner.snapshot().status).toBe("held");
      const a = login("acct-a");
      writeInPlace(a.raw);
      expect(await served()).toBe(a.access);
      writeInPlace("");
      expect(await served()).toBe(a.access);
      await owner.release();
      released = true;
      expect(lastNativeMainRetentionInvalidationForTests()).toBe("ownership-loss");
      expect(await served()).toBeNull();
    } finally {
      if (!released) await owner.release();
    }
  });

  test("an expired retained login is not reported usable during a rewrite", () => {
    writeInPlace(login("acct-a", { expired: true, refresh: "grant-a" }).raw);
    expect(getMainAccountCredentialStatus().usable).toBe(true);
    writeInPlace("");
    expect(getMainAccountCredentialStatus().usable).toBe(false);
  });

  test("an expired retained token follows the selected refresh owner", async () => {
    const a = login("acct-a", { expired: true, refresh: "grant-a" });
    writeInPlace(a.raw);
    expect(getMainAccountCredentialStatus().usable).toBe(true);
    writeInPlace("");
    // The guarded writer cannot refresh a file mid-rewrite; it reports no credential, as before.
    expect(await served()).toBeNull();

    // Codex owns the refresh: its own answer decides, not the retained copy.
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    const confirmed = fakeChatGptJwt("acct-a");
    const viaCodex = await getValidMainAccountToken({
      codexAuthStatus: async () => ({ authMethod: "chatgpt", authToken: confirmed, requiresOpenaiAuth: true }),
    });
    expect(viaCodex?.accessToken).toBe(confirmed);
  });

  test("a missing file is unavailable unless Codex confirms the login", async () => {
    const a = login("acct-a");
    writeInPlace(a.raw);
    expect(await served()).toBe(a.access);
    rmSync(authPath);
    expect(await served()).toBeNull();
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    const confirmed = fakeChatGptJwt("acct-a");
    expect((await getValidMainAccountToken({
      codexAuthStatus: async () => ({ authMethod: "chatgpt", authToken: confirmed, requiresOpenaiAuth: true }),
    }))?.accessToken).toBe(confirmed);
    expect((await getValidMainAccountToken({
      codexAuthStatus: async () => ({ authMethod: null, authToken: null, requiresOpenaiAuth: true }),
    }))).toBeNull();
  });

  test("write guards read the physical file, never the retained copy", async () => {
    const a = login("acct-a");
    writeInPlace(a.raw);
    expect(await served()).toBe(a.access);
    writeInPlace("");
    expect(() => beginNativeMainReauth()).toThrow(NativeMainReauthUnavailableError);
  });

  test("classification separates the rewrite window from authoritative states", () => {
    expect(classifyNativeMainAuthText("").kind).toBe("incomplete");
    expect(classifyNativeMainAuthText("  \n").kind).toBe("incomplete");
    expect(classifyNativeMainAuthText('{"tokens": {"access_tok').kind).toBe("incomplete");
    expect(classifyNativeMainAuthText('{"tokens": null}').kind).toBe("no-login");
    expect(classifyNativeMainAuthText('{"OPENAI_API_KEY": "sk-x"}').kind).toBe("no-login");
    expect(classifyNativeMainAuthText('{"tokens": {"access_token": "", "refresh_token": ""}}').kind).toBe("no-login");
    expect(classifyNativeMainAuthText('{"tokens": {"refresh_token": "r"}}').kind).toBe("complete");
  });
});
