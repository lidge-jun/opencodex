import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { commitPoolQuotaResponse } from "../../src/codex/auth-api/pool-quota-probe";
import { captureConfigGeneration } from "../../src/lib/state-store-sweeper";
import { applyAccountQuotaFromUpstreamHeaders, clearAccountQuota, getAccountQuota, setAccountQuotaFromParsed, updateAccountQuota } from "../../src/codex/quota";
import type { CodexAccount } from "../../src/types/accounts";
import type { CodexLowQuotaProtectionConfig, OcxConfig } from "../../src/types/config";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ACCOUNT_A = "low-quota-a";
const ACCOUNT_B = "low-quota-b";
type Notice = { window: "short" | "weekly"; percentUsed: number; threshold: number };

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
  notify?: (notice: Notice) => void | Promise<void>;
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
    expect(notices.at(-1)).toEqual({ window: "weekly", percentUsed: 90, threshold: 80 });
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
    expect(notices).toEqual([{ window: "weekly", percentUsed: 99, threshold: 80 }]);
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
    const generation = saveCodexAccountCredential(ACCOUNT_A, {
      accessToken: "fixture-access", refreshToken: "fixture-refresh",
      expiresAt: Date.now() + 60_000, chatgptAccountId: "fixture-chatgpt-account",
    });
    const publish = (usedPercent: number) => commitPoolQuotaResponse(
      new Response(JSON.stringify({ rate_limit: { primary_window: {
        used_percent: usedPercent, limit_window_seconds: 604_800,
      } } }), { status: 200 }),
      { accountId: ACCOUNT_A, existing: null, configuredPlan: "plus", generation,
        writerGeneration: captureConfigGeneration() },
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

  test("notice failure retries on a later observation and only then reports delivery", async () => {
    const config = configWith(protection({ actions: { pause: false, notify: true } }));
    let calls = 0;
    const registration = register(config, { notify: async () => { if (++calls === 1) throw new Error("sink failed"); } });
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 80 });
    await Promise.resolve();
    expect(registration.listEvents(1)[0]?.status).toBe("failed");
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
    await registration.flush();
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
