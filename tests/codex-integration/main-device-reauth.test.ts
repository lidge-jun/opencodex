import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelMainDeviceReauth,
  getMainDeviceReauthStatus,
  MainDeviceReauthFlowBusyError,
  resetMainDeviceReauthForTests,
  startMainDeviceReauth,
  type MainDeviceReauthStatus,
} from "../../src/codex/main-device-reauth";
import {
  beginNativeMainReauth,
  MainAuthJsonChangedDuringRefreshError,
  NativeMainReauthIdentityMismatchError,
  NativeMainReauthUnavailableError,
  setMainAuthJsonBeforeRenameHookForTests,
} from "../../src/codex/main-account";
import type { NativeDeviceLogin } from "../../src/oauth/chatgpt-device";
import type { OAuthController } from "../../src/oauth/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * #3898: the headless-hub native-main device reauth. One process-owned flow,
 * same-identity fenced commit, and a DTO that can never carry tokens.
 */

function grant(accountId = "acct-main-1"): NativeDeviceLogin {
  return {
    credential: {
      access: "new-access-token",
      refresh: "new-refresh-token",
      expires: Date.now() + 3600_000,
      accountId,
    } as NativeDeviceLogin["credential"],
    idToken: "new-id-token",
  };
}

function loginStub(
  behavior: (ctrl: OAuthController) => Promise<NativeDeviceLogin>,
): (ctrl: OAuthController) => Promise<NativeDeviceLogin> {
  return behavior;
}

async function waitForTerminal(flowId: string, timeoutMs = 2_000): Promise<MainDeviceReauthStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = getMainDeviceReauthStatus(flowId);
    if (status && status.status !== "pending" && status.status !== "committing") return status;
    if (Date.now() > deadline) throw new Error(`flow ${flowId} never settled: ${JSON.stringify(status)}`);
    await Bun.sleep(5);
  }
}

beforeEach(() => resetMainDeviceReauthForTests());
afterEach(() => resetMainDeviceReauthForTests());

describe("native main device reauth flow (#3898)", () => {
  test("start publishes the verification URL and human code, then succeeds", async () => {
    const started = startMainDeviceReauth({
      login: loginStub(async ctrl => {
        ctrl.onAuth?.({ url: "https://auth.openai.com/codex/device", deviceCode: "ABCD-1234" });
        return grant();
      }),
      beginCommit: () => ({ commit: async () => ({ chatgptAccountId: "acct-main-1" }) }),
    });
    expect(started.status).toBe("pending");
    const pending = getMainDeviceReauthStatus(started.flowId);
    expect(pending).toMatchObject({ status: "pending", deviceCode: "ABCD-1234" });
    expect((pending as { verificationUrl?: string }).verificationUrl).toContain("codex/device");
    const terminal = await waitForTerminal(started.flowId);
    expect(terminal).toMatchObject({ status: "succeeded", credentialUpdated: true });
  });

  test("a second start while active is refused", () => {
    let release!: (value: NativeDeviceLogin) => void;
    const gate = new Promise<NativeDeviceLogin>(resolve => { release = resolve; });
    startMainDeviceReauth({
      login: loginStub(() => gate),
      beginCommit: () => ({ commit: async () => ({ chatgptAccountId: "acct-main-1" }) }),
    });
    expect(() => startMainDeviceReauth({
      login: loginStub(async () => grant()),
      beginCommit: () => ({ commit: async () => ({ chatgptAccountId: "acct-main-1" }) }),
    })).toThrow(MainDeviceReauthFlowBusyError);
    release(grant());
  });

  test("identity mismatch fails without touching the credential", async () => {
    const started = startMainDeviceReauth({
      login: loginStub(async () => grant("acct-OTHER")),
      beginCommit: () => ({
        commit: async () => { throw new NativeMainReauthIdentityMismatchError(); },
      }),
    });
    const terminal = await waitForTerminal(started.flowId);
    expect(terminal).toMatchObject({ status: "failed", code: "identity_mismatch" });
    expect((terminal as { credentialUpdated?: boolean }).credentialUpdated).toBeUndefined();
  });

  test("a cancelled flow cannot publish a late grant", async () => {
    let release!: (value: NativeDeviceLogin) => void;
    const gate = new Promise<NativeDeviceLogin>(resolve => { release = resolve; });
    let commitCalled = false;
    const started = startMainDeviceReauth({
      login: loginStub(() => gate),
      beginCommit: () => ({ commit: async () => { commitCalled = true; return { chatgptAccountId: "acct-main-1" }; } }),
    });
    const cancelled = cancelMainDeviceReauth(started.flowId);
    expect(cancelled).toMatchObject({ status: "cancelled" });
    release(grant());
    await Bun.sleep(20);
    expect(getMainDeviceReauthStatus(started.flowId)).toMatchObject({ status: "cancelled" });
    expect(commitCalled).toBe(false);
  });

  test("a cancel landing as the grant resolves skips the commit entirely", async () => {
    let commitCalled = false;
    const started = startMainDeviceReauth({
      flowId: () => "flow-cancel-at-resolve",
      login: loginStub(async () => {
        // The cancel lands after the grant exists but before the commit
        // window: the write must not happen.
        cancelMainDeviceReauth("flow-cancel-at-resolve");
        return grant();
      }),
      beginCommit: () => ({
        commit: async () => { commitCalled = true; return { chatgptAccountId: "acct-main-1" }; },
      }),
    });
    await Bun.sleep(20);
    expect(getMainDeviceReauthStatus(started.flowId)).toMatchObject({ status: "cancelled" });
    expect(commitCalled).toBe(false);
  });

  test("a commit already in flight publishes; the cancel loses", async () => {
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>(resolve => { releaseCommit = resolve; });
    const started = startMainDeviceReauth({
      login: loginStub(async () => grant()),
      beginCommit: () => ({
        commit: async () => { await commitGate; return { chatgptAccountId: "acct-main-1" }; },
      }),
    });
    // Wait until the flow is committing, then cancel; the publication wins.
    const deadline = Date.now() + 2_000;
    while (getMainDeviceReauthStatus(started.flowId)?.status !== "committing") {
      if (Date.now() > deadline) throw new Error("flow never reached committing");
      await Bun.sleep(5);
    }
    cancelMainDeviceReauth(started.flowId);
    releaseCommit();
    // Publication beats the racing cancellation — but the flip lands when the
    // commit resolves, so a transient cancelled read is allowed between the
    // cancel and the commit's return.
    let terminal: MainDeviceReauthStatus | null = null;
    const settleDeadline = Date.now() + 2_000;
    while (Date.now() < settleDeadline) {
      terminal = getMainDeviceReauthStatus(started.flowId);
      if (terminal?.status === "succeeded") break;
      await Bun.sleep(5);
    }
    expect(terminal).toMatchObject({ status: "succeeded", credentialUpdated: true });
  });

  test("cancellation after publication returns succeeded, never cancelled", async () => {
    const started = startMainDeviceReauth({
      login: loginStub(async ctrl => {
        ctrl.onAuth?.({ url: "https://auth.openai.com/codex/device", deviceCode: "WXYZ-9999" });
        return grant();
      }),
      beginCommit: () => ({ commit: async () => ({ chatgptAccountId: "acct-main-1" }) }),
    });
    await waitForTerminal(started.flowId);
    expect(cancelMainDeviceReauth(started.flowId)).toMatchObject({ status: "succeeded" });
  });

  test("claim-unavailable maps to native_main_unavailable", async () => {
    const started = startMainDeviceReauth({
      login: loginStub(async () => grant()),
      beginCommit: () => ({
        commit: async () => {
          const error = new Error("claim held elsewhere") as Error & { code: string };
          error.code = "NATIVE_MAIN_CLAIM_UNAVAILABLE";
          throw error;
        },
      }),
    });
    expect(await waitForTerminal(started.flowId)).toMatchObject({
      status: "failed",
      code: "native_main_unavailable",
    });
  });

  test("device authorization failures map to device_authorization_failed", async () => {
    const started = startMainDeviceReauth({
      login: loginStub(async () => { throw new Error("ChatGPT device authorization poll failed: HTTP 500"); }),
      beginCommit: () => ({ commit: async () => ({ chatgptAccountId: "acct-main-1" }) }),
    });
    expect(await waitForTerminal(started.flowId)).toMatchObject({
      status: "failed",
      code: "device_authorization_failed",
    });
  });

  test("no DTO ever carries token material", async () => {
    const started = startMainDeviceReauth({
      login: loginStub(async ctrl => {
        ctrl.onAuth?.({ url: "https://auth.openai.com/codex/device", deviceCode: "ABCD-1234" });
        return grant();
      }),
      beginCommit: () => ({ commit: async () => ({ chatgptAccountId: "acct-main-1" }) }),
    });
    const terminal = await waitForTerminal(started.flowId);
    for (const dto of [started, getMainDeviceReauthStatus(started.flowId), terminal]) {
      const json = JSON.stringify(dto);
      expect(json).not.toContain("new-access-token");
      expect(json).not.toContain("new-refresh-token");
      expect(json).not.toContain("new-id-token");
      expect(json).not.toContain("acct-main-1");
    }
  });
});

describe("beginNativeMainReauth commit (#3898)", () => {
  let home: string;
  let previousCodexHome: string | undefined;
  let authPath: string;

  const original = {
    auth_mode: "chatgpt",
    tokens: {
      access_token: "old-access",
      refresh_token: "old-refresh",
      id_token: "old-id-token",
      account_id: "acct-main-1",
      future_token_field: "preserve-token",
    },
    future_root_field: { preserve: true },
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-main-reauth-"));
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    authPath = join(home, "auth.json");
    writeFileSync(authPath, JSON.stringify(original));
  });

  afterEach(() => {
    setMainAuthJsonBeforeRenameHookForTests(null);
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    removeTreeWithRetry(home);
  });

  function readTokens(): Record<string, unknown> {
    return (JSON.parse(readFileSync(authPath, "utf8")) as { tokens: Record<string, unknown> }).tokens;
  }

  test("same-identity commit writes all four token fields and preserves metadata", async () => {
    const prepared = beginNativeMainReauth();
    const result = await prepared.commit({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      idToken: "new-id-token",
      chatgptAccountId: "acct-main-1",
    });
    expect(result.chatgptAccountId).toBe("acct-main-1");
    const tokens = readTokens();
    expect(tokens.access_token).toBe("new-access");
    expect(tokens.refresh_token).toBe("new-refresh");
    expect(tokens.id_token).toBe("new-id-token");
    expect(tokens.account_id).toBe("acct-main-1");
    expect(tokens.future_token_field).toBe("preserve-token");
    expect(JSON.parse(readFileSync(authPath, "utf8")).future_root_field).toEqual({ preserve: true });
  });

  test("a different account identity is refused and the file is untouched", async () => {
    const before = readFileSync(authPath, "utf8");
    const prepared = beginNativeMainReauth();
    await expect(prepared.commit({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      idToken: "new-id-token",
      chatgptAccountId: "acct-someone-else",
    })).rejects.toThrow(NativeMainReauthIdentityMismatchError);
    expect(readFileSync(authPath, "utf8")).toBe(before);
  });

  test("an incomplete token set is refused before any claim work", async () => {
    const before = readFileSync(authPath, "utf8");
    const prepared = beginNativeMainReauth();
    await expect(prepared.commit({
      accessToken: "new-access",
      refreshToken: "",
      idToken: "new-id-token",
      chatgptAccountId: "acct-main-1",
    })).rejects.toThrow(NativeMainReauthUnavailableError);
    expect(readFileSync(authPath, "utf8")).toBe(before);
  });

  test("a concurrent writer during publish fails the commit closed", async () => {
    const before = readFileSync(authPath, "utf8");
    setMainAuthJsonBeforeRenameHookForTests(() => {
      writeFileSync(authPath, JSON.stringify({ tokens: { refresh_token: "foreign-writer" } }));
    });
    const prepared = beginNativeMainReauth();
    await expect(prepared.commit({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      idToken: "new-id-token",
      chatgptAccountId: "acct-main-1",
    })).rejects.toThrow(MainAuthJsonChangedDuringRefreshError);
    expect(readFileSync(authPath, "utf8")).not.toBe(before);
    expect(readTokens().refresh_token).toBe("foreign-writer");
  });

  test("preparation without an existing credential fails fast", () => {
    removeTreeWithRetry(home);
    home = mkdtempSync(join(tmpdir(), "ocx-main-reauth-empty-"));
    process.env.CODEX_HOME = home;
    expect(() => beginNativeMainReauth()).toThrow(NativeMainReauthUnavailableError);
  });
});
