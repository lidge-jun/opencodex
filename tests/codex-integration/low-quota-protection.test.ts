import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfigCandidate } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { observeCodexLowQuota, registerLowQuotaObserver } from "../../src/codex/low-quota-observer";
import { clearLowQuotaEventsForTests, listLowQuotaEvents, publishLowQuotaEvent } from "../../src/codex/low-quota-events";
import { registerCodexLowQuotaProtection, type LowQuotaRegistration } from "../../src/codex/low-quota-protection";
import { setCodexAccountPaused } from "../../src/codex/account-pause";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
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
  notify?: (notice: Notice) => Promise<void>;
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
  clearLowQuotaEventsForTests();
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

    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 79 });
    expect(config.pausedCodexAccountIds).toBeUndefined();
    expect(persisted).toEqual([]);

    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 80 });
    expect(config.pausedCodexAccountIds).toEqual([ACCOUNT_A]);
    expect(persisted).toHaveLength(0);
    await registration.flush();
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
    setAccountQuotaFromParsed(ACCOUNT_A, { weeklyPercent: 99 });
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

  test("notice failure retries on a later observation and only then reports delivery", async () => {
    const config = configWith(protection({ actions: { pause: false, notify: true } }));
    let calls = 0;
    register(config, { notify: async () => { if (++calls === 1) throw new Error("sink failed"); } });
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 80 });
    await Promise.resolve();
    expect(listLowQuotaEvents(1)[0]?.status).toBe("failed");
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 82 });
    await Promise.resolve();
    expect(listLowQuotaEvents(1)[0]?.status).toBe("delivered");
    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 90 });
    expect(calls).toBe(2);
    expect(listLowQuotaEvents(100).every(event => Object.keys(event).sort().join(",") ===
      "accountId,delivery,percentUsed,resetAt,status,timestamp,window")).toBe(true);
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
    expect(listLowQuotaEvents(1)[0]?.status).toBe("failed");
    resolveSave?.();
    observeCodexLowQuota(ACCOUNT_B, { weeklyPercent: 90 });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(writes).toBe(1);
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
    expect(listLowQuotaEvents(100).map(event => event.status)).toContain("failed");
    expect(listLowQuotaEvents(1)[0]?.status).toBe("delivered");
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
    for (let i = 0; i < 120; i++) {
      publishLowQuotaEvent({ accountId: `account-${i}`, window: "weekly", percentUsed: 80,
        resetAt: null, timestamp: i, status: "delivered", delivery: "notice" });
    }
    const events = listLowQuotaEvents(999);
    expect(events).toHaveLength(100);
    expect(events[0]?.accountId).toBe("account-119");
    expect(events.at(-1)?.accountId).toBe("account-20");
  });
});
