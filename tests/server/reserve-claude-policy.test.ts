import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import * as authContext from "../../src/codex/auth-context";
import * as liveStores from "../../src/lib/state-store-registrations";
import * as pacing from "../../src/providers/request-pacing";
import { clearAccountQuota } from "../../src/codex/quota";
import { clearMainAccountInfoCache, observeMainQuotaCredential } from "../../src/codex/main-account-cache";
import { reconcileMainCodexAccountRuntimeState, resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { setMainAccountPlan } from "../../src/codex/main-account";
import { isNativeMainTrafficBlocked, waitForNativeMainStartupGate } from "../../src/codex/native-profile-startup";
import { startServer } from "../../src/server";
import { resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { ownedServiceHomeInspection } from "../helpers/owned-service-home-inspection";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { INTERNAL_DEADLINE_MS, SERVER_BUDGET_MS } from "../helpers/test-budget";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function clearState(): void {
  clearAccountQuota();
  clearMainAccountInfoCache();
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountNeedsReauth("__main__");
  resetMainCodexAccountIdentityTrackingForTests();
  resetLifecycleDrainStateForTests();
  pacing.resetProviderRequestPacingForTest();
  setMainAccountPlan(null);
}

/** Independent primary-loopback fixture: /v1/messages is not allowed on the secondary listener. */
async function claudePolicyFixture() {
  const names = ["OPENCODEX_HOME", "CODEX_HOME", "OPENCODEX_API_AUTH_TOKEN", "OPENCODEX_ADMIN_AUTH_TOKEN"] as const;
  const oldEnv = names.map(name => [name, process.env[name]] as const);
  const root = mkdtempSync(join(tmpdir(), "ocx-reserve-claude-policy-"));
  const codexHome = join(root, "codex");
  const configHome = join(root, "ocx");
  mkdirSync(codexHome); mkdirSync(configHome);
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = configHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = "ocx_data_claude_policy_fixture";
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "claude-policy-admin-fixture";
  const aclOk = { success: true, exitCode: 0, timedOut: false, stdout: "" };
  setIcaclsRunnerForTests(() => aclOk);
  setAsyncIcaclsRunnerForTests(async () => aclOk);
  clearState();
  const accountId = "claude-policy-owned-account";
  const accessToken = fakeChatGptJwt({ exp: 4_000_000_000,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
  writeFileSync(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n');
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {
    access_token: accessToken, account_id: accountId, refresh_token: "claude-policy-refresh-fixture",
  } }));
  const nativeFetch = globalThis.fetch;
  const restores: Array<() => void> = [];
  const entered = deferred();
  const release = deferred();
  const abort = new AbortController();
  let liveConfig: OcxConfig | undefined;
  let replayConfig: OcxConfig | undefined;
  let policy: authContext.CodexAuthPolicyConfig | undefined;
  let receivedAdmission: string | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  const counters = { wham: 0, inference: 0 };
  const unexpected: string[] = [];

  const close = async () => {
    release.resolve();
    abort.abort();
    try { await server?.stop(true); }
    finally {
      globalThis.fetch = nativeFetch;
      for (const restore of restores.reverse()) restore();
      clearState();
      try { await flushConfigDirHardeningForTests(); }
      finally {
        setIcaclsRunnerForTests(null); setAsyncIcaclsRunnerForTests(null);
        for (const [name, value] of oldEnv) {
          if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
        removeTreeWithRetry(root);
      }
    }
    expect(unexpected).toEqual([]);
  };

  try {
    const realSetLive = liveStores.setLiveStateStoreConfig;
    const liveSpy = spyOn(liveStores, "setLiveStateStoreConfig").mockImplementation(config => {
      liveConfig = config;
      realSetLive(config);
    });
    restores.push(() => liveSpy.mockRestore());
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.href === "https://chatgpt.com/backend-api/wham/usage") {
        counters.wham++;
        return Response.json({ rate_limit: { allowed: true } });
      }
      if (url.origin === "https://chatgpt.com" && url.pathname.endsWith("/models")) return Response.json({ models: [] });
      if (url.href === "https://chatgpt.com/backend-api/codex/responses") {
        counters.inference++;
        expect(request.headers.get("authorization")).toBe(`Bearer ${accessToken}`);
        const body = await request.json() as { model: string; stream?: boolean };
        expect(body.model).toBe("gpt-reserve");
        const response = { id: "resp_claude_policy", object: "response", status: "completed", model: body.model,
          output: [{ id: "msg_fixture", type: "message", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: "fixture response", annotations: [] }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
        if (!body.stream) return Response.json(response);
        const events = [{ type: "response.created", response: { ...response, status: "in_progress" } },
          { type: "response.output_text.delta", item_id: "msg_fixture", output_index: 0, content_index: 0, delta: "fixture response" },
          { type: "response.completed", response }];
        return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } });
      }
      unexpected.push(`${url.origin}${url.pathname}`);
      throw new Error("Unexpected outbound request in Claude policy fixture");
    }, { preconnect() {} });

    saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "openai", openaiProviderTierVersion: 2,
      codexDesktopAuthless: false, codexMainAccountHardLock: false, subagentModels: [], codexAccounts: [],
      providers: { openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct",
        upstreamWebsocket: false, baseUrl: "https://chatgpt.com/backend-api/codex" } },
      webSearchSidecar: { enabled: false, model: "global-search", timeoutMs: 12_345 },
      visionSidecar: { enabled: false, model: "global-vision", timeoutMs: 23_456 },
      claudeCode: { enabled: true, modelMap: { "reserve-policy-test": "openai/gpt-reserve" },
        webSearchSidecar: { model: "claude-search" }, visionSidecar: { model: "claude-vision" } },
    });
    server = startServer(0, { inspectNativeCodexOwnership: ownedServiceHomeInspection("Claude live-policy fixture") });
    await waitForNativeMainStartupGate();
    expect(isNativeMainTrafficBlocked()).toBe(false);
    reconcileMainCodexAccountRuntimeState();
    observeMainQuotaCredential(accessToken, accountId);
    if (!liveConfig) throw new Error("fixture expected the live server config");
    expect(liveConfig.hostname).toBe("127.0.0.1");
    expect(liveConfig.unauthenticatedLoopbackListener?.enabled).not.toBe(true);
    const realResolve = authContext.resolveCodexAuthContext;
    const authSpy = spyOn(authContext, "resolveCodexAuthContext").mockImplementation((headers, config, mode, options) => {
      replayConfig = config;
      policy = options?.codexAuthPolicy;
      receivedAdmission = options?.admission?.source;
      return realResolve(headers, config, mode, options);
    });
    restores.push(() => authSpy.mockRestore());
    const realPacing = pacing.waitForProviderRequestSlot;
    const pacingSpy = spyOn(pacing, "waitForProviderRequestSlot").mockImplementation(async (name, provider, model, signal) => {
      if (name === "openai" && model === "gpt-reserve") {
        entered.resolve();
        await release.promise;
      }
      return realPacing(name, provider, model, signal);
    });
    restores.push(() => pacingSpy.mockRestore());
    counters.wham = 0; counters.inference = 0;
    const original = liveConfig;
    const request = () => nativeFetch(`http://127.0.0.1:${server!.port}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "reserve-policy-test", max_tokens: 32,
        messages: [{ role: "user", content: "fixture request" }], stream: false }),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(INTERNAL_DEADLINE_MS)]),
    }).then(async response => ({ status: response.status, text: await response.text() }));
    return { original, request, entered: entered.promise, release: release.resolve, counters, close,
      assertReplayBoundary: () => {
        expect(receivedAdmission).toBe("loopback");
        expect(policy).toBe(original);
        expect(replayConfig).not.toBe(original);
        expect(replayConfig?.codexDesktopAuthless).toBe(false);
        expect(replayConfig?.webSearchSidecar).toMatchObject({ model: "claude-search", timeoutMs: 12_345, enabled: false });
        expect(replayConfig?.visionSidecar).toMatchObject({ model: "claude-vision", timeoutMs: 23_456, enabled: false });
        expect(original.webSearchSidecar?.model).toBe("global-search");
        expect(original.visionSidecar?.model).toBe("global-vision");
      },
    };
  } catch (error) { await close(); throw error; }
}

describe("Claude replay preserves live Reserve policy", () => {
  for (const enableWhilePaced of [true, false]) {
    test(`primary loopback Messages: ${enableWhilePaced ? "off-to-on refuses" : "still-off dispatches"} after replay creation`, async () => {
      const fixture = await claudePolicyFixture();
      try {
        const observed = fixture.request().then(
          response => ({ kind: "response" as const, response }),
          (error: unknown) => ({ kind: "error" as const, error }),
        );
        const first = await Promise.race([
          fixture.entered.then(() => "paced" as const), observed.then(() => "finished-before-pacing" as const),
        ]);
        expect(first).toBe("paced");
        fixture.assertReplayBoundary();
        if (enableWhilePaced) fixture.original.codexDesktopAuthless = true;
        fixture.release();
        const outcome = await observed;
        if (outcome.kind !== "response") throw outcome.error;
        expect(outcome.response.status).toBe(enableWhilePaced ? 429 : 200);
        expect(outcome.response.text).toContain(enableWhilePaced ? "Reserve is unavailable" : "fixture response");
        expect(fixture.counters).toEqual({ wham: 0, inference: enableWhilePaced ? 0 : 1 });
        fixture.assertReplayBoundary();
      } finally { await fixture.close(); }
    }, SERVER_BUDGET_MS);
  }
});
