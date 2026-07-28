import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  anthropicSessionKeyFromParts,
  bindAnthropicSessionAffinity,
  clearAnthropicAccountPoolState,
  formatAnthropicProviderForLog,
  getEligibleAnthropicAccounts,
  isAnthropicAccountPoolEnabled,
  resolveAnthropicAccountForSession,
  rotateAnthropicAccountOn429,
} from "../src/oauth/anthropic-routing";
import { saveCredential, setActiveAccount } from "../src/oauth/store";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../src/providers/quota";
import type { OcxConfig } from "../src/types";

const originalHome = process.env.OPENCODEX_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-anthropic-pool-"));
  process.env.OPENCODEX_HOME = home;
  clearAnthropicAccountPoolState();
  clearAccountQuotaCache("anthropic");
});

afterEach(() => {
  clearAnthropicAccountPoolState();
  clearAccountQuotaCache("anthropic");
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

async function seedTwoAccounts() {
  await saveCredential("anthropic", {
    access: "access-a",
    refresh: "refresh-a",
    expires: Date.now() + 3_600_000,
    accountId: "uuid-aaaa",
    email: "a@example.test",
  });
  await saveCredential("anthropic", {
    access: "access-b",
    refresh: "refresh-b",
    expires: Date.now() + 3_600_000,
    accountId: "uuid-bbbb",
    email: "b@example.test",
  });
  // saveCredential activates the newly appended account (B). Pin A as active for predictable tests.
  const { getAccountSet } = await import("../src/oauth/store");
  const set = getAccountSet("anthropic")!;
  const a = set.accounts.find(acc => acc.credential.accountId === "uuid-aaaa")!;
  const b = set.accounts.find(acc => acc.credential.accountId === "uuid-bbbb")!;
  await setActiveAccount("anthropic", a.id);
  return { aId: a.id, bId: b.id };
}

function cfg(enabled: boolean, threshold = 80): OcxConfig {
  return {
    port: 0,
    defaultProvider: "anthropic",
    providers: {
      anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" },
    },
    anthropicAccountPool: { enabled, autoSwitchThreshold: threshold },
  } as OcxConfig;
}

describe("anthropic account pool", () => {
  test("default off always returns the active account", async () => {
    const { aId, bId } = await seedTwoAccounts();
    expect(isAnthropicAccountPoolEnabled(cfg(false))).toBe(false);
    const sel = resolveAnthropicAccountForSession("session-1", cfg(false));
    expect(sel.accountId).toBe(aId);
    expect(sel.reason).toBe("pool-disabled");
    expect(sel.accountId).not.toBe(bId);
  });

  test("affinity sticks across resolves until cooled", async () => {
    const { aId, bId } = await seedTwoAccounts();
    // Force lowest-usage toward B for a cold start with high active usage.
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 95 });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 10 });
    const first = resolveAnthropicAccountForSession("sess-sticky", cfg(true));
    expect(first.accountId).toBe(bId);
    // Even if A becomes "better", affinity keeps B.
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 1 });
    const second = resolveAnthropicAccountForSession("sess-sticky", cfg(true));
    expect(second.accountId).toBe(bId);
    expect(second.reason).toBe("affinity");
  });

  test("429 cools the account and failover picks another eligible account", async () => {
    const { aId, bId } = await seedTwoAccounts();
    bindAnthropicSessionAffinity("sess-fail", aId);
    const next = rotateAnthropicAccountOn429(cfg(true), aId, "30", "sess-fail");
    expect(next).toBe(bId);
    expect(getEligibleAnthropicAccounts()).toEqual([bId]);
    const after = resolveAnthropicAccountForSession("sess-fail", cfg(true));
    expect(after.accountId).toBe(bId);
  });

  test("all cooled returns all-cooled rather than none", async () => {
    const { aId, bId } = await seedTwoAccounts();
    expect(rotateAnthropicAccountOn429(cfg(true), aId, "120")).toBe(bId);
    expect(rotateAnthropicAccountOn429(cfg(true), bId, "120")).toBeNull();
    const sel = resolveAnthropicAccountForSession("cooled-sess", cfg(true));
    expect(sel.accountId).toBeNull();
    expect(sel.reason).toBe("all-cooled");
  });

  test("unknown active usage does not force a switch", async () => {
    const { aId, bId } = await seedTwoAccounts();
    // Only B has known usage; active A is unknown and must stay selected under threshold rules.
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 5 });
    const sel = resolveAnthropicAccountForSession("unknown-usage", cfg(true, 80));
    expect(sel.accountId).toBe(aId);
    expect(sel.reason).toBe("active");
  });

  test("new session prefers lower fiveHour usage when above threshold", async () => {
    const { aId, bId } = await seedTwoAccounts();
    setCachedProviderAccountQuotaForTests("anthropic", aId, { fiveHourPercent: 90 });
    setCachedProviderAccountQuotaForTests("anthropic", bId, { fiveHourPercent: 20 });
    const sel = resolveAnthropicAccountForSession("new-sess", cfg(true, 80));
    expect(sel.accountId).toBe(bId);
    expect(sel.reason).toBe("lowest-usage");
  });

  test("session key prefers session_id over prompt_cache_key", () => {
    expect(anthropicSessionKeyFromParts({
      sessionIdHeader: "sess-a",
      promptCacheKey: "cache-b",
    })).toBe("sess-a");
  });

  test("shared Desktop cache cohort alone does not create affinity key", () => {
    expect(anthropicSessionKeyFromParts({
      promptCacheKey: "shared-cohort-hash",
      promptCacheKeyIsSharedCohort: true,
    })).toBeNull();
    expect(anthropicSessionKeyFromParts({
      promptCacheKey: "per-session-hash",
      promptCacheKeyIsSharedCohort: false,
    })).toBe("per-session-hash");
  });

  test("log label is non-PII ordinal", () => {
    const label = formatAnthropicProviderForLog("anthropic", "deadbeefdeadbeef");
    expect(label).toMatch(/^anthropic-p[a-f0-9]{6}$/);
    expect(label).not.toContain("deadbeef");
  });
});
