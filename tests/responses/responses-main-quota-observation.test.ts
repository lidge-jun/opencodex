import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAIN_CODEX_ACCOUNT_ID as MAIN } from "../../src/codex/account-id";
import * as mainCache from "../../src/codex/main-account-cache";
import {
  CodexReserveUnavailableError, materializeCodexUpstreamAuth, materializeCodexUpstreamAuthAsync, resolveCodexAuthContext,
  type CodexAuthContext,
} from "../../src/codex/auth-context";
import { beginNativeMainReauth, forceRefreshMainAccountToken } from "../../src/codex/main-account";
import { advanceCodexCredentialMutationEpoch, codexCredentialMutationEpoch } from "../../src/codex/credential-mutation-epoch";
import { resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, getAccountQuota, getMainPolicyQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { captureConfigGeneration } from "../../src/lib/state-store-sweeper";
import { parseRequest } from "../../src/responses/parser";
import { codexAccountSelectionForTurn, tryAdmitTurn } from "../../src/server/lifecycle";
import { handleResponses } from "../../src/server/responses";
import { BOUNDED_WS_RUNTIME } from "../helpers/ws-upstream-fixtures";
import { deliverPassthroughResponse } from "../../src/server/responses/passthrough-delivery";
import { codexWsQuotaObserver, retryCodexPoolOnAlternateAccount } from "../../src/server/responses/core-codex-account";
import { CodexWsMetadata } from "../../src/server/responses/codex-ws-metadata";
import { codexWsExchange } from "../../src/server/responses/codex-ws-exchange";
import { CodexWsSession } from "../../src/server/responses/codex-ws-session";
import { CODEX_RESPONSES_HTTP_URL, CODEX_RESPONSES_WS_URL, prepareCodexWsRequest } from "../../src/server/responses/codex-ws-request";
import { NATIVE_RESERVE_MODEL } from "../../src/codex/catalog/native-models";
import { getMainAccountHardLockStatus } from "../../src/codex/main-account-hard-lock";
import { CODEX_WS_RESPONSE_PRELUDE_TIMEOUT_MS, isCodexWsPreludeProjection } from "../../src/server/responses/ws-upstream";
import { UPGRADE_DEADLINE_MS, markCodexWsResponse, isCodexWsQuotaObservedResponse, isCodexWsUpstreamResponse } from "../../src/server/responses/codex-ws-wire";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/agent-task-recovery";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

const ACCOUNT = "fixture-observed-main";
const POOL = "fixture-observed-pool";
const provider: OcxProviderConfig = {
  adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex",
};
const originalFetch = globalThis.fetch;
let root: string;
let oldOcxHome: string | undefined;
let oldCodexHome: string | undefined;
let bearer: string;
let config: OcxConfig;
let releaseSpend: (() => void) | undefined;
let pendingPersist: { run: () => void; timer: ReturnType<typeof setTimeout> } | undefined;
let clock: ReturnType<typeof installPersistenceClock>;
let pendingPreludeTimeout: (() => void) | undefined;
let pendingUpgradeTimeout: (() => void) | undefined;

// Exercise the real serializer without a wall-clock race, as main-quota-provenance does.
function installPersistenceClock() {
  const nativeTimeout = globalThis.setTimeout;
  return spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]
  ) => {
    if (delay === UPGRADE_DEADLINE_MS) {
      pendingUpgradeTimeout = () => callback(...args);
      return nativeTimeout(() => {}, delay);
    }
    if (delay === CODEX_WS_RESPONSE_PRELUDE_TIMEOUT_MS) {
      pendingPreludeTimeout = () => callback(...args);
      return nativeTimeout(() => {}, delay);
    }
    if (delay !== 250) return nativeTimeout(callback, delay, ...args);
    const timer = nativeTimeout(() => {}, 60_000);
    pendingPersist = { run: () => callback(...args), timer };
    return timer;
  }) as typeof setTimeout);
}

function observe(token = bearer, account = ACCOUNT): void {
  mainCache.observeMainQuotaIdentity(account);
  expect(mainCache.observeMainQuotaCredential(token, account)).toBeDefined();
}
function caller(token = bearer, account: string | undefined = ACCOUNT): Headers {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (account !== undefined) headers.set("chatgpt-account-id", account);
  return headers;
}
function materialized(headers = caller()): Extract<CodexAuthContext, { kind: "main" }> {
  const ctx: Extract<CodexAuthContext, { kind: "main" }> = { kind: "main", accountId: null };
  materializeCodexUpstreamAuth(headers, ctx, { config, modelId: "gpt-5.5" });
  return ctx;
}
function quotaHeaders(percent = "23"): Headers {
  return new Headers({ "x-codex-primary-used-percent": percent, "x-codex-primary-window-minutes": "10080" });
}
function quotaResponse(headers = quotaHeaders()): Response {
  // A real upstream redirect takes the early relay return after quota publication. This keeps
  // this delivery fixture independent of unrelated success-body repair and continuation state.
  headers = new Headers(headers);
  headers.set("location", "https://chatgpt.com/backend-api/codex/responses");
  return new Response(null, { status: 307, headers });
}
async function deliver(ctx: CodexAuthContext, response = quotaResponse(), selectedProvider = provider): Promise<void> {
  type Args = Parameters<typeof deliverPassthroughResponse>;
  const budget = createTranslatorBudget();
  try {
    const result = await deliverPassthroughResponse(
      { config, logCtx: { model: "", provider: "" }, options: {}, req: new Request("http://localhost/v1/responses") },
      { authCtx: ctx } as Args[1],
      { parsed: parseRequest({ model: "gpt-5.5", input: "hi", stream: false }),
        route: { providerName: "openai", modelId: "gpt-5.5", provider: selectedProvider },
        clientRequestedStream: false, translatorBudget: budget, inboundWire: "responses" },
      { requestBindings: undefined } as Args[3], {},
      { plaintextV2AgentMessageToolNames: new Set(), routedMuseToolNameAliases: new Map(),
        routedNamespaceToolAliases: new Map(), plaintextV2AgentMessageAliasedToolNames: new Set(),
        commitReasoningReplayServingRoute: () => {}, recordTerminalOutcomes: () => {},
        responseCompletionCancelled: () => false } as Args[5],
      { upstreamResponse: response, upstream: new AbortController(), connectMs: 1000 } as Args[6],
    );
    expect(result.status).toBe(response.status);
    await result.body?.cancel();
  } finally { budget.dispose(); }
}
function frame(metadata: CodexWsMetadata, percent: number): void {
  const event = { type: "codex.rate_limits", rate_limits: { primary: { used_percent: percent, window_minutes: 10080 } } };
  expect(metadata.consume(event, JSON.stringify(event).length)).not.toBeNull();
}

beforeEach(() => {
  mkdirSync(repoPath(".tmp"), { recursive: true });
  root = mkdtempSync(repoPath(".tmp/main-quota-observation-"));
  oldOcxHome = process.env.OPENCODEX_HOME;
  oldCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = root;
  process.env.CODEX_HOME = root;
  releaseSpend = acquireOwnedSpendHome();
  clearAccountQuota();
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearPoolRotationState();
  clearAccountNeedsReauth(MAIN);
  clearAccountNeedsReauth(POOL);
  resetMainCodexAccountIdentityTrackingForTests();
  mainCache.clearMainAccountInfoCache();
  mainCache.observeMainQuotaIdentity("fixture-unobserved");
  bearer = fakeChatGptJwt(ACCOUNT);
  config = { providers: { openai: provider }, codexAccounts: [], codexMainAccountHardLock: false } as OcxConfig;
  pendingPersist = undefined;
  pendingPreludeTimeout = undefined;
  pendingUpgradeTimeout = undefined;
  clock = installPersistenceClock();
  globalThis.fetch = (async () => { throw new Error("unexpected network call"); }) as typeof fetch;
});
afterEach(() => {
  releaseSpend?.(); releaseSpend = undefined;
  globalThis.fetch = originalFetch;
  clearAccountQuota();
  if (pendingPersist) clearTimeout(pendingPersist.timer);
  pendingPersist = undefined;
  pendingPreludeTimeout = undefined;
  pendingUpgradeTimeout = undefined;
  clock.mockRestore();
  clearCodexUpstreamHealth(); clearThreadAccountMap(); clearPoolRotationState();
  clearAccountNeedsReauth(MAIN); clearAccountNeedsReauth(POOL);
  resetMainCodexAccountIdentityTrackingForTests(); mainCache.clearMainAccountInfoCache();
  if (oldOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = oldOcxHome;
  if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = oldCodexHome;
  removeTreeWithRetry(root);
});

describe("credential-bound plain-main Responses quota", () => {
  test("1: observed caller bearer updates main through HTTP delivery", async () => {
    observe();
    const ctx = materialized();
    expect(ctx.mainQuotaDispatch).toBeDefined();
    await deliver(ctx);
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(23);
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(23);
    // Materialization resets an old proof when this context is reused for another bearer.
    materializeCodexUpstreamAuth(caller("fixture-unmatched"), ctx, { config });
    expect(ctx.mainQuotaDispatch).toBeUndefined();
    await deliver(ctx, quotaResponse(quotaHeaders("31")));
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(23);
  });

  for (const mode of ["sync", "async"] as const) {
    test(`2: ${mode} stored-main substitution captures the sent credential`, async () => {
      observe();
      writeFileSync(join(root, "auth.json"), JSON.stringify({ tokens: { access_token: bearer, account_id: ACCOUNT } }));
      const ctx: Extract<CodexAuthContext, { kind: "main" }> = { kind: "main", accountId: null };
      const options = { config, substituteMainCredential: true };
      const selected = mode === "sync"
        ? materializeCodexUpstreamAuth(caller("fixture-admission", "fixture-wrong-workspace"), ctx, options)
        : await materializeCodexUpstreamAuthAsync(caller("fixture-admission", "fixture-wrong-workspace"), ctx, options);
      // Compare without putting credential material in a failed assertion's output.
      expect(selected.get("authorization") === `Bearer ${bearer}`).toBe(true);
      expect(selected.get("chatgpt-account-id") === ACCOUNT).toBe(true);
      expect(ctx.mainQuotaDispatch).toBeDefined();
      await deliver(ctx);
      expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(23);
    });
  }

  test("3: different account, different token and unobserved caller cannot publish", async () => {
    const unobserved = materialized();
    expect(unobserved.mainQuotaDispatch).toBeUndefined();
    await deliver(unobserved);
    observe();
    for (const headers of [caller(fakeChatGptJwt("fixture-other"), "fixture-other"), caller("fixture-other-token")]) {
      const ctx = materialized(headers);
      expect(ctx.mainQuotaDispatch).toBeUndefined();
      await deliver(ctx);
    }
    expect(getAccountQuota(MAIN)).toBeNull();
    expect(getMainPolicyQuota()).toBeNull();
  });

  test("4: same-account rotation and A to B to A reject old HTTP dispatches", async () => {
    observe();
    const rotation = materialized();
    observe("fixture-rotated");
    expect(mainCache.isMainQuotaWriterLive(rotation.mainQuotaDispatch!.writer)).toBe(true);
    expect(mainCache.isMainQuotaDispatchLive(rotation.mainQuotaDispatch!)).toBe(false);
    await deliver(rotation);
    observe();
    const aba = materialized();
    observe("fixture-b", "fixture-account-b");
    observe();
    await deliver(aba);
    expect(getAccountQuota(MAIN)).toBeNull();
    expect(getMainPolicyQuota()).toBeNull();
  });

  for (const commit of ["refresh", "reauth"] as const) {
    for (const transport of ["HTTP", "WS"] as const) {
      test(`real native main ${commit} commit fences an older ${transport} quota dispatch`, async () => {
        writeFileSync(join(root, "auth.json"), JSON.stringify({ tokens: {
          access_token: bearer, refresh_token: "fixture-main-before-publication", account_id: ACCOUNT,
        } }));
        observe();
        const ctx = materialized();
        expect(ctx.mainQuotaDispatch).toBeDefined();
        const observer = transport === "WS" ? codexWsQuotaObserver(ctx, provider, "gpt-5.5") : undefined;
        if (transport === "WS") expect(observer).toBeDefined();
        const epoch = codexCredentialMutationEpoch();
        expect(ctx.mainQuotaDispatch!.credentialMutationEpoch).toBe(epoch);
        const generation = mainCache.getMainQuotaCredentialGeneration();
        const replacement = fakeChatGptJwt(ACCOUNT, { fixture_publication: commit });
        if (commit === "refresh") {
          let refreshes = 0;
          const result = await forceRefreshMainAccountToken(bearer, {
            refreshToken: async () => {
              refreshes++;
              return { access: replacement, refresh: "fixture-main-after-refresh", expires: Date.now() + 3600_000, accountId: ACCOUNT };
            },
          });
          expect(refreshes).toBe(1);
          expect(result?.accessToken === replacement).toBe(true);
        } else {
          const result = await beginNativeMainReauth().commit({ accessToken: replacement,
            refreshToken: "fixture-main-after-reauth", idToken: "fixture-main-identity-token", chatgptAccountId: ACCOUNT });
          expect(result.chatgptAccountId).toBe(ACCOUNT);
        }
        const stored = JSON.parse(readFileSync(join(root, "auth.json"), "utf8"));
        expect(stored.tokens.access_token === replacement).toBe(true);
        expect(codexCredentialMutationEpoch()).toBeGreaterThan(epoch);
        // No subsequent credential observation warmed the main quota generation.
        expect(mainCache.getMainQuotaCredentialGeneration()).toBe(generation);
        expect(mainCache.isMainQuotaWriterLive(ctx.mainQuotaDispatch!.writer)).toBe(true);
        if (transport === "HTTP") await deliver(ctx);
        else observer!(quotaHeaders());
        expect(getAccountQuota(MAIN)).toBeNull();
        expect(getMainPolicyQuota()).toBeNull();
        expect(mainCache.isMainQuotaDispatchLive(ctx.mainQuotaDispatch!)).toBe(false);
      });
    }
  }

  test("5: non-canonical, key-auth and other-adapter providers cannot publish", async () => {
    observe();
    const ctx = materialized();
    for (const other of [{ ...provider, baseUrl: "https://fixture.test/v1" },
      { ...provider, authMode: "key" as const }, { ...provider, adapter: "openai-chat" }]) {
      await deliver(ctx, quotaResponse(), other);
      expect(codexWsQuotaObserver(ctx, other)).toBeUndefined();
    }
    expect(getAccountQuota(MAIN)).toBeNull();
  });

  test("6: WS metadata publishes once and its projected HTTP response cannot duplicate", async () => {
    observe();
    const ctx = materialized();
    const observer = codexWsQuotaObserver(ctx, provider, "gpt-5.5");
    expect(observer).toBeDefined();
    const metadata = new CodexWsMetadata(observer);
    frame(metadata, 19);
    const quota = getAccountQuota(MAIN);
    expect(quota?.weeklyPercent).toBe(19);
    // A distinct projected value detects a second write even within the same millisecond.
    const projected = quotaResponse(quotaHeaders("47"));
    markCodexWsResponse(projected, true);
    expect(isCodexWsQuotaObservedResponse(projected)).toBe(true);
    await deliver(ctx, projected);
    expect(getAccountQuota(MAIN)).toEqual(quota);
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(19);
    metadata.finish();
  });

  test("a WS-marked unobserved refusal cannot overwrite newer main display or policy quota", async () => {
    observe();
    const ctx = materialized();
    const metadata = new CodexWsMetadata(codexWsQuotaObserver(ctx, provider, "gpt-5.5"));
    frame(metadata, 17);
    frame(metadata, 99);
    const display = getAccountQuota(MAIN);
    const policy = getMainPolicyQuota();
    const refusal = Response.json({ error: { type: "invalid_request_error", message: "fixture refused create" } },
      { status: 400, headers: quotaHeaders("17") });
    markCodexWsResponse(refusal, false);
    expect(isCodexWsUpstreamResponse(refusal)).toBe(true);
    expect(isCodexWsQuotaObservedResponse(refusal)).toBe(false);
    await deliver(ctx, refusal);
    expect(getAccountQuota(MAIN)).toEqual(display);
    expect(getMainPolicyQuota()).toEqual(policy);
    expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: true }).state).toBe("blocked");
    metadata.finish();
  });

  for (const failure of ["4xx refusal", "socket closure", "prelude timeout", "connect timeout"] as const) {
    test(`WS ${failure} through the real exchange cannot republish stale prelude quota`, async () => {
      observe();
      const ctx = materialized();
      const observer = codexWsQuotaObserver(ctx, provider, "gpt-5.5");
      expect(observer).toBeDefined();
      const originalSocket = globalThis.WebSocket;
      const controller = new AbortController();
      class RefusalSocket extends EventTarget {
        readyState = 0;
        constructor() {
          super();
          queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
        }
        send(_text: string): void {
          queueMicrotask(() => {
            this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
              type: "codex.rate_limits", rate_limits: { primary: { used_percent: 17, window_minutes: 10080 } },
            }) }));
            expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(17);
            // A concurrent main response publishes newer usage before this exchange fails.
            observer!(quotaHeaders("99"));
            expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(99);
            expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
            if (failure === "socket closure") this.close();
            else if (failure === "prelude timeout") {
              expect(pendingPreludeTimeout).toBeDefined();
              pendingPreludeTimeout!();
            } else if (failure === "connect timeout") controller.abort(new DOMException("fixture deadline", "TimeoutError"));
            else this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
              type: "error", status_code: 400, error: { type: "invalid_request_error", message: "fixture refused create" },
            }) }));
          });
        }
        close(): void {
          if (this.readyState === 3) return;
          this.readyState = 3;
          this.dispatchEvent(new Event("close"));
        }
      }
      globalThis.WebSocket = RefusalSocket as unknown as typeof WebSocket;
      const session = new CodexWsSession(CODEX_RESPONSES_WS_URL, {});
      try {
        expect(session.reserve()).toBe(true);
        const init = { method: "POST", signal: controller.signal, headers: caller(), body: JSON.stringify({ model: "gpt-5.5", stream: true, input: "hi" }) };
        const prepared = prepareCodexWsRequest(CODEX_RESPONSES_HTTP_URL, init);
        expect(prepared).not.toBeNull();
        const refusal = await codexWsExchange({ session, url: CODEX_RESPONSES_HTTP_URL, init, prepared: prepared!,
          sseFallback: globalThis.fetch, onQuota: observer, bunVersion: "1.4.0" });
        expect(refusal.status).toBe(failure === "4xx refusal" ? 400 : failure === "socket closure" ? 502 : 504);
        expect(isCodexWsUpstreamResponse(refusal)).toBe(false);
        expect(isCodexWsPreludeProjection(quotaResponse())).toBe(false);
        expect(isCodexWsQuotaObservedResponse(refusal)).toBe(false);
        expect(refusal.headers.get("x-codex-primary-used-percent")).toBe("17");
        expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: true }).state).toBe("blocked");
        await deliver(ctx, refusal);
        expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(99);
        expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
        expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: true }).state).toBe("blocked");
        expect(isCodexWsPreludeProjection(refusal)).toBe(true);
      } finally {
        session.dispose();
        globalThis.WebSocket = originalSocket;
      }
    });
  }

  for (const failure of ["close", "error", "upgrade timeout", "send exception"] as const) {
    test(`real HTTP fallback after WS ${failure} still publishes main quota`, async () => {
      observe();
      const ctx = materialized();
      const originalSocket = globalThis.WebSocket;
      class UpgradeFailureSocket extends EventTarget {
        readyState = 0;
        constructor() {
          super();
          queueMicrotask(() => {
            if (failure === "upgrade timeout") { expect(pendingUpgradeTimeout).toBeDefined(); pendingUpgradeTimeout!(); }
            else if (failure === "send exception") { this.readyState = 1; this.dispatchEvent(new Event("open")); }
            else if (failure === "close") this.close();
            else this.dispatchEvent(new Event("error"));
          });
        }
        send(): void { throw new Error("fixture unsent create"); }
        close(): void {
          if (this.readyState === 3) return;
          this.readyState = 3;
          this.dispatchEvent(new Event("close"));
        }
      }
      globalThis.WebSocket = UpgradeFailureSocket as unknown as typeof WebSocket;
      const session = new CodexWsSession(CODEX_RESPONSES_WS_URL, {});
      let fallbackCalls = 0;
      try {
        expect(session.reserve()).toBe(true);
        const init = { method: "POST", headers: caller(), body: JSON.stringify({ model: "gpt-5.5", stream: true, input: "hi" }) };
        const prepared = prepareCodexWsRequest(CODEX_RESPONSES_HTTP_URL, init);
        expect(prepared).not.toBeNull();
        const response = await codexWsExchange({ session, url: CODEX_RESPONSES_HTTP_URL, init, prepared: prepared!,
          sseFallback: (async () => { fallbackCalls++; return quotaResponse(quotaHeaders("37")); }) as typeof fetch,
          onQuota: codexWsQuotaObserver(ctx, provider, "gpt-5.5"), bunVersion: "1.4.0" });
        expect(fallbackCalls).toBe(1);
        expect(mainCache.isMainQuotaDispatchWsClaimed(ctx.mainQuotaDispatch!)).toBe(false);
        expect(isCodexWsUpstreamResponse(response)).toBe(false);
        expect(isCodexWsPreludeProjection(response)).toBe(false);
        expect(isCodexWsQuotaObservedResponse(response)).toBe(false);
        await deliver(ctx, response);
        expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(37);
        expect(getMainPolicyQuota()?.weeklyPercent).toBe(37);
        expect(mainCache.isMainQuotaDispatchWsClaimed(ctx.mainQuotaDispatch!)).toBe(false);
      } finally {
        session.dispose();
        globalThis.WebSocket = originalSocket;
      }
    });
  }

  test("full handler HTTP replacement after WS quota publishes under a new physical attempt", async () => {
    observe();
    const originalSocket = globalThis.WebSocket;
    const sockets: FailedAttemptSocket[] = [];
    class FailedAttemptSocket extends EventTarget {
      readyState = 0;
      sent: string[] = [];
      constructor() {
        super();
        sockets.push(this);
        queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
      }
      send(text: string): void {
        this.sent.push(text);
        queueMicrotask(() => {
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
            type: "codex.rate_limits", rate_limits: { primary: { used_percent: 17, window_minutes: 10080 } },
          }) }));
          expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(17);
          expect(getMainPolicyQuota()?.weeklyPercent).toBe(17);
          this.close();
        });
      }
      close(): void {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
      }
    }
    globalThis.WebSocket = FailedAttemptSocket as unknown as typeof WebSocket;
    let httpCalls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      httpCalls++;
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: "gpt-5.5", store: false });
      expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(17);
      const headers = quotaHeaders("99");
      headers.set("content-type", "text/event-stream");
      return new Response(`event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed", response: { id: "fixture-http-replacement", status: "completed", output: [] },
      })}\n\n`, { status: 200, headers });
    }) as typeof fetch;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: new Headers({ ...Object.fromEntries(caller()), "content-type": "application/json" }),
        body: JSON.stringify({ model: "gpt-5.5", stream: true, store: false, input: "fixture self-contained turn" }),
      }), { ...config, defaultProvider: "openai",
        providers: { openai: { ...provider, codexAccountMode: "direct", retryOnReset: {} } } },
      { model: "", provider: "" }, { codexWsRuntimeIdentity: BOUNDED_WS_RUNTIME });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("fixture-http-replacement");
      expect(sockets).toHaveLength(1);
      expect(sockets[0]!.sent).toHaveLength(1);
      expect(sockets[0]!.readyState).toBe(3);
      expect(httpCalls).toBe(1);
      expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(99);
      expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
      expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: true }).state).toBe("blocked");
    } finally {
      for (const socket of sockets) socket.close();
      globalThis.WebSocket = originalSocket;
    }
  });

  for (const mutation of ["credential observation", "credential publication epoch"] as const) {
    test(`attempt renewal preserves retired fences after ${mutation}`, async () => {
      observe();
      const ctx = materialized();
      const observer = codexWsQuotaObserver(ctx, provider, "gpt-5.5");
      const original = ctx.mainQuotaDispatch!;
      expect(observer).toBeDefined();
      observer!(quotaHeaders("17"));
      expect(mainCache.isMainQuotaDispatchWsClaimed(original)).toBe(true);
      if (mutation === "credential observation") mainCache.observeMainQuotaCredential("fixture-next-credential", ACCOUNT);
      else advanceCodexCredentialMutationEpoch();
      const renewed = mainCache.renewMainQuotaDispatchForAttempt(original);
      expect(renewed).not.toBe(original);
      expect(renewed).toEqual(original);
      expect(renewed.writer).toBe(original.writer);
      expect(mainCache.isMainQuotaDispatchWsClaimed(renewed)).toBe(false);
      expect(mainCache.isMainQuotaDispatchWsClaimed(original)).toBe(true);
      expect(mainCache.isMainQuotaDispatchLive(renewed)).toBe(false);
      ctx.mainQuotaDispatch = renewed;
      observer!(quotaHeaders("99"));
      expect(mainCache.isMainQuotaDispatchWsClaimed(renewed)).toBe(false);
      await deliver(ctx, quotaResponse(quotaHeaders("99")));
      expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(17);
      expect(getMainPolicyQuota()?.weeklyPercent).toBe(17);
    });
  }

  test("plaintext V2 deferred reset keeps original headers bound to their arrival dispatch", async () => {
    observe();
    const renewalSpy = spyOn(mainCache, "renewMainQuotaDispatchForAttempt");
    const claimSpy = spyOn(mainCache, "isMainQuotaDispatchWsClaimed");
    let httpCalls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      httpCalls++;
      expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true, store: false });
      expect(getAccountQuota(MAIN)).toBeNull();
      expect(getMainPolicyQuota()).toBeNull();
      if (httpCalls === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            controller.error(Object.assign(new Error("fixture pre-output reset"), { code: "ECONNRESET" }));
          },
        }), { status: 200, headers: quotaHeaders("17") });
      }
      return new Response(new TextEncoder().encode(`event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed", response: { id: "fixture-plaintext-reset", status: "completed", output: [] },
      })}\n\n`), { status: 200, headers: quotaHeaders("99") });
    }) as typeof fetch;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: new Headers({ ...Object.fromEntries(caller()), "content-type": "application/json" }),
        body: JSON.stringify({ model: "gpt-5.5", stream: true, store: false, input: "fixture delegate request",
          tools: [{ type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent",
            parameters: { type: "object", properties: { message: { type: "string", encrypted: true } } } }] }],
        }),
      }), { ...config, defaultProvider: "openai", plaintextV2AgentMessages: true,
        providers: { openai: { ...provider, codexAccountMode: "direct", upstreamWebsocket: false, retryOnReset: {} } } },
      { model: "", provider: "" }, { codexWsRuntimeIdentity: BOUNDED_WS_RUNTIME });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("fixture-plaintext-reset");
      expect(httpCalls).toBe(2);
      expect(renewalSpy).toHaveBeenCalledTimes(2);
      const arrival = renewalSpy.mock.results[0]!.value as mainCache.MainQuotaDispatch;
      const successor = renewalSpy.mock.results[1]!.value as mainCache.MainQuotaDispatch;
      expect(successor).not.toBe(arrival);
      expect(successor).toEqual(arrival);
      // The prefix probe awaits the replacement before publication; the original proof stays live.
      // Its 17% may publish only under that proof. Replacement-header publication is a follow-up.
      expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(17);
      expect(getMainPolicyQuota()?.weeklyPercent).toBe(17);
      expect(claimSpy).toHaveBeenCalledTimes(1);
      expect(claimSpy.mock.calls[0]![0]).toBe(arrival);
      expect(claimSpy.mock.calls[0]![0]).not.toBe(successor);
    } finally {
      claimSpy.mockRestore();
      renewalSpy.mockRestore();
    }
  });

  test("full handler sanitized recovery with failed WS upgrade publishes fresh HTTP quota", async () => {
    observe();
    const originalSocket = globalThis.WebSocket;
    const sockets: RecoverySocket[] = [];
    const opaqueBytes = Buffer.alloc(73, 1);
    opaqueBytes[0] = 0x80;
    const opaqueOutput = opaqueBytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
    class RecoverySocket extends EventTarget {
      readyState = 0;
      sent: string[] = [];
      constructor() {
        super();
        sockets.push(this);
        const attempt = sockets.length;
        queueMicrotask(() => {
          if (attempt === 1) { this.readyState = 1; this.dispatchEvent(new Event("open")); }
          else this.close();
        });
      }
      send(text: string): void {
        this.sent.push(text);
        queueMicrotask(() => {
          const emit = (payload: unknown) => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
          emit({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 17, window_minutes: 10080 } } });
          expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(17);
          expect(getMainPolicyQuota()?.weeklyPercent).toBe(17);
          emit({ type: "error", status_code: 400, error: { type: "invalid_request_error",
            code: "invalid_encrypted_content", message: "The encrypted content could not be verified." } });
        });
      }
      close(): void {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
      }
    }
    globalThis.WebSocket = RecoverySocket as unknown as typeof WebSocket;
    let httpCalls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      httpCalls++;
      const body = JSON.parse(String(init?.body));
      const output = body.input.find((item: { type?: string }) => item.type === "function_call_output");
      expect(output.output).toEqual([{ type: "input_text", text: "[encrypted content omitted]" }]);
      expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(17);
      const headers = quotaHeaders("99");
      headers.set("content-type", "text/event-stream");
      return new Response(`event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed", response: { id: "fixture-sanitized-http", status: "completed", output: [] },
      })}\n\n`, { status: 200, headers });
    }) as typeof fetch;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: new Headers({ ...Object.fromEntries(caller()), "content-type": "application/json" }),
        body: JSON.stringify({ model: "gpt-5.5", stream: true, store: false, input: [
          { type: "function_call", call_id: "fixture-call", name: "fixture_tool", arguments: "{}" },
          { type: "function_call_output", call_id: "fixture-call",
            output: [{ type: "encrypted_content", encrypted_content: opaqueOutput }] },
        ] }),
      }), { ...config, defaultProvider: "openai", providers: { openai: { ...provider, codexAccountMode: "direct" } } },
      { model: "", provider: "" }, { codexWsRuntimeIdentity: BOUNDED_WS_RUNTIME });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("fixture-sanitized-http");
      expect(sockets).toHaveLength(2);
      expect(sockets[0]!.sent).toHaveLength(1);
      const firstOutput = JSON.parse(sockets[0]!.sent[0]!).input.find((item: { type?: string }) => item.type === "function_call_output");
      expect(firstOutput.output[0].type).toBe("encrypted_content");
      expect(sockets[1]!.sent).toHaveLength(0);
      expect(httpCalls).toBe(1);
      expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(99);
      expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
      expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: true }).state).toBe("blocked");
    } finally {
      for (const socket of sockets) socket.close();
      globalThis.WebSocket = originalSocket;
    }
  });

  test("full handler preflight for encrypted function output retains newer WS quota", async () => {
    observe();
    const newerObserver = codexWsQuotaObserver(materialized(), provider, "gpt-5.5");
    expect(newerObserver).toBeDefined();
    const originalSocket = globalThis.WebSocket;
    const sockets: PreflightSocket[] = [];
    const opaqueBytes = Buffer.alloc(73, 1);
    opaqueBytes[0] = 0x80;
    const opaqueOutput = opaqueBytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
    class PreflightSocket extends EventTarget {
      readyState = 0;
      sent: string[] = [];
      constructor() {
        super();
        sockets.push(this);
        queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
      }
      send(text: string): void {
        this.sent.push(text);
        queueMicrotask(() => {
          const emit = (payload: unknown) => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
          emit({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 17, window_minutes: 10080 } } });
          expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(17);
          emit({ type: "response.created", response: { id: "fixture-preflight", status: "in_progress", output: [] } });
          // The committed response has a 17% prelude; another dispatch publishes 99%.
          newerObserver!(quotaHeaders("99"));
          expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
          emit({ type: "response.output_text.delta", delta: "fixture answer", output_index: 0, content_index: 0 });
          emit({ type: "response.completed", response: { id: "fixture-preflight", status: "completed", output: [] } });
        });
      }
      close(): void {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
      }
    }
    globalThis.WebSocket = PreflightSocket as unknown as typeof WebSocket;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: new Headers({ ...Object.fromEntries(caller()), "content-type": "application/json" }),
        body: JSON.stringify({ model: "gpt-5.5", stream: true, input: [
          { type: "function_call", call_id: "fixture-call", name: "fixture_tool", arguments: "{}" },
          { type: "function_call_output", call_id: "fixture-call",
            output: [{ type: "encrypted_content", encrypted_content: opaqueOutput }] },
        ] }),
      }), { ...config, defaultProvider: "openai", streamMode: "legacy-tee",
        providers: { openai: { ...provider, codexAccountMode: "direct" } } }, { model: "", provider: "" },
      { codexWsRuntimeIdentity: BOUNDED_WS_RUNTIME });
      expect(response.status).toBe(200);
      expect(sockets).toHaveLength(1);
      const sentOutput = JSON.parse(sockets[0]!.sent[0]!).input.find((item: { type?: string }) => item.type === "function_call_output");
      expect(sentOutput.output[0].type).toBe("encrypted_content");
      // The preflight replay is a fresh Response; no response-object marker survives.
      expect(isCodexWsUpstreamResponse(response)).toBe(false);
      expect(isCodexWsPreludeProjection(response)).toBe(false);
      const text = await response.text();
      expect(text).toContain("fixture answer");
      expect(text).toContain("response.completed");
      expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(99);
      expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
      expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: true }).state).toBe("blocked");
    } finally {
      for (const socket of sockets) socket.close();
      globalThis.WebSocket = originalSocket;
    }
  });

  test("an observed WS dispatch rejects an unmarked HTTP-shaped quota snapshot", async () => {
    observe();
    const ctx = materialized();
    const observer = codexWsQuotaObserver(ctx, provider, "gpt-5.5");
    expect(observer).toBeDefined();
    observer!(quotaHeaders("17"));
    observer!(quotaHeaders("99"));
    expect(mainCache.isMainQuotaDispatchWsClaimed(ctx.mainQuotaDispatch!)).toBe(true);
    const response = quotaResponse(quotaHeaders("17"));
    expect(isCodexWsUpstreamResponse(response)).toBe(false);
    expect(isCodexWsPreludeProjection(response)).toBe(false);
    await deliver(ctx, response);
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(99);
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
    expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: true }).state).toBe("blocked");
  });

  test("each WS observer owns a fresh dispatch and an old observer cannot claim its successor", async () => {
    observe();
    const ctx = materialized();
    const materializedDispatch = ctx.mainQuotaDispatch!;
    const firstObserver = codexWsQuotaObserver(ctx, provider, "gpt-5.5");
    const firstDispatch = ctx.mainQuotaDispatch!;
    expect(firstObserver).toBeDefined();
    expect(firstDispatch).not.toBe(materializedDispatch);
    expect(firstDispatch).toEqual(materializedDispatch);
    firstObserver!(quotaHeaders("17"));
    expect(mainCache.isMainQuotaDispatchWsClaimed(firstDispatch)).toBe(true);
    const nextObserver = codexWsQuotaObserver(ctx, provider, "gpt-5.5");
    const nextDispatch = ctx.mainQuotaDispatch!;
    expect(nextObserver).toBeDefined();
    expect(nextDispatch).not.toBe(firstDispatch);
    expect(nextDispatch).toEqual(firstDispatch);
    expect(nextDispatch.writer).toBe(firstDispatch.writer);
    expect(mainCache.isMainQuotaDispatchWsClaimed(nextDispatch)).toBe(false);
    // A callback retained by a previous attempt must never claim the later fallback.
    firstObserver!(new Headers());
    expect(mainCache.isMainQuotaDispatchWsClaimed(nextDispatch)).toBe(false);
    await deliver(ctx, quotaResponse(quotaHeaders("99")));
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(99);
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
    // If this attempt's own observer runs, its HTTP-shaped projection is suppressed.
    nextObserver!(quotaHeaders("99"));
    expect(mainCache.isMainQuotaDispatchWsClaimed(nextDispatch)).toBe(true);
    await deliver(ctx, quotaResponse(quotaHeaders("17")));
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(99);
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
  });

  test("every observer invocation claims its captured dispatch before checking liveness", async () => {
    observe();
    const ctx = materialized();
    const observer = codexWsQuotaObserver(ctx, provider, "gpt-5.5");
    const dispatch = ctx.mainQuotaDispatch!;
    expect(observer).toBeDefined();
    expect(mainCache.isMainQuotaDispatchWsClaimed(dispatch)).toBe(false);
    mainCache.observeMainQuotaCredential("fixture-replaced-before-frame", ACCOUNT);
    expect(mainCache.isMainQuotaDispatchLive(dispatch)).toBe(false);
    observer!(new Headers());
    expect(mainCache.isMainQuotaDispatchWsClaimed(dispatch)).toBe(true);
    expect(getAccountQuota(MAIN)).toBeNull();
    // Reusing the context cannot transfer an old observer's claim to a new dispatch.
    observe();
    materializeCodexUpstreamAuth(caller(), ctx, { config, modelId: "gpt-5.5" });
    expect(ctx.mainQuotaDispatch).not.toBe(dispatch);
    expect(mainCache.isMainQuotaDispatchWsClaimed(ctx.mainQuotaDispatch!)).toBe(false);
    observer!(quotaHeaders("99"));
    await deliver(ctx, quotaResponse(quotaHeaders("37")));
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(37);
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(37);
  });

  test("async Reserve admission failure clears a reused main dispatch proof", async () => {
    observe();
    const ctx = materialized();
    expect(ctx.mainQuotaDispatch).toBeDefined();
    expect(mainCache.isMainQuotaDispatchLive(ctx.mainQuotaDispatch!)).toBe(true);
    await expect(materializeCodexUpstreamAuthAsync(caller(), ctx, {
      config: { ...config, codexDesktopAuthless: true, pausedCodexAccountIds: [MAIN] },
      modelId: NATIVE_RESERVE_MODEL, admission: { source: "loopback" },
    })).rejects.toBeInstanceOf(CodexReserveUnavailableError);
    expect(ctx.mainQuotaDispatch).toBeUndefined();
  });

  test("7: stored pool HTTP and WS still update only their pool row", async () => {
    const generation = saveCodexAccountCredential(POOL, { accessToken: "fixture-pool-token",
      refreshToken: "fixture-pool-refresh", chatgptAccountId: "fixture-pool-workspace", expiresAt: Date.now() + 3600_000 });
    const ctx: Extract<CodexAuthContext, { kind: "pool" }> = { kind: "pool", accountId: POOL,
      generation, writerGeneration: captureConfigGeneration(), accessToken: "fixture-pool-token", chatgptAccountId: "fixture-pool-workspace" };
    await deliver(ctx);
    expect(getAccountQuota(POOL)?.weeklyPercent).toBe(23);
    const observer = codexWsQuotaObserver(ctx, provider, "gpt-5.5");
    expect(observer).toBeDefined();
    observer!(quotaHeaders("29"));
    expect(getAccountQuota(POOL)?.weeklyPercent).toBe(29);
    expect(getAccountQuota(MAIN)).toBeNull();
  });

  test("8: credential replacement during the HTTP import yield rejects publication", async () => {
    observe();
    const ctx = materialized();
    const live = mainCache.isMainQuotaDispatchLive;
    let checks = 0;
    const fence = spyOn(mainCache, "isMainQuotaDispatchLive").mockImplementation(dispatch => {
      const current = live(dispatch);
      if (++checks === 1) queueMicrotask(() => observe("fixture-during-import"));
      return current;
    });
    try {
      await deliver(ctx);
      expect(checks).toBe(2);
      expect(mainCache.isMainQuotaWriterLive(ctx.mainQuotaDispatch!.writer)).toBe(true);
      expect(getAccountQuota(MAIN)).toBeNull();
      expect(getMainPolicyQuota()).toBeNull();
    } finally { fence.mockRestore(); }
  });

  test("9: WS closure rejects a second frame after rotation despite mutable context recapture", () => {
    observe();
    const ctx = materialized();
    const metadata = new CodexWsMetadata(codexWsQuotaObserver(ctx, provider, "gpt-5.5"));
    frame(metadata, 17);
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(17);
    observe("fixture-new-token");
    materializeCodexUpstreamAuth(caller("fixture-new-token"), ctx, { config });
    expect(mainCache.isMainQuotaDispatchLive(ctx.mainQuotaDispatch!)).toBe(true);
    frame(metadata, 39);
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(17);
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(17);
    metadata.finish();
  });

  test("10: the same bearer for a different workspace cannot publish", async () => {
    observe();
    const ctx = materialized(caller(bearer, "fixture-different-workspace"));
    expect(ctx.mainQuotaDispatch).toBeUndefined();
    await deliver(ctx);
    expect(getAccountQuota(MAIN)).toBeNull();
    expect(getMainPolicyQuota()).toBeNull();
  });

  test("11: absent and nonnumeric headers do nothing; invalid ranges clamp display but retain policy", async () => {
    observe();
    const ctx = materialized();
    for (const headers of [new Headers(), quotaHeaders("not-a-number")]) await deliver(ctx, quotaResponse(headers));
    expect(getAccountQuota(MAIN)).toBeNull();
    expect(getMainPolicyQuota()).toBeNull();
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 44, shortPercent: 12, shortWindowSeconds: 18_000 },
      undefined, ctx.mainQuotaDispatch!.writer);
    const before = getMainPolicyQuota();
    await deliver(ctx, quotaResponse(quotaHeaders("120")));
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(100);
    expect(getMainPolicyQuota()).toEqual(before);
    await deliver(ctx, quotaResponse(new Headers({ "x-codex-primary-used-percent": "-5",
      "x-codex-primary-window-minutes": "300", "x-codex-secondary-used-percent": "25" })));
    expect(getAccountQuota(MAIN)).toMatchObject({ shortPercent: 0, weeklyPercent: 25 });
    // The existing main-pool consumer rejects the entire policy projection of a mixed set.
    expect(getMainPolicyQuota()).toEqual(before);
  });

  test("12: real persistence saves fresh main usage without credential or dispatch proof", async () => {
    observe();
    const before = Date.now();
    const ctx = materialized();
    await deliver(ctx);
    expect(pendingPersist).toBeDefined();
    const pending = pendingPersist!;
    pendingPersist = undefined;
    clearTimeout(pending.timer);
    pending.run();
    const body = readFileSync(join(root, "codex-quota-cache.json"), "utf8");
    const persisted = JSON.parse(body);
    expect(persisted.quotas[MAIN].weeklyPercent).toBe(23);
    expect(persisted.quotas[MAIN].updatedAt).toBeGreaterThanOrEqual(before);
    expect(persisted.quotas[MAIN].updatedAt).toBeLessThanOrEqual(Date.now());
    for (const forbidden of [bearer, ACCOUNT, "bearerHmac", "mainQuotaDispatch", "credentialGeneration", "credentialMutationEpoch", "configGeneration", "identityGeneration"])
      expect(body.includes(forbidden)).toBe(false);
    expect(Object.keys(persisted.mainPolicyQuota).sort()).toEqual(["identityKey", "quota"]);
  });

  test("13: actual pool to caller-main retry publishes only the final dispatch proof", async () => {
    observe();
    saveCodexAccountCredential(POOL, { accessToken: "fixture-retry-pool",
      refreshToken: "fixture-retry-refresh", chatgptAccountId: "fixture-pool-workspace", expiresAt: Date.now() + 3600_000 });
    config = { ...config, activeCodexAccountId: POOL, autoSwitchThreshold: 0,
      providers: { openai: { ...provider, codexAccountMode: "pool" } }, codexAccounts: [{ id: POOL, label: "fixture pool" }] };
    const turn = tryAdmitTurn();
    expect(turn).not.toBeNull();
    const budget = createTranslatorBudget();
    let sends = 0;
    globalThis.fetch = (async (_input, init) => {
      sends++;
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization") === `Bearer ${bearer}`).toBe(true);
      expect(headers.get("chatgpt-account-id") === ACCOUNT).toBe(true);
      return quotaResponse(quotaHeaders("32"));
    }) as typeof fetch;
    try {
      const firstAuthCtx = await resolveCodexAuthContext(caller(), config, "pool", {
        modelId: "gpt-5.5", requestScopedMainCredential: true,
        beginCodexAccountSelection: codexAccountSelectionForTurn(turn!),
      });
      expect(firstAuthCtx.kind).toBe("pool");
      if (firstAuthCtx.kind !== "pool") throw new Error("fixture did not select pool");
      const result = await retryCodexPoolOnAlternateAccount({ callerAuthHeaders: caller(), config, firstAuthCtx,
        firstResponse: new Response(null, { status: 429, headers: { "retry-after": "60", ...Object.fromEntries(quotaHeaders("91")) } }),
        outcomeStatus: 429, route: { providerName: "openai", modelId: "gpt-5.5", provider: config.providers.openai! },
        parsed: parseRequest({ model: "gpt-5.5", input: "hi", stream: false }), logCtx: { model: "", provider: "" },
        options: { translatorBudget: budget, turnAdmissionLease: turn! }, upstream: new AbortController(),
        connectMs: 1000, stream: false, httpOnly: true });
      expect(result.kind).toBe("retried");
      if (result.kind !== "retried") throw new Error("fixture did not retry");
      expect(sends).toBe(1);
      expect(result.authCtx.kind).toBe("main");
      if (result.authCtx.kind !== "main") throw new Error("fixture did not choose caller main");
      expect(result.authCtx.mainQuotaDispatch).toBeDefined();
      expect(getAccountQuota(POOL)?.weeklyPercent).toBe(91);
      expect(getAccountQuota(MAIN)).toBeNull();
      await deliver(result.authCtx, result.upstreamResponse);
      expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(32);
      // An older completed dispatch cannot overwrite a newer credential's observation.
      observe("fixture-final-replacement");
      const final = materialized(caller("fixture-final-replacement"));
      await deliver(final, quotaResponse(quotaHeaders("41")));
      await deliver(result.authCtx, quotaResponse(quotaHeaders("79")));
      expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(41);
    } finally { turn?.release(); budget.dispose(); }
  });
});
