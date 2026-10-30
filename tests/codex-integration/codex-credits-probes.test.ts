import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePoolQuotaWriter, poolQuotaHistoryIdentity, readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";
import { codexCreditsFor, rememberCodexCredits, resetCodexCreditsForTests } from "../../src/codex/credits";
import { listCodexAuthAccounts, poolAccountDto } from "../../src/codex/auth-api/account-list";
import { fetchMainAccountInfoSnapshot } from "../../src/codex/auth-api/main-account-probe";
import { commitPoolQuotaResponse } from "../../src/codex/auth-api/pool-quota-probe";
import { clearMainAccountInfoCache } from "../../src/codex/main-account-cache";
import { resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { applyAccountQuotaFromUpstreamHeaders, clearAccountQuota, getAccountQuota, parseUsageQuota, poolWhamPolicyObservation, type WhamUsageResponse } from "../../src/codex/quota";
import { resetQuotaQueryBackoffForTests } from "../../src/codex/quota-query-backoff";
import { captureConfigGeneration } from "../../src/lib/state-store-sweeper";
import { resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import type { CodexAccount, OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let originalFetch: typeof fetch;
const account: CodexAccount = { id: "credits-pool", email: "credits@example.test", isMain: false };
const config = (): OcxConfig => ({ port: 10100, defaultProvider: "openai", providers: {}, codexAccounts: [] });

function writeMain(bearer = "fixture-main-bearer", identity = "fixture-main-identity") {
  writeFileSync(join(process.env.CODEX_HOME!, "auth.json"), JSON.stringify({
    tokens: { access_token: bearer, account_id: identity },
  }));
}
function poolContext() {
  const record = readCodexAccountRecord(account.id)!;
  const credential = record.credential!;
  return { accountId: account.id, existing: null, configuredPlan: undefined,
    generation: record.generation, writerGeneration: captureConfigGeneration(),
    poolWriter: capturePoolQuotaWriter(account.id, { ...credential, generation: record.generation }),
  };
}
function savePool(identity = "fixture-pool-identity") {
  saveCodexAccountCredential(account.id, {
    accessToken: "fixture-pool-bearer", refreshToken: "fixture-pool-refresh",
    chatgptAccountId: identity, expiresAt: Date.now() + 3_600_000,
  });
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  originalFetch = globalThis.fetch;
  testDir = mkdtempSync(join(tmpdir(), "ocx-credits-probes-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.CODEX_HOME = join(testDir, "codex");
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  globalThis.fetch = (async () => { throw new Error("unexpected fixture network request"); }) as typeof fetch;
  clearMainAccountInfoCache();
  clearAccountQuota();
  resetMainCodexAccountIdentityTrackingForTests();
  resetLifecycleDrainStateForTests();
  resetCodexCreditsForTests();
  resetQuotaQueryBackoffForTests();
});
afterEach(() => {
  clearMainAccountInfoCache();
  clearAccountQuota();
  resetMainCodexAccountIdentityTrackingForTests();
  resetLifecycleDrainStateForTests();
  resetCodexCreditsForTests();
  resetQuotaQueryBackoffForTests();
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(testDir);
});

describe("main credits publication", () => {
  test("current credential publishes credits-only usage, omission keeps, null clears", async () => {
    writeMain();
    for (const payload of [{ credits: { balance: "125.725" } }, {}, { credits: null }]) {
      globalThis.fetch = (async () => Response.json(payload)) as typeof fetch;
      await fetchMainAccountInfoSnapshot(true, config());
      expect(codexCreditsFor("__main__", "fixture-main-identity"))
        .toEqual("credits" in payload && payload.credits === null ? undefined : { balance: "125.725" });
    }
  });
  test("a response from a replaced bearer never publishes credits", async () => {
    writeMain();
    globalThis.fetch = (async () => {
      writeMain("fixture-replacement-bearer");
      return Response.json({ credits: { balance: "999" } });
    }) as typeof fetch;
    await fetchMainAccountInfoSnapshot(true, config());
    expect(codexCreditsFor("__main__", "fixture-main-identity")).toBeUndefined();
  });
  test("main account DTO is gated, identity-bound and pruning removes retired pool observations", async () => {
    writeMain();
    globalThis.fetch = (async () => Response.json({ credits: { balance: "24.5" } })) as typeof fetch;
    const cfg = config();
    const off = await listCodexAuthAccounts(cfg, true);
    expect(off[0].credits).toBeUndefined();
    cfg.showCodexCredits = true;
    rememberCodexCredits("removed-pool", "removed-identity", { balance: "11" });
    const on = await listCodexAuthAccounts(cfg);
    expect(on[0].credits).toEqual({ balance: "24.5" });
    expect(codexCreditsFor("removed-pool", "removed-identity")).toBeUndefined();
    writeMain("fixture-new-bearer", "fixture-new-identity");
    globalThis.fetch = (async () => Response.json({})) as typeof fetch;
    expect((await listCodexAuthAccounts(cfg, true))[0].credits).toBeUndefined();
  });
});

describe("pool credits publication", () => {
  test("credits-only response publishes without usage windows and DTO follows the switch", async () => {
    savePool();
    const ctx = poolContext();
    const result = await commitPoolQuotaResponse(Response.json({ credits: { balance: "7.125" } }), ctx);
    expect(result.quota?.credits).toEqual({ balance: 7.125, observedAt: expect.any(Number) });
    for (const window of ["weeklyPercent", "monthlyPercent", "shortPercent", "customWindows"]) {
      expect(result.quota).not.toHaveProperty(window);
    }
    expect(ctx.poolWriter).toBeDefined();
    const cfg = config();
    expect(poolAccountDto(cfg, account, result, true, false, 0, false).credits).toBeUndefined();
    cfg.showCodexCredits = true;
    expect(poolAccountDto(cfg, account, result, true, false, 0, false).credits).toEqual({ balance: "7.125" });
    await commitPoolQuotaResponse(Response.json({}), ctx);
    expect(codexCreditsFor(account.id, poolQuotaHistoryIdentity(account.id)!)).toEqual({ balance: "7.125" });
    await commitPoolQuotaResponse(Response.json({ credits: null }), ctx);
    expect(codexCreditsFor(account.id, poolQuotaHistoryIdentity(account.id)!)).toBeUndefined();
  });
  test("same pool id with a replaced identity hides previous credits and rejects a dead generation", async () => {
    savePool();
    const old = poolContext();
    await commitPoolQuotaResponse(Response.json({ credits: { balance: "5" } }), old);
    savePool("fixture-other-pool-identity");
    expect(poolQuotaHistoryIdentity(account.id)).not.toBe(old.poolWriter!.historyIdentity);
    const dto = poolAccountDto({ ...config(), showCodexCredits: true }, account,
      { quota: null, needsReauth: false }, true, false, 0, false);
    expect(dto.credits).toBeUndefined();
    await commitPoolQuotaResponse(Response.json({ credits: { balance: "9" } }), old);
    expect(codexCreditsFor(account.id, old.poolWriter!.historyIdentity)).toBeUndefined();
  });
  test("a superseded request and a request without a captured writer cannot publish or clear credits", async () => {
    savePool();
    const ctx = poolContext();
    await commitPoolQuotaResponse(Response.json({ credits: { balance: "5" } }), ctx);
    await commitPoolQuotaResponse(Response.json({ credits: null }), { ...ctx, mayPublish: () => false });
    await commitPoolQuotaResponse(Response.json({ credits: { balance: "99" } }), { ...ctx, poolWriter: undefined });
    expect(codexCreditsFor(account.id, ctx.poolWriter!.historyIdentity)).toEqual({ balance: "5" });
  });
  test("with the switch on, the listing bypasses a fresh quota cache once per identity", async () => {
    savePool();
    writeMain();
    const resetAt = Math.floor(Date.now() / 1000) + 3_600;
    const usage = { rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_at: resetAt },
      secondary_window: { used_percent: 20, limit_window_seconds: 604_800, reset_at: resetAt } } };
    // A restart keeps the disk-hydrated quota but loses the process-local credits.
    await commitPoolQuotaResponse(Response.json(usage), poolContext());
    resetCodexCreditsForTests();
    let poolReads = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (auth.includes("fixture-pool-bearer")) {
        poolReads += 1;
        return Response.json({ ...usage, credits: { balance: "62498.725" } });
      }
      return Response.json({});
    }) as typeof fetch;
    const cfg: OcxConfig = { ...config(), codexAccounts: [account] };
    expect((await listCodexAuthAccounts(cfg)).find(row => row.id === account.id)?.credits).toBeUndefined();
    expect(poolReads).toBe(0);
    cfg.showCodexCredits = true;
    expect((await listCodexAuthAccounts(cfg)).find(row => row.id === account.id)?.credits).toEqual({ balance: "62498.725" });
    expect(poolReads).toBe(1);
    await listCodexAuthAccounts(cfg);
    expect(poolReads).toBe(1);
  });
});

describe("pool WHAM short-window retirement", () => {
  const now = () => Math.floor(Date.now() / 1000);
  const short = () => ({ used_percent: 100, limit_window_seconds: 18_000, reset_at: now() + 3600 });
  const weekly = () => ({ used_percent: 0, limit_window_seconds: 604_800, reset_at: now() + 604_800 });
  const observe = (primary: unknown, secondary: unknown, extra = {}) => Response.json({
    plan_type: "pro", rate_limit: { allowed: true, primary_window: primary, secondary_window: secondary }, ...extra,
  });

  test("complete weekly-only probe retires the carried short tuple", async () => {
    savePool();
    const ctx = poolContext();
    await commitPoolQuotaResponse(observe(short(), weekly()), ctx);
    const result = await commitPoolQuotaResponse(observe(weekly(), null), ctx);
    expect(result.quota?.shortPercent).toBeUndefined();
    expect(result.quota?.shortResetAt).toBeUndefined();
    expect(result.quota?.weeklyPercent).toBe(0);
  });

  test("a Plus-style five-hour window remains present", async () => {
    savePool();
    const ctx = poolContext();
    const result = await commitPoolQuotaResponse(observe(short(), weekly(), { plan_type: "plus" }), ctx);
    expect(result.quota?.shortPercent).toBe(100);
    expect(result.quota?.shortResetAt).toBeDefined();
  });

  test("partial and invalid WHAM observations retain the carried tuple", async () => {
    savePool();
    const ctx = poolContext();
    await commitPoolQuotaResponse(observe(short(), weekly()), ctx);
    const partial = await commitPoolQuotaResponse(Response.json({ rate_limit: { primary_window: weekly() } }), ctx);
    expect(partial.quota?.shortPercent).toBe(100);
    const invalid = await commitPoolQuotaResponse(observe(weekly(), null, {
      additional_rate_limits: [{ rate_limit: { primary_window: { used_percent: 101 } } }],
    }), ctx);
    expect(invalid.quota?.shortPercent).toBe(100);
  });
  test("partial response headers do not retire a carried short window", async () => {
    savePool();
    await commitPoolQuotaResponse(observe(short(), weekly()), poolContext());
    applyAccountQuotaFromUpstreamHeaders(account.id, new Headers({ "x-codex-primary-used-percent": "12" }));
    expect(getAccountQuota(account.id)?.shortPercent).toBe(100);
  });

  test("monthly-only pool plans keep their monthly observation", async () => {
    savePool();
    const ctx = poolContext();
    await commitPoolQuotaResponse(observe(short(), weekly()), ctx);
    const monthly = { used_percent: 14, limit_window_seconds: 2_592_000, reset_at: now() + 2_592_000 };
    const result = await commitPoolQuotaResponse(observe(monthly, null, { plan_type: "go" }), ctx);
    expect(result.quota?.shortPercent).toBeUndefined();
    expect(result.quota?.monthlyPercent).toBe(14);
  });

  test("a probe without a live writer for this account retains the carried tuple", async () => {
    savePool();
    await commitPoolQuotaResponse(observe(short(), weekly()), poolContext());
    const missing = await commitPoolQuotaResponse(observe(weekly(), null), { ...poolContext(), poolWriter: undefined });
    expect(missing.quota?.shortPercent).toBe(100);
    const live = poolContext().poolWriter!;
    const stale = { ...live, historyIdentity: "00000000-0000-4000-8000-000000000000" };
    expect((await commitPoolQuotaResponse(observe(weekly(), null), { ...poolContext(), poolWriter: stale })).quota?.shortPercent).toBe(100);
    const other = { ...live, accountId: "other-pool" };
    expect((await commitPoolQuotaResponse(observe(weekly(), null), { ...poolContext(), poolWriter: other })).quota?.shortPercent).toBe(100);
    expect((await commitPoolQuotaResponse(observe(weekly(), null), poolContext())).quota?.shortPercent).toBeUndefined();
  });
  test("an explicit upstream denial never retires the carried tuple", async () => {
    savePool();
    const ctx = poolContext();
    await commitPoolQuotaResponse(observe(short(), weekly()), ctx);
    const denied = await commitPoolQuotaResponse(Response.json({ plan_type: "pro", rate_limit: {
      allowed: false, primary_window: weekly(), secondary_window: null, tertiary_window: null,
    } }), ctx);
    expect(denied.quota?.shortPercent).toBe(100);
  });

  test("pool policy evidence marks absence only for a valid, allowed, complete topology", () => {
    const evidence = (data: WhamUsageResponse) => poolWhamPolicyObservation(data, parseUsageQuota(data));
    const weeklyOnly = { rate_limit: { allowed: true, primary_window: weekly(), secondary_window: null } };
    expect(evidence(weeklyOnly)?.shortWindowAbsent).toBe(true);
    expect(evidence({ rate_limit: { ...weeklyOnly.rate_limit, allowed: false, tertiary_window: null } })?.shortWindowAbsent).toBeUndefined();
    expect(evidence({ rate_limit: { allowed: true, primary_window: short(), secondary_window: weekly() } })?.shortWindowAbsent).toBeUndefined();
    expect(evidence({ rate_limit: { primary_window: weekly() } })?.shortWindowAbsent).toBeUndefined();
    expect(evidence({ ...weeklyOnly, additional_rate_limits: [{ rate_limit: { primary_window: { used_percent: 101 } } }] })).toBeNull();
  });

  test("a malformed usage reading keeps the carried tuple and its reset", async () => {
    savePool();
    const ctx = poolContext();
    const first = await commitPoolQuotaResponse(observe(short(), weekly()), ctx);
    for (const used_percent of ["unreadable", true, {}]) {
      const result = await commitPoolQuotaResponse(observe(weekly(), null, {
        additional_rate_limits: [{ rate_limit: { primary_window: { used_percent, limit_window_seconds: 604_800 } } }],
      }), ctx);
      expect(result.quota?.shortPercent).toBe(100);
      expect(result.quota?.shortResetAt).toBe(first.quota?.shortResetAt);
    }
  });

  test("a writer captured before a credential rollover cannot retire the tuple", async () => {
    savePool();
    await commitPoolQuotaResponse(observe(short(), weekly()), poolContext());
    const before = poolContext().poolWriter!;
    savePool();
    const after = poolContext();
    expect(after.generation).not.toBe(before.credentialGeneration);
    const replay = await commitPoolQuotaResponse(observe(weekly(), null), { ...after, poolWriter: before });
    expect(replay.quota?.shortPercent).toBe(100);
  });
});
