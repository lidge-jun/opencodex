import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../../src/types";
import * as oauth from "../../src/oauth";
import { getAccountSet, saveCredential } from "../../src/oauth/store";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome } from "../helpers/temp-home";

const PROVIDER = "orcarouter-oauth";
const ACCESS = "fixture-refresh-capacity-access";
const originalRefresh = oauth.OAUTH_PROVIDERS[PROVIDER]!.refresh;
const originalForceRefresh = oauth.forceRefreshOAuthAccessSnapshot;
const resolver = await import("../../src/server/adapter-resolve");
const originalResolver = { ...resolver };
let rejectInference: () => Promise<void>;
let inferenceSends = 0;
let transportMode: "adapter" | "passthrough" | "runTurn";
let runTurnSends = 0;
let runTurnReady = false;
let httpPaths: string[] = [];
mock.module("../../src/server/adapter-resolve", () => ({ ...originalResolver,
  resolveAdapter(provider: OcxProviderConfig, cache?: "none" | "short" | "long", providerId?: string) {
    if (provider.baseUrl !== "https://fixture.invalid/v1") return originalResolver.resolveAdapter(provider, cache, providerId);
    if (transportMode !== "runTurn") return originalResolver.resolveAdapter({ ...provider,
      adapter: transportMode === "passthrough" ? "openai-responses" : "openai-chat",
    }, cache, providerId);
    return {
      name: "devin",
      buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
      async *parseStream() { yield { type: "done" } as AdapterEvent; },
      async runTurn(_parsed, _incoming, emit) {
        expect(provider.apiKey).toBe(ACCESS);
        inferenceSends++;
        runTurnSends++;
        if (runTurnReady) emit({ type: "heartbeat", preflightReady: true });
        await rejectInference();
        emit({ type: "error", status: 401, errorType: "authentication_error",
          code: "unauthenticated", retryable: false, message: "fixture upstream rejected credential" });
      },
    } satisfies ProviderAdapter;
  },
}));
const { handleResponses } = await import("../../src/server/responses");

let home: ReturnType<typeof createTempHome>;
let releaseSpendHome: () => void;
beforeEach(() => {
  home = createTempHome("ocx-refresh-capacity-");
  releaseSpendHome = acquireOwnedSpendHome();
  inferenceSends = 0;
  runTurnSends = 0;
  httpPaths = [];
});
afterEach(() => {
  oauth.OAUTH_PROVIDERS[PROVIDER]!.refresh = originalRefresh;
  releaseSpendHome();
  home.remove();
});
afterAll(() => { mock.module("../../src/server/adapter-resolve", () => originalResolver); });

const cases = (["adapter", "passthrough", "runTurn"] as const).flatMap(transport =>
  [false, true].flatMap(stream => [false, true].map(cancelled => ({ transport, stream, cancelled, ready: false, requestOnly: false }))));
cases.push({ transport: "runTurn", stream: true, cancelled: false, ready: true, requestOnly: false });
for (const stream of [false, true]) cases.push({ transport: "runTurn", stream, cancelled: true, ready: false, requestOnly: true });
cases.push({ transport: "runTurn", stream: true, cancelled: true, ready: true, requestOnly: true });
for (const { transport, stream, cancelled, ready, requestOnly } of cases) {
  test(`${transport} fresh auth then 401 maps saturated refresh correctly (stream=${stream}, cancelled=${cancelled}, ready=${ready}, requestOnly=${requestOnly})`, async () => {
    transportMode = transport;
    runTurnReady = ready;
    await saveCredential(PROVIDER, {
      access: ACCESS, refresh: "fixture-refresh-capacity-token", expires: Date.now() + 3_600_000,
      accountId: "fixture-refresh-capacity-account",
    });
    const snapshot = await oauth.getValidAccessTokenSnapshot(PROVIDER);
    const controller = new AbortController(), optionController = new AbortController();
    let releaseRefresh!: () => void;
    let enteredRefresh!: () => void;
    const blocked = new Promise<void>(resolve => { releaseRefresh = resolve; });
    const entered = new Promise<void>(resolve => { enteredRefresh = resolve; });
    let refreshCalls = 0;
    oauth.OAUTH_PROVIDERS[PROVIDER]!.refresh = async () => {
      refreshCalls++;
      enteredRefresh();
      await blocked;
      return { access: "fixture-refreshed-access", refresh: "fixture-rotated-refresh", expires: Date.now() + 3_600_000 };
    };
    let waiting: Promise<unknown>[] = [];
    rejectInference = async () => {
      // Initial auth really used the fresh token. Only once that inference is in flight do
      // independent callers occupy every refresh-consumer slot for its rejected generation.
      expect(refreshCalls).toBe(0);
      waiting = Array.from({ length: oauth.MAX_OAUTH_TOKEN_REFRESH_WAITERS }, () =>
        originalForceRefresh(snapshot).catch(error => error));
      await entered;
    };
    let busyRejections = 0;
    const forceRefresh = spyOn(oauth, "forceRefreshOAuthAccessSnapshot").mockImplementation(async sent => {
      try { return await originalForceRefresh(sent); }
      catch (error) {
        if (error instanceof oauth.OAuthTokenRefreshBusyError) {
          busyRejections++;
          // Cancel at the refusal boundary so each transport's catch must prioritize it.
          if (cancelled) { controller.abort(); if (!requestOnly) optionController.abort(); }
        }
        throw error;
      }
    });
    const config = { port: 0, defaultProvider: PROVIDER, providers: { [PROVIDER]: {
      adapter: transport === "runTurn" ? "devin" : transport === "passthrough" ? "openai-responses" : "openai-chat",
      authMode: "oauth", baseUrl: "https://fixture.invalid/v1", models: ["fixture-model"],
      fetch: async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        httpPaths.push(new URL(_input instanceof Request ? _input.url : String(_input)).pathname);
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${ACCESS}`);
        inferenceSends++;
        await rejectInference();
        return Response.json({ error: { type: "authentication_error", message: "fixture upstream rejected credential" } }, { status: 401 });
      },
    } } } as OcxConfig;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ model: `${PROVIDER}/fixture-model`, input: "fixture", stream }),
      }), config, { model: "", provider: "" }, { abortSignal: optionController.signal });
      const body = await response.text();
      expect(inferenceSends).toBe(1);
      expect(runTurnSends).toBe(transport === "runTurn" ? 1 : 0);
      expect(httpPaths).toEqual(transport === "runTurn" ? [] : [transport === "passthrough" ? "/v1/responses" : "/v1/chat/completions"]);
      expect(refreshCalls).toBe(1);
      expect(busyRejections).toBe(1);
      expect(response.status).toBe(ready ? 200 : cancelled ? 499 : 503);
      expect(response.headers.get("retry-after")).toBe(cancelled || ready ? null : "1");
      expect(body).toContain(cancelled ? "client_cancelled" : "server_error");
      if (!cancelled) expect(body).toContain("OAuth token refresh capacity reached");
      expect(body).not.toContain("authentication_error");
      expect(body).not.toContain("unauthenticated");
      if (ready) {
        const failure = body.split("\n").filter(line => line.startsWith("data: {"))
          .map(line => JSON.parse(line.slice(6))).find(frame => frame.type === "response.failed");
        expect(failure?.response.retryable).toBe(!cancelled);
        expect(failure?.response.error.type).toBe(cancelled ? "client_cancelled" : "server_error");
      }
      expect(body).not.toContain(ACCESS);
      expect(getAccountSet(PROVIDER)?.activeAccountId).toBe(snapshot.accountId);
      expect(getAccountSet(PROVIDER)?.accounts.find(row => row.id === snapshot.accountId)?.needsReauth).not.toBe(true);
    } finally {
      forceRefresh.mockRestore();
      releaseRefresh();
      await Promise.all(waiting);
    }
  });
}

for (const cancelledSignal of ["request", "option"] as const) {
  test(`initial refresh capacity prioritizes independent ${cancelledSignal} cancellation`, async () => {
    transportMode = "adapter";
    await saveCredential(PROVIDER, { access: ACCESS, refresh: "fixture-initial-refresh", expires: 1,
      accountId: "fixture-initial-account" });
    const accountId = getAccountSet(PROVIDER)!.activeAccountId;
    let finish!: () => void, started!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    oauth.OAUTH_PROVIDERS[PROVIDER]!.refresh = async () => {
      started(); await blocked;
      return { access: "fixture-initial-new", refresh: "fixture-initial-next", expires: Date.now() + 3_600_000 };
    };
    const waiting = Array.from({ length: oauth.MAX_OAUTH_TOKEN_REFRESH_WAITERS }, () =>
      oauth.getValidAccessTokenForAccount(PROVIDER, accountId).catch(error => error));
    await entered;
    const requestAbort = new AbortController(), optionAbort = new AbortController();
    const originalResolve = oauth.getValidAccessTokenSnapshot;
    const resolve = spyOn(oauth, "getValidAccessTokenSnapshot").mockImplementation(async (...args) => {
      try { return await originalResolve(...args); }
      catch (error) {
        expect(error).toBeInstanceOf(oauth.OAuthTokenRefreshBusyError);
        (cancelledSignal === "request" ? requestAbort : optionAbort).abort();
        throw error;
      }
    });
    const config = { port: 0, defaultProvider: PROVIDER, providers: { [PROVIDER]: {
      adapter: "openai-chat", authMode: "oauth", baseUrl: "https://fixture.invalid/v1", models: ["fixture-model"],
      fetch: async () => { throw new Error("unexpected inference dispatch"); },
    } } } as OcxConfig;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" }, signal: requestAbort.signal,
        body: JSON.stringify({ model: `${PROVIDER}/fixture-model`, input: "fixture", stream: false }),
      }), config, { model: "", provider: "" }, { abortSignal: optionAbort.signal });
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(499);
      expect(response.headers.get("retry-after")).toBeNull();
      expect(await response.text()).toContain("client_cancelled");
      expect(getAccountSet(PROVIDER)?.accounts.find(row => row.id === accountId)?.needsReauth).not.toBe(true);
    } finally { resolve.mockRestore(); finish(); await Promise.all(waiting); }
  });
}
