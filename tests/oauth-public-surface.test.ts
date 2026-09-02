import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync} from "node:fs";
import { join } from "node:path";
import {
  cancelLoginFlow,
  clearLoginState,
  getLoginStatus,
  isOAuthProvider,
  isPublicOAuthProvider,
  listOAuthProviders,
  OAUTH_PROVIDERS,
  runLogin,
  startLoginFlow,
  upsertOAuthProvider,
} from "../src/oauth";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import type { OAuthController } from "../src/oauth/types";
import { getCredential } from "../src/oauth/store";
import * as oauthStore from "../src/oauth/store";
import { flushConfigDirHardeningForTests } from "../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../src/lib/windows-secret-acl";

// Server-less OAuth store test: nothing drains hardenConfigDir()'s icacls flight before
// teardown (run 33612731522 shard 3). Same treatment as oauth-reauth-bind.
const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };
import { armClaudeCodeBaseline, loadConfig, saveConfig, saveConfigPreservingClaudeCode } from "../src/config";
import { isApiAuthRequired, requireApiAuth } from "../src/server/auth-cors";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const TEST_DIR = join(import.meta.dir, ".tmp-oauth-public-surface");
const PUBLIC_OAUTH_ERROR = "OAuth authentication failed. Check the OpenCodex account status and retry.";
const previousHome = process.env.OPENCODEX_HOME;
const canonical = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward" as const,
};

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: { openai: { ...canonical, codexAccountMode: "pool" } },
  };
}

beforeEach(() => {
  setIcaclsRunnerForTests(() => ICACLS_OK);
  setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
  clearLoginState("xai");
  removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
});

afterEach(async () => {
  clearLoginState("xai");
  await flushConfigDirHardeningForTests();
  setIcaclsRunnerForTests(null);
  setAsyncIcaclsRunnerForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(TEST_DIR);
});

async function waitForOAuthDone(provider: string): Promise<ReturnType<typeof getLoginStatus>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = getLoginStatus(provider);
    if (status.done) return status;
    await Bun.sleep(5);
  }
  throw new Error(`OAuth login for ${provider} did not settle`);
}

describe("legacy ChatGPT OAuth public-surface exclusion", () => {
  test("keeps low-level compatibility but excludes public discovery", () => {
    expect(isOAuthProvider("chatgpt")).toBe(true);
    expect(isPublicOAuthProvider("chatgpt")).toBe(false);
    expect(listOAuthProviders()).not.toContain("chatgpt");
    expect(listOAuthProviders()).toContain("xai");
    expect(listOAuthProviders()).toContain("github-copilot");
    expect(isPublicOAuthProvider("github-copilot")).toBe(true);
  });

  test("generic management OAuth endpoints reject chatgpt before touching login state", async () => {
    const cfg = config();
    const requests = [
      new Request("http://localhost/api/oauth/login", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "chatgpt" }),
      }),
      new Request("http://localhost/api/oauth/login/code", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "chatgpt", input: "code" }),
      }),
      new Request("http://localhost/api/oauth/status?provider=chatgpt"),
      new Request("http://localhost/api/oauth/logout?provider=chatgpt", { method: "POST" }),
      new Request("http://localhost/api/oauth/accounts?provider=chatgpt"),
      new Request("http://localhost/api/oauth/accounts/active", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "chatgpt", accountId: "a" }),
      }),
      new Request("http://localhost/api/oauth/accounts?provider=chatgpt&id=a", { method: "DELETE" }),
    ];
    for (const req of requests) {
      const response = await handleManagementAPI(req, new URL(req.url), cfg);
      expect(response?.status).toBe(400);
      expect(await response?.json()).toEqual({ error: "unknown oauth provider" });
    }
    const discoveryReq = new Request("http://localhost/api/oauth/providers");
    const discovery = await handleManagementAPI(discoveryReq, new URL(discoveryReq.url), cfg);
    expect((await discovery?.json() as { providers: string[] }).providers).not.toContain("chatgpt");
  });

  test("internal chatgpt login persists credentials without creating a fourth provider", async () => {
    const cfg = config();
    upsertOAuthProvider(cfg, "chatgpt");
    expect(cfg.providers.chatgpt).toBeUndefined();

    const originalLogin = OAUTH_PROVIDERS.chatgpt.login;
    OAUTH_PROVIDERS.chatgpt.login = async () => ({
      access: "legacy-access",
      refresh: "legacy-refresh",
      expires: Date.now() + 60_000,
    });
    try {
      await runLogin("chatgpt", {} as OAuthController);
    } finally {
      OAUTH_PROVIDERS.chatgpt.login = originalLogin;
    }
    expect(getCredential("chatgpt")?.access).toBe("legacy-access");
    expect(cfg.providers.chatgpt).toBeUndefined();
  });

  test("OAuth provider creation rejects account namespace collisions before login or mutation", async () => {
    const cfg = config();
    cfg.codexAccountNamespaces = { XAI: "side-account-id" };
    const before = structuredClone(cfg.providers);

    expect(() => upsertOAuthProvider(cfg, "xai")).toThrow(/must not collide with a configured Codex account namespace/);
    expect(cfg.providers).toEqual(before);

    const routeReq = new Request("http://localhost/api/oauth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "xai" }),
    });
    const routeResponse = await handleManagementAPI(routeReq, new URL(routeReq.url), cfg);
    expect(routeResponse?.status).toBe(409);
    expect(await routeResponse?.json()).toEqual({
      error: "provider name must not collide with a configured Codex account namespace",
    });

    saveConfig(cfg);
    const originalLogin = OAUTH_PROVIDERS.xai.login;
    let loginCalls = 0;
    OAUTH_PROVIDERS.xai.login = async () => {
      loginCalls += 1;
      return { access: "must-not-save", refresh: "must-not-save" };
    };
    try {
      await expect(runLogin("xai", {} as OAuthController)).rejects.toThrow(
        /must not collide with a configured Codex account namespace/,
      );
    } finally {
      OAUTH_PROVIDERS.xai.login = originalLogin;
    }
    expect(loginCalls).toBe(0);
    expect(getCredential("xai")).toBeNull();

    saveConfig(config());
    OAUTH_PROVIDERS.xai.login = async () => {
      loginCalls += 1;
      const changedDuringLogin = config();
      changedDuringLogin.codexAccountNamespaces = { xai: "side-account-id" };
      saveConfig(changedDuringLogin);
      return { access: "must-not-save", refresh: "must-not-save" };
    };
    try {
      await expect(runLogin("xai", {} as OAuthController)).rejects.toThrow(
        /must not collide with a configured Codex account namespace/,
      );
    } finally {
      OAUTH_PROVIDERS.xai.login = originalLogin;
    }
    expect(loginCalls).toBe(1);
    expect(getCredential("xai")).toBeNull();
  });

  test("OAuth provider creation preserves a namespace claimed after credential persistence", async () => {
    saveConfig(config());
    const originalLogin = OAUTH_PROVIDERS.xai.login;
    const originalSaveCredential = oauthStore.saveCredential;
    let changedAfterCredential = false;
    let credentialWrites = 0;
    OAUTH_PROVIDERS.xai.login = async () => ({
      access: "post-check-access",
      refresh: "post-check-refresh",
      accountId: "post-check-account",
      expires: Date.now() + 60_000,
    });
    const saveSpy = spyOn(oauthStore, "saveCredential").mockImplementation(async (provider, credential) => {
      credentialWrites += 1;
      await originalSaveCredential(provider, credential);
      const changed = config();
      changed.defaultProvider = "concurrent";
      changed.providers.concurrent = {
        adapter: "openai-chat",
        baseUrl: "https://concurrent.example.test/v1",
      };
      changed.codexAccountNamespaces = {
        XAI: "side-account-id",
        retained: "retained-account-id",
      };
      saveConfig(changed);
      changedAfterCredential = true;
    });

    try {
      await expect(runLogin("xai", {} as OAuthController)).rejects.toThrow(
        "OAuth credential was saved, but the provider entry was not written. Resolve the account namespace collision, then retry login.",
      );
    } finally {
      OAUTH_PROVIDERS.xai.login = originalLogin;
      saveSpy.mockRestore();
    }

    expect(changedAfterCredential).toBe(true);
    expect(credentialWrites).toBe(1);
    expect(getCredential("xai")?.access).toBe("post-check-access");
    const persistedConfig = loadConfig();
    expect(persistedConfig).toMatchObject({
      defaultProvider: "concurrent",
      providers: {
        concurrent: {
          adapter: "openai-chat",
          baseUrl: "https://concurrent.example.test/v1",
        },
      },
      codexAccountNamespaces: {
        XAI: "side-account-id",
        retained: "retained-account-id",
      },
    });
    expect(persistedConfig.providers.xai).toBeUndefined();
  });

  test("OAuth provider creation preserves same-provider key changes during credential persistence", async () => {
    const seeded = config();
    seeded.providers.xai = {
      ...OAUTH_PROVIDERS.xai.providerConfig,
      authMode: "key",
      apiKey: "test-key-a",
      apiKeyPool: [{ id: "key-a", key: "test-key-a" }],
    };
    saveConfig(seeded);
    const originalLogin = OAUTH_PROVIDERS.xai.login;
    const originalSaveCredential = oauthStore.saveCredential;
    OAUTH_PROVIDERS.xai.login = async () => ({
      access: "same-provider-access",
      refresh: "same-provider-refresh",
      accountId: "same-provider-account",
      expires: Date.now() + 60_000,
    });
    const saveSpy = spyOn(oauthStore, "saveCredential").mockImplementation(async (provider, credential) => {
      await originalSaveCredential(provider, credential);
      const changed = loadConfig();
      changed.providers.xai = {
        ...changed.providers.xai!,
        authMode: "key",
        apiKey: "test-key-b",
        apiKeyPool: [
          { id: "key-a", key: "test-key-a" },
          { id: "key-b", key: "test-key-b" },
        ],
      };
      saveConfig(changed);
    });

    try {
      await runLogin("xai", {} as OAuthController);
    } finally {
      OAUTH_PROVIDERS.xai.login = originalLogin;
      saveSpy.mockRestore();
    }

    expect(loadConfig().providers.xai).toMatchObject({
      authMode: "key",
      apiKey: "test-key-b",
      apiKeyPool: [
        { id: "key-a", key: "test-key-a" },
        { id: "key-b", key: "test-key-b" },
      ],
    });
  });

  test("management OAuth activates the live provider only after persistence succeeds", async () => {
    const liveConfig = config();
    saveConfig(liveConfig);
    const originalLogin = OAUTH_PROVIDERS.xai.login;
    let releaseLogin!: () => void;
    const loginGate = new Promise<void>((resolve) => { releaseLogin = resolve; });
    OAUTH_PROVIDERS.xai.login = async (ctrl) => {
      ctrl.onAuth({
        url: "https://auth.example.test/authorize",
        deviceCode: "test-device-code",
      });
      await loginGate;
      return {
        access: "successful-access",
        refresh: "successful-refresh",
        accountId: "successful-account",
        expires: Date.now() + 60_000,
      };
    };

    try {
      const request = new Request("http://localhost/api/oauth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "xai" }),
      });
      const response = await handleManagementAPI(request, new URL(request.url), liveConfig);
      expect(response?.status).toBe(200);
      expect(liveConfig.providers.xai).toBeUndefined();
      expect(getLoginStatus("xai").done).toBe(false);

      releaseLogin();
      const status = await waitForOAuthDone("xai");
      expect(status.error).toBeUndefined();
      expect(status.loggedIn).toBe(true);
      expect(liveConfig.providers.xai).toEqual(loadConfig().providers.xai);
      expect(liveConfig.providers.xai).toBeDefined();
    } finally {
      releaseLogin();
      OAUTH_PROVIDERS.xai.login = originalLogin;
      clearLoginState("xai");
    }
  });

  test("management OAuth merges its provider row with a pending live provider edit", async () => {
    const liveConfig = config();
    saveConfig(liveConfig);
    liveConfig.providers.xai = {
      ...OAUTH_PROVIDERS.xai.providerConfig,
      selectedModels: ["pending-model"],
    };
    const originalLogin = OAUTH_PROVIDERS.xai.login;
    OAUTH_PROVIDERS.xai.login = async (ctrl) => {
      ctrl.onAuth({
        url: "https://auth.example.test/authorize",
        deviceCode: "same-provider-device-code",
      });
      return {
        access: "same-provider-access",
        refresh: "same-provider-refresh",
        accountId: "same-provider-account",
        expires: Date.now() + 60_000,
      };
    };

    try {
      const request = new Request("http://localhost/api/oauth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "xai" }),
      });
      const response = await handleManagementAPI(request, new URL(request.url), liveConfig);
      expect(response?.status).toBe(200);

      const status = await waitForOAuthDone("xai");
      expect(status).toMatchObject({ done: true, loggedIn: true });
      expect(status.error).toBeUndefined();
      expect(liveConfig.providers.xai).toMatchObject({
        ...loadConfig().providers.xai,
        selectedModels: ["pending-model"],
      });

      saveConfigPreservingClaudeCode(liveConfig);
      expect(loadConfig().providers.xai?.selectedModels).toEqual(["pending-model"]);
    } finally {
      OAUTH_PROVIDERS.xai.login = originalLogin;
      clearLoginState("xai");
    }
  });

  test("OAuth settlement preserves the original login failure", async () => {
    saveConfig(config());
    const originalLogin = OAUTH_PROVIDERS.xai.login;
    OAUTH_PROVIDERS.xai.login = async (ctrl) => {
      ctrl.onAuth({
        url: "https://auth.example.test/authorize",
        deviceCode: "failed-login-device-code",
      });
      throw new Error("browser flow aborted");
    };

    try {
      await startLoginFlow("xai", undefined, {
        onSettled: () => { throw new Error("runtime reconciliation failed"); },
      });
      const status = await waitForOAuthDone("xai");
      expect(status.done).toBe(true);
      expect(status.error).toBe(PUBLIC_OAUTH_ERROR);
    } finally {
      OAUTH_PROVIDERS.xai.login = originalLogin;
      clearLoginState("xai");
    }
  });

  test("OAuth settlement reports reconciliation failure after a successful login", async () => {
    saveConfig(config());
    const originalLogin = OAUTH_PROVIDERS.xai.login;
    OAUTH_PROVIDERS.xai.login = async (ctrl) => {
      ctrl.onAuth({
        url: "https://auth.example.test/authorize",
        deviceCode: "successful-login-device-code",
      });
      return {
        access: "successful-access",
        refresh: "successful-refresh",
        accountId: "successful-account",
        expires: Date.now() + 60_000,
      };
    };

    try {
      await startLoginFlow("xai", undefined, {
        onSettled: () => { throw new Error("runtime reconciliation failed"); },
      });
      const status = await waitForOAuthDone("xai");
      expect(status.done).toBe(true);
      expect(status.error).toBe(PUBLIC_OAUTH_ERROR);
    } finally {
      OAUTH_PROVIDERS.xai.login = originalLogin;
      clearLoginState("xai");
    }
  });

  test("OAuth cancellation remains terminal after the provider rejects", async () => {
    const originalLogin = OAUTH_PROVIDERS.xai.login;
    OAUTH_PROVIDERS.xai.login = async (ctrl) => {
      ctrl.onAuth({ url: "", deviceCode: "cancel-flow-device-code" });
      await new Promise<never>((_, reject) => {
        ctrl.signal.addEventListener("abort", () => reject(new Error("late provider abort after cancellation")), { once: true });
      });
    };

    try {
      await startLoginFlow("xai");
      expect(cancelLoginFlow("xai")).toBe(true);
      await Bun.sleep(20);

      expect(getLoginStatus("xai")).toMatchObject({
        done: true,
        error: "Login cancelled",
      });
    } finally {
      OAUTH_PROVIDERS.xai.login = originalLogin;
      clearLoginState("xai");
    }
  });

  test("a superseded OAuth flow cannot commit after its replacement owns the provider", async () => {
    saveConfig(config());
    const originalLogin = OAUTH_PROVIDERS.xai.login;
    let loginCalls = 0;
    OAUTH_PROVIDERS.xai.login = async (ctrl) => {
      loginCalls += 1;
      const call = loginCalls;
      ctrl.onAuth({ url: `https://auth.example.test/${call}`, deviceCode: `flow-${call}` });
      return {
        access: `access-${call}`,
        refresh: `refresh-${call}`,
        accountId: `account-${call}`,
        email: `account-${call}@example.test`,
        expires: Date.now() + 60_000,
      };
    };

    let releaseHead!: () => void;
    let signalHeadStarted!: () => void;
    const headStarted = new Promise<void>(resolve => { signalHeadStarted = resolve; });
    const headGate = new Promise<void>(resolve => { releaseHead = resolve; });
    const blockingMutation = oauthStore.mutateStore(async () => {
      signalHeadStarted();
      await headGate;
    });

    const waitForMutationCount = async (minimum: number): Promise<void> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (oauthStore.oauthMutationTailSnapshot().active >= minimum) return;
        await Bun.sleep(5);
      }
      throw new Error(`OAuth mutation queue did not reach ${minimum} active rows`);
    };

    try {
      await headStarted;
      await startLoginFlow("xai");
      await waitForMutationCount(2);
      expect(cancelLoginFlow("xai")).toBe(true);

      await startLoginFlow("xai");
      await waitForMutationCount(3);
      releaseHead();
      await blockingMutation;

      const status = await waitForOAuthDone("xai");
      expect(status).toMatchObject({ done: true, loggedIn: true });
      expect(getCredential("xai")).toMatchObject({
        access: "access-2",
        accountId: "account-2",
      });
      expect(oauthStore.getAccountSet("xai")?.accounts.map(account => account.credential.accountId))
        .toEqual(["account-2"]);
    } finally {
      releaseHead();
      await blockingMutation.catch(() => {});
      OAUTH_PROVIDERS.xai.login = originalLogin;
      clearLoginState("xai");
    }
  });

  test("Kiro does not start a replacement until the canceled external CLI flow settles", async () => {
    saveConfig(config());
    const originalLogin = OAUTH_PROVIDERS.kiro.login;
    let loginCalls = 0;
    OAUTH_PROVIDERS.kiro.login = async (ctrl) => {
      loginCalls += 1;
      const call = loginCalls;
      ctrl.onAuth({ url: "", deviceCode: `kiro-flow-${call}` });
      if (call === 1) {
        await new Promise<never>((_, reject) => {
          ctrl.signal.addEventListener("abort", () => reject(new Error("Kiro login cancelled")), { once: true });
        });
      }
      return {
        access: "kiro-replacement-access",
        refresh: "kiro-replacement-refresh",
        accountId: "kiro-replacement-account",
        email: "kiro-replacement@example.test",
        expires: Date.now() + 60_000,
      };
    };

    try {
      await startLoginFlow("kiro");
      expect(cancelLoginFlow("kiro")).toBe(true);
      await expect(startLoginFlow("kiro")).rejects.toThrow("A login for kiro is already in progress");

      let replacement: Awaited<ReturnType<typeof startLoginFlow>> | undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          replacement = await startLoginFlow("kiro");
          break;
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("already in progress")) throw error;
          await Bun.sleep(5);
        }
      }
      expect(replacement).toMatchObject({ deviceCode: "kiro-flow-2" });
      expect(await waitForOAuthDone("kiro")).toMatchObject({ done: true, loggedIn: true });
      expect(loginCalls).toBe(2);
    } finally {
      OAUTH_PROVIDERS.kiro.login = originalLogin;
      clearLoginState("kiro");
    }
  });

  test("management OAuth safely reconciles live config after a late namespace claim", async () => {
    const liveConfig = config();
    liveConfig.hostname = "0.0.0.0";
    liveConfig.port = 10444;
    liveConfig.claudeCode = { authMode: "subscription" };
    saveConfig(liveConfig);
    armClaudeCodeBaseline(liveConfig);
    // Model visibility has mutated the shared object but yielded before saving. OAuth
    // must not replace it with the pre-mutation disk snapshot when login settles.
    liveConfig.disabledModels = ["pending/provider-model"];
    const originalLogin = OAUTH_PROVIDERS.xai.login;
    const originalSaveCredential = oauthStore.saveCredential;
    OAUTH_PROVIDERS.xai.login = async (ctrl) => {
      ctrl.onAuth({
        url: "https://auth.example.test/authorize",
        deviceCode: "test-device-code",
      });
      return {
        access: "route-collision-access",
        refresh: "route-collision-refresh",
        accountId: "route-collision-account",
        expires: Date.now() + 60_000,
      };
    };
    const saveSpy = spyOn(oauthStore, "saveCredential").mockImplementation(async (provider, credential) => {
      await originalSaveCredential(provider, credential);
      const concurrentConfig = config();
      concurrentConfig.defaultProvider = "concurrent";
      concurrentConfig.providers.concurrent = {
        adapter: "openai-chat",
        baseUrl: "https://concurrent.example.test/v1",
      };
      concurrentConfig.codexAccountNamespaces = {
        XAI: "side-account-id",
        retained: "retained-account-id",
      };
      concurrentConfig.claudeCode = { authMode: "proxy" };
      saveConfig(concurrentConfig);
    });

    try {
      const request = new Request("http://localhost/api/oauth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "xai" }),
      });
      const response = await handleManagementAPI(request, new URL(request.url), liveConfig);
      expect(response?.status).toBe(200);

      const status = await waitForOAuthDone("xai");
      expect(status.loggedIn).toBe(true);
      expect(status.error).toBe(
        "OAuth credential was saved, but the provider entry was not written. Resolve the account namespace collision, then retry login.",
      );
      expect(getCredential("xai")?.access).toBe("route-collision-access");
      expect(liveConfig).toMatchObject({
        defaultProvider: "concurrent",
        providers: {
          concurrent: {
            adapter: "openai-chat",
            baseUrl: "https://concurrent.example.test/v1",
          },
        },
        codexAccountNamespaces: {
          XAI: "side-account-id",
          retained: "retained-account-id",
        },
      });
      expect(liveConfig.providers.xai).toBeUndefined();
      expect(liveConfig.claudeCode?.authMode).toBe("proxy");
      expect(liveConfig.disabledModels).toEqual(["pending/provider-model"]);
      // Reconciliation must not make the externally bound socket look loopback-only.
      expect(liveConfig.hostname).toBe("0.0.0.0");
      expect(liveConfig.port).toBe(10444);
      expect(isApiAuthRequired(liveConfig)).toBe(true);
      const forgedLoopbackRequest = new Request("http://localhost:10444/api/config", {
        headers: { host: "localhost:10444" },
      });
      expect(requireApiAuth(forgedLoopbackRequest, liveConfig, "management")?.status).toBe(401);
      expect(loadConfig().providers.xai).toBeUndefined();

      // A second disk edit must be compared with the state OAuth just adopted, not
      // the stale startup baseline, or this unrelated save would restore "proxy".
      const editedAgain = loadConfig();
      editedAgain.hostname = "127.0.0.1";
      editedAgain.port = 11445;
      editedAgain.claudeCode = { authMode: "subscription", systemEnv: true };
      saveConfig(editedAgain);

      saveConfigPreservingClaudeCode(liveConfig);
      const afterLaterSave = loadConfig();
      expect(afterLaterSave.codexAccountNamespaces).toEqual({
        XAI: "side-account-id",
        retained: "retained-account-id",
      });
      expect(afterLaterSave.providers.concurrent).toBeDefined();
      expect(afterLaterSave.providers.xai).toBeUndefined();
      expect(afterLaterSave.disabledModels).toEqual(["pending/provider-model"]);
      expect(afterLaterSave.claudeCode).toEqual({ authMode: "subscription", systemEnv: true });
      expect(liveConfig.claudeCode).toEqual({ authMode: "subscription", systemEnv: true });
      // Runtime admission remains tied to the open socket, but the next-start
      // binding adopted from disk must survive this unrelated live save.
      expect(liveConfig.hostname).toBe("0.0.0.0");
      expect(liveConfig.port).toBe(10444);
      expect(afterLaterSave.hostname).toBe("127.0.0.1");
      expect(afterLaterSave.port).toBe(11445);
      expect(loadConfig()).toMatchObject({ hostname: "127.0.0.1", port: 11445 });
    } finally {
      OAUTH_PROVIDERS.xai.login = originalLogin;
      saveSpy.mockRestore();
      clearLoginState("xai");
    }
  });
});
import { ManagementRequest as Request } from "./helpers/management-auth";
