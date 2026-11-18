import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { readCodexAccountRecord, saveCodexAccountCredential, saveCodexAccountCredentialIfGeneration } from "../../src/codex/account-store";
import { captureMainQuotaWriter, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import { preserveLongQuotaCandidates } from "../../src/codex/routing/preserve-long-quota";
import { clearAccountQuota, getAccountQuota, parseMainPolicyUsageQuota, parseUsageQuota, poolWhamPolicyObservation, setAccountQuotaFromParsed } from "../../src/codex/quota";
import type { StoredAccountQuota, WhamUsageResponse } from "../../src/codex/quota-types";
import { clearPoolRotationState, parseAccountPoolStrategy, parseCodexAccountPoolStrategy } from "../../src/codex/pool-rotation";
import { setCodexAccountPriority } from "../../src/codex/account-priority";
import { clearCodexUpstreamHealth, clearThreadAccountMap, getEffectiveActiveCodexAccountId, pickAlternateCodexAccount, previewCodexAccountForRequest, recordCodexUpstreamOutcome, resolveCodexAccountForThread } from "../../src/codex/routing";
import type { OcxConfig } from "../../src/types";

const HOUR = 3_600_000;
let home: TempHome;
let config: OcxConfig;
let now: number;
beforeEach(() => {
  home = createTempHome("ocx-preserve-long-quota-");
  now = Date.now() + 1000;
  clearAccountQuota();
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearPoolRotationState();
  for (const id of ["a", "b", "c"]) saveCodexAccountCredential(id, {
    accessToken: `fixture-access-${id}`, refreshToken: `fixture-refresh-${id}`,
    expiresAt: now + HOUR, chatgptAccountId: `fixture-account-${id}`,
  });
  config = {
    providers: {}, autoSwitchThreshold: 80, activeCodexAccountId: "a",
    accountPoolStrategy: "preserve-long-quota",
    codexAccounts: ["a", "b", "c"].map(id => ({ id, email: `${id}@example.test`, isMain: false })),
  } as OcxConfig;
});
afterEach(() => {
  clearAccountQuota(); clearThreadAccountMap(); clearCodexUpstreamHealth(); clearPoolRotationState();
  home.remove();
});
function quota(id: string, value: Omit<StoredAccountQuota, "updatedAt">): void {
  setAccountQuotaFromParsed(id, value);
}
function shortOnlyWham(complete = true): WhamUsageResponse {
  return { rate_limit: { allowed: true,
    primary_window: { used_percent: 20, reset_at: now / 1000 + 5 * 3600, limit_window_seconds: 18000 },
    ...(complete ? { secondary_window: null } : {}), tertiary_window: null,
  } };
}
function publishWham(id: string, data: WhamUsageResponse): void {
  const parsed = parseUsageQuota(data);
  setAccountQuotaFromParsed(id, parsed, undefined, undefined, poolWhamPolicyObservation(data, parsed));
}
function first(): string | null { return previewCodexAccountForRequest(null, config, now); }

describe("preserve-long-quota", () => {
  test("Codex accepts the strategy without extending other pool kinds", () => {
    expect(parseCodexAccountPoolStrategy("preserve-long-quota")).toBe("preserve-long-quota");
    expect(parseAccountPoolStrategy("preserve-long-quota")).toBeNull();
  });
  test("weekly reset tomorrow beats a short reset today with a distant weekly reset", () => {
    quota("a", { shortPercent: 16, shortResetAt: now + 5 * HOUR, weeklyPercent: 54, weeklyResetAt: now + 120 * HOUR });
    quota("b", { weeklyPercent: 32, weeklyResetAt: now + 24 * HOUR });
    expect(first()).toBe("b");
    expect(getEffectiveActiveCodexAccountId(config)).toBe("a");
    expect(resolveCodexAccountForThread("new", config, now)).toBe("b");
    expect(config.activeCodexAccountId).toBe("a");
    config.accountPoolStrategy = "reset-first";
    expect(first()).toBe("a");
  });
  test("proven short-only preserves the weekly budget even when its short reset is later", () => {
    quota("a", { shortPercent: 10, shortResetAt: now + HOUR, weeklyPercent: 30, weeklyResetAt: now + 120 * HOUR });
    publishWham("b", shortOnlyWham());
    expect(first()).toBe("b");
    expect(resolveCodexAccountForThread(null, config, now)).toBe("b");
    expect(pickAlternateCodexAccount(config, "b", now)).toBe("a");
  });
  test("partial short evidence does not prove absence of long windows", () => {
    quota("a", { weeklyPercent: 40, weeklyResetAt: now + 24 * HOUR });
    publishWham("b", shortOnlyWham(false));
    expect(first()).toBe("a");
    quota("b", { shortPercent: 5, shortResetAt: now + HOUR });
    expect(first()).toBe("a");
  });
  test.each(["denied", "additional", "missing-tertiary", "invalid-usage"])("%s WHAM does not prove short-only", kind => {
    quota("a", { weeklyPercent: 40, weeklyResetAt: now + 24 * HOUR });
    const data = shortOnlyWham();
    if (kind === "denied") data.rate_limit!.allowed = false;
    if (kind === "additional") data.additional_rate_limits = [{ limit_name: "unknown" }];
    if (kind === "missing-tertiary") delete data.rate_limit!.tertiary_window;
    if (kind === "invalid-usage") data.rate_limit!.primary_window!.used_percent = NaN;
    publishWham("b", data);
    expect(first()).toBe("a");
  });
  test.each(["additional", "unmeasured-long"])("new %s topology retracts prior short-only proof", kind => {
    quota("a", { weeklyPercent: 40, weeklyResetAt: now + 24 * HOUR });
    publishWham("b", shortOnlyWham());
    expect(first()).toBe("b");
    const data = shortOnlyWham();
    if (kind === "additional") data.additional_rate_limits = [{ limit_name: "unknown" }];
    else data.rate_limit!.secondary_window = { limit_window_seconds: 604800 };
    publishWham("b", data);
    expect(first()).toBe("a");
  });
  test("replacing the credential under the same ID invalidates proof but a token refresh does not", () => {
    quota("a", { weeklyPercent: 40, weeklyResetAt: now + 24 * HOUR });
    publishWham("b", shortOnlyWham());
    expect(first()).toBe("b");
    expect(saveCodexAccountCredentialIfGeneration("b", readCodexAccountRecord("b")!.generation, { accessToken: "fixture-refreshed", refreshToken: "fixture-refreshed-grant", expiresAt: now + HOUR, chatgptAccountId: "fixture-account-b" })).toBe(true);
    expect(first()).toBe("b");
    saveCodexAccountCredential("b", { accessToken: "fixture-replaced", refreshToken: "fixture-replaced-grant", expiresAt: now + HOUR, chatgptAccountId: "fixture-other-account" });
    quota("b", { shortPercent: 5, shortResetAt: now + HOUR });
    expect(first()).toBe("a");
    saveCodexAccountCredential("b", { accessToken: "fixture-returned", refreshToken: "fixture-returned-grant", expiresAt: now + HOUR, chatgptAccountId: "fixture-account-b" });
    expect(first()).toBe("a");
    publishWham("b", shortOnlyWham());
    expect(first()).toBe("b");
  });
  test("owned native-main WHAM supplies the same topology proof and invalidates it on identity change", () => {
    observeMainQuotaIdentity("fixture-native-short-only");
    const writer = captureMainQuotaWriter("fixture-native-short-only")!;
    const data = shortOnlyWham();
    setAccountQuotaFromParsed("__main__", parseUsageQuota(data), undefined, writer, parseMainPolicyUsageQuota(data));
    quota("a", { weeklyPercent: 40, weeklyResetAt: now + 24 * HOUR });
    expect(preserveLongQuotaCandidates(["a", "__main__"], getAccountQuota, now)).toEqual(["__main__"]);
    observeMainQuotaIdentity("fixture-native-replacement");
    expect(preserveLongQuotaCandidates(["a", "__main__"], getAccountQuota, now)).toEqual(["a"]);
  });
  test("partial updates do not renew short-only topology proof", () => {
    quota("a", { weeklyPercent: 40, weeklyResetAt: now + 24 * HOUR });
    publishWham("b", shortOnlyWham());
    expect(first()).toBe("b");
    const observed = getAccountQuota("b")?.shortOnlyObservedAt;
    quota("b", { shortPercent: 5, shortResetAt: now + 12 * HOUR });
    expect(getAccountQuota("b")?.shortOnlyObservedAt).toBe(observed);
    expect(previewCodexAccountForRequest(null, config, now + 7 * HOUR)).toBe("a");
  });
  test("a new long observation retracts short-only evidence", () => {
    quota("a", { weeklyPercent: 40, weeklyResetAt: now + 24 * HOUR });
    publishWham("b", shortOnlyWham());
    expect(first()).toBe("b");
    quota("b", { weeklyPercent: 10, weeklyResetAt: now + 120 * HOUR });
    expect(first()).toBe("a");
  });
  test("partial headers retain known long windows instead of granting short-only priority", () => {
    quota("a", { weeklyPercent: 40, weeklyResetAt: now + 24 * HOUR });
    quota("b", { weeklyPercent: 10, weeklyResetAt: now + 120 * HOUR });
    quota("b", { shortPercent: 5, shortResetAt: now + HOUR });
    expect(getAccountQuota("b")?.weeklyPercent).toBe(10);
    expect(first()).toBe("a");
  });
  test("weekly comes before monthly even when the monthly deadline is closer", () => {
    quota("a", { monthlyPercent: 10, monthlyResetAt: now + HOUR });
    quota("b", { weeklyPercent: 40, weeklyResetAt: now + 24 * HOUR });
    expect(first()).toBe("b");
  });
  test("monthly accounts are ordered by monthly not short or weekly deadlines", () => {
    quota("a", { monthlyPercent: 10, monthlyResetAt: now + 120 * HOUR, shortPercent: 1, shortResetAt: now + HOUR });
    quota("b", { monthlyPercent: 40, monthlyResetAt: now + 24 * HOUR, weeklyPercent: 20, weeklyResetAt: now + 12 * HOUR });
    expect(first()).toBe("b");
  });
  test.each([undefined, NaN, 0, -1])("missing or invalid long deadline %s retains the category", reset => {
    quota("a", { weeklyPercent: 1, weeklyResetAt: reset, shortPercent: 1, shortResetAt: now + HOUR });
    quota("b", { weeklyPercent: 40, weeklyResetAt: now + 24 * HOUR });
    expect(first()).toBe("b");
  });
  test("past long deadline does not reclassify a weekly account as short-only", () => {
    quota("a", { weeklyPercent: 1, weeklyResetAt: now - 1, shortPercent: 1, shortResetAt: now + HOUR });
    quota("b", { weeklyPercent: 40, weeklyResetAt: now + 24 * HOUR });
    expect(first()).toBe("b");
  });
  test("deadline seconds and milliseconds compare equally; short deadlines break a tie", () => {
    quota("a", { weeklyPercent: 1, weeklyResetAt: now / 1000 + 86400, shortPercent: 1, shortResetAt: now + 3 * HOUR });
    quota("b", { weeklyPercent: 40, weeklyResetAt: now + 24 * HOUR, shortPercent: 5, shortResetAt: now + HOUR });
    expect(first()).toBe("b");
  });
  test("incomplete short tie-break uses usage consistently, not pairwise comparisons", () => {
    quota("a", { weeklyPercent: 30, weeklyResetAt: now + 24 * HOUR, shortPercent: 10, shortResetAt: now + HOUR });
    quota("b", { weeklyPercent: 10, weeklyResetAt: now + 24 * HOUR });
    quota("c", { weeklyPercent: 20, weeklyResetAt: now + 24 * HOUR, shortPercent: 10, shortResetAt: now + 2 * HOUR });
    expect(first()).toBe("b");
  });
  test("thresholds, priority and cooldown remain authoritative", () => {
    quota("a", { weeklyPercent: 90, weeklyResetAt: now + HOUR });
    quota("b", { weeklyPercent: 20, weeklyResetAt: now + 24 * HOUR });
    expect(first()).toBe("b");
    config.autoSwitchThreshold = 0;
    expect(first()).toBe("a");
    config.autoSwitchThreshold = 80;
    setCodexAccountPriority(config, "c", 2);
    quota("c", { monthlyPercent: 20, monthlyResetAt: now + 120 * HOUR });
    expect(first()).toBe("c");
    recordCodexUpstreamOutcome(config, "c", 429, { now, retryAfter: "60" });
    expect(first()).toBe("b");
  });
  test("all accounts over threshold use the existing lowest-usage fallback", () => {
    for (const [id, usage] of [["a", 95], ["b", 90], ["c", 99]] as const) quota(id, { weeklyPercent: usage, weeklyResetAt: now + HOUR });
    expect(first()).toBe("b");
  });
  test.each(["spark", "reserve"] as const)("independent %s scopes keep quota behavior", scope => {
    quota("a", { weeklyPercent: 10, weeklyResetAt: now + 120 * HOUR });
    quota("b", { weeklyPercent: 40, weeklyResetAt: now + HOUR });
    expect(previewCodexAccountForRequest(null, config, now, scope)).toBe("a");
    expect(resolveCodexAccountForThread(null, config, now, scope)).toBe("a");
    expect(first()).toBe("b");
  });
  test.each([false, true])("live binding obeys cacheAffinity=%s", cacheAffinity => {
    config.pool = { cacheAffinity };
    quota("a", { weeklyPercent: 10, weeklyResetAt: now + HOUR });
    quota("b", { weeklyPercent: 20, weeklyResetAt: now + 24 * HOUR });
    expect(resolveCodexAccountForThread("bound", config, now)).toBe("a");
    publishWham("b", shortOnlyWham());
    expect(resolveCodexAccountForThread("bound", config, now + 1)).toBe("a");
    quota("a", { weeklyPercent: 90 });
    expect(previewCodexAccountForRequest("bound", config, now + 2)).toBe(cacheAffinity ? "a" : "b");
    expect(resolveCodexAccountForThread("bound", config, now + 2)).toBe(cacheAffinity ? "a" : "b");
  });
  test("disabled threshold retains a binding until an actual failure", () => {
    config.autoSwitchThreshold = 0;
    quota("a", { weeklyPercent: 10, weeklyResetAt: now + HOUR });
    quota("b", { weeklyPercent: 20, weeklyResetAt: now + 24 * HOUR });
    expect(resolveCodexAccountForThread("bound", config, now)).toBe("a");
    quota("a", { weeklyPercent: 100 });
    expect(resolveCodexAccountForThread("bound", config, now + 1)).toBe("a");
    recordCodexUpstreamOutcome(config, "a", 429, { now: now + 2, retryAfter: "60" });
    expect(pickAlternateCodexAccount(config, "a", now + 3)).toBe("b");
  });
});
