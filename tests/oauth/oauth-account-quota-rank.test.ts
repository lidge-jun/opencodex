import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyModelFamilyForQuota,
  hasHeadroomEvidence,
  isAccountQuotaExhausted,
  rankAccountsByHeadroom,
} from "../../src/oauth/account-quota-rank";
import {
  clearGenericFailoverHealth,
  eligibleFailoverAccounts,
  genericFailoverRetryAfterSeconds,
  preferredInitialAccount,
  rotateGenericOAuthAccountOn429,
} from "../../src/oauth/generic-account-failover";
import { getAccountSet, saveCredential, setActiveAccount } from "../../src/oauth/store";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../../src/providers/quota";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalHome = process.env.OPENCODEX_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-ag-family-rank-"));
  process.env.OPENCODEX_HOME = home;
  clearGenericFailoverHealth();
});

afterEach(() => {
  clearGenericFailoverHealth();
  clearAccountQuotaCache();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

const PROVIDER = {
  adapter: "google",
  authMode: "oauth",
} as unknown as OcxProviderConfig;

function config(): OcxConfig {
  return {
    providers: {
      "google-antigravity": { ...PROVIDER, oauthAccountFailover: { enabled: true } },
    },
    oauthAccountFailover: { enabled: true },
  } as unknown as OcxConfig;
}

function seedWindows(accountId: string, gem: number, cla: number): void {
  setCachedProviderAccountQuotaForTests("google-antigravity", accountId, {
    updatedAt: Date.now(),
    customWindows: [
      { label: "Gem", percent: gem },
      { label: "Gem (Weekly)", percent: gem },
      { label: "Cla", percent: cla },
      { label: "Cla (Weekly)", percent: cla },
    ],
  });
}

describe("classifyModelFamilyForQuota", () => {
  test("maps Gemini and Claude ids, and ignores Gemma", () => {
    expect(classifyModelFamilyForQuota("google-antigravity", "gemini-3.8-flash")).toBe("gem");
    expect(classifyModelFamilyForQuota("google-antigravity", "claude-sonnet-4-5")).toBe("cla");
    expect(classifyModelFamilyForQuota("google-antigravity", "gemma-3-27b")).toBeUndefined();
    expect(classifyModelFamilyForQuota("xai", "gemini-3.8-flash")).toBeUndefined();
    expect(classifyModelFamilyForQuota("google-antigravity", undefined)).toBeUndefined();
    expect(classifyModelFamilyForQuota("google-antigravity", "gemini-pro-agent")).toBe("gem");
    expect(classifyModelFamilyForQuota("google-antigravity", "gemini-3.1-flash-image")).toBe("gem");
    expect(classifyModelFamilyForQuota("google-antigravity", "claude-sonnet-4-6")).toBe("cla");
    expect(classifyModelFamilyForQuota("google-antigravity", "claude-opus-4-6-thinking")).toBe("cla");
    expect(classifyModelFamilyForQuota("google-antigravity", "gem-experimental")).toBeUndefined();
  });
});

describe("Antigravity family ranking", () => {
  test("does not treat a spent Claude window as Gemini exhaustion", () => {
    seedWindows("a", 10, 100);
    seedWindows("b", 80, 5);
    expect(isAccountQuotaExhausted("google-antigravity", "a", "gemini-3.8-flash")).toBe(false);
    expect(isAccountQuotaExhausted("google-antigravity", "a", "claude-sonnet-4-5")).toBe(true);
    expect(rankAccountsByHeadroom("google-antigravity", ["a", "b"], "gemini-3.8-flash")[0]).toBe("a");
    expect(rankAccountsByHeadroom("google-antigravity", ["a", "b"], "claude-sonnet-4-5")[0]).toBe("b");
  });

  test("falls back to the unranked ring when family labels are missing", () => {
    setCachedProviderAccountQuotaForTests("google-antigravity", "a", {
      updatedAt: Date.now(),
      customWindows: [{ label: "Other", percent: 1 }],
    });
    setCachedProviderAccountQuotaForTests("google-antigravity", "b", {
      updatedAt: Date.now(),
      customWindows: [{ label: "Other", percent: 99 }],
    });
    expect(hasHeadroomEvidence("google-antigravity", ["a", "b"], "gemini-3.8-flash")).toBe(false);
    expect(rankAccountsByHeadroom("google-antigravity", ["b", "a"], "gemini-3.8-flash")).toEqual(["b", "a"]);
  });
});

describe("Antigravity family-scoped cooldown", () => {
  test("a Claude 429 still keeps the account for Gemini", async () => {
    for (const accountId of ["acct-a", "acct-b"]) {
      await saveCredential("google-antigravity", {
        access: "access-" + accountId,
        refresh: "refresh-" + accountId,
        expires: Date.now() + 3_600_000,
        accountId,
      } as never, { addAccount: true });
    }
    const ids = getAccountSet("google-antigravity")?.accounts.map((account) => account.id) ?? [];
    expect(ids.length).toBe(2);
    await setActiveAccount("google-antigravity", ids[0]!);
    seedWindows(ids[0]!, 10, 100);
    seedWindows(ids[1]!, 80, 5);
    const cfg = config();
    expect(rotateGenericOAuthAccountOn429(cfg, "google-antigravity", ids[0]!, null, Date.now(), "claude-sonnet-4-5")).toBe(ids[1]);
    expect(preferredInitialAccount(cfg, "google-antigravity", Date.now(), "gemini-3.8-flash")).toBeNull();
  });
});

function kernelConfig(strategy: "fill-first" | "round-robin"): OcxConfig {
  return {
    pool: { kernel: true },
    providers: {
      "google-antigravity": {
        ...PROVIDER,
        oauthAccountFailover: { enabled: true, strategy, autoSwitchThreshold: 80 },
      },
    },
    oauthAccountFailover: { enabled: true },
  } as unknown as OcxConfig;
}

async function seedPair(): Promise<string[]> {
  for (const accountId of ["acct-a", "acct-b"]) {
    await saveCredential("google-antigravity", {
      access: "access-" + accountId,
      refresh: "refresh-" + accountId,
      expires: Date.now() + 3_600_000,
      accountId,
    } as never, { addAccount: true });
  }
  const ids = getAccountSet("google-antigravity")?.accounts.map((account) => account.id) ?? [];
  expect(ids.length).toBe(2);
  await setActiveAccount("google-antigravity", ids[0]!);
  return ids;
}

describe("Antigravity family strategies behind pool.kernel", () => {
  test("fill-first stays on Gemini headroom when only Claude is over the threshold", async () => {
    const ids = await seedPair();
    seedWindows(ids[0]!, 40, 90);
    seedWindows(ids[1]!, 10, 10);
    const cfg = kernelConfig("fill-first");
    expect(preferredInitialAccount(cfg, "google-antigravity", Date.now(), "gemini-3.8-flash")).toBeNull();
    expect(preferredInitialAccount(cfg, "google-antigravity", Date.now(), "claude-sonnet-4-6")).toBe(ids[1]);
  });

  test("a Claude 429 does not hide the account from Gemini round-robin", async () => {
    const ids = await seedPair();
    seedWindows(ids[0]!, 20, 20);
    seedWindows(ids[1]!, 20, 20);
    const cfg = kernelConfig("round-robin");
    expect(rotateGenericOAuthAccountOn429(cfg, "google-antigravity", ids[0]!, null, Date.now(), "claude-sonnet-4-6")).toBe(ids[1]);
    expect(eligibleFailoverAccounts("google-antigravity", Date.now(), "gem")).toContain(ids[0]);
    expect(eligibleFailoverAccounts("google-antigravity", Date.now(), "cla")).not.toContain(ids[0]);
    expect(genericFailoverRetryAfterSeconds("google-antigravity")).toBeGreaterThan(0);
  });
});
