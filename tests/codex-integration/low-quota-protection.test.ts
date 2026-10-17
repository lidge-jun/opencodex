import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfigCandidate } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { observeCodexLowQuota, registerLowQuotaObserver } from "../../src/codex/low-quota-observer";
import { createLowQuotaEventLedger } from "../../src/codex/low-quota-events";
import { registerCodexLowQuotaProtection, type LowQuotaRegistration } from "../../src/codex/low-quota-protection";
import { setCodexAccountPaused } from "../../src/codex/account-pause";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/account-id";
import { capturePoolQuotaWriter, removeCodexAccountCredential, saveCodexAccountCredential } from "../../src/codex/account-store";
import { commitPoolQuotaResponse } from "../../src/codex/auth-api/pool-quota-probe";
import * as authContextModule from "../../src/codex/auth-context";
import { handleResponsesCompact } from "../../src/server/responses";
import { baseCompactionBody, compactionRequest, completedPayload, drainCompactionResponseState } from "../helpers/compaction-routing-fixtures";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { codexWsQuotaObserver } from "../../src/server/responses/core-codex-account";
import { captureConfigGeneration } from "../../src/lib/state-store-sweeper";
import { applyAccountQuotaFromUpstreamHeaders, clearAccountQuota, getAccountQuota, setAccountQuotaFromParsed, updateAccountQuota } from "../../src/codex/quota";
import type { CodexAccount } from "../../src/types/accounts";
import type { CodexLowQuotaProtectionConfig, OcxConfig } from "../../src/types/config";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { resolveLowQuotaDesktopSink, type LowQuotaNotice, type LowQuotaNoticeSink } from "../../src/codex/low-quota-desktop-notifier";
import { fallbackCodexAccountLogLabel } from "../../src/codex/account-label";

const ACCOUNT_A = "low-quota-a";
const ACCOUNT_B = "low-quota-b";
type Notice = LowQuotaNotice;

let home = "";
let previousHome: string | undefined;
let cleanups: Array<() => void> = [];

function account(id: string): CodexAccount {
  return { id, email: `${id}@example.test`, isMain: false, plan: "team" };
}

function protection(overrides: Partial<CodexLowQuotaProtectionConfig> = {}): CodexLowQuotaProtectionConfig {
  return {
    enabled: true,
    threshold: 80,
    actions: { pause: true, notify: false },
    windows: { short: true, weekly: true },
    ...overrides,
  };
}

function configWith(policy?: CodexLowQuotaProtectionConfig): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "fixture",
    providers: { fixture: { adapter: "openai-chat", baseUrl: "https://fixture.example/v1", apiKey: "fixture-key" } },
    codexAccounts: [account(ACCOUNT_A), account(ACCOUNT_B)],
    ...(policy === undefined ? {} : { codexPool: { lowQuotaProtection: policy } }),
  };
}

function register(config: OcxConfig, deps: {
  persist?: (next: OcxConfig) => void;
  notify?: (notice: Notice, signal: AbortSignal) => void | Promise<void>;
  desktopSink?: () => LowQuotaNoticeSink | undefined;
} = {}): LowQuotaRegistration {
  const cleanup = registerCodexLowQuotaProtection(config, deps);
  cleanups.push(cleanup);
  return cleanup;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-low-quota-protection-"));
  process.env.OPENCODEX_HOME = home;
  cleanups = [];
  clearAccountQuota();
});

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) cleanup();
  clearAccountQuota();
  await flushConfigDirHardeningForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

describe("low quota protection", () => {
  test("persists a paused-account snapshot only after the threshold is reached", async () => {
    const config = configWith(protection());
    const persisted: OcxConfig[] = [];
    const registration = register(config, { persist: next => { persisted.push(structuredClone(next)); } });
    expect(registration.hasPendingSave()).toBe(false);

    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 79 });
    expect(config.pausedCodexAccountIds).toBeUndefined();
    expect(persisted).toEqual([]);

    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 80 });
    expect(registration.hasPendingSave()).toBe(true);
    expect(config.pausedCodexAccountIds).toEqual([ACCOUNT_A]);
    expect(persisted).toHaveLength(0);
    await registration.flush();
    expect(registration.hasPendingSave()).toBe(false);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.pausedCodexAccountIds).toContain(ACCOUNT_A);
    observeCodexLowQuota(ACCOUNT_B, { weeklyPercent: 79 });
    expect(config.pausedCodexAccountIds).toEqual([ACCOUNT_A]);
    expect(persisted).toHaveLength(1);
  });

  test("notifies once per account and window, then rearms for a reset or a recovery", () => {
    const config = configWith(protection({ actions: { pause: false, notify: true } }));
    const notices: Notice[] = [];
    register(config, { notify: async notice => { notices.push(notice); } });
    const firstReset = Date.now() + 60_000;
    const secondReset = firstReset + 60_000;

    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 80, weeklyResetAt: firstReset });
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 95, weeklyResetAt: firstReset });
    expect(notices).toHaveLength(1);

    observeCodexLowQuota(ACCOUNT_B, { weeklyPercent: 80, weeklyResetAt: firstReset });
    observeCodexLowQuota(ACCOUNT_A, { shortPercent: 80, shortResetAt: firstReset });
    expect(notices.map(notice => notice.window)).toEqual(["weekly", "weekly", "short"]);

    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 90, weeklyResetAt: secondReset });
    expect(notices).toHaveLength(4);
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 95, weeklyResetAt: secondReset });
    expect(notices).toHaveLength(4);

    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 10, weeklyResetAt: secondReset });
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 90, weeklyResetAt: secondReset });
    expect(notices).toHaveLength(5);
    expect(notices.at(-1)).toMatchObject({ window: "weekly", percentUsed: 90, threshold: 80 });
    observeCodexLowQuota(ACCOUNT_A, { shortPercent: 95, shortResetAt: firstReset });
    observeCodexLowQuota(ACCOUNT_B, { weeklyPercent: 95, weeklyResetAt: firstReset });
    expect(notices).toHaveLength(5);
    expect(config.pausedCodexAccountIds).toBeUndefined();
  });

  test("ignores credits-only and expired observations", () => {
    const config = configWith(protection({ actions: { pause: true, notify: true } }));
    const persisted: OcxConfig[] = [];
    const notices: Notice[] = [];
    register(config, {
      persist: next => persisted.push(structuredClone(next)),
      notify: async notice => { notices.push(notice); },
    });

    observeCodexLowQuota(ACCOUNT_A, { resetCredits: 1 });
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 100, weeklyResetAt: Date.now() - 1 });
    observeCodexLowQuota(ACCOUNT_A, { shortPercent: 100, shortResetAt: Math.floor(Date.now() / 1000) - 1 });

    expect(config.pausedCodexAccountIds).toBeUndefined();
    expect(persisted).toEqual([]);
    expect(notices).toEqual([]);
  });

  test("does not treat carried usage in a credits-only quota write as a fresh observation", async () => {
    setAccountQuotaFromParsed(ACCOUNT_A, { weeklyPercent: 99 });
    const config = configWith(protection({ actions: { pause: true, notify: true } }));
    const persisted: OcxConfig[] = [];
    const notices: Notice[] = [];
    const registration = register(config, {
      persist: next => persisted.push(structuredClone(next)),
      notify: async notice => { notices.push(notice); },
    });

    setAccountQuotaFromParsed(ACCOUNT_A, { resetCredits: 1 });

    expect(config.pausedCodexAccountIds).toBeUndefined();
    expect(persisted).toEqual([]);
    expect(notices).toEqual([]);
    const accepted = { weeklyPercent: 99 };
    setAccountQuotaFromParsed(ACCOUNT_A, accepted, undefined, undefined, accepted);
    await registration.flush();
    expect(persisted[0]?.pausedCodexAccountIds).toEqual([ACCOUNT_A]);
    expect(notices).toEqual([{ accountLabel: fallbackCodexAccountLogLabel(ACCOUNT_A), window: "weekly", percentUsed: 99, threshold: 80, resetAt: null }]);
  });

  test("stops acting after unregister", () => {
    const config = configWith(protection({ actions: { pause: true, notify: true } }));
    const persisted: OcxConfig[] = [];
    const notices: Notice[] = [];
    const unregister = register(config, {
      persist: next => persisted.push(structuredClone(next)),
      notify: async notice => { notices.push(notice); },
    });

    unregister();
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 100 });

    expect(config.pausedCodexAccountIds).toBeUndefined();
    expect(persisted).toEqual([]);
    expect(notices).toEqual([]);
  });

  test("leaves protection inactive when disabled or absent", () => {
    for (const config of [
      configWith(protection({ enabled: false, actions: { pause: true, notify: true } })),
      configWith(),
    ]) {
      const persisted: OcxConfig[] = [];
      const notices: Notice[] = [];
      register(config, {
        persist: next => persisted.push(structuredClone(next)),
        notify: async notice => { notices.push(notice); },
      });
      observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 100 });
      expect(config.pausedCodexAccountIds).toBeUndefined();
      expect(persisted).toEqual([]);
      expect(notices).toEqual([]);
      cleanups.pop()?.();
    }
  });

  test("main-account observations never enter pool low-quota protection", () => {
    const config = configWith(protection({ actions: { pause: true, notify: true } }));
    let writes = 0;
    const registration = register(config, { persist: () => { writes++; } });
    observeCodexLowQuota(MAIN_CODEX_ACCOUNT_ID, { shortPercent: 95, weeklyPercent: 95 });
    expect(config.pausedCodexAccountIds).toBeUndefined();
    expect(registration.listEvents()).toEqual([]);
    expect(writes).toBe(0);
  });

  test("rejects unknown low-quota policy, action, and window keys", () => {
    const policy = protection();
    expect(validateConfigCandidate(configWith(policy)).ok).toBe(true);
    const candidates = [
      { name: "policy", value: { ...policy, unexpected: true } },
      { name: "actions", value: { ...policy, actions: { ...policy.actions, unexpected: true } } },
      { name: "windows", value: { ...policy, windows: { ...policy.windows, unexpected: true } } },
    ];

    for (const candidate of candidates) {
      const result = validateConfigCandidate({
        ...configWith(),
        codexPool: { lowQuotaProtection: candidate.value },
      });
      expect(result.ok, candidate.name).toBe(false);
    }
    for (const candidate of [
      { ...policy, threshold: 0 },
      { ...policy, actions: { pause: false, notify: false } },
      { ...policy, windows: { short: false, weekly: false } },
    ]) {
      expect(validateConfigCandidate({ ...configWith(), codexPool: { lowQuotaProtection: candidate } }).ok).toBe(false);
    }
  });

  test("a manual resume suppresses repause until recovery or a new reset", () => {
    const config = configWith(protection({ actions: { pause: true, notify: false } }));
    register(config, { persist: () => {} });
    const firstReset = Date.now() + 60_000;
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 85, weeklyResetAt: firstReset });
    expect(config.pausedCodexAccountIds).toContain(ACCOUNT_A);
    setCodexAccountPaused(config, ACCOUNT_A, false);
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 90, weeklyResetAt: firstReset });
    expect(config.pausedCodexAccountIds).toBeUndefined();
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 50, weeklyResetAt: firstReset });
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 90, weeklyResetAt: firstReset });
    expect(config.pausedCodexAccountIds).toContain(ACCOUNT_A);
    setCodexAccountPaused(config, ACCOUNT_A, false);
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 90, weeklyResetAt: firstReset + 60_000 });
    expect(config.pausedCodexAccountIds).toContain(ACCOUNT_A);
  });

  test("both active windows honor one manual resume until a new reset episode", () => {
    const config = configWith(protection({ actions: { pause: true, notify: false } }));
    register(config, { persist: () => {} });
    const reset = Date.now() + 60_000;
    const high = { shortPercent: 90, shortResetAt: reset, weeklyPercent: 90, weeklyResetAt: reset };
    observeCodexLowQuota(ACCOUNT_A, high);
    expect(config.pausedCodexAccountIds).toContain(ACCOUNT_A);
    setCodexAccountPaused(config, ACCOUNT_A, false);
    observeCodexLowQuota(ACCOUNT_A, high);
    observeCodexLowQuota(ACCOUNT_A, { ...high, shortPercent: 95, weeklyPercent: 95 });
    expect(config.pausedCodexAccountIds).toBeUndefined();
    observeCodexLowQuota(ACCOUNT_A, { ...high, shortResetAt: reset + 60_000 });
    expect(config.pausedCodexAccountIds).toContain(ACCOUNT_A);
  });

  test("invalid raw WHAM usage stays display-only while valid usage pauses", async () => {
    const config = configWith(protection({ actions: { pause: true, notify: false } }));
    const registration = register(config, { persist: () => {} });
    const credential = {
      accessToken: "fixture-access", refreshToken: "fixture-refresh",
      expiresAt: Date.now() + 60_000, chatgptAccountId: "fixture-chatgpt-account",
    };
    const generation = saveCodexAccountCredential(ACCOUNT_A, credential);
    const poolWriter = capturePoolQuotaWriter(ACCOUNT_A, { ...credential, generation });
    expect(poolWriter).toBeDefined();
    const publish = (usedPercent: number) => commitPoolQuotaResponse(
      new Response(JSON.stringify({ rate_limit: { primary_window: {
        used_percent: usedPercent, limit_window_seconds: 604_800,
      } } }), { status: 200 }),
      { accountId: ACCOUNT_A, existing: null, configuredPlan: "plus", generation,
        writerGeneration: captureConfigGeneration(), poolWriter },
    );
    await publish(150);
    expect(getAccountQuota(ACCOUNT_A)?.weeklyPercent).toBe(100);
    expect(config.pausedCodexAccountIds).toBeUndefined();
    await publish(90);
    expect(config.pausedCodexAccountIds).toContain(ACCOUNT_A);
    await registration.flush();
  });

  test("invalid raw response-header usage stays display-only while valid usage pauses", async () => {
    const config = configWith(protection({ actions: { pause: true, notify: false } }));
    const registration = register(config, { persist: () => {} });
    const headers = (usedPercent: number) => new Headers({
      "x-codex-primary-used-percent": String(usedPercent),
      "x-codex-primary-window-minutes": "10080",
    });
    applyAccountQuotaFromUpstreamHeaders(ACCOUNT_A, headers(150));
    expect(getAccountQuota(ACCOUNT_A)?.weeklyPercent).toBe(100);
    expect(config.pausedCodexAccountIds).toBeUndefined();
    applyAccountQuotaFromUpstreamHeaders(ACCOUNT_A, headers(90));
    expect(config.pausedCodexAccountIds).toContain(ACCOUNT_A);
    await registration.flush();
  });

  test("a stale pool credential response cannot pause its replacement", () => {
    const config = configWith(protection({ actions: { pause: true, notify: false } }));
    const registration = register(config, { persist: () => {} });
    const first = { accessToken: "first-access", refreshToken: "first-refresh",
      expiresAt: Date.now() + 60_000, chatgptAccountId: "first-chatgpt" };
    const generation = saveCodexAccountCredential(ACCOUNT_A, first);
    const writer = capturePoolQuotaWriter(ACCOUNT_A, { ...first, generation });
    expect(writer).toBeDefined();
    removeCodexAccountCredential(ACCOUNT_A);
    saveCodexAccountCredential(ACCOUNT_A, { ...first, accessToken: "replacement-access" });

    applyAccountQuotaFromUpstreamHeaders(ACCOUNT_A, new Headers({
      "x-codex-primary-used-percent": "90", "x-codex-primary-window-minutes": "10080",
    }), captureConfigGeneration(), undefined, { poolWriter: writer });

    expect(getAccountQuota(ACCOUNT_A)?.weeklyPercent).toBe(90);
    expect(config.pausedCodexAccountIds).toBeUndefined();
    expect(registration.hasPendingSave()).toBe(false);
  });

  test("a pool response whose writer capture failed cannot pause its replacement", () => {
    const config = configWith(protection({ actions: { pause: true, notify: false } }));
    const registration = register(config, { persist: () => {} });
    const first = { accessToken: "first-access", refreshToken: "first-refresh",
      expiresAt: Date.now() + 60_000, chatgptAccountId: "first-chatgpt" };
    saveCodexAccountCredential(ACCOUNT_A, first);
    // The credential is replaced before the delayed response lands, exactly when a
    // dispatch-time capture could no longer produce a writer for the retired credential.
    removeCodexAccountCredential(ACCOUNT_A);
    saveCodexAccountCredential(ACCOUNT_A, { ...first, accessToken: "replacement-access" });

    applyAccountQuotaFromUpstreamHeaders(ACCOUNT_A, new Headers({
      "x-codex-primary-used-percent": "90", "x-codex-primary-window-minutes": "10080",
    }), captureConfigGeneration(), undefined, { poolResponse: true });

    // The display snapshot still commits; only the policy observation fails closed.
    expect(getAccountQuota(ACCOUNT_A)?.weeklyPercent).toBe(90);
    expect(config.pausedCodexAccountIds).toBeUndefined();
    expect(registration.hasPendingSave()).toBe(false);
  });

  test("valid WHAM usage without a captured pool writer remains display-only", async () => {
    const config = configWith(protection({ actions: { pause: true, notify: false } }));
    const registration = register(config, { persist: () => {} });
    const generation = saveCodexAccountCredential(ACCOUNT_A, {
      accessToken: "fixture-access", refreshToken: "fixture-refresh",
      expiresAt: Date.now() + 60_000, chatgptAccountId: "fixture-chatgpt-account",
    });
    await commitPoolQuotaResponse(new Response(JSON.stringify({ rate_limit: { primary_window: {
      used_percent: 90, limit_window_seconds: 604_800,
    } } }), { status: 200 }), {
      accountId: ACCOUNT_A, existing: null, configuredPlan: "plus", generation,
      writerGeneration: captureConfigGeneration(),
    });
    expect(getAccountQuota(ACCOUNT_A)?.weeklyPercent).toBe(90);
    expect(config.pausedCodexAccountIds).toBeUndefined();
    expect(registration.hasPendingSave()).toBe(false);
  });

  test.each([false, true])("WS pool metadata requires a captured live writer (captured=%s)", captured => {
    const config = configWith(protection({ actions: { pause: true, notify: false } }));
    const registration = register(config, { persist: () => {} });
    const credential = { accessToken: "fixture-access", refreshToken: "fixture-refresh",
      expiresAt: Date.now() + 60_000, chatgptAccountId: "fixture-chatgpt-account" };
    const generation = saveCodexAccountCredential(ACCOUNT_A, credential);
    const writer = capturePoolQuotaWriter(ACCOUNT_A, { ...credential, generation });
    expect(writer).toBeDefined();
    const observer = codexWsQuotaObserver({
      kind: "pool", accountId: ACCOUNT_A, generation, ...credential,
      writerGeneration: captureConfigGeneration(), poolQuotaWriter: captured ? writer : undefined,
    }, { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" });
    expect(observer).toBeDefined();
    observer!(new Headers({ "x-codex-primary-used-percent": "90", "x-codex-primary-window-minutes": "10080" }));
    expect(getAccountQuota(ACCOUNT_A)?.weeklyPercent).toBe(90);
    expect(config.pausedCodexAccountIds).toEqual(captured ? [ACCOUNT_A] : undefined);
    expect(registration.hasPendingSave()).toBe(captured);
  });

  test("WS metadata from a retired generation cannot refresh or pause its replacement", () => {
    const config = configWith(protection({ actions: { pause: true, notify: false } }));
    const registration = register(config, { persist: () => {} });
    const credential = { accessToken: "fixture-access", refreshToken: "fixture-refresh",
      expiresAt: Date.now() + 60_000, chatgptAccountId: "fixture-chatgpt-account" };
    const generation = saveCodexAccountCredential(ACCOUNT_A, credential);
    const writer = capturePoolQuotaWriter(ACCOUNT_A, { ...credential, generation });
    expect(writer).toBeDefined();
    const observer = codexWsQuotaObserver({
      kind: "pool", accountId: ACCOUNT_A, generation, ...credential,
      writerGeneration: captureConfigGeneration(), poolQuotaWriter: writer,
    }, { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" });
    expect(observer).toBeDefined();
    removeCodexAccountCredential(ACCOUNT_A);
    saveCodexAccountCredential(ACCOUNT_A, { ...credential, accessToken: "replacement-access" });
    observer!(new Headers({ "x-codex-primary-used-percent": "90", "x-codex-primary-window-minutes": "10080" }));
    expect(getAccountQuota(ACCOUNT_A)).toBeNull();
    expect(config.pausedCodexAccountIds).toBeUndefined();
    expect(registration.hasPendingSave()).toBe(false);
  });

  test.each([false, true])("compact pool headers require a captured live writer (captured=%s)", async captured => {
    const config = configWith(protection({ actions: { pause: true, notify: false } }));
    config.defaultProvider = "openai";
    config.activeCodexAccountId = ACCOUNT_A;
    config.providers = { openai: { adapter: "openai-responses", authMode: "forward",
      baseUrl: "https://chatgpt.com/backend-api/codex", codexAccountMode: "pool" } };
    saveCodexAccountCredential(ACCOUNT_A, { accessToken: "fixture-access", refreshToken: "fixture-refresh",
      expiresAt: Date.now() + 600_000, chatgptAccountId: "fixture-chatgpt-account" });
    updateAccountQuota(ACCOUNT_A, 10);
    const registration = register(config, { persist: () => {} });
    const originalResolve = authContextModule.resolveCodexAuthContext;
    let poolContexts = 0;
    // The resolver still chooses a real fixture credential. Omit only its optional writer
    // to exercise dispatch-time capture failure through the actual compact handler.
    const resolve = spyOn(authContextModule, "resolveCodexAuthContext").mockImplementation(async (...args) => {
      const ctx = await originalResolve(...args);
      if (ctx.kind !== "pool") return ctx;
      expect(ctx.poolQuotaWriter).toBeDefined();
      poolContexts++;
      return captured ? ctx : { ...ctx, poolQuotaWriter: undefined };
    });
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    const releaseSpendHome = acquireOwnedSpendHome();
    const originalFetch = globalThis.fetch;
    let compactSends = 0;
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        return Response.json({ models: [{ slug: "gpt-5.6-sol", supported_in_api: true, visibility: "list" }] });
      }
      expect(url.pathname.endsWith("/responses/compact")).toBe(true);
      compactSends++;
      return Response.json(completedPayload("fixture compact result"), { headers: {
        "x-codex-primary-used-percent": "90", "x-codex-primary-window-minutes": "10080",
      } });
    }) as typeof fetch;
    try {
      const response = await handleResponsesCompact(compactionRequest(baseCompactionBody({ model: "gpt-5.6-sol" })),
        config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      expect(compactSends).toBe(1);
      expect(poolContexts).toBeGreaterThan(0);
      expect(getAccountQuota(ACCOUNT_A)?.weeklyPercent).toBe(90);
      expect(config.pausedCodexAccountIds).toEqual(captured ? [ACCOUNT_A] : undefined);
      expect(registration.hasPendingSave()).toBe(captured);
    } finally {
      resolve.mockRestore();
      globalThis.fetch = originalFetch;
      try { await drainCompactionResponseState(); } finally {
        releaseSpendHome();
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousCodexHome;
      }
    }
  });

  test("invalid raw legacy weekly usage stays display-only while valid usage pauses", async () => {
    const config = configWith(protection({ actions: { pause: true, notify: false } }));
    const registration = register(config, { persist: () => {} });
    updateAccountQuota(ACCOUNT_A, 150);
    expect(getAccountQuota(ACCOUNT_A)?.weeklyPercent).toBe(100);
    expect(config.pausedCodexAccountIds).toBeUndefined();
    updateAccountQuota(ACCOUNT_A, 90);
    expect(config.pausedCodexAccountIds).toContain(ACCOUNT_A);
    await registration.flush();
  });

  test("notice failure retries on an observation after the backoff and only then reports delivery", async () => {
    const config = configWith(protection({ actions: { pause: false, notify: true } }));
    let calls = 0;
    const registration = register(config, { notify: async () => { if (++calls === 1) throw new Error("sink failed"); } });
    const start = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(start);
    cleanups.push(() => clock.mockRestore());
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 80 });
    await Promise.resolve();
    expect(registration.listEvents(1)[0]?.status).toBe("failed");
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 81 });
    expect(calls).toBe(1);
    clock.mockReturnValue(start + 5 * 60_000 + 1);
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 82 });
    await Promise.resolve();
    expect(registration.listEvents(1)[0]?.status).toBe("delivered");
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 90 });
    expect(calls).toBe(2);
    expect(registration.listEvents(100).every(event => Object.keys(event).sort().join(",") ===
      "accountId,delivery,percentUsed,resetAt,status,timestamp,window")).toBe(true);
  });

  test("the default headless alert is logged, never reported as delivered", () => {
    const config = configWith(protection({ actions: { pause: false, notify: true } }));
    const registration = register(config);
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 85 });
    expect(registration.listEvents(1)[0]).toMatchObject({
      accountId: ACCOUNT_A, delivery: "notice", status: "logged",
    });
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 90 });
    expect(registration.listEvents(100).filter(event => event.delivery === "notice")).toHaveLength(1);
  });

  test("a blocked save times out flush and later work is fenced", async () => {
    const config = configWith(protection({ actions: { pause: true, notify: false } }));
    let resolveSave: (() => void) | undefined;
    let writes = 0;
    const registration = registerCodexLowQuotaProtection(config, {
      persist: async () => { writes++; await new Promise<void>(resolve => { resolveSave = resolve; }); },
    });
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 90 });
    const flushStartedAt = performance.now();
    await registration.flush();
    const flushElapsedMs = performance.now() - flushStartedAt;
    // The production deadline is 500 ms. Allow scheduler jitter, but an immediate
    // return (or an unref'd deadline that never waits) must not satisfy this case.
    expect(flushElapsedMs).toBeGreaterThanOrEqual(400);
    expect(flushElapsedMs).toBeLessThan(3_000);
    expect(writes).toBe(1);
    expect(registration.listEvents(1)[0]?.status).toBe("pending");
    resolveSave?.();
    const deadline = Date.now() + 1_000;
    while (registration.listEvents(1)[0]?.status !== "succeeded" && Date.now() < deadline) {
      await Bun.sleep(1);
    }
    expect(registration.listEvents(1)[0]?.status).toBe("succeeded");
    expect(registration.listEvents(100).filter(event => event.status === "cancelled")).toHaveLength(0);
    observeCodexLowQuota(ACCOUNT_B, { weeklyPercent: 90 });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(writes).toBe(1);
  });

  test("flush returns promptly when no pause save is pending", async () => {
    const registration = register(configWith(protection()));
    const flushStartedAt = performance.now();
    await registration.flush();
    expect(performance.now() - flushStartedAt).toBeLessThan(400);
    expect(registration.hasPendingSave()).toBe(false);
  });

  test("closing before the queued save starts cancels it without a config write", async () => {
    const config = configWith(protection({ actions: { pause: true, notify: false } }));
    let writes = 0;
    const registration = register(config, { persist: () => { writes++; } });
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 90 });
    registration();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(writes).toBe(0);
    expect(registration.listEvents(1)[0]?.status).toBe("cancelled");
  });

  test("a failed deferred save retries and publishes durable status", async () => {
    const config = configWith(protection({ actions: { pause: true, notify: false } }));
    let writes = 0;
    let saved: (() => void) | undefined;
    const succeeded = new Promise<void>(resolve => { saved = resolve; });
    const registration = register(config, { persist: () => {
      if (++writes === 1) throw new Error("transient save failure");
      saved?.();
    } });
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 88 });
    await Promise.race([succeeded, new Promise((_, reject) => setTimeout(() => reject(new Error("save retry timeout")), 1_000))]);
    await registration.flush();
    expect(writes).toBe(2);
    expect(registration.listEvents(100).map(event => event.status)).toContain("failed");
    expect(registration.listEvents(1)[0]?.status).toBe("succeeded");
  });

  test("fan-out isolates throwing observers and independent server configs", async () => {
    const older = configWith(protection({ actions: { pause: false, notify: true } }));
    older.codexAccounts = [account(ACCOUNT_A)];
    const newer = configWith(protection({ actions: { pause: true, notify: false } }));
    newer.codexAccounts = [account(ACCOUNT_B)];
    const notices: Notice[] = [];
    const first = register(older, { notify: notice => { notices.push(notice); } });
    const throwing = registerLowQuotaObserver(() => { throw new Error("isolated"); });
    cleanups.push(throwing);
    const second = register(newer, { persist: () => {} });
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 85 });
    expect(newer.pausedCodexAccountIds).toBeUndefined();
    expect(notices).toHaveLength(1);
    observeCodexLowQuota(ACCOUNT_B, { weeklyPercent: 85 });
    expect(newer.pausedCodexAccountIds).toEqual([ACCOUNT_B]);
    await second.flush();
    first();
    throwing();
    observeCodexLowQuota(ACCOUNT_A, { shortPercent: 85 });
    expect(notices).toHaveLength(1);
  });

  test("the event ledger retains only its newest hundred sanitized entries", () => {
    const ledger = createLowQuotaEventLedger();
    for (let i = 0; i < 120; i++) {
      ledger.publish({ accountId: `account-${i}`, window: "weekly", percentUsed: 80,
        resetAt: null, timestamp: i, status: "succeeded", delivery: "pause-save" });
    }
    const events = ledger.list(999);
    expect(events).toHaveLength(100);
    expect(events[0]?.accountId).toBe("account-119");
    expect(events.at(-1)?.accountId).toBe("account-20");
  });

  test("one coalesced save reports durability for both paused accounts", async () => {
    const config = configWith(protection({ actions: { pause: true, notify: false } }));
    let writes = 0;
    const registration = register(config, { persist: () => { writes++; } });
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 90 });
    observeCodexLowQuota(ACCOUNT_B, { weeklyPercent: 90 });
    expect(writes).toBe(0);
    await registration.flush();
    expect(writes).toBe(1);
    expect(new Set(registration.listEvents(100).filter(event => event.status === "succeeded")
      .map(event => event.accountId))).toEqual(new Set([ACCOUNT_A, ACCOUNT_B]));
  });

  test("a manual resume before the deferred save is not reported as a durable pause", async () => {
    const config = configWith(protection({ actions: { pause: true, notify: false } }));
    const registration = register(config, { persist: () => {} });
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 90 });
    setCodexAccountPaused(config, ACCOUNT_A, false);
    await registration.flush();
    expect(registration.listEvents(1)[0]).toMatchObject({ accountId: ACCOUNT_A, delivery: "pause-save", status: "cancelled" });
  });
});

type DeferredCall = { notice: Notice; signal: AbortSignal; resolve(): void; reject(error: Error): void };

function deferredDesktop(): { sink: () => LowQuotaNoticeSink; calls: DeferredCall[]; resolves: () => number } {
  const calls: DeferredCall[] = [];
  let resolved = 0;
  const sink: LowQuotaNoticeSink = (notice, signal) => new Promise<void>((resolve, reject) => {
    calls.push({ notice, signal, resolve, reject });
  });
  return { sink: () => { resolved++; return sink; }, calls, resolves: () => resolved };
}

function desktopPolicy(desktop: boolean | undefined, overrides: Partial<CodexLowQuotaProtectionConfig> = {}): CodexLowQuotaProtectionConfig {
  return protection({ actions: { pause: false, notify: true, ...(desktop === undefined ? {} : { desktop }) }, ...overrides });
}

function noticeStatuses(registration: LowQuotaRegistration): string[] {
  return registration.listEvents(100).filter(event => event.delivery === "notice").map(event => event.status).reverse();
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe("low quota desktop delivery", () => {
  test("without the desktop opt-in the alert stays logged and no notifier is resolved", () => {
    const desktop = deferredDesktop();
    for (const flag of [undefined, false]) {
      const config = configWith(desktopPolicy(flag));
      const registration = register(config, { desktopSink: desktop.sink });
      observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 85 });
      expect(noticeStatuses(registration)).toEqual(["logged"]);
      registration();
    }
    expect(desktop.resolves()).toBe(0);
  });

  test("the desktop opt-in delivers one pseudonymous notice per episode", async () => {
    const config = configWith(desktopPolicy(true));
    config.codexAccounts = [{ ...account(ACCOUNT_A), alias: "secret alias", logLabel: "p0a1b2c" }];
    const desktop = deferredDesktop();
    const registration = register(config, { desktopSink: desktop.sink });
    const resetAt = Date.now() + 60_000;
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 85, weeklyResetAt: resetAt });
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 90, weeklyResetAt: resetAt });
    expect(desktop.calls).toHaveLength(1);
    expect(desktop.calls[0]!.notice).toEqual({ accountLabel: "p0a1b2c", window: "weekly", percentUsed: 85, threshold: 80, resetAt });
    const text = JSON.stringify(desktop.calls[0]!.notice);
    for (const secret of ["secret alias", "@example.test", ACCOUNT_A]) expect(text).not.toContain(secret);
    desktop.calls[0]!.resolve();
    await settle();
    expect(noticeStatuses(registration)).toEqual(["pending", "delivered"]);
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 95, weeklyResetAt: resetAt });
    expect(desktop.calls).toHaveLength(1);
  });

  test("an account without a stored log label gets the fallback pseudonym", () => {
    const config = configWith(desktopPolicy(true));
    const desktop = deferredDesktop();
    register(config, { desktopSink: desktop.sink });
    observeCodexLowQuota(ACCOUNT_B, { shortPercent: 81 });
    expect(desktop.calls[0]!.notice.accountLabel).toBe(fallbackCodexAccountLogLabel(ACCOUNT_B));
  });

  test("a failed desktop notice is recorded, logged once, and retried only after the backoff", async () => {
    const config = configWith(desktopPolicy(true));
    const desktop = deferredDesktop();
    const registration = register(config, { desktopSink: desktop.sink });
    const start = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(start);
    cleanups.push(() => clock.mockRestore());
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    cleanups.push(() => warn.mockRestore());
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 85 });
    desktop.calls[0]!.reject(new Error("notifier exited 1"));
    await settle();
    expect(noticeStatuses(registration)).toEqual(["pending", "failed"]);
    for (const percent of [86, 87, 88]) observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: percent });
    expect(desktop.calls).toHaveLength(1);
    clock.mockReturnValue(start + 5 * 60_000 - 1);
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 89 });
    expect(desktop.calls).toHaveLength(1);
    clock.mockReturnValue(start + 5 * 60_000 + 1);
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 90 });
    expect(desktop.calls).toHaveLength(2);
    desktop.calls[1]!.resolve();
    await settle();
    expect(noticeStatuses(registration)).toEqual(["pending", "failed", "pending", "delivered"]);
    expect(warn.mock.calls.filter(call => String(call[0]).startsWith("[codex-low-quota] weekly quota reached"))).toHaveLength(1);
  });

  test("an unsupported host keeps the opted-in alert logged", () => {
    const config = configWith(desktopPolicy(true));
    let resolved = 0;
    const registration = register(config, { desktopSink: () => { resolved++; return undefined; } });
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 85 });
    expect(resolved).toBe(1);
    expect(noticeStatuses(registration)).toEqual(["logged"]);
  });

  const cancellations: Array<{ name: string; trigger: (config: OcxConfig, registration: LowQuotaRegistration) => void | Promise<void> }> = [
    { name: "a new reset boundary", trigger: () => { observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 85, weeklyResetAt: Date.now() + 120_000 }); } },
    { name: "a below-threshold recovery", trigger: () => { observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 10, weeklyResetAt: Date.now() + 60_000 }); } },
    { name: "account removal", trigger: config => {
      config.codexAccounts = [account(ACCOUNT_B)];
      observeCodexLowQuota(ACCOUNT_B, { weeklyPercent: 5 });
    } },
    { name: "disabling the policy", trigger: config => {
      config.codexPool = { lowQuotaProtection: desktopPolicy(true, { enabled: false }) };
      observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 85 });
    } },
    { name: "turning desktop delivery off", trigger: config => {
      config.codexPool = { lowQuotaProtection: desktopPolicy(false) };
      observeCodexLowQuota(ACCOUNT_B, { weeklyPercent: 5 });
    } },
    { name: "shutdown through flush", trigger: async (_config, registration) => { await registration.flush(); } },
  ];

  for (const { name, trigger } of cancellations) {
    test("an in-flight desktop notice is cancelled once by " + name, async () => {
      const config = configWith(desktopPolicy(true));
      const desktop = deferredDesktop();
      const registration = register(config, { desktopSink: desktop.sink });
      observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 85, weeklyResetAt: Date.now() + 60_000 });
      const first = desktop.calls[0]!;
      expect(first.signal.aborted).toBe(false);
      await trigger(config, registration);
      expect(first.signal.aborted).toBe(true);
      first.resolve();
      await settle();
      const statuses = noticeStatuses(registration);
      expect(statuses.filter(status => status === "cancelled")).toHaveLength(1);
      expect(statuses.slice(0, 2)).toEqual(["pending", "cancelled"]);
      expect(statuses).not.toContain("delivered");
    });
  }

  test("turning desktop delivery on and off takes effect without re-registration", async () => {
    const config = configWith(desktopPolicy(false));
    const desktop = deferredDesktop();
    const registration = register(config, { desktopSink: desktop.sink });
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 85 });
    expect(desktop.resolves()).toBe(0);
    config.codexPool = { lowQuotaProtection: desktopPolicy(true) };
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 86 });
    expect(desktop.resolves()).toBe(1);
    desktop.calls[0]!.resolve();
    await settle();
    config.codexPool = { lowQuotaProtection: desktopPolicy(false) };
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 87 });
    expect(desktop.resolves()).toBe(1);
    expect(noticeStatuses(registration)).toEqual(["logged", "pending", "delivered", "logged"]);
  });

  test("desktop delivery requires notify even while the policy is disabled", () => {
    for (const enabled of [true, false]) {
      const policy = protection({ enabled, actions: { pause: true, notify: false, desktop: true } });
      const result = validateConfigCandidate({ ...configWith(), codexPool: { lowQuotaProtection: policy } });
      expect(result.ok, String(enabled)).toBe(false);
    }
    for (const desktop of [true, false]) {
      expect(validateConfigCandidate(configWith(protection({ actions: { pause: true, notify: true, desktop } }))).ok).toBe(true);
    }
    const typo = { ...protection(), actions: { pause: true, notify: true, desktop: "yes" } };
    expect(validateConfigCandidate({ ...configWith(), codexPool: { lowQuotaProtection: typo } } as unknown as OcxConfig).ok).toBe(false);
  });
});

describe("low quota desktop delivery through the platform adapter", () => {
  type Child = { killed: number; exit(code: number): void };
  function adapter(timeoutMs = 60_000) {
    const children: Child[] = [];
    const sink = resolveLowQuotaDesktopSink({
      platform: "darwin", exists: () => true, timeoutMs,
      spawn: () => {
        let done!: (code: number) => void;
        const exited = new Promise<number>(resolve => { done = resolve; });
        const child: Child = { killed: 0, exit: code => done(code) };
        children.push(child);
        return { exited, kill: () => { child.killed++; } };
      },
    })!;
    return { sink: () => sink, children };
  }

  test("a timed-out notifier is recorded as failed", async () => {
    const config = configWith(desktopPolicy(true));
    const host = adapter(5);
    const registration = register(config, { desktopSink: host.sink });
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 85 });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(host.children[0]!.killed).toBe(1);
    expect(noticeStatuses(registration)).toEqual(["pending", "failed"]);
  });

  test("a reset boundary kills the old child once and the replacement is delivered", async () => {
    const config = configWith(desktopPolicy(true));
    const host = adapter();
    const registration = register(config, { desktopSink: host.sink });
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 85, weeklyResetAt: Date.now() + 60_000 });
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 86, weeklyResetAt: Date.now() + 120_000 });
    expect(host.children.map(child => child.killed)).toEqual([1, 0]);
    host.children[0]!.exit(0);
    host.children[1]!.exit(0);
    await settle();
    expect(noticeStatuses(registration)).toEqual(["pending", "cancelled", "pending", "delivered"]);
  });

  test("shutdown kills an in-flight child once and records no late delivery", async () => {
    const config = configWith(desktopPolicy(true));
    const host = adapter();
    const registration = register(config, { desktopSink: host.sink });
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 85 });
    await registration.flush();
    expect(host.children[0]!.killed).toBe(1);
    host.children[0]!.exit(0);
    await settle();
    expect(noticeStatuses(registration)).toEqual(["pending", "cancelled"]);
  });

  test("an injected notify sink takes precedence over desktop delivery", async () => {
    const config = configWith(desktopPolicy(true));
    const host = adapter();
    let resolved = 0;
    const notices: Notice[] = [];
    const registration = register(config, {
      notify: notice => { notices.push(notice); },
      desktopSink: () => { resolved++; return host.sink(); },
    });
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 85 });
    await settle();
    expect(notices).toHaveLength(1);
    expect(resolved).toBe(0);
    expect(host.children).toHaveLength(0);
    expect(noticeStatuses(registration)).toEqual(["pending", "delivered"]);
  });
});
