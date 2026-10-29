import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nativeMainRefreshMode from "../../src/codex/native-main-refresh-mode";
import {
  CODEX_AUTH_STATUS_MIN_VERSION,
  CodexAuthStatusError,
  formatNativeMainRefreshDoctorLines,
  requestCodexAuthStatus,
  resolveNativeMainRefreshMode,
  setNativeMainRefreshResolutionForTests,
  type CodexAuthStatus,
  type NativeMainRefreshResolution,
} from "../../src/codex/native-main-refresh-mode";
import {
  forceRefreshMainAccountToken,
  getMainAccountCredentialStatus,
  getValidMainAccountToken,
  isMainAccountRefreshGrantRejected,
  MAIN_CODEX_ACCOUNT_ID,
  MainAuthJsonChangedDuringRefreshError,
  MainAccountTokenRefreshError,
} from "../../src/codex/main-account";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { NATIVE_GPT6_ASTRA_MINOR_MODEL } from "../../src/codex/catalog/native-models";
import { codexCredentialMutationEpoch } from "../../src/codex/credential-mutation-epoch";
import { resolveCodexAuthContext, materializeCodexUpstreamAuthAsync, CodexAuthContextError, CodexMainAccountHardLockError, CodexMainProfileDrainingError, CodexModelAvailabilityError, CodexPoolAuthenticationError } from "../../src/codex/auth-context";
import { applyConfirmedMainCodexAccountTransition, reconcileMainCodexAccountRuntimeState, resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { captureMainQuotaWriter, isMainQuotaDispatchLive, isMainQuotaWriterLive, matchesMainQuotaCredential, observeMainQuotaCredential } from "../../src/codex/main-account-cache";
import { clearAccountQuota, getMainPolicyQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { getMainAccountHardLockStatus } from "../../src/codex/main-account-hard-lock";
import { clearThreadAccountMap } from "../../src/codex/routing";
import { clearAccountNeedsReauth, isAccountNeedsReauth, markAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { withNativeMainSharedClaim } from "../../src/codex/native-main-claim";
import { resolveNativeProfileContext } from "../../src/codex/native-profile-store";
import type { OcxConfig } from "../../src/types";
import type { ResolveCodexRuntimeResult } from "../../src/codex/runtime";
import type { CodexExecBoundaryAsyncDeps } from "../../src/codex/exec-boundary";
import { fakeChatGptJwt } from "../helpers/agent-task-recovery";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const CODEX_MODE: NativeMainRefreshResolution = {
  mode: "codex", configured: "auto", reason: "codex-compatible", command: "/fake/codex", version: "0.162.1",
};

function runtime(version: string | null, source: ResolveCodexRuntimeResult["runtime"]["source"] = "path") {
  return async (): Promise<ResolveCodexRuntimeResult> => ({
    runtime: { command: source === "fallback" ? "codex" : "/usr/local/bin/codex", version, source },
    failures: [],
  });
}

describe("native main refresh mode resolution (#2999)", () => {
  test("auto picks codex only for a binary at or above the supported version", async () => {
    expect((await resolveNativeMainRefreshMode({}, { resolveRuntime: runtime("0.162.1") })).mode).toBe("codex");
    expect((await resolveNativeMainRefreshMode({}, { resolveRuntime: runtime(CODEX_AUTH_STATUS_MIN_VERSION) })).mode)
      .toBe("codex");
    expect((await resolveNativeMainRefreshMode({}, { resolveRuntime: runtime("0.155.0-alpha.9", "installed") })).mode)
      .toBe("codex");
    expect(await resolveNativeMainRefreshMode({}, { resolveRuntime: runtime("0.129.0") })).toMatchObject({
      mode: "opencodex", configured: "auto", reason: "codex-too-old", version: "0.129.0",
    });
    expect(await resolveNativeMainRefreshMode({}, { resolveRuntime: runtime(null, "fallback") })).toMatchObject({
      mode: "opencodex", configured: "auto", reason: "codex-missing",
    });
  });

  test("an explicit opencodex choice never probes Codex", async () => {
    let probed = false;
    const resolution = await resolveNativeMainRefreshMode({ nativeMainRefresh: "opencodex" }, {
      resolveRuntime: async () => { probed = true; return runtime("0.162.1")(); },
    });
    expect(resolution).toEqual({ mode: "opencodex", configured: "opencodex", reason: "configured-opencodex" });
    expect(probed).toBe(false);
  });

  test("an explicit codex choice falls back to the guarded writer without a usable binary", async () => {
    expect(await resolveNativeMainRefreshMode({ nativeMainRefresh: "codex" }, { resolveRuntime: runtime(null, "fallback") }))
      .toMatchObject({ mode: "opencodex", configured: "codex", reason: "codex-missing" });
    expect(await resolveNativeMainRefreshMode({ nativeMainRefresh: "codex" }, { resolveRuntime: runtime("0.162.1") }))
      .toMatchObject({ mode: "codex", configured: "codex" });
  });

  test("the armed test guard keeps the default path off the developer's real Codex", async () => {
    expect(await resolveNativeMainRefreshMode({})).toMatchObject({ mode: "opencodex", reason: "test-guard" });
  });

  test("doctor names the active owner and the reason", () => {
    expect(formatNativeMainRefreshDoctorLines(CODEX_MODE)[0]).toContain("ok  codex: Codex refreshes");
    expect(formatNativeMainRefreshDoctorLines({ mode: "opencodex", configured: "opencodex", reason: "configured-opencodex" })[0])
      .toContain('opencodex: OpenCodex refreshes auth.json with its guarded writer (nativeMainRefresh: "opencodex")');
    expect(formatNativeMainRefreshDoctorLines({ mode: "opencodex", configured: "auto", reason: "codex-missing" }).join("\n"))
      .toContain(`Install Codex ${CODEX_AUTH_STATUS_MIN_VERSION} or newer`);
    expect(formatNativeMainRefreshDoctorLines({
      mode: "opencodex", configured: "auto", reason: "codex-too-old", command: "/usr/local/bin/codex", version: "0.120.0",
    })[0]).toContain("0.120.0) is older than");
  });
});

const FAKE_APP_SERVER = `
const fs = require("node:fs");
const log = { args: process.argv.slice(2), codexHome: process.env.CODEX_HOME, messages: [] };
const scenario = process.env.OCX_FAKE_CODEX_SCENARIO;
const out = message => process.stdout.write(JSON.stringify(message) + "\\n");
let buffered = "";
process.stdin.setEncoding("utf8");
if (scenario === "stubborn") process.on("SIGTERM", () => {});
process.stdin.on("data", chunk => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\\n")) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    log.messages.push(message);
    fs.writeFileSync(process.env.OCX_FAKE_CODEX_LOG, JSON.stringify(log));
    if (message.method === "initialize") {
      out({ id: message.id, result: { userAgent: "fake" } });
      out({ method: "remoteControl/status/changed", params: { status: "disabled" } });
    } else if (message.method === "getAuthStatus") {
      if (scenario === "hang" || scenario === "stubborn") continue;
      if (scenario === "exit") process.exit(3);
      if (scenario === "error") { out({ id: message.id, error: { code: -32600, message: "no" } }); continue; }
      out({ id: message.id, result: { authMethod: "chatgpt", authToken: process.env.OCX_FAKE_CODEX_TOKEN || null, requiresOpenaiAuth: true } });
    }
  }
});
`;

let root: string;
let home: string;
let previousCodexHome: string | undefined;
const touchedEnv = ["OCX_FAKE_CODEX_SCENARIO", "OCX_FAKE_CODEX_LOG", "OCX_FAKE_CODEX_TOKEN"] as const;

function fakeCodex(): { command: string; logPath: string } {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "server.cjs"), FAKE_APP_SERVER);
  const command = join(bin, "codex");
  writeFileSync(command, `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "server.cjs")}" "$@"\n`);
  chmodSync(command, 0o755);
  const logPath = join(root, "fake-codex-log.json");
  process.env.OCX_FAKE_CODEX_LOG = logPath;
  return { command, logPath };
}

function seedAuth(accessToken: string, refreshToken = "codex-owned-grant"): string {
  const raw = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: accessToken, refresh_token: refreshToken, account_id: "acct-main" } });
  writeFileSync(join(home, "auth.json"), raw);
  return raw;
}

const expired = () => fakeChatGptJwt("acct-main", { exp: Math.floor(Date.now() / 1000) - 60 });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-native-refresh-mode-"));
  home = join(root, "codex-home");
  mkdirSync(home);
  previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
});

afterEach(() => {
  setNativeMainRefreshResolutionForTests(null);
  for (const name of touchedEnv) delete process.env[name];
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(root);
});

describe.skipIf(process.platform === "win32")("codex app-server getAuthStatus client", () => {
  test("initializes, then asks for a refreshed token under the caller's CODEX_HOME", async () => {
    const { command, logPath } = fakeCodex();
    process.env.OCX_FAKE_CODEX_TOKEN = "codex-bearer";
    const status = await requestCodexAuthStatus(command, { refresh: true, signal: AbortSignal.timeout(10_000) });

    expect(status).toEqual({ authMethod: "chatgpt", authToken: "codex-bearer", requiresOpenaiAuth: true });
    const log = JSON.parse(readFileSync(logPath, "utf8"));
    expect(log.args).toEqual(["-c", 'model_provider="openai"', "app-server"]);
    expect(log.codexHome).toBe(home);
    expect(log.messages.map((message: { method: string }) => message.method)).toEqual(["initialize", "initialized", "getAuthStatus"]);
    expect(log.messages[2].params).toEqual({ includeToken: true, refreshToken: true });
  });

  test("a JSON-RPC error, an early exit, and a hang all fail without a token", async () => {
    const { command } = fakeCodex();
    process.env.OCX_FAKE_CODEX_SCENARIO = "error";
    await expect(requestCodexAuthStatus(command, { refresh: true, signal: AbortSignal.timeout(10_000) }))
      .rejects.toBeInstanceOf(CodexAuthStatusError);
    process.env.OCX_FAKE_CODEX_SCENARIO = "exit";
    await expect(requestCodexAuthStatus(command, { refresh: true, signal: AbortSignal.timeout(10_000) }))
      .rejects.toBeInstanceOf(CodexAuthStatusError);
    process.env.OCX_FAKE_CODEX_SCENARIO = "hang";
    const controller = new AbortController();
    const reason = new Error("refresh timed out");
    setTimeout(() => controller.abort(reason), 200);
    await expect(requestCodexAuthStatus(command, { refresh: true, signal: controller.signal })).rejects.toBe(reason);
  });

  test("a child that ignores SIGTERM still settles on timeout and is killed", async () => {
    const { command } = fakeCodex();
    process.env.OCX_FAKE_CODEX_SCENARIO = "stubborn";
    const started = Date.now();
    await expect(requestCodexAuthStatus(command, { refresh: true, signal: AbortSignal.timeout(300) }))
      .rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a missing binary is a client error", async () => {
    await expect(requestCodexAuthStatus(join(root, "no-such-codex"), { refresh: true, signal: AbortSignal.timeout(5_000) }))
      .rejects.toBeInstanceOf(CodexAuthStatusError);
  });

  test("end to end: the main account uses the bearer Codex returns and leaves auth.json alone", async () => {
    const { command } = fakeCodex();
    const fresh = fakeChatGptJwt("acct-main");
    process.env.OCX_FAKE_CODEX_TOKEN = fresh;
    setNativeMainRefreshResolutionForTests({ ...CODEX_MODE, command });
    const original = seedAuth(expired());

    expect(await getValidMainAccountToken()).toEqual({ accessToken: fresh, chatgptAccountId: "acct-main" });
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(original);
  });
});

describe("codex app-server exec boundary abort", () => {
  test("an abort during the deferred bundle trust check rethrows the signal reason", async () => {
    const controller = new AbortController();
    const reason = new Error("refresh aborted while the trust check was pending");
    let enteredResolve!: () => void;
    const entered = new Promise<void>(resolvePromise => { enteredResolve = resolvePromise; });
    let forwardedSignal: AbortSignal | undefined;
    let trustChecks = 0;
    let rejectTrust = (_reason: unknown) => {};
    // The deferred check honors the forwarded signal and settles with its reason; the
    // validation catch must rethrow that exact reason, not wrap it in CodexAuthStatusError.
    const execDeps: CodexExecBoundaryAsyncDeps = {
      platform: "darwin",
      env: { HOME: "/home/tester", PATH: "" },
      exists: () => true,
      executable: () => true,
      realpath: path => path,
      macBundleTrustReasonAsync: (_bundle, _binary, signal) => new Promise((_resolve, reject) => {
        trustChecks += 1;
        forwardedSignal = signal;
        const stop = () => rejectTrust(signal?.reason);
        rejectTrust = cause => {
          signal?.removeEventListener("abort", stop);
          reject(cause);
        };
        signal?.addEventListener("abort", stop, { once: true });
        enteredResolve();
        if (signal?.aborted) stop();
      }),
    };
    const pending = requestCodexAuthStatus(
      "/home/tester/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
      { refresh: true, signal: controller.signal, execDeps },
    );
    try {
      await Promise.race([entered, pending.then(() => { throw new Error("auth status settled before entering trust validation"); })]);
      expect(forwardedSignal).toBe(controller.signal);
      expect(trustChecks).toBe(1);
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(trustChecks).toBe(1);
    } finally {
      controller.abort(reason);
      rejectTrust(reason);
      await pending.catch(() => {});
    }
  });
});

describe("main account in codex refresh mode (#2999)", () => {
  function seam(answer: () => CodexAuthStatus | Promise<CodexAuthStatus>) {
    const calls: { refresh: boolean }[] = [];
    return {
      calls,
      codexAuthStatus: async (options: { refresh: boolean; signal: AbortSignal }) => {
        calls.push({ refresh: options.refresh });
        return answer();
      },
    };
  }

  test("a stale token is refreshed by Codex and nothing is written", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    const original = seedAuth(expired());
    const fresh = fakeChatGptJwt("acct-main");
    const { calls, codexAuthStatus } = seam(() => ({ authMethod: "chatgpt", authToken: fresh, requiresOpenaiAuth: true }));
    const epochBefore = codexCredentialMutationEpoch();

    expect(await getValidMainAccountToken({ codexAuthStatus })).toEqual({ accessToken: fresh, chatgptAccountId: "acct-main" });
    expect(calls).toEqual([{ refresh: true }]);
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(original);
    expect(readdirSync(home).filter(name => name.startsWith("auth.json"))).toEqual(["auth.json"]);
    expect(codexCredentialMutationEpoch()).toBe(epochBefore);
  });

  test("the RPC answer is used even when Codex moved the login to its keyring", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    seedAuth(expired());
    const fresh = fakeChatGptJwt("acct-other");
    const { calls, codexAuthStatus } = seam(() => {
      rmSync(join(home, "auth.json"), { force: true });
      return { authMethod: "chatgpt", authToken: fresh, requiresOpenaiAuth: true };
    });

    expect(await getValidMainAccountToken({ codexAuthStatus })).toEqual({ accessToken: fresh, chatgptAccountId: "acct-other" });
    expect(await getValidMainAccountToken({ codexAuthStatus })).toEqual({ accessToken: fresh, chatgptAccountId: "acct-other" });
    expect(calls).toEqual([{ refresh: true }, { refresh: false }]);
  });

  test("a keyring-only login is discovered without an earlier file-backed refresh", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    const fresh = fakeChatGptJwt("acct-main");
    const { calls, codexAuthStatus } = seam(() => ({ authMethod: "chatgpt", authToken: fresh, requiresOpenaiAuth: true }));

    expect(await getValidMainAccountToken({ codexAuthStatus })).toEqual({ accessToken: fresh, chatgptAccountId: "acct-main" });
    expect(calls).toEqual([{ refresh: false }]);
  });

  test.each([false, true])("a withheld lookup only refuses its own materialization (forced=%s)", async forced => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    const bearer = fakeChatGptJwt("acct-per-lookup");
    let withheld = true;
    const { calls, codexAuthStatus } = seam(() => ({
      authMethod: "chatgpt", authToken: withheld ? null : bearer, requiresOpenaiAuth: true,
    }));
    const inbound = new Headers({ authorization: "Bearer ocx_data_fixture" });
    const context = { kind: "main" as const, accountId: null };
    const options = { substituteMainCredential: true, nativeMainRefreshDependencies: { codexAuthStatus } };
    if (forced) {
      await expect(forceRefreshMainAccountToken(bearer, { codexAuthStatus })).rejects.toMatchObject({ reason: "reauth" });
    } else {
      await expect(materializeCodexUpstreamAuthAsync(inbound, context, options)).rejects.toMatchObject({ reason: "reauth" });
    }
    expect(getMainAccountCredentialStatus()).toMatchObject({ refreshGrantRejected: false, usable: false });
    withheld = false;
    const selected = await materializeCodexUpstreamAuthAsync(inbound, context, options);
    expect(selected.get("authorization")).toBe(`Bearer ${bearer}`);
    expect(selected.get("chatgpt-account-id")).toBe("acct-per-lookup");
    expect(calls).toEqual([{ refresh: forced }, { refresh: false }]);
  });

  test("Pool discovers a keyring-only main login before synchronous candidacy", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    clearThreadAccountMap();
    clearAccountNeedsReauth("__main__");
    const fresh = fakeChatGptJwt("acct-keyring-pool");
    const { calls, codexAuthStatus } = seam(() => ({ authMethod: "chatgpt", authToken: fresh, requiresOpenaiAuth: true }));
    const config: OcxConfig = {
      port: 10100, defaultProvider: "openai", codexAccounts: [], codexMainAccountHardLock: false,
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
    };
    let claimed = false;
    const context = await resolveCodexAuthContext(new Headers(), config, "pool", {
      modelId: "gpt-5.5", nativeMainRefreshDependencies: { codexAuthStatus },
      beginCodexAccountSelection: () => ({ mainProfileDraining: false,
        claimMainProfile: () => { claimed = true; return true; }, release() {} }),
    });
    expect(context).toMatchObject({ kind: "main-pool", accessToken: fresh, chatgptAccountId: "acct-keyring-pool" });
    expect(claimed).toBe(true);
    expect(calls).toEqual([{ refresh: false }, { refresh: false }]);
  });

  test("stored Direct materialization uses the currently verified keyring account", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    const fresh = fakeChatGptJwt("acct-keyring-direct");
    const { codexAuthStatus } = seam(() => ({ authMethod: "chatgpt", authToken: fresh, requiresOpenaiAuth: true }));
    const inbound = new Headers({ authorization: "Bearer ocx_data_fixture", "chatgpt-account-id": "caller-account" });
    const selected = await materializeCodexUpstreamAuthAsync(inbound, { kind: "main", accountId: null }, {
      substituteMainCredential: true, nativeMainRefreshDependencies: { codexAuthStatus },
    });
    expect(selected.get("authorization")).toBe(`Bearer ${fresh}`);
    expect(selected.get("chatgpt-account-id")).toBe("acct-keyring-direct");
    expect(inbound.get("chatgpt-account-id")).toBe("caller-account");
  });

  test("a cold keyring discovery transport failure retains its retryable auth-context cause", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    clearThreadAccountMap();
    clearAccountNeedsReauth("__main__");
    const config: OcxConfig = {
      port: 10100, defaultProvider: "openai", codexAccounts: [], codexMainAccountHardLock: false,
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
    };
    const failure = await resolveCodexAuthContext(new Headers(), config, "pool", {
      nativeMainRefreshDependencies: { codexAuthStatus: async () => { throw new CodexAuthStatusError("fixture unavailable"); } },
      beginCodexAccountSelection: () => ({ mainProfileDraining: false, claimMainProfile: () => true, release() {} }),
    }).catch(error => error);
    expect(failure).toBeInstanceOf(CodexAuthContextError);
    expect(failure.cause).toMatchObject({ reason: "transient" });
  });

  test("a cold keyring discovery failure reaches the exact __main__ selector as its retryable cause", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    clearThreadAccountMap();
    clearAccountNeedsReauth("__main__");
    const config: OcxConfig = {
      port: 10100, defaultProvider: "openai", codexAccounts: [], codexMainAccountHardLock: false,
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
    };
    const failure = await resolveCodexAuthContext(new Headers(), config, "pool", {
      accountId: MAIN_CODEX_ACCOUNT_ID,
      nativeMainRefreshDependencies: { codexAuthStatus: async () => { throw new CodexAuthStatusError("fixture unavailable"); } },
      beginCodexAccountSelection: () => ({ mainProfileDraining: false, claimMainProfile: () => true, release() {} }),
    }).catch(error => error);
    expect(failure).toBeInstanceOf(CodexAuthContextError);
    expect(failure).not.toBeInstanceOf(CodexPoolAuthenticationError);
    expect(failure.cause).toMatchObject({ reason: "transient" });
  });

  test("an ordinary keyring read with no Codex login reports absence for the exact __main__ selector", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    clearThreadAccountMap();
    clearAccountNeedsReauth("__main__");
    const { codexAuthStatus } = seam(() => ({ authMethod: null, authToken: null, requiresOpenaiAuth: true }));
    const config: OcxConfig = {
      port: 10100, defaultProvider: "openai", codexAccounts: [], codexMainAccountHardLock: false,
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
    };
    const failure = await resolveCodexAuthContext(new Headers(), config, "pool", {
      accountId: MAIN_CODEX_ACCOUNT_ID,
      nativeMainRefreshDependencies: { codexAuthStatus },
      beginCodexAccountSelection: () => ({ mainProfileDraining: false, claimMainProfile: () => true, release() {} }),
    }).catch(error => error);
    expect(failure).toBeInstanceOf(CodexPoolAuthenticationError);
    expect(failure).not.toBeInstanceOf(CodexAuthContextError);
    expect(getMainAccountCredentialStatus().usable).toBe(false);
  });

  test("an ordinary keyring read with no Codex login reports absence in Pool mode", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    clearThreadAccountMap();
    clearAccountNeedsReauth("__main__");
    const { codexAuthStatus } = seam(() => ({ authMethod: null, authToken: null, requiresOpenaiAuth: true }));
    const config: OcxConfig = {
      port: 10100, defaultProvider: "openai", codexAccounts: [], codexMainAccountHardLock: false,
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
    };
    const failure = await resolveCodexAuthContext(new Headers(), config, "pool", {
      nativeMainRefreshDependencies: { codexAuthStatus },
      beginCodexAccountSelection: () => ({ mainProfileDraining: false, claimMainProfile: () => true, release() {} }),
    }).catch(error => error);
    expect(failure).toBeInstanceOf(CodexPoolAuthenticationError);
    expect(failure).not.toBeInstanceOf(CodexAuthContextError);
  });

  test("an ordinary fileless read with no Codex login returns null instead of a refresh failure", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    const { calls, codexAuthStatus } = seam(() => ({ authMethod: null, authToken: null, requiresOpenaiAuth: true }));
    expect(await getValidMainAccountToken({ codexAuthStatus })).toBeNull();
    expect(calls).toEqual([{ refresh: false }]);
    expect(getMainAccountCredentialStatus().usable).toBe(false);
  });

  test("a missing CODEX_HOME is the same observed absence: no claim, no RPC, null", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    process.env.CODEX_HOME = join(root, "never-created", "codex-home");
    const { calls, codexAuthStatus } = seam(() => { throw new Error("must not be called"); });
    expect(await getValidMainAccountToken({ codexAuthStatus })).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a forced fileless refresh over a missing CODEX_HOME still reports the absence", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    process.env.CODEX_HOME = join(root, "never-created");
    const { calls, codexAuthStatus } = seam(() => { throw new Error("must not be called"); });
    expect(await forceRefreshMainAccountToken(expired(), { codexAuthStatus })).toBeNull();
    expect(calls).toEqual([]);
  });

  test.each(["cancel", "home-change"] as const)("missing-home absence does not mask %s during mode discovery", async change => {
    process.env.CODEX_HOME = join(root, "never-created");
    const controller = new AbortController();
    const cancellation = new Error("cancelled during mode discovery");
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<NativeMainRefreshResolution>(resolve => { release = () => resolve(CODEX_MODE); });
    const mode = spyOn(nativeMainRefreshMode, "resolveNativeMainRefreshMode").mockImplementation(() => {
      started();
      return held;
    });
    const { calls, codexAuthStatus } = seam(() => { throw new Error("must not be called"); });
    const observed = getValidMainAccountToken({ codexAuthStatus, signal: controller.signal }).then(
      value => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    try {
      await entered;
      if (change === "cancel") controller.abort(cancellation);
      else process.env.CODEX_HOME = home;
      release();
      const outcome = await observed;
      expect(outcome.kind).toBe("rejected");
      if (outcome.kind !== "rejected") throw new Error("expected the pending lookup to reject");
      if (change === "cancel") expect(outcome.error).toBe(cancellation);
      else expect(outcome.error).toBeInstanceOf(MainAuthJsonChangedDuringRefreshError);
      expect(calls).toEqual([]);
    } finally {
      release();
      await observed;
      mode.mockRestore();
    }
  });

  test("a CODEX_HOME that exists but is not a directory stays fail closed", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    const file = join(root, "codex-home-is-a-file");
    writeFileSync(file, "not a directory");
    process.env.CODEX_HOME = file;
    const { calls, codexAuthStatus } = seam(() => { throw new Error("must not be called"); });
    const before = readFileSync(file);
    const failure = await getValidMainAccountToken({ codexAuthStatus }).then(
      () => { throw new Error("expected a non-directory CODEX_HOME to be rejected"); },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    // Linux can reject file/auth.json at lstat before the profile-context validator runs.
    expect(["CODEX_HOME_UNAVAILABLE", "ENOTDIR"]).toContain((failure as NodeJS.ErrnoException).code);
    expect(calls).toEqual([]);
    expect(readFileSync(file)).toEqual(before);
  });

  test("a dangling CODEX_HOME link stays fail closed, including through a dangling parent", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    const dangling = join(root, "dangling-home");
    symlinkSync(join(root, "gone"), dangling, process.platform === "win32" ? "junction" : "dir");
    process.env.CODEX_HOME = dangling;
    const { calls, codexAuthStatus } = seam(() => { throw new Error("must not be called"); });
    await expect(getValidMainAccountToken({ codexAuthStatus }))
      .rejects.toMatchObject({ code: "CODEX_HOME_UNAVAILABLE" });

    // A missing child under a dangling parent must not read as an absent home:
    // the entry that broke the chain exists, so the verdict stays unsafe.
    process.env.CODEX_HOME = join(dangling, "child");
    await expect(getValidMainAccountToken({ codexAuthStatus }))
      .rejects.toMatchObject({ code: "CODEX_HOME_UNAVAILABLE" });
    expect(calls).toEqual([]);
  });

  test("an expiring-bearer promotion turns the same no-login back into a refresh failure", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    const answers: CodexAuthStatus[] = [
      { authMethod: "chatgpt", authToken: expired(), requiresOpenaiAuth: true },
      { authMethod: null, authToken: null, requiresOpenaiAuth: true },
    ];
    let index = 0;
    const { calls, codexAuthStatus } = seam(() => answers[index++]);
    const failure = await getValidMainAccountToken({ codexAuthStatus }).catch(error => error);
    expect(failure).toBeInstanceOf(MainAccountTokenRefreshError);
    expect((failure as MainAccountTokenRefreshError).reason).toBe("transient");
    expect(calls).toEqual([{ refresh: false }, { refresh: true }]);
  });

  test("an expiring-bearer promotion keeps a withheld grant at reauth", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    const answers: CodexAuthStatus[] = [
      { authMethod: "chatgpt", authToken: expired(), requiresOpenaiAuth: true },
      { authMethod: "chatgpt", authToken: null, requiresOpenaiAuth: true },
    ];
    let index = 0;
    const { calls, codexAuthStatus } = seam(() => answers[index++]);
    const failure = await getValidMainAccountToken({ codexAuthStatus }).catch(error => error);
    expect(failure).toBeInstanceOf(MainAccountTokenRefreshError);
    expect((failure as MainAccountTokenRefreshError).reason).toBe("reauth");
    expect(calls).toEqual([{ refresh: false }, { refresh: true }]);
  });

  test("a forced fileless refresh still reports no-login as transient", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    const { calls, codexAuthStatus } = seam(() => ({ authMethod: null, authToken: null, requiresOpenaiAuth: true }));
    const failure = await forceRefreshMainAccountToken(expired(), { codexAuthStatus }).catch(error => error);
    expect(failure).toBeInstanceOf(MainAccountTokenRefreshError);
    expect((failure as MainAccountTokenRefreshError).reason).toBe("transient");
    expect(calls).toEqual([{ refresh: true }]);
  });

  test("a refused main-profile claim outranks a saved discovery failure", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    clearThreadAccountMap();
    clearAccountNeedsReauth("__main__");
    const config: OcxConfig = {
      port: 10100, defaultProvider: "openai", codexAccounts: [], codexMainAccountHardLock: false,
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
    };
    const failure = await resolveCodexAuthContext(new Headers(), config, "pool", {
      accountId: MAIN_CODEX_ACCOUNT_ID,
      nativeMainRefreshDependencies: { codexAuthStatus: async () => { throw new CodexAuthStatusError("fixture unavailable"); } },
      beginCodexAccountSelection: () => ({ mainProfileDraining: false, claimMainProfile: () => false, release() {} }),
    }).catch(error => error);
    expect(failure).toBeInstanceOf(CodexMainProfileDrainingError);
  });

  test("a stale discovery failure does not refuse an exact __main__ selector once the credential recovers", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    clearThreadAccountMap();
    clearAccountNeedsReauth("__main__");
    const fresh = fakeChatGptJwt("acct-main");
    let recovered = false;
    const { codexAuthStatus } = seam(() => {
      if (!recovered) throw new CodexAuthStatusError("fixture unavailable");
      return { authMethod: "chatgpt", authToken: fresh, requiresOpenaiAuth: true };
    });
    const config: OcxConfig = {
      port: 10100, defaultProvider: "openai", codexAccounts: [], codexMainAccountHardLock: false,
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
    };
    const context = await resolveCodexAuthContext(new Headers(), config, "pool", {
      accountId: MAIN_CODEX_ACCOUNT_ID,
      modelId: NATIVE_GPT6_ASTRA_MINOR_MODEL,
      nativeMainRefreshDependencies: { codexAuthStatus },
      resolveCodexModelEntitlements: async () => {
        // A real recovery landing during the entitlement await: the read below goes through
        // the production credential path, so the saved probe error above is stale evidence.
        recovered = true;
        await getValidMainAccountToken({ codexAuthStatus });
        return {
          modelsByAccount: new Map([[MAIN_CODEX_ACCOUNT_ID, new Set([NATIVE_GPT6_ASTRA_MINOR_MODEL])]]),
          clientVersionByAccount: new Map(),
          confirmedAccountIds: new Set([MAIN_CODEX_ACCOUNT_ID]),
          credentialIdentities: new Map(),
        };
      },
      beginCodexAccountSelection: () => ({ mainProfileDraining: false, claimMainProfile: () => true, release() {} }),
    });
    expect(context).toMatchObject({ kind: "main-pool", accountId: MAIN_CODEX_ACCOUNT_ID, accessToken: fresh });
  });

  test("a stale discovery failure does not outrank the current selection answer when nothing can serve", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    clearThreadAccountMap();
    clearAccountNeedsReauth("__main__");
    const fresh = fakeChatGptJwt("acct-main");
    let recovered = false;
    const { codexAuthStatus } = seam(() => {
      if (!recovered) throw new CodexAuthStatusError("fixture unavailable");
      return { authMethod: "chatgpt", authToken: fresh, requiresOpenaiAuth: true };
    });
    const config: OcxConfig = {
      port: 10100, defaultProvider: "openai", codexAccounts: [], codexMainAccountHardLock: false,
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
    };
    const failure = await resolveCodexAuthContext(new Headers(), config, "pool", {
      modelId: NATIVE_GPT6_ASTRA_MINOR_MODEL,
      nativeMainRefreshDependencies: { codexAuthStatus },
      resolveCodexModelEntitlements: async () => {
        // Same mid-await recovery as above: the credential verifies healthy, so the saved
        // probe error is stale. The roster admits nobody for this model, so main stays
        // out of candidacy on CURRENT eligibility evidence and the honest refusal is the
        // selection's own answer, not the stale transient.
        recovered = true;
        await getValidMainAccountToken({ codexAuthStatus });
        return {
          modelsByAccount: new Map(),
          clientVersionByAccount: new Map(),
          confirmedAccountIds: new Set(),
          credentialIdentities: new Map(),
        };
      },
      beginCodexAccountSelection: () => ({ mainProfileDraining: false, claimMainProfile: () => true, release() {} }),
    }).catch(error => error);
    expect(failure).toBeInstanceOf(CodexModelAvailabilityError);
    expect(failure).not.toBeInstanceOf(CodexAuthContextError);
  });

  test("a failed main discovery still lets a healthy pool account serve the request", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    clearThreadAccountMap();
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = join(root, "opencodex-home");
    mkdirSync(process.env.OPENCODEX_HOME);
    try {
      saveCodexAccountCredential("pool-a", {
        accessToken: "pool-a-bearer",
        refreshToken: "pool-a-refresh",
        expiresAt: Date.now() + 3_600_000,
        chatgptAccountId: "pool_acc",
      });
      const config: OcxConfig = {
        port: 10100, defaultProvider: "openai", codexMainAccountHardLock: false,
        activeCodexAccountId: "pool-a",
        codexAccounts: [{ id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "pool_acc" }],
        providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
      };
      const context = await resolveCodexAuthContext(new Headers(), config, "pool", {
        nativeMainRefreshDependencies: { codexAuthStatus: async () => { throw new CodexAuthStatusError("fixture unavailable"); } },
        beginCodexAccountSelection: () => ({ mainProfileDraining: false, claimMainProfile: () => true, release() {} }),
      });
      expect(context).toMatchObject({ kind: "pool", accountId: "pool-a" });
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
    }
  });

  test("a near-expiry keyring read refreshes once through Codex", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    const fresh = fakeChatGptJwt("acct-main");
    const calls: boolean[] = [];
    const token = await getValidMainAccountToken({ codexAuthStatus: async ({ refresh }) => {
      calls.push(refresh);
      return { authMethod: "chatgpt", authToken: refresh ? fresh : expired(), requiresOpenaiAuth: true };
    } });
    expect(token?.accessToken).toBe(fresh);
    expect(calls).toEqual([false, true]);
  });

  test("a keyring result is never attributed to a different home after an awaited read", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    const otherHome = join(root, "other-codex-home");
    mkdirSync(otherHome);
    const { codexAuthStatus } = seam(() => {
      process.env.CODEX_HOME = otherHome;
      return { authMethod: "chatgpt", authToken: fakeChatGptJwt("acct-old-home"), requiresOpenaiAuth: true };
    });
    await expect(getValidMainAccountToken({ codexAuthStatus })).rejects.toBeInstanceOf(MainAuthJsonChangedDuringRefreshError);
    expect(getMainAccountCredentialStatus().usable).toBe(false);
    process.env.CODEX_HOME = home;
    expect(getMainAccountCredentialStatus().usable).toBe(false);
  });

  test("cancellation interrupts a read-only keyring lookup without starting a refresh", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    const controller = new AbortController();
    const reason = new Error("fixture caller disconnected");
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const calls: boolean[] = [];
    const pending = getValidMainAccountToken({ signal: controller.signal,
      codexAuthStatus: ({ refresh, signal }) => new Promise((_resolve, reject) => {
        calls.push(refresh);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        started();
      }),
    });
    await entered;
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(calls).toEqual([false]);
    expect(getMainAccountCredentialStatus().usable).toBe(false);
  });

  test("a keyring claim deadline is transient and never starts Codex while a reader owns the home", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const reader = withNativeMainSharedClaim(resolveNativeProfileContext(), async () => { started(); await held; });
    await entered;
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation(ms => originalTimeout(ms === 30_000 ? 10 : ms));
    const { calls, codexAuthStatus } = seam(() => ({ authMethod: "chatgpt", authToken: fakeChatGptJwt("acct-main"), requiresOpenaiAuth: true }));
    try {
      await expect(getValidMainAccountToken({ codexAuthStatus })).rejects.toMatchObject({ reason: "transient" });
      expect(calls).toEqual([]);
    } finally {
      timeout.mockRestore();
      release();
      await reader;
    }
  });

  test("a subsequent keyring read follows an external account switch", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    seedAuth(expired());
    let current = fakeChatGptJwt("acct-main");
    const { calls, codexAuthStatus } = seam(() => {
      rmSync(join(home, "auth.json"), { force: true });
      return { authMethod: "chatgpt", authToken: current, requiresOpenaiAuth: true };
    });
    expect((await getValidMainAccountToken({ codexAuthStatus }))?.chatgptAccountId).toBe("acct-main");
    current = fakeChatGptJwt("acct-switched");

    expect(await getValidMainAccountToken({ codexAuthStatus })).toEqual({ accessToken: current, chatgptAccountId: "acct-switched" });
    expect(calls).toEqual([{ refresh: true }, { refresh: false }]);
  });

  test("external logout invalidates the previously observed keyring bearer", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    seedAuth(expired());
    let status: CodexAuthStatus = { authMethod: "chatgpt", authToken: fakeChatGptJwt("acct-main"), requiresOpenaiAuth: true };
    const { codexAuthStatus } = seam(() => {
      rmSync(join(home, "auth.json"), { force: true });
      return status;
    });
    await getValidMainAccountToken({ codexAuthStatus });
    status = { authMethod: null, authToken: null, requiresOpenaiAuth: true };

    expect(await getValidMainAccountToken({ codexAuthStatus })).toBeNull();
    expect(getMainAccountCredentialStatus().usable).toBe(false);
  });

  test("a later authoritative keyring lookup can return the same bearer after withholding it", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    seedAuth(expired());
    const rejected = fakeChatGptJwt("acct-main");
    let status: CodexAuthStatus = { authMethod: "chatgpt", authToken: rejected, requiresOpenaiAuth: true };
    const { codexAuthStatus } = seam(() => {
      rmSync(join(home, "auth.json"), { force: true });
      return status;
    });
    await getValidMainAccountToken({ codexAuthStatus });
    status = { authMethod: "chatgpt", authToken: null, requiresOpenaiAuth: true };

    await expect(forceRefreshMainAccountToken(rejected, { codexAuthStatus })).rejects.toMatchObject({ reason: "reauth" });
    expect(getMainAccountCredentialStatus().usable).toBe(false);
    expect(isMainAccountRefreshGrantRejected()).toBe(false);
    await expect(getValidMainAccountToken({ codexAuthStatus })).rejects.toMatchObject({ reason: "reauth" });
    status = { authMethod: "chatgpt", authToken: rejected, requiresOpenaiAuth: true };
    expect((await getValidMainAccountToken({ codexAuthStatus }))?.accessToken).toBe(rejected);
    expect(isMainAccountRefreshGrantRejected()).toBe(false);
  });

  test("a chatgpt login with a withheld token keeps the file-backed grant rejection", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    const original = seedAuth(expired());
    const { codexAuthStatus } = seam(() => ({ authMethod: "chatgpt", authToken: null, requiresOpenaiAuth: true }));

    const failure = await getValidMainAccountToken({ codexAuthStatus }).catch(error => error);
    expect(failure).toBeInstanceOf(MainAccountTokenRefreshError);
    expect((failure as MainAccountTokenRefreshError).reason).toBe("reauth");
    expect(isMainAccountRefreshGrantRejected()).toBe(true);
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(original);
  });

  test("an unreachable Codex, a non-ChatGPT login, or the same rejected bearer stay transient", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    const rejected = fakeChatGptJwt("acct-main");
    seedAuth(rejected);
    const answers: (() => CodexAuthStatus)[] = [
      () => { throw new CodexAuthStatusError("codex app-server exited before answering getAuthStatus"); },
      () => ({ authMethod: "apikey", authToken: "api-key-login-not-a-chatgpt-bearer", requiresOpenaiAuth: true }),
      () => ({ authMethod: null, authToken: null, requiresOpenaiAuth: true }),
      () => ({ authMethod: "chatgpt", authToken: rejected, requiresOpenaiAuth: true }),
      () => ({ authMethod: "chatgpt", authToken: expired(), requiresOpenaiAuth: true }),
    ];
    for (const answer of answers) {
      const { codexAuthStatus } = seam(answer);
      const failure = await forceRefreshMainAccountToken(rejected, { codexAuthStatus }).catch(error => error);
      expect(failure).toBeInstanceOf(MainAccountTokenRefreshError);
      expect((failure as MainAccountTokenRefreshError).reason).toBe("transient");
    }
    expect(isMainAccountRefreshGrantRejected()).toBe(false);
  });

  test("a fresh token on disk is served without asking Codex", async () => {
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
    const fresh = fakeChatGptJwt("acct-main");
    seedAuth(fresh);
    const { calls, codexAuthStatus } = seam(() => { throw new Error("must not be called"); });

    expect(await getValidMainAccountToken({ codexAuthStatus })).toEqual({ accessToken: fresh, chatgptAccountId: "acct-main" });
    expect(calls).toEqual([]);
  });

  test("opencodex mode keeps the guarded writer and never calls Codex", async () => {
    setNativeMainRefreshResolutionForTests({ mode: "opencodex", configured: "opencodex", reason: "configured-opencodex" });
    seedAuth(expired());
    const { calls, codexAuthStatus } = seam(() => { throw new Error("must not be called"); });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      access_token: fakeChatGptJwt("acct-main"), refresh_token: "rotated", id_token: fakeChatGptJwt("acct-main"), expires_in: 3600,
    })) as unknown as typeof fetch;
    try {
      const token = await getValidMainAccountToken({ codexAuthStatus });
      expect(token?.chatgptAccountId).toBe("acct-main");
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toEqual([]);
    expect(JSON.parse(readFileSync(join(home, "auth.json"), "utf8")).tokens.refresh_token).toBe("rotated");
  });
});

describe("owned keyring account identity and quota", () => {
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = join(root, "opencodex-home");
    mkdirSync(process.env.OPENCODEX_HOME);
    resetMainCodexAccountIdentityTrackingForTests();
    clearAccountQuota();
    clearThreadAccountMap();
    clearAccountNeedsReauth("__main__");
    setNativeMainRefreshResolutionForTests(CODEX_MODE);
  });

  afterEach(() => {
    clearAccountQuota();
    resetMainCodexAccountIdentityTrackingForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
  });

  function config(): OcxConfig {
    return { port: 10100, defaultProvider: "openai", codexAccounts: [], codexMainAccountHardLock: true,
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } } };
  }

  function oldAccount(percent = 99) {
    const accessToken = fakeChatGptJwt("acct-main");
    seedAuth(accessToken);
    reconcileMainCodexAccountRuntimeState();
    const writer = observeMainQuotaCredential(accessToken, "acct-main")!;
    expect(writer).toBeDefined();
    setAccountQuotaFromParsed("__main__", { weeklyPercent: percent, weeklyResetAt: Date.now() / 1000 + 3600 }, undefined, writer);
    rmSync(join(home, "auth.json"));
    return { accessToken, writer };
  }

  function answer(accessToken: string) {
    const calls: boolean[] = [];
    return { calls, codexAuthStatus: async ({ refresh }: { refresh: boolean; signal: AbortSignal }) => {
      calls.push(refresh);
      return { authMethod: "chatgpt", authToken: accessToken, requiresOpenaiAuth: true } as CodexAuthStatus;
    } };
  }

  const selection = () => ({ mainProfileDraining: false, claimMainProfile: () => true, release() {} });

  test("a verified keyring switch retires the old quota writer and binds the new credential", async () => {
    const old = oldAccount();
    const fresh = fakeChatGptJwt("acct-keyring-new");
    const { codexAuthStatus } = answer(fresh);
    expect(await getValidMainAccountToken({ codexAuthStatus })).toEqual({ accessToken: fresh, chatgptAccountId: "acct-keyring-new" });
    expect(isMainQuotaWriterLive(old.writer)).toBe(false);
    expect(matchesMainQuotaCredential(old.accessToken, "acct-main")).toBe(false);
    expect(matchesMainQuotaCredential(fresh, "acct-keyring-new")).toBe(true);
    const nextWriter = captureMainQuotaWriter("acct-keyring-new");
    expect(nextWriter).toBeDefined();
    expect(getMainPolicyQuota()).toBeNull();
    setAccountQuotaFromParsed("__main__", { weeklyPercent: 5 }, undefined, nextWriter);
    setAccountQuotaFromParsed("__main__", { weeklyPercent: 100 }, undefined, old.writer);
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(5);
  });

  test("stored Direct materialization binds its new keyring dispatch after an awaited identity switch", async () => {
    oldAccount();
    const fresh = fakeChatGptJwt("acct-keyring-new");
    const { codexAuthStatus } = answer(fresh);
    const context: { kind: "main"; accountId: null; mainQuotaDispatch?: import("../../src/codex/main-account-cache").MainQuotaDispatch } = { kind: "main", accountId: null };
    const headers = await materializeCodexUpstreamAuthAsync(new Headers({ authorization: "Bearer fixture-admission" }), context, {
      config: config(), substituteMainCredential: true, nativeMainRefreshDependencies: { codexAuthStatus },
    });
    expect(headers.get("authorization")).toBe(`Bearer ${fresh}`);
    expect(headers.get("chatgpt-account-id")).toBe("acct-keyring-new");
    expect(context.mainQuotaDispatch).toBeDefined();
    expect(isMainQuotaDispatchLive(context.mainQuotaDispatch!)).toBe(true);
  });

  test.each([true, false])("stored Direct discovers a replacement before old policy checks (hard lock=%s)", async hardLock => {
    oldAccount(100);
    const cfg = { ...config(), codexMainAccountHardLock: hardLock };
    const { calls, codexAuthStatus } = answer(fakeChatGptJwt("acct-keyring-new"));
    await expect(resolveCodexAuthContext(new Headers({ authorization: "Bearer fixture-admission" }), cfg, "direct", {
      substituteMainCredentialForDirect: true, nativeMainRefreshDependencies: { codexAuthStatus },
      beginCodexAccountSelection: selection,
    })).resolves.toMatchObject({ kind: "main", accountId: null });
    expect(calls).toEqual([false]);
    expect(getMainPolicyQuota()).toBeNull();
  });

  test.each([false, true])("Pool observes a replacement before old quota selection (prior keyring lookup=%s)", async warm => {
    const old = oldAccount();
    if (warm) {
      await getValidMainAccountToken({ codexAuthStatus: answer(old.accessToken).codexAuthStatus });
      expect(getMainAccountCredentialStatus().usable).toBe(true);
    }
    const cfg = config();
    const before = structuredClone(cfg);
    const fresh = fakeChatGptJwt("acct-keyring-new");
    const { calls, codexAuthStatus } = answer(fresh);
    const context = await resolveCodexAuthContext(new Headers(), cfg, "pool", {
      modelId: "gpt-5.5", nativeMainRefreshDependencies: { codexAuthStatus },
      beginCodexAccountSelection: selection, primeCodexPoolQuotas: async () => {},
    });
    expect(context).toMatchObject({ kind: "main-pool", accessToken: fresh, chatgptAccountId: "acct-keyring-new" });
    expect(context.kind === "main-pool" && context.mainQuotaWriter).toBeDefined();
    if (context.kind === "main-pool") expect(isMainQuotaWriterLive(context.mainQuotaWriter!)).toBe(true);
    expect(calls).toEqual([false, false]);
    // Ordinary Pool selection records its active slot; operator policy stays unchanged.
    expect(cfg).toEqual({ ...before, activeCodexAccountId: "__main__" });
    expect(isMainQuotaWriterLive(old.writer)).toBe(false);
  });

  test("the unchanged keyring account retains its hard lock", async () => {
    const old = oldAccount();
    const { codexAuthStatus } = answer(old.accessToken);
    await getValidMainAccountToken({ codexAuthStatus });
    expect(getMainAccountHardLockStatus(config()).state).toBe("blocked");
    expect(isMainQuotaWriterLive(old.writer)).toBe(true);
    await expect(materializeCodexUpstreamAuthAsync(new Headers(), { kind: "main", accountId: null }, {
      config: config(), substituteMainCredential: true, nativeMainRefreshDependencies: { codexAuthStatus },
    })).rejects.toBeInstanceOf(CodexMainAccountHardLockError);
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
  });

  test("Pool acquisition carries the specifically owned replacement writer after discovery", async () => {
    const old = oldAccount(5);
    const fresh = fakeChatGptJwt("acct-keyring-new");
    let reads = 0;
    const context = await resolveCodexAuthContext(new Headers(), config(), "pool", {
      nativeMainRefreshDependencies: { codexAuthStatus: async () => ({
        authMethod: "chatgpt", authToken: ++reads === 1 ? old.accessToken : fresh, requiresOpenaiAuth: true,
      }) },
      beginCodexAccountSelection: selection, primeCodexPoolQuotas: async () => {},
    });
    expect(reads).toBe(2);
    expect(context).toMatchObject({ kind: "main-pool", chatgptAccountId: "acct-keyring-new" });
    expect(isMainQuotaWriterLive(old.writer)).toBe(false);
    expect(context.kind === "main-pool" && context.mainQuotaWriter).toEqual(captureMainQuotaWriter("acct-keyring-new"));
    if (context.kind === "main-pool") {
      setAccountQuotaFromParsed("__main__", { weeklyPercent: 7 }, undefined, context.mainQuotaWriter);
    }
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(7);
  });

  test("an incoming Direct bearer cannot replace the owned quota identity", async () => {
    const old = oldAccount();
    const incoming = fakeChatGptJwt("acct-caller-only");
    const { calls, codexAuthStatus } = answer(incoming);
    await expect(resolveCodexAuthContext(new Headers({ authorization: `Bearer ${incoming}` }), config(), "direct", {
      nativeMainRefreshDependencies: { codexAuthStatus }, beginCodexAccountSelection: selection,
    })).resolves.toMatchObject({ kind: "main", accountId: null });
    expect(calls).toEqual([]);
    expect(isMainQuotaWriterLive(old.writer)).toBe(true);
    expect(matchesMainQuotaCredential(incoming, "acct-caller-only")).toBe(false);
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
  });

  test("a late RPC cannot overwrite a newer native identity generation", async () => {
    const old = oldAccount();
    await expect(getValidMainAccountToken({ codexAuthStatus: async () => {
      applyConfirmedMainCodexAccountTransition("acct-main", "acct-concurrent");
      return { authMethod: "chatgpt", authToken: fakeChatGptJwt("acct-keyring-new"), requiresOpenaiAuth: true };
    } })).rejects.toBeInstanceOf(MainAuthJsonChangedDuringRefreshError);
    expect(isMainQuotaWriterLive(old.writer)).toBe(false);
    expect(captureMainQuotaWriter("acct-concurrent")).toBeDefined();
    expect(captureMainQuotaWriter("acct-keyring-new")).toBeUndefined();
  });

  test.each(["unavailable", "missing-id", "conflicting-id", "cancelled", "home-changed"])("uncertain keyring evidence preserves old quota policy (%s)", async scenario => {
    const old = oldAccount();
    markAccountNeedsReauth("__main__");
    const controller = new AbortController();
    const otherHome = join(root, "other-home");
    mkdirSync(otherHome);
    const token = scenario === "missing-id" ? "opaque-fixture-token" : scenario === "conflicting-id"
      ? fakeChatGptJwt("acct-keyring-new", { chatgpt_account_id: "acct-conflict" })
      : fakeChatGptJwt("acct-keyring-new");
    await getValidMainAccountToken({ signal: controller.signal, codexAuthStatus: async () => {
      if (scenario === "unavailable") throw new CodexAuthStatusError("fixture unavailable");
      if (scenario === "cancelled") controller.abort(new Error("fixture cancelled"));
      if (scenario === "home-changed") process.env.CODEX_HOME = otherHome;
      return { authMethod: "chatgpt", authToken: token, requiresOpenaiAuth: true };
    } }).catch(() => null);
    process.env.CODEX_HOME = home;
    expect(isMainQuotaWriterLive(old.writer)).toBe(true);
    expect(getMainAccountHardLockStatus(config()).state).toBe("blocked");
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
    expect(isAccountNeedsReauth("__main__")).toBe(true);
  });

  test("a manual main pause prevents discovery and remains configured", async () => {
    oldAccount();
    const cfg = { ...config(), pausedCodexAccountIds: ["__main__"] };
    const { calls, codexAuthStatus } = answer(fakeChatGptJwt("acct-keyring-new"));
    await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", {
      nativeMainRefreshDependencies: { codexAuthStatus }, beginCodexAccountSelection: selection,
      primeCodexPoolQuotas: async () => {},
    })).rejects.toBeDefined();
    expect(calls).toEqual([]);
    expect(cfg.pausedCodexAccountIds).toEqual(["__main__"]);
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
  });
});
