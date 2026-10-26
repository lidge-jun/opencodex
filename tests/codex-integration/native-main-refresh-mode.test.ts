import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  MainAuthJsonChangedDuringRefreshError,
  MainAccountTokenRefreshError,
} from "../../src/codex/main-account";
import { codexCredentialMutationEpoch } from "../../src/codex/credential-mutation-epoch";
import { resolveCodexAuthContext, materializeCodexUpstreamAuthAsync, CodexAuthContextError } from "../../src/codex/auth-context";
import { clearThreadAccountMap } from "../../src/codex/routing";
import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { withNativeMainSharedClaim } from "../../src/codex/native-main-claim";
import { resolveNativeProfileContext } from "../../src/codex/native-profile-store";
import type { OcxConfig } from "../../src/types";
import type { ResolveCodexRuntimeResult } from "../../src/codex/runtime";
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

    await expect(getValidMainAccountToken({ codexAuthStatus })).rejects.toBeInstanceOf(MainAccountTokenRefreshError);
    expect(getMainAccountCredentialStatus().usable).toBe(false);
  });

  test("a keyring refresh refusal cannot resurrect the rejected bearer", async () => {
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
    expect(isMainAccountRefreshGrantRejected()).toBe(true);
    await expect(getValidMainAccountToken({ codexAuthStatus })).rejects.toMatchObject({ reason: "reauth" });
    status = { authMethod: "chatgpt", authToken: fakeChatGptJwt("acct-new-login"), requiresOpenaiAuth: true };
    expect((await getValidMainAccountToken({ codexAuthStatus }))?.chatgptAccountId).toBe("acct-new-login");
    expect(isMainAccountRefreshGrantRejected()).toBe(false);
  });

  test("a chatgpt login with a withheld token means reauthentication", async () => {
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
