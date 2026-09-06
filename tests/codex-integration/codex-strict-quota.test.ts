import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, getStrictAccountQuota, parseMainPolicyUsageQuota, parseUsageQuota, setAccountQuotaFromParsed, updateAccountQuota } from "../../src/codex/quota";
import { getCodexStrictQuotaStatus } from "../../src/codex/strict-quota";
import { observeMainQuotaIdentity, captureMainQuotaWriter } from "../../src/codex/main-account-cache";
import { subscribeCodexQuotaChanges } from "../../src/codex/quota-events";
import { clearThreadAccountMap, clearCodexUpstreamHealth, resetCodexRoutingForManualSelection, previewCodexAccountForRequest, resolveCodexAccountForThreadDetailed } from "../../src/codex/routing";

let dir: string;
let priorHome: string | undefined;
let priorCodex: string | undefined;
const config = (extra: Partial<OcxConfig> = {}): OcxConfig => ({
  providers: {}, codexAccounts: [{ id: "a" }, { id: "b" }], activeCodexAccountId: "a",
  autoSwitchThreshold: 95, codexAccountStrictQuota: true, ...extra,
} as OcxConfig);
function credential(id: string, owner = `test-account-${id}`) {
  saveCodexAccountCredential(id, { accessToken: `test-access-${id}`, refreshToken: `test-refresh-${id}`,
    chatgptAccountId: owner, expiresAt: Date.now() + 3600000 });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-strict-quota-"));
  priorHome = process.env.OPENCODEX_HOME; priorCodex = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = dir; process.env.CODEX_HOME = dir;
  clearAccountQuota(); clearThreadAccountMap(); clearCodexUpstreamHealth();
  credential("a"); credential("b");
});
afterEach(() => {
  clearAccountQuota(); clearThreadAccountMap(); clearCodexUpstreamHealth();
  if (priorHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = priorHome;
  if (priorCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodex;
  rmSync(dir, { recursive: true, force: true });
});
describe("strict quota policy", () => {
  test("off by default, unknown fails closed, independent scopes keep their own policy", () => {
    expect(getCodexStrictQuotaStatus(config({ codexAccountStrictQuota: false }), "a").state).toBe("off");
    expect(getCodexStrictQuotaStatus(config({ autoSwitchThreshold: 0 }), "a").state).toBe("off");
    expect(getCodexStrictQuotaStatus(config(), "a").state).toBe("unknown");
    expect(getCodexStrictQuotaStatus(config(), "a", "reserve").state).toBe("off");
    expect(getCodexStrictQuotaStatus(config(), "a", "spark").state).toBe("off");
  });
  test("threshold inclusive with a hard ceiling of 99", () => {
    updateAccountQuota("a", 95);
    expect(getCodexStrictQuotaStatus(config(), "a").state).toBe("blocked");
    expect(getCodexStrictQuotaStatus(config({ autoSwitchThreshold: 100 }), "a").state).toBe("ready");
    updateAccountQuota("a", 99);
    expect(getCodexStrictQuotaStatus(config({ autoSwitchThreshold: 100 }), "a").state).toBe("blocked");
  });
  test("reset passage and unrelated partial/credits updates cannot recover an observed short block", () => {
    setAccountQuotaFromParsed("a", { shortPercent: 99, shortResetAt: Date.now() / 1000 - 1, weeklyPercent: 10 });
    setAccountQuotaFromParsed("a", { weeklyPercent: 0, resetCredits: 4 });
    expect(getCodexStrictQuotaStatus(config(), "a", "shared", Date.now() + 86400000).state).toBe("blocked");
    setAccountQuotaFromParsed("a", { shortPercent: 0 });
    expect(getCodexStrictQuotaStatus(config(), "a").state).toBe("ready");
  });
  test("each window must be fresh; credit and other-window writes do not refresh old evidence", () => {
    updateAccountQuota("a", 20);
    const observed = getStrictAccountQuota("a")!.windows[0]!.observedAt;
    setAccountQuotaFromParsed("a", { resetCredits: 3 });
    expect(getStrictAccountQuota("a")!.windows[0]!.observedAt).toBe(observed);
    expect(getCodexStrictQuotaStatus(config(), "a", "shared", observed + 300001).state).toBe("unknown");
    setAccountQuotaFromParsed("a", { monthlyPercent: 1 });
    expect(getStrictAccountQuota("a")!.windows.find(w => w.key === "weekly")!.observedAt).toBe(observed);
  });
  test("invalid upstream evidence is not clamped into recovery", () => {
    updateAccountQuota("a", 99);
    for (const used_percent of [-1, NaN, Infinity]) {
      setAccountQuotaFromParsed("a", parseUsageQuota({ rate_limit: { primary_window: { used_percent } } }));
      expect(getCodexStrictQuotaStatus(config(), "a").state).toBe("blocked");
    }
    updateAccountQuota("a", -1);
    expect(getCodexStrictQuotaStatus(config(), "a").state).toBe("blocked");
  });
  test("persisted blocks outlive the legacy six-hour cache and predicted reset", () => {
    const old = Date.now() - 86400000;
    writeFileSync(join(dir, "codex-quota-cache.json"), JSON.stringify({ version: 1, quotas: {},
      strictQuotas: { a: { identity: createHash("sha256").update("test-account-a").digest("hex"),
        quota: { windows: [{ scope: "shared", key: "weekly", usedPercent: 99, observedAt: old, resetAt: old / 1000 }] } } } }));
    expect(getCodexStrictQuotaStatus(config(), "a").state).toBe("blocked");
    updateAccountQuota("a", 0);
    expect(getCodexStrictQuotaStatus(config(), "a").state).toBe("ready");
  });
  test("credential replacement invalidates old evidence and requires a fresh read", () => {
    updateAccountQuota("a", 10); credential("a", "replacement-account");
    expect(getCodexStrictQuotaStatus(config(), "a").state).toBe("unknown");
    updateAccountQuota("a", 1);
    expect(getCodexStrictQuotaStatus(config(), "a").state).toBe("ready");
  });
  test("token refresh retains blocked windows until those windows are freshly observed", () => {
    setAccountQuotaFromParsed("a", { shortPercent: 99, weeklyPercent: 1 });
    credential("a"); updateAccountQuota("a", 0);
    expect(getCodexStrictQuotaStatus(config(), "a").state).toBe("blocked");
  });
  test("complete monthly-only WHAM retires old weekly and short windows", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 99, shortPercent: 99 });
    setAccountQuotaFromParsed("a", parseUsageQuota({ rate_limit: {
      primary_window: { used_percent: 0, limit_window_seconds: 30 * 86400 }, secondary_window: null,
    } }));
    expect(getCodexStrictQuotaStatus(config(), "a").state).toBe("ready");
    expect(getStrictAccountQuota("a")!.windows.map(w => w.key)).toEqual(["monthly"]);
  });
  test("partial or invalid monthly response cannot retire a blocked weekly window", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 99 });
    for (const rate_limit of [
      { primary_window: { used_percent: 0, limit_window_seconds: 30 * 86400 } },
      { primary_window: { used_percent: -1, limit_window_seconds: 30 * 86400 }, secondary_window: null },
      { primary_window: { used_percent: 0, limit_window_seconds: 30 * 86400 }, secondary_window: { used_percent: NaN, limit_window_seconds: 7 * 86400 } },
    ]) {
      setAccountQuotaFromParsed("a", parseUsageQuota({ rate_limit }));
      expect(getCodexStrictQuotaStatus(config(), "a").state).toBe("blocked");
    }
    setAccountQuotaFromParsed("a", { monthlyPercent: 0, monthlyIsPrimaryWindow: true });
    expect(getCodexStrictQuotaStatus(config(), "a").state).toBe("blocked");
  });
  test("main policy retains complete WHAM authority through validated parsing", () => {
    observeMainQuotaIdentity("strict-monthly-migration");
    const writer = captureMainQuotaWriter("strict-monthly-migration")!;
    setAccountQuotaFromParsed("__main__", { weeklyPercent: 99 }, undefined, writer);
    const data = { rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 30 * 86400 }, secondary_window: null } };
    setAccountQuotaFromParsed("__main__", parseUsageQuota(data), undefined, writer, parseMainPolicyUsageQuota(data));
    expect(getCodexStrictQuotaStatus(config(), "__main__").state).toBe("ready");
    setAccountQuotaFromParsed("__main__", { monthlyPercent: 99 }, undefined, writer);
    const weekly = { rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 7 * 86400 },
      secondary_window: null, tertiary_window: null } };
    setAccountQuotaFromParsed("__main__", parseUsageQuota(weekly), undefined, writer, parseMainPolicyUsageQuota(weekly));
    expect(getCodexStrictQuotaStatus(config(), "__main__").state).toBe("ready");
  });
  test("main and added accounts apply the same strict maximum across reported windows", () => {
    observeMainQuotaIdentity("strict-shared-max");
    const writer = captureMainQuotaWriter("strict-shared-max")!;
    const data = { rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 7 * 86400 },
      tertiary_window: { used_percent: 95, limit_window_seconds: 30 * 86400 } } };
    setAccountQuotaFromParsed("a", parseUsageQuota(data));
    setAccountQuotaFromParsed("__main__", parseUsageQuota(data), undefined, writer, parseMainPolicyUsageQuota(data));
    expect(getCodexStrictQuotaStatus(config(), "a").state).toBe("blocked");
    expect(getCodexStrictQuotaStatus(config(), "__main__").state).toBe("blocked");
  });
  test("quota notification subscription is removable and has no background polling", () => {
    let changes = 0; const stop = subscribeCodexQuotaChanges(() => changes++);
    updateAccountQuota("a", 20); expect(changes).toBe(1);
    stop(); updateAccountQuota("a", 30); expect(changes).toBe(1);
  });
});
describe("strict pool routing", () => {
  for (const accountPoolStrategy of ["quota", "fill-first"] as const) {
    test(`${accountPoolStrategy}: current stays until threshold, affinity and preview agree`, () => {
      const cfg = config({ accountPoolStrategy });
      updateAccountQuota("a", 90); updateAccountQuota("b", 1);
      expect(previewCodexAccountForRequest("thread", cfg)).toBe("a");
      expect(resolveCodexAccountForThreadDetailed("thread", cfg)).toEqual({ status: "selected", accountId: "a" });
      updateAccountQuota("a", 95);
      expect(previewCodexAccountForRequest("thread", cfg)).toBe("b");
      expect(resolveCodexAccountForThreadDetailed("thread", cfg)).toEqual({ status: "selected", accountId: "b" });
      updateAccountQuota("a", 0);
      expect(previewCodexAccountForRequest(null, cfg)).toBe("b");
      expect(resolveCodexAccountForThreadDetailed(null, cfg)).toEqual({ status: "selected", accountId: "b" });
    });
  }
  test("manual fill-first B remains selected when higher-priority A recovers", () => {
    const cfg = config({ accountPoolStrategy: "fill-first", activeCodexAccountId: "b",
      activeCodexAccountPinned: "b", codexAccountPriorities: { a: 100, b: 0 } });
    resetCodexRoutingForManualSelection("b");
    updateAccountQuota("a", 99); updateAccountQuota("b", 60);
    expect(resolveCodexAccountForThreadDetailed(null, cfg)).toEqual({ status: "selected", accountId: "b" });
    updateAccountQuota("a", 0);
    expect(previewCodexAccountForRequest(null, cfg)).toBe("b");
    expect(resolveCodexAccountForThreadDetailed(null, cfg)).toEqual({ status: "selected", accountId: "b" });
    updateAccountQuota("b", 95);
    expect(resolveCodexAccountForThreadDetailed(null, cfg)).toEqual({ status: "selected", accountId: "a" });
  });
  test("a strict-only drained pin is retired and cannot reclaim the active account after recovery", () => {
    const cfg = config({ accountPoolStrategy: "fill-first", activeCodexAccountId: "b",
      activeCodexAccountPinned: "b", codexAccountPriorities: { a: 100, b: 0 } });
    resetCodexRoutingForManualSelection("b");
    updateAccountQuota("a", 20);
    // A short-only reading is enough for strict admission; the legacy scorer keeps it unknown.
    setAccountQuotaFromParsed("b", { shortPercent: 0 });
    expect(resolveCodexAccountForThreadDetailed(null, cfg)).toEqual({ status: "selected", accountId: "b" });
    setAccountQuotaFromParsed("b", { shortPercent: 95 });
    expect(resolveCodexAccountForThreadDetailed(null, cfg)).toEqual({ status: "selected", accountId: "a" });
    const pinAfterDrain = cfg.activeCodexAccountPinned;
    setAccountQuotaFromParsed("b", { shortPercent: 0 });
    const afterRecovery = resolveCodexAccountForThreadDetailed(null, cfg);
    expect(pinAfterDrain).toBeUndefined();
    expect(afterRecovery).toEqual({ status: "selected", accountId: "a" });
  });
  test("strict fill-first finishes an automatically selected account before a higher tier returns", () => {
    const cfg = config({ accountPoolStrategy: "fill-first", codexAccountPriorities: { a: 100, b: 0 } });
    updateAccountQuota("a", 95); updateAccountQuota("b", 20);
    expect(resolveCodexAccountForThreadDetailed(null, cfg)).toEqual({ status: "selected", accountId: "b" });
    updateAccountQuota("a", 0);
    const previewAfterRecovery = previewCodexAccountForRequest(null, cfg);
    const afterRecovery = resolveCodexAccountForThreadDetailed(null, cfg);
    updateAccountQuota("b", 95);
    expect(previewAfterRecovery).toBe("b");
    expect(afterRecovery).toEqual({ status: "selected", accountId: "b" });
    expect(resolveCodexAccountForThreadDetailed(null, cfg)).toEqual({ status: "selected", accountId: "a" });
    expect(cfg.activeCodexAccountPinned).toBeUndefined();
  });
  test("round-robin still rotates new threads but excludes over-threshold candidates", () => {
    const cfg = config({ accountPoolStrategy: "round-robin" });
    updateAccountQuota("a", 20); updateAccountQuota("b", 30);
    const first = resolveCodexAccountForThreadDetailed("rr-1", cfg);
    const second = resolveCodexAccountForThreadDetailed("rr-2", cfg);
    expect(first.status).toBe("selected"); expect(second.status).toBe("selected");
    expect(first).not.toEqual(second);
    updateAccountQuota("a", 95);
    expect(previewCodexAccountForRequest("rr-3", cfg)).toBe("b");
    expect(resolveCodexAccountForThreadDetailed("rr-3", cfg)).toEqual({ status: "selected", accountId: "b" });
  });
  test("all blocked or unknown never falls back to active", () => {
    updateAccountQuota("a", 95);
    expect(previewCodexAccountForRequest(null, config())).toBeNull();
    expect(resolveCodexAccountForThreadDetailed(null, config())).toEqual({ status: "none" });
  });
  test("manual pause survives new healthy quota", () => {
    updateAccountQuota("a", 1); updateAccountQuota("b", 1);
    const cfg = config({ pausedCodexAccountIds: ["a", "b"] });
    expect(resolveCodexAccountForThreadDetailed(null, cfg)).toEqual({ status: "none" });
    expect(cfg.pausedCodexAccountIds).toEqual(["a", "b"]);
  });
});
