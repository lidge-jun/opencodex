import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectInitialQuotaActivation, reserveInitialQuotaActivation } from "../../src/codex/quota-initial-activation";
import { resetCodexQuotaAutoRefreshForTests, runCodexQuotaAutoRefresh } from "../../src/codex/quota-auto-refresh";
import { loadConfig, validateConfigCandidate } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { StoredAccountQuota } from "../../src/codex/quota-types";
import type { OcxConfig } from "../../src/types";

const NOW = 1_800_000_000_000;
const WEEK = 604_800_000;
function config(): OcxConfig {
  return { defaultProvider: "openai", providers: { openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex", codexAccountMode: "pool" } },
    codexAccounts: [{ id: "pool-a", isMain: false, plan: "pro", email: "fixture@example.test" }],
    codexQuotaAutoRefresh: { "pool-a": { weekly: true, nextWeeklyResetAt: NOW + 86_400_000 } } };
}
function idle(at = NOW): StoredAccountQuota { return { weeklyPercent: 0, weeklyResetAt: (at + WEEK) / 1000, updatedAt: at }; }
afterEach(resetCodexQuotaAutoRefreshForTests);

test("one 0% snapshot or a repeated cached snapshot never activates", () => {
  const cfg = config(), quota = idle();
  expect(inspectInitialQuotaActivation(cfg, "pool-a", quota, "g1", NOW)).toEqual({ probe: false, windows: [] });
  expect(inspectInitialQuotaActivation(cfg, "pool-a", quota, "g1", NOW + 60_000)).toEqual({ probe: true, windows: [] });
});

test("two fresh moving reset observations prove an idle weekly window", () => {
  const cfg = config();
  inspectInitialQuotaActivation(cfg, "pool-a", idle(), "g1", NOW);
  expect(inspectInitialQuotaActivation(cfg, "pool-a", idle(NOW + 60_000), "g1", NOW + 60_000).windows).toEqual(["weekly"]);
});

test("a fixed reset is already counting down even while percent remains zero", () => {
  const cfg = config();
  inspectInitialQuotaActivation(cfg, "pool-a", idle(), "g1", NOW);
  expect(inspectInitialQuotaActivation(cfg, "pool-a", { ...idle(), updatedAt: NOW + 60_000 }, "g1", NOW + 60_000).windows).toEqual([]);
});

test.each(["identity", "disabled", "nonzero", "stale", "clock", "short-gap"])("uncertain %s evidence cannot activate", reason => {
  const cfg = config();
  inspectInitialQuotaActivation(cfg, "pool-a", idle(), "g1", NOW);
  let next = idle(NOW + 60_000), binding = "g1", now = NOW + 60_000;
  if (reason === "identity") binding = "g2";
  if (reason === "disabled") cfg.codexQuotaAutoRefresh!["pool-a"]!.weekly = false;
  if (reason === "nonzero") next.weeklyPercent = 1;
  if (reason === "stale") now += 300_001;
  if (reason === "clock") now = NOW - 1;
  if (reason === "short-gap") { now = NOW + 1000; next = idle(now); }
  expect(inspectInitialQuotaActivation(cfg, "pool-a", next, binding, now).windows).toEqual([]);
});

test("only an explicitly reported five-hour window joins weekly activation", () => {
  const cfg = config(); cfg.codexQuotaAutoRefresh!["pool-a"]!.fiveHour = true;
  const both = (at: number): StoredAccountQuota => ({ ...idle(at), shortPercent: 0, shortWindowSeconds: 18_000, shortResetAt: (at + 18_000_000) / 1000, shortObservedAt: at });
  inspectInitialQuotaActivation(cfg, "pool-a", both(NOW), "g1", NOW);
  expect(inspectInitialQuotaActivation(cfg, "pool-a", both(NOW + 60_000), "g1", NOW + 60_000).windows).toEqual(["fiveHour", "weekly"]);
  resetCodexQuotaAutoRefreshForTests();
  const other = (at: number) => ({ ...both(at), shortWindowSeconds: 3600 });
  inspectInitialQuotaActivation(cfg, "pool-a", other(NOW), "g1", NOW);
  expect(inspectInitialQuotaActivation(cfg, "pool-a", other(NOW + 60_000), "g1", NOW + 60_000).windows).toEqual(["weekly"]);
});

test("worker observes twice and reserves durable intent before one warmup", async () => {
  const cfg = config(); let quota = idle(), probes = 0, warms = 0, saved = false;
  const deps = { getQuota: () => quota, refreshQuota: async () => { probes++; quota = idle(NOW + 60_000); },
    reserveInitial: (current: OcxConfig, id: string, _windows: readonly string[], now: number) => {
      current.codexQuotaAutoRefresh![id]!.lastInitialActivationAttemptAt = now; saved = true; return true;
    }, warmAccount: async () => { expect(saved).toBe(true); warms++; } };
  await runCodexQuotaAutoRefresh(cfg, NOW, deps);
  expect(warms).toBe(0);
  await runCodexQuotaAutoRefresh(cfg, NOW + 60_000, deps);
  expect(probes).toBe(1); expect(warms).toBe(1);
  resetCodexQuotaAutoRefreshForTests();
  await runCodexQuotaAutoRefresh(cfg, NOW + 120_000, deps);
  expect(warms).toBe(1);
  expect(cfg.codexQuotaAutoRefresh!["pool-a"]!.lastWeeklyResetAt).toBeUndefined();
  expect(cfg.codexQuotaAutoRefresh!["pool-a"]!.nextWeeklyResetAt).toBe(NOW + 86_400_000);
  cfg.codexQuotaAutoRefresh!["pool-a"]!.nextWeeklyResetAt = NOW + 90_000;
  resetCodexQuotaAutoRefreshForTests();
  await runCodexQuotaAutoRefresh(cfg, NOW + 120_000, deps);
  expect(warms).toBe(1);
});

test("metadata arriving after sweep entry retains the first observation", async () => {
  const cfg = config(); let clock = NOW, quota = idle(), warms = 0;
  const time = spyOn(Date, "now").mockImplementation(() => clock);
  try {
    const deps = { getQuota: () => quota,
      refreshQuota: async () => { clock += 100; quota = idle(clock); },
      reserveInitial: () => true, warmAccount: async () => { warms++; } };
    await runCodexQuotaAutoRefresh(cfg, undefined, deps);
    clock += 60_000;
    await runCodexQuotaAutoRefresh(cfg, undefined, deps);
    expect(warms).toBe(1);
  } finally { time.mockRestore(); }
});

test("failed intent persistence and an opt-out during probing send nothing", async () => {
  for (const optOut of [false, true]) {
    resetCodexQuotaAutoRefreshForTests(); const cfg = config(); let quota = idle(), warms = 0;
    const deps = { getQuota: () => quota, refreshQuota: async () => { quota = idle(NOW + 60_000); if (optOut) cfg.codexQuotaAutoRefresh = {}; },
      reserveInitial: () => false, warmAccount: async () => { warms++; } };
    await runCodexQuotaAutoRefresh(cfg, NOW, deps);
    await runCodexQuotaAutoRefresh(cfg, NOW + 60_000, deps);
    expect(warms).toBe(0);
  }
});

async function withStoredConfig(run: (cfg: OcxConfig, path: string) => void) {
  const previous = process.env.OPENCODEX_HOME, home = mkdtempSync(join(tmpdir(), "ocx-initial-activation-"));
  process.env.OPENCODEX_HOME = home;
  try { const cfg = config(), path = join(home, "config.json"); writeFileSync(path, JSON.stringify(cfg)); run(cfg, path); }
  finally { await flushConfigDirHardeningForTests(); if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous; removeTreeWithRetry(home); }
}

test("the persisted attempt survives restart without claiming a successful reset", async () => {
  await withStoredConfig((cfg, path) => {
    expect(reserveInitialQuotaActivation(cfg, "pool-a", ["weekly"], NOW)).toBe(true);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.codexQuotaAutoRefresh["pool-a"]).toMatchObject({ lastInitialActivationAttemptAt: NOW, nextWeeklyResetAt: NOW + 86_400_000 });
    expect(saved.codexQuotaAutoRefresh["pool-a"].lastWeeklyResetAt).toBeUndefined();
    resetCodexQuotaAutoRefreshForTests();
    expect(reserveInitialQuotaActivation(loadConfig(), "pool-a", ["weekly"], NOW + 60_000)).toBe(false);
    expect(validateConfigCandidate(saved).ok).toBe(true);
  });
});

test("persisted provider disable or account pause outranks stale in-memory opt-in", async () => {
  for (const change of ["provider", "pause", "optout"]) await withStoredConfig((cfg, path) => {
    const current = structuredClone(cfg);
    if (change === "provider") current.providers.openai!.disabled = true;
    if (change === "pause") current.pausedCodexAccountIds = ["pool-a"];
    if (change === "optout") current.codexQuotaAutoRefresh = {};
    writeFileSync(path, JSON.stringify(current));
    expect(reserveInitialQuotaActivation(cfg, "pool-a", ["weekly"], NOW)).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8")).codexQuotaAutoRefresh?.["pool-a"]?.lastInitialActivationAttemptAt).toBeUndefined();
  });
});
