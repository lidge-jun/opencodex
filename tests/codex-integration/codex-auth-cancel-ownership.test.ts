import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCodexAccountCredential, saveCodexAccountCredential } from "../../src/codex/account-store";
import { isAccountNeedsReauth, markAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { handleCodexAuthLoginCancel, handleCodexAuthLoginStart } from "../../src/codex/auth-api/login-flow";
import { CODEX_LOGIN_TERMINAL_TTL_MS, codexAuthLoginState } from "../../src/codex/auth-api/login-state";
import { handleCodexAuthAPI } from "../../src/codex/auth-api/routes";
import { saveConfig } from "../../src/config";
import { reconcileLiveStateStores, STATE_STORE_REGISTRATIONS, setLiveStateStoreConfig } from "../../src/lib/state-store-registrations";
import { registerStateStore } from "../../src/lib/state-store-sweeper";
import { cancelLoginFlow, clearLoginState, getLoginStatus, OAUTH_PROVIDERS, startLoginFlow, waitForLoginSettled } from "../../src/oauth";
import { saveCredential } from "../../src/oauth/store";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const OLD_ID = "cancel-ownership-old";
const NEW_ID = "cancel-ownership-new";
const TERMINAL_ID = "cancel-ownership-terminal";

function cancel(body: unknown): Promise<Response> {
  return handleCodexAuthLoginCancel(new Request("http://127.0.0.1/api/codex-auth/login/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("Codex OAuth cancel ownership", () => {
  test("a stale flow cannot abort or expire the active controller", async () => {
    const originalLogin = OAUTH_PROVIDERS.chatgpt.login;
    const signals: AbortSignal[] = [];
    OAUTH_PROVIDERS.chatgpt.login = async controller => {
      signals.push(controller.signal);
      controller.onAuth({ url: "about:blank" });
      return await new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("provider cancelled")), { once: true });
      });
    };

    try {
      await startLoginFlow("chatgpt", {}, { flowId: OLD_ID });
      codexAuthLoginState.set(OLD_ID, { status: "pending", startedAt: Date.now() });
      expect((await cancel({ flowId: OLD_ID })).status).toBe(200);
      expect(signals[0]?.aborted).toBe(true);
      expect(codexAuthLoginState.get(OLD_ID)?.status).toBe("error");

      await startLoginFlow("chatgpt", {}, { flowId: NEW_ID });
      codexAuthLoginState.set(NEW_ID, { status: "pending", startedAt: Date.now() });
      codexAuthLoginState.set(TERMINAL_ID, { status: "error", startedAt: Date.now(), doneAt: Date.now() });
      const active = signals[1];
      expect(active).toBeDefined();

      for (const body of [{}, { flowId: "" }, { flowId: "  " }, { flowId: 42 }, null, [],
        { flowId: "unknown-flow" }, { flowId: TERMINAL_ID }]) {
        expect((await cancel(body)).status).toBe(400);
        expect(active?.aborted).toBe(false);
        expect(codexAuthLoginState.get(NEW_ID)?.status).toBe("pending");
      }
      expect(codexAuthLoginState.has("unknown-flow")).toBe(false);
      expect(codexAuthLoginState.get(TERMINAL_ID)?.status).toBe("error");

      // A stale row can still say pending after its controller was replaced.
      codexAuthLoginState.set(OLD_ID, { status: "pending", startedAt: Date.now() });
      expect((await cancel({ flowId: OLD_ID })).status).toBe(400);
      expect(codexAuthLoginState.get(OLD_ID)?.status).toBe("pending");
      expect(active?.aborted).toBe(false);
      expect(getLoginStatus("chatgpt").done).toBe(false);

      const response = await cancel({ flowId: NEW_ID });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, cancelled: true });
      expect(active?.aborted).toBe(true);
      expect(codexAuthLoginState.get(NEW_ID)?.status).toBe("error");
      expect(codexAuthLoginState.get(OLD_ID)?.status).toBe("pending");

      await startLoginFlow("chatgpt");
      expect(cancelLoginFlow("chatgpt")).toBe(true);
      expect(signals[2]?.aborted).toBe(true);
    } finally {
      OAUTH_PROVIDERS.chatgpt.login = originalLogin;
      clearLoginState("chatgpt");
      codexAuthLoginState.delete(OLD_ID);
      codexAuthLoginState.delete(NEW_ID);
      codexAuthLoginState.delete(TERMINAL_ID);
    }
  });
});

test.each([
  "cancel before OAuth settles",
  "cancel during the pool usage probe",
  "newer OAuth flow succeeds",
  "delete an unrelated account before polling",
  "delete an unrelated account during the probe, then cancel",
] as const)(
  "pool reauth remains bound to its own flow when %s",
  async phase => {
    const home = mkdtempSync(join(tmpdir(), "ocx-pool-cancel-"));
    const priorOcxHome = process.env.OPENCODEX_HOME;
    const priorCodexHome = process.env.CODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    process.env.CODEX_HOME = join(home, "codex");
    const id = "pool-cancel";
    const unrelatedId = "pool-unrelated";
    const identity = "fixture-chatgpt-account";
    const expires = Date.now() + 60_000;
    const oauthCredential = { access: "fixture-oauth-access", refresh: "fixture-oauth-refresh", expires, accountId: identity };
    const poolCredential = { accessToken: "fixture-pool-access", refreshToken: "fixture-pool-refresh", expiresAt: expires, chatgptAccountId: identity };
    const config: OcxConfig = {
      port: 10100, defaultProvider: "openai",
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1" } },
      codexAccounts: [{ id }, { id: unrelatedId }],
    };
    const grant = Promise.withResolvers<typeof oauthCredential>();
    const probeStarted = Promise.withResolvers<void>();
    const probe = Promise.withResolvers<Response>();
    const pollStopped = Promise.withResolvers<void>();
    let poll: (() => void) | undefined;
    const originalSetTimeout = globalThis.setTimeout;
    async function waitForBarrier(barrier: Promise<void>, phase: string): Promise<void> {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([barrier, new Promise<never>((_, reject) => {
          deadline = originalSetTimeout(() => reject(new Error(`Timed out waiting for ${phase}`)), 1_000);
        })]);
      } finally {
        clearTimeout(deadline);
      }
    }
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) => {
      if (delay === 2_000) poll = () => callback(...args);
      else if (delay === CODEX_LOGIN_TERMINAL_TTL_MS) pollStopped.resolve();
      else if (delay !== 30_000) return originalSetTimeout(callback, delay, ...args);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async request => {
      if (String(request) === "https://chatgpt.com/backend-api/wham/usage") {
        probeStarted.resolve();
        return probe.promise;
      }
      throw new Error("Unexpected fetch in pool cancellation test");
    });
    const originalLogin = OAUTH_PROVIDERS.chatgpt.login;
    OAUTH_PROVIDERS.chatgpt.login = async controller => {
      controller.onAuth({ url: "https://example.test/oauth" });
      return grant.promise;
    };
    let flowId: string | undefined;
    let unregisterOAuthFlowStore: (() => void) | undefined;
    async function deleteUnrelatedAccount() {
      // A distinct name: re-registering "oauth-flow-state" would replace the process-wide entry, and
      // the cleanup unregister would then delete it for every later test in this process.
      const production = STATE_STORE_REGISTRATIONS.find(row => row.name === "oauth-flow-state")!;
      unregisterOAuthFlowStore = registerStateStore({ ...production, name: "oauth-flow-state:cancel-ownership-fixture" });
      setLiveStateStoreConfig(config);
      const url = new URL(`http://127.0.0.1/api/codex-auth/accounts?id=${unrelatedId}`);
      const deleted = await handleCodexAuthAPI(new Request(url, { method: "DELETE" }), url, config);
      expect(deleted?.status).toBe(200);
      expect(config.codexAccounts?.map(account => account.id)).toEqual([id]);
      expect(config.providers.chatgpt).toBeUndefined();
    }
    const exhausted = () => Response.json({ plan_type: "pro", rate_limit: {
      primary_window: { used_percent: 100, limit_window_seconds: 604800 },
    } });
    try {
      saveConfig(config);
      saveCodexAccountCredential(id, poolCredential);
      markAccountNeedsReauth(id);
      await saveCredential("chatgpt", oauthCredential);
      const resp = await handleCodexAuthLoginStart(new Request("http://127.0.0.1/api/codex-auth/login", {
        method: "POST",
        body: JSON.stringify({ id, reauth: true, openBrowser: false }),
      }), config);
      expect(resp.status).toBe(200);
      flowId = (await resp.json() as { flowId: string }).flowId;
      if (phase !== "cancel before OAuth settles") {
        grant.resolve(oauthCredential);
        expect(await waitForLoginSettled("chatgpt", 1_000, flowId)).toBe(true);
        expect(getLoginStatus("chatgpt", true, flowId).status).toBe("complete");
      }
      if (phase === "newer OAuth flow succeeds") {
        const newerId = "pool-reauth-newer-oauth";
        OAUTH_PROVIDERS.chatgpt.login = async controller => {
          controller.onAuth({ url: "https://example.test/oauth" });
          return { ...oauthCredential, access: "fixture-other-access", accountId: "other-fixture-account" };
        };
        await startLoginFlow("chatgpt", { forceLogin: true }, { flowId: newerId });
        expect(await waitForLoginSettled("chatgpt", 1_000, newerId)).toBe(true);
        expect(getLoginStatus("chatgpt").flowId).toBe(newerId);
        poll?.();
        probe.resolve(exhausted());
        await waitForBarrier(pollStopped.promise, "pool poller settlement");
        expect(codexAuthLoginState.get(flowId)).toMatchObject({ status: "done", accountId: id });
        expect(getCodexAccountCredential(id)?.accessToken).toBe(oauthCredential.access);
        expect(isAccountNeedsReauth(id)).toBe(false);
        return;
      }
      if (phase === "delete an unrelated account before polling") {
        await deleteUnrelatedAccount();
        expect(getLoginStatus("chatgpt", true, flowId)).toMatchObject({ status: "complete", flowId });
        poll?.();
        probe.resolve(exhausted());
        await waitForBarrier(pollStopped.promise, "pool poller settlement");
        expect(codexAuthLoginState.get(flowId)).toMatchObject({ status: "done", accountId: id });
        expect(getCodexAccountCredential(id)?.accessToken).toBe(oauthCredential.access);
        reconcileLiveStateStores();
        expect(getLoginStatus("chatgpt", true, flowId).status).toBe("idle");
        return;
      }
      if (phase === "cancel during the pool usage probe" || phase === "delete an unrelated account during the probe, then cancel") {
        poll?.();
        await waitForBarrier(probeStarted.promise, "pool usage probe");
      }
      if (phase === "delete an unrelated account during the probe, then cancel") await deleteUnrelatedAccount();
      const cancelled = await cancel({ flowId });
      if (phase === "cancel before OAuth settles") {
        grant.resolve(oauthCredential);
        poll?.();
      }
      probe.resolve(exhausted());
      await waitForBarrier(pollStopped.promise, "pool poller settlement");
      expect(cancelled.status).toBe(200);
      expect(codexAuthLoginState.get(flowId)).toMatchObject({ status: "error", error: "Login cancelled" });
      expect(getCodexAccountCredential(id)).toEqual(poolCredential);
      expect(isAccountNeedsReauth(id)).toBe(true);
      if (phase === "cancel before OAuth settles") expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      unregisterOAuthFlowStore?.();
      grant.resolve(oauthCredential);
      probe.resolve(exhausted());
      clearLoginState("chatgpt");
      if (flowId) codexAuthLoginState.delete(flowId);
      timer.mockRestore();
      fetchSpy.mockRestore();
      OAUTH_PROVIDERS.chatgpt.login = originalLogin;
      if (priorOcxHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = priorOcxHome;
      if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = priorCodexHome;
      await removeTreeWithRetry(home);
    }
  },
);
