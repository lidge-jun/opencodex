import { describe, expect, test } from "bun:test";
import {
  analyzeAccountQuota,
  extractMaskedLogin,
  extractEmailLogin,
  filterAccounts,
  sortAccounts,
  type AccountFilterKey,
} from "../../gui/src/components/provider-workspace/account-quota-analysis";
import type { OAuthAccountRow } from "../../gui/src/components/provider-workspace/types";

describe("account-quota-analysis", () => {
  test("extractMaskedLogin formats masked username with asterisks", () => {
    expect(extractMaskedLogin("z***2@example.com")).toBe("z***2");
    expect(extractMaskedLogin(undefined, "testuser26@example.com")).toBe("t***6");
    expect(extractMaskedLogin(undefined, undefined, "alphauser@example.com")).toBe("a***r");
  });

  test("extractEmailLogin strips @domain and keeps username", () => {
    expect(extractEmailLogin("g***1@example.com")).toBe("g***1");
    expect(extractEmailLogin("alphauser@example.com")).toBe("alphauser");
    expect(extractEmailLogin("admin@example.com")).toBe("admin");
    expect(extractEmailLogin("z***2@example.com")).toBe("z***2");
    expect(extractEmailLogin(undefined, "my-alias")).toBe("my-alias");
    expect(extractEmailLogin("", "only-alias")).toBe("only-alias");
    expect(extractEmailLogin(undefined, undefined, "account-12345678")).toBe("account-…5678");
  });

  const makeAccount = (
    id: string,
    email: string,
    customWindows: { label: string; percent: number; resetAt?: number }[],
    active = false,
  ): OAuthAccountRow => ({
    id,
    email,
    active,
    quotaMode: "probe",
    quota: {
      updatedAt: Date.now(),
      customWindows,
    },
  });

  test("analyzeAccountQuota extracts both 5h and weekly windows for Gemini and Claude", () => {
    const acc = makeAccount("acc-1", "user1@example.com", [
      { label: "Gem", percent: 0, resetAt: 1700000000 },
      { label: "Gem (Weekly)", percent: 51, resetAt: 1700500000 },
      { label: "Cla", percent: 0, resetAt: 1700000000 },
      { label: "Cla (Weekly)", percent: 6, resetAt: 1700600000 },
    ]);

    const analyzed = analyzeAccountQuota(acc);
    expect(analyzed.emailLogin).toBe("user1");
    expect(analyzed.gemini5h?.percent).toBe(0);
    expect(analyzed.geminiWeekly?.percent).toBe(51);
    expect(analyzed.claude5h?.percent).toBe(0);
    expect(analyzed.claudeWeekly?.percent).toBe(6);
    expect(analyzed.geminiUsedMax).toBe(51);
    expect(analyzed.claudeUsedMax).toBe(6);
    expect(analyzed.overallUsedMax).toBe(51);
    expect(analyzed.freeHeadroom).toBe(49);
    expect(analyzed.readinessStatus).toBe("both_ready");
    expect(analyzed.hasAnyLimitsLeft).toBe(true);
  });

  test("detects when Gemini is exhausted but Claude is available", () => {
    const acc = makeAccount("acc-gem-exhausted", "z***s@example.com", [
      { label: "Gem", percent: 0 },
      { label: "Gem (Weekly)", percent: 100 },
      { label: "Cla", percent: 0 },
      { label: "Cla (Weekly)", percent: 0 },
    ]);

    const analyzed = analyzeAccountQuota(acc);
    expect(analyzed.geminiExhausted).toBe(true);
    expect(analyzed.claudeExhausted).toBe(false);
    expect(analyzed.readinessStatus).toBe("claude_only");
    expect(analyzed.hasAnyLimitsLeft).toBe(true);
    expect(analyzed.fullyExhausted).toBe(false);
  });

  test("detects when Claude is exhausted but Gemini is available", () => {
    const acc = makeAccount("acc-cla-exhausted", "d***0@example.com", [
      { label: "Gem", percent: 0 },
      { label: "Gem (Weekly)", percent: 0 },
      { label: "Cla", percent: 0 },
      { label: "Cla (Weekly)", percent: 100 },
    ]);

    const analyzed = analyzeAccountQuota(acc);
    expect(analyzed.geminiExhausted).toBe(false);
    expect(analyzed.claudeExhausted).toBe(true);
    expect(analyzed.readinessStatus).toBe("gemini_only");
    expect(analyzed.hasAnyLimitsLeft).toBe(true);
    expect(analyzed.fullyExhausted).toBe(false);
  });

  test("detects when 5-hour window is exhausted", () => {
    const acc = makeAccount("acc-5h-exhausted", "fast-user@example.com", [
      { label: "Gem", percent: 100 },
      { label: "Gem (Weekly)", percent: 20 },
      { label: "Cla", percent: 0 },
      { label: "Cla (Weekly)", percent: 0 },
    ]);

    const analyzed = analyzeAccountQuota(acc);
    expect(analyzed.geminiExhausted).toBe(true);
    expect(analyzed.readinessStatus).toBe("claude_only");
  });

  test("detects fully exhausted account when both Gemini and Claude are 100%", () => {
    const acc = makeAccount("acc-both-exhausted", "spent@example.com", [
      { label: "Gem", percent: 100 },
      { label: "Gem (Weekly)", percent: 100 },
      { label: "Cla", percent: 100 },
      { label: "Cla (Weekly)", percent: 100 },
    ]);

    const analyzed = analyzeAccountQuota(acc);
    expect(analyzed.geminiExhausted).toBe(true);
    expect(analyzed.claudeExhausted).toBe(true);
    expect(analyzed.fullyExhausted).toBe(true);
    expect(analyzed.hasAnyLimitsLeft).toBe(false);
    expect(analyzed.readinessStatus).toBe("fully_exhausted");
  });

  test("filterAccounts respects model-specific filters and with_limits default", () => {
    const a1 = analyzeAccountQuota(makeAccount("a1", "both@example.com", [
      { label: "Gem", percent: 10 }, { label: "Cla", percent: 20 },
    ]));
    const a2 = analyzeAccountQuota(makeAccount("a2", "cla-only@example.com", [
      { label: "Gem", percent: 100 }, { label: "Cla", percent: 0 },
    ]));
    const a3 = analyzeAccountQuota(makeAccount("a3", "gem-only@example.com", [
      { label: "Gem", percent: 0 }, { label: "Cla", percent: 100 },
    ]));
    const a4 = analyzeAccountQuota(makeAccount("a4", "dead@example.com", [
      { label: "Gem", percent: 100 }, { label: "Cla", percent: 100 },
    ]));

    const pool = [a1, a2, a3, a4];

    // with_limits (default): includes a1, a2, a3 (has some limit left) and excludes a4
    expect(filterAccounts(pool, "with_limits", "").map(x => x.emailLogin)).toEqual(["both", "cla-only", "gem-only"]);

    // with_limits_gemini: only accounts where Gemini is not exhausted
    expect(filterAccounts(pool, "with_limits_gemini", "").map(x => x.emailLogin)).toEqual(["both", "gem-only"]);

    // with_limits_claude: only accounts where Claude is not exhausted
    expect(filterAccounts(pool, "with_limits_claude", "").map(x => x.emailLogin)).toEqual(["both", "cla-only"]);

    // all: includes all 4
    expect(filterAccounts(pool, "all", "").map(x => x.emailLogin)).toEqual(["both", "cla-only", "gem-only", "dead"]);

    // gemini_exhausted: a2 and a4
    expect(filterAccounts(pool, "gemini_exhausted", "").map(x => x.emailLogin)).toEqual(["cla-only", "dead"]);

    // claude_exhausted: a3 and a4
    expect(filterAccounts(pool, "claude_exhausted", "").map(x => x.emailLogin)).toEqual(["gem-only", "dead"]);

    // fully_exhausted: only a4
    expect(filterAccounts(pool, "fully_exhausted", "").map(x => x.emailLogin)).toEqual(["dead"]);

    // search query filter
    expect(filterAccounts(pool, "all", "cla-only").map(x => x.emailLogin)).toEqual(["cla-only"]);
  });

  test("sortAccounts sorts by headroom and active status", () => {
    const a1 = analyzeAccountQuota(makeAccount("a1", "low-free@example.com", [{ label: "Gem", percent: 80 }]));
    const a2 = analyzeAccountQuota(makeAccount("a2", "high-free@example.com", [{ label: "Gem", percent: 10 }]));
    const a3 = analyzeAccountQuota(makeAccount("a3", "full-free@example.com", [{ label: "Gem", percent: 0 }]));

    const sorted = sortAccounts([a1, a2, a3], "more_headroom");
    expect(sorted.map(x => x.emailLogin)).toEqual(["full-free", "high-free", "low-free"]);

    const sortedAsc = sortAccounts([a1, a2, a3], "less_headroom");
    expect(sortedAsc.map(x => x.emailLogin)).toEqual(["low-free", "high-free", "full-free"]);
  });

  test("sortAccounts supports simplified 4 options with smart filter context and 5h/7d reset", () => {
    const acc1 = analyzeAccountQuota({
      id: "a1", email: "gem-full@example.com", active: false, quotaMode: "probe",
      quota: { updatedAt: 1, customWindows: [
        { label: "Gem", percent: 0, resetAt: 2000 },
        { label: "Gem (Weekly)", percent: 20, resetAt: 5000 },
        { label: "Cla", percent: 100, resetAt: 1000 },
        { label: "Cla (Weekly)", percent: 100, resetAt: 9000 }
      ] },
    });
    const acc2 = analyzeAccountQuota({
      id: "a2", email: "cla-full@example.com", active: false, quotaMode: "probe",
      quota: { updatedAt: 1, customWindows: [
        { label: "Gem", percent: 100, resetAt: 1500 },
        { label: "Gem (Weekly)", percent: 100, resetAt: 8000 },
        { label: "Cla", percent: 0, resetAt: 3000 },
        { label: "Cla (Weekly)", percent: 0, resetAt: 4000 }
      ] },
    });

    // When Gemini filter is active, more_headroom ranks by Gemini
    const byGemini = sortAccounts([acc1, acc2], "more_headroom", "with_limits_gemini");
    expect(byGemini[0].emailLogin).toBe("gem-full");

    // When Claude filter is active, more_headroom ranks by Claude
    const byClaude = sortAccounts([acc1, acc2], "more_headroom", "with_limits_claude");
    expect(byClaude[0].emailLogin).toBe("cla-full");

    // 5-hour reset soonest: acc1 (1000) vs acc2 (1500)
    const by5h = sortAccounts([acc1, acc2], "reset_5h_soonest");
    expect(by5h[0].emailLogin).toBe("gem-full");

    // 7-day reset soonest: acc1 (5000) vs acc2 (4000)
    const by7d = sortAccounts([acc1, acc2], "reset_7d_soonest");
    expect(by7d[0].emailLogin).toBe("cla-full");
  });
  test("xai weekly quota stays generic and is not treated as Antigravity families", () => {
    const analyzed = analyzeAccountQuota({
      id: "xai-1",
      email: "grok@example.com",
      active: true,
      quotaMode: "probe",
      quota: { weeklyPercent: 10, weeklyResetAt: 1_800_000_000 },
    }, "xai");
    expect(analyzed.isAntigravity).toBe(false);
    expect(analyzed.genericWeekly?.percent).toBe(10);
    expect(analyzed.gemini5h).toBeUndefined();
    expect(analyzed.claude5h).toBeUndefined();
    expect(analyzed.readinessStatus).toBe("ready");
    expect(analyzed.hasAnyLimitsLeft).toBe(true);
  });
});
