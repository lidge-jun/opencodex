import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindGoogleAntigravitySessionAffinity,
  clearGoogleAntigravityAccountPoolState,
  formatGoogleAntigravityProviderForLog,
  getEligibleGoogleAntigravityAccounts,
  getGoogleAntigravityAccountHealthSnapshot,
  getGoogleAntigravityPoolAccessSnapshot,
  getGoogleAntigravityPoolRetryAfterSeconds,
  googleAntigravityAutoSwitchThreshold,
  googleAntigravitySessionAffinitySizeForTests,
  googleAntigravityUsageScore,
  isGoogleAntigravityAccountPoolEnabled,
  resolveGoogleAntigravityAccountForSession,
  rotateGoogleAntigravityAccountOnQuotaError,
} from "../src/oauth/google-antigravity-routing";
import {
  clearAccountQuotaCache,
  getCachedProviderAccountQuota,
  setCachedProviderAccountQuotaForTests,
} from "../src/providers/quota";
import { getAccountSet, saveCredential, setActiveAccount } from "../src/oauth/store";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const previousHome = process.env.OPENCODEX_HOME;
let home = "";

function config(
  enabled?: boolean,
  threshold?: number,
  strategy?: "quota" | "round-robin" | "fill-first",
): OcxConfig {
  const provider: OcxProviderConfig = {
    adapter: "google",
    authMode: "oauth",
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    googleMode: "cloud-code-assist",
  };
  return {
    port: 0,
    defaultProvider: "google-antigravity",
    providers: { "google-antigravity": provider },
    ...(enabled === undefined && threshold === undefined && strategy === undefined
      ? {}
      : {
          googleAntigravityAccountPool: {
            ...(enabled === undefined ? {} : { enabled }),
            ...(threshold === undefined ? {} : { autoSwitchThreshold: threshold }),
            ...(strategy === undefined ? {} : { strategy }),
          },
        }),
  } as OcxConfig;
}

async function seedTwoAccounts() {
  const expires = Date.now() + 3_600_000;
  await saveCredential("google-antigravity", {
    access: "google-access-a",
    refresh: "google-refresh-a",
    expires,
    accountId: "google-identity-a",
    email: "a@example.test",
    projectId: "project-a",
  });
  await saveCredential("google-antigravity", {
    access: "google-access-b",
    refresh: "google-refresh-b",
    expires,
    accountId: "google-identity-b",
    email: "b@example.test",
    projectId: "project-b",
  });
  const set = getAccountSet("google-antigravity")!;
  const a = set.accounts.find(account => account.credential.accountId === "google-identity-a")!;
  const b = set.accounts.find(account => account.credential.accountId === "google-identity-b")!;
  await setActiveAccount("google-antigravity", a.id);
  return { aId: a.id, bId: b.id };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-google-antigravity-pool-"));
  process.env.OPENCODEX_HOME = home;
  clearGoogleAntigravityAccountPoolState();
  clearAccountQuotaCache("google-antigravity");
});

afterEach(() => {
  clearGoogleAntigravityAccountPoolState();
  clearAccountQuotaCache("google-antigravity");
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
});

describe("google antigravity account pool", () => {
  test("is backward-compatible and disabled by default", async () => {
    const { aId } = await seedTwoAccounts();
    expect(isGoogleAntigravityAccountPoolEnabled(config())).toBe(false);
    expect(resolveGoogleAntigravityAccountForSession("thread-1", "gemini-3.7-flash", config())).toEqual({
      accountId: aId,
      reason: "pool-disabled",
    });
    expect(rotateGoogleAntigravityAccountOnQuotaError(
      config(), aId, "30", "gemini-3.7-flash", "thread-1",
    )).toEqual({ kind: "pool-disabled" });
    expect(getGoogleAntigravityAccountHealthSnapshot(aId)).toBeNull();
  });

  test("invalid persisted pool values fail safely to disabled/default policy", async () => {
    const { aId } = await seedTwoAccounts();
    const invalid = config() as OcxConfig & { googleAntigravityAccountPool: Record<string, unknown> };
    invalid.googleAntigravityAccountPool = {
      enabled: "yes",
      autoSwitchThreshold: 101,
      strategy: "weighted",
      stickyLimit: 0,
    };
    expect(isGoogleAntigravityAccountPoolEnabled(invalid)).toBe(false);
    expect(googleAntigravityAutoSwitchThreshold(invalid)).toBe(80);
    expect(resolveGoogleAntigravityAccountForSession("invalid", "gemini-3.7-flash", invalid)).toEqual({
      accountId: aId,
      reason: "pool-disabled",
    });
  });

  test("switches above threshold using the maximum relevant custom window", async () => {
    const { aId, bId } = await seedTwoAccounts();
    setCachedProviderAccountQuotaForTests("google-antigravity", aId, {
      customWindows: [
        { label: "Gem", percent: 81 },
        { label: "Gemini secondary", percent: 92 },
        { label: "Cla", percent: 5 },
      ],
      updatedAt: Date.now(),
    });
    setCachedProviderAccountQuotaForTests("google-antigravity", bId, {
      customWindows: [
        { label: "Gem", percent: 20 },
        { label: "Cla", percent: 97 },
      ],
      updatedAt: Date.now(),
    });

    expect(googleAntigravityUsageScore(
      "gemini-3.7-flash",
      getCachedProviderAccountQuota("google-antigravity", aId),
    )).toBe(92);
    expect(resolveGoogleAntigravityAccountForSession("thread-gemini", "gemini-3.7-flash", config(true, 80))).toEqual({
      accountId: bId,
      reason: "lowest-usage",
    });
    expect(resolveGoogleAntigravityAccountForSession("thread-claude", "claude-sonnet-4-6", config(true, 80))).toEqual({
      accountId: aId,
      reason: "active",
    });
  });

  test("unknown usage holds the healthy active account", async () => {
    const { aId, bId } = await seedTwoAccounts();
    setCachedProviderAccountQuotaForTests("google-antigravity", bId, {
      customWindows: [{ label: "Gem", percent: 4 }],
      updatedAt: Date.now(),
    });
    expect(resolveGoogleAntigravityAccountForSession("unknown-active", "gemini-3.7-flash", config(true, 80))).toEqual({
      accountId: aId,
      reason: "active",
    });
  });

  test("account resolution proposes without committing or refreshing session affinity", async () => {
    const { aId } = await seedTwoAccounts();
    const start = 1_800_000_000_000;

    expect(resolveGoogleAntigravityAccountForSession(
      "proposal-only", "gemini-3.7-flash", config(true, 80), start,
    )).toMatchObject({ accountId: aId, reason: "active" });
    expect(googleAntigravitySessionAffinitySizeForTests()).toBe(0);

    bindGoogleAntigravitySessionAffinity("existing-affinity", aId, start);
    expect(resolveGoogleAntigravityAccountForSession(
      "existing-affinity", "gemini-3.7-flash", config(true, 80), start + 23 * 60 * 60_000,
    )).toMatchObject({ accountId: aId, reason: "affinity" });
    expect(googleAntigravitySessionAffinitySizeForTests()).toBe(1);

    resolveGoogleAntigravityAccountForSession(
      "expiry-probe", "gemini-3.7-flash", config(true, 80), start + 25 * 60 * 60_000,
    );
    expect(googleAntigravitySessionAffinitySizeForTests()).toBe(0);
  });

  test("round-robin honors stickyLimit and fill-first advances a drained active account", async () => {
    const { aId, bId } = await seedTwoAccounts();
    const roundRobin = config(true, 80, "round-robin");
    roundRobin.googleAntigravityAccountPool!.stickyLimit = 2;
    const picks = [
      resolveGoogleAntigravityAccountForSession("rr-1", "gemini-3.7-flash", roundRobin).accountId,
      resolveGoogleAntigravityAccountForSession("rr-2", "gemini-3.7-flash", roundRobin).accountId,
      resolveGoogleAntigravityAccountForSession("rr-3", "gemini-3.7-flash", roundRobin).accountId,
    ];
    expect(picks[0]).toBe(picks[1]);
    expect(picks[2]).not.toBe(picks[1]);

    clearGoogleAntigravityAccountPoolState();
    setCachedProviderAccountQuotaForTests("google-antigravity", aId, {
      customWindows: [{ label: "Gem", percent: 90 }],
      updatedAt: Date.now(),
    });
    setCachedProviderAccountQuotaForTests("google-antigravity", bId, {
      customWindows: [{ label: "Gem", percent: 20 }],
      updatedAt: Date.now(),
    });
    expect(resolveGoogleAntigravityAccountForSession(
      "fill-1", "gemini-3.7-flash", config(true, 80, "fill-first"),
    )).toMatchObject({ accountId: bId, reason: "fill-first" });
  });

  test("preserves thread affinity until the bound account is cooled", async () => {
    const { aId, bId } = await seedTwoAccounts();
    bindGoogleAntigravitySessionAffinity("sticky-thread", aId);
    expect(resolveGoogleAntigravityAccountForSession("sticky-thread", "gemini-3.7-flash", config(true))).toMatchObject({
      accountId: aId,
      reason: "affinity",
    });

    expect(rotateGoogleAntigravityAccountOnQuotaError(
      config(true), aId, "30", "gemini-3.7-flash", "sticky-thread",
    )).toEqual({ kind: "next-account", accountId: bId });
    expect(googleAntigravitySessionAffinitySizeForTests()).toBe(0);
    bindGoogleAntigravitySessionAffinity("sticky-thread", bId);
    expect(resolveGoogleAntigravityAccountForSession("sticky-thread", "gemini-3.7-flash", config(true))).toMatchObject({
      accountId: bId,
      reason: "affinity",
    });
  });

  test("reports all-cooled with the earliest Retry-After", async () => {
    const now = 1_800_000_000_000;
    const { aId, bId } = await seedTwoAccounts();
    expect(rotateGoogleAntigravityAccountOnQuotaError(
      config(true), aId, "90", "gemini-3.7-flash", null, now,
    )).toEqual({ kind: "next-account", accountId: bId });
    expect(rotateGoogleAntigravityAccountOnQuotaError(
      config(true), bId, "30", "gemini-3.7-flash", null, now,
    )).toEqual({ kind: "all-cooled" });
    expect(resolveGoogleAntigravityAccountForSession("all-cooled", "gemini-3.7-flash", config(true), now)).toEqual({
      accountId: null,
      reason: "all-cooled",
    });
    expect(getEligibleGoogleAntigravityAccounts(now)).toEqual([]);
    expect(getGoogleAntigravityPoolRetryAfterSeconds(now)).toBe(30);
  });

  test("uses non-PII labels and bounds retained affinity state", async () => {
    const { aId } = await seedTwoAccounts();
    const label = formatGoogleAntigravityProviderForLog("google-antigravity", aId);
    expect(label).toMatch(/^google-antigravity-p[a-f0-9]{6}$/);
    expect(label).not.toContain(aId);

    bindGoogleAntigravitySessionAffinity("x".repeat(513), aId);
    expect(googleAntigravitySessionAffinitySizeForTests()).toBe(0);
    for (let index = 0; index < 2_050; index++) {
      bindGoogleAntigravitySessionAffinity(`thread-${index}`, aId, index);
    }
    expect(googleAntigravitySessionAffinitySizeForTests()).toBeLessThanOrEqual(2_000);
  });

  test("resolves access token and projectId from the same selected account snapshot", async () => {
    const { aId, bId } = await seedTwoAccounts();
    expect(getAccountSet("google-antigravity")?.activeAccountId).toBe(aId);

    const snapshot = await getGoogleAntigravityPoolAccessSnapshot(bId);

    expect(snapshot).toMatchObject({
      provider: "google-antigravity",
      accountId: bId,
      accessToken: "google-access-b",
      projectId: "project-b",
      generation: expect.any(String),
    });
    expect(snapshot.accessToken).not.toBe("google-access-a");
    expect(snapshot.projectId).not.toBe("project-a");
    expect(getAccountSet("google-antigravity")?.activeAccountId).toBe(aId);
  });
});
