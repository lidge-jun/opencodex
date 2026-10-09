import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAIN_CODEX_ACCOUNT_ID as MAIN } from "../../src/codex/account-id";
import * as mainCache from "../../src/codex/main-account-cache";
import {
  materializeCodexUpstreamAuth, materializeCodexUpstreamAuthAsync, resolveCodexAuthContext,
  type CodexAuthContext,
} from "../../src/codex/auth-context";
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
import { deliverPassthroughResponse } from "../../src/server/responses/passthrough-delivery";
import { codexWsQuotaObserver, retryCodexPoolOnAlternateAccount } from "../../src/server/responses/core-codex-account";
import { CodexWsMetadata } from "../../src/server/responses/codex-ws-metadata";
import { markCodexWsResponse, isCodexWsQuotaObservedResponse } from "../../src/server/responses/codex-ws-wire";
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

// Exercise the real serializer without a wall-clock race, as main-quota-provenance does.
function installPersistenceClock() {
  const nativeTimeout = globalThis.setTimeout;
  return spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]
  ) => {
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
    expect(result.status).toBe(307);
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
  clock = installPersistenceClock();
  globalThis.fetch = (async () => { throw new Error("unexpected network call"); }) as typeof fetch;
});
afterEach(() => {
  releaseSpend?.(); releaseSpend = undefined;
  globalThis.fetch = originalFetch;
  clearAccountQuota();
  if (pendingPersist) clearTimeout(pendingPersist.timer);
  pendingPersist = undefined;
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
    for (const forbidden of [bearer, ACCOUNT, "bearerHmac", "mainQuotaDispatch", "credentialGeneration", "configGeneration", "identityGeneration"])
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
