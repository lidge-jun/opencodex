import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfigCandidate } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { observeCodexLowQuota } from "../../src/codex/low-quota-observer";
import { registerCodexLowQuotaProtection } from "../../src/codex/low-quota-protection";
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
} = {}): () => void {
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
  test("persists a paused-account snapshot only after the threshold is reached", () => {
    const config = configWith(protection());
    const persisted: OcxConfig[] = [];
    register(config, { persist: next => persisted.push(structuredClone(next)) });

    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 79 });
    expect(config.pausedCodexAccountIds).toBeUndefined();
    expect(persisted).toEqual([]);

    observeCodexLowQuota(ACCOUNT_A, { weeklyPercent: 80 });
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

  test("does not treat carried usage in a credits-only quota write as a fresh observation", () => {
    setAccountQuotaFromParsed(ACCOUNT_A, { weeklyPercent: 99 });
    const config = configWith(protection({ actions: { pause: true, notify: true } }));
    const persisted: OcxConfig[] = [];
    const notices: Notice[] = [];
    register(config, {
      persist: next => persisted.push(structuredClone(next)),
      notify: async notice => { notices.push(notice); },
    });

    setAccountQuotaFromParsed(ACCOUNT_A, { resetCredits: 1 });

    expect(config.pausedCodexAccountIds).toBeUndefined();
    expect(persisted).toEqual([]);
    expect(notices).toEqual([]);
    setAccountQuotaFromParsed(ACCOUNT_A, { weeklyPercent: 99 });
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
  });
});
