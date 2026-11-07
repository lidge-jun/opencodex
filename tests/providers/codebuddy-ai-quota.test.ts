import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTempHome } from "../helpers/temp-home";
import { parseWorkBuddyCredits, normalizeWorkBuddyCredits } from "../../src/providers/workbuddy-credit-balance";
import { fetchCodeBuddyAiQuota, codeBuddyAiExpiringCredits } from "../../src/providers/quota/codebuddy-ai";
import { TERMINAL_QUOTA_FAILURE } from "../../src/providers/quota/report-cache";
import { clearAccountQuotaCache, clearProviderQuotaCache, fetchProviderAccountQuotas, providerOAuthAccountQuotaMode, fetchProviderQuotaReports } from "../../src/providers/quota";
import { saveCredential, getAccountSet, setAccountPaused, mergeAccountCredential, getAccountCredential, setActiveAccount } from "../../src/oauth/store";
import { accountHeadroomPercent } from "../../src/oauth/account-quota-rank";
import { cachedProviderQuotaIsExhausted } from "../../src/combos/resolve";
import { providerDecisionWindows } from "../../src/providers/quota-decision-publication";
import type { OAuthCredentials } from "../../src/oauth/types";

const originalFetch = globalThis.fetch;
let home: ReturnType<typeof createTempHome>;
beforeEach(() => { home = createTempHome("ocx-codebuddy-ai-quota-"); clearAccountQuotaCache(); clearProviderQuotaCache(); });
afterEach(() => { globalThis.fetch = originalFetch; clearAccountQuotaCache(); clearProviderQuotaCache(); home.remove(); });
const credentials = (suffix = "a"): OAuthCredentials => ({ access: `fixture-access-${suffix}`, refresh: `fixture-refresh-${suffix}`, expires: Date.now() + 3600_000,
  accountId: `fixture-user-${suffix}`, codeBuddyAi: { uid: `fixture-user-${suffix}`, domain: "international" } });
const amounts = (total = "100", used = "0", remaining = "100") => ({ CycleTotalCapacity: total, CycleUsedCapacity: used, CycleRemainCapacity: remaining, CycleFrozenCapacity: "0" });
const summary = () => ({ Packages: [{ PackageCode: "fixture-base", ...amounts() }, { PackageCode: "fixture-gift", ...amounts("250", "0", "250") }],
  TotalCredits: "350", CreditGroups: [{ Kind: "plan_base", ...amounts() }, { Kind: "benefit", ...amounts("250", "0", "250") }] });
function stubSummary(value: unknown) {
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toStartWith("https://www.codebuddy.ai/billing/meter/");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("user-agent")).toBe("CLI/2.180.0 CodeBuddy/2.180.0");
    return Response.json({ code: 0, data: String(input).endsWith("summary") ? value : { Accounts: [], TotalCount: 0 } });
  }) as typeof fetch;
}

test("counts the 100 base + 250 gift balance once, with credit groups as a breakdown", () => {
  const result = parseWorkBuddyCredits(summary())!;
  expect(result).toMatchObject({ total: 350, used: 0, remaining: 350, frozen: 0 });
  expect(result.groups.map(g => [g.kind, g.remaining])).toEqual([["plan_base", 100], ["benefit", 250]]);
  expect(JSON.stringify(result)).not.toContain("PackageCode");
});

test("uses precise remaining capacity and frozen credits, and keeps zero distinct from unknown", () => {
  expect(parseWorkBuddyCredits({ Packages: [{ ...amounts("100", "10.25", "84.75"), CycleFrozenCapacity: "5" }] }))
    .toMatchObject({ used: 10.25, remaining: 84.75, frozen: 5 });
  expect(parseWorkBuddyCredits({ Packages: [{ CycleTotalCapacity: 100, CycleUsedCapacity: 25 }] })?.remaining).toBe(75);
  expect(parseWorkBuddyCredits({ Packages: [] })?.remaining).toBe(0);
  for (const value of [{}, { Packages: [{ CycleTotalCapacity: "bad" }] }, { Packages: Array(513).fill(amounts()) }]) expect(parseWorkBuddyCredits(value)).toBeUndefined();
  expect(normalizeWorkBuddyCredits({ total: Infinity, used: 0, remaining: 0, frozen: 0, groups: [] })).toBeUndefined();
});

test("finds the earliest counted gift expiry, excluding daily slices and unrelated packages", () => {
  const now = Date.UTC(2026, 9, 1), at = Date.UTC(2026, 10, 1, 1, 19, 34);
  const rows = [
    { PackageCode: "gift", CapacityType: 1, CycleCapacityRemainPrecise: "250", DeductionEndTime: at },
    { PackageCode: "gift", CapacityType: 1, CycleCapacityRemain: 10, CycleEndTime: "2026-11-01 09:19:34" },
    { PackageCode: "base", CapacityType: 4, CycleCapacityRemain: 100, DeductionEndTime: now + 1 },
    { PackageCode: "other", CapacityType: 1, CycleCapacityRemain: 50, DeductionEndTime: now + 1 },
  ];
  expect(codeBuddyAiExpiringCredits(rows, new Set(["gift", "base"]), now)).toEqual({ amount: 260, at });
  // A precise zero means the package is depleted; the legacy field must not resurrect it.
  expect(codeBuddyAiExpiringCredits([{ PackageCode: "gift", CapacityType: 1, CycleCapacityRemainPrecise: "0",
    CycleCapacityRemain: 250, DeductionEndTime: at }], new Set(["gift"]), now)).toBeUndefined();
  expect(codeBuddyAiExpiringCredits([{ PackageCode: "gift", CapacityType: 1, CycleCapacityRemainPrecise: 0,
    CycleCapacityRemain: 250, DeductionEndTime: at }], new Set(["gift"]), now)).toBeUndefined();
});

test("uses account-owned headers and bounded pagination for package expiry", async () => {
  const calls: string[] = [], at = Date.now() + 86400_000;
  globalThis.fetch = (async (input, init) => {
    const url = String(input), headers = new Headers(init?.headers); calls.push(url);
    expect(headers.get("authorization")).toBe("Bearer fixture-access-a");
    expect(headers.get("x-user-id")).toBe("fixture-user-a");
    expect(headers.get("x-tenant-id")).toBe("fixture-team");
    if (url.endsWith("summary")) return Response.json({ code: 0, data: summary() });
    const body = JSON.parse(String(init?.body));
    expect(body.PackageCodes).toEqual(["fixture-base", "fixture-gift"]);
    expect(body.PageSize).toBe(200);
    return Response.json({ code: 0, data: { TotalCount: url.includes("free") ? 1 : 0,
      Accounts: url.includes("free") ? [{ PackageCode: "fixture-gift", CapacityType: 1, CycleCapacityRemainPrecise: "250", DeductionEndTime: at }] : [] } });
  }) as typeof fetch;
  const cred = credentials(); cred.codeBuddyAi!.enterpriseId = "fixture-team";
  const report = await fetchCodeBuddyAiQuota("codebuddy-ai", cred);
  expect(report).toMatchObject({ quota: { workbuddyCredits: { remaining: 350, expiring: { amount: 250, at } } } });
  expect(calls).toHaveLength(3);
});

test("a failed detail read keeps the balance; invalid summary is unknown; 401 clears stale evidence", async () => {
  globalThis.fetch = (async input => String(input).endsWith("summary") ? Response.json({ code: 0, data: summary() }) : new Response("", { status: 500 })) as typeof fetch;
  expect(await fetchCodeBuddyAiQuota("codebuddy-ai", credentials())).toMatchObject({ quota: { workbuddyCredits: { remaining: 350 } } });
  stubSummary({ Packages: [{}] });
  expect(await fetchCodeBuddyAiQuota("codebuddy-ai", credentials())).toBeNull();
  globalThis.fetch = (async () => new Response("", { status: 401 })) as typeof fetch;
  expect(await fetchCodeBuddyAiQuota("codebuddy-ai", credentials())).toBe(TERMINAL_QUOTA_FAILURE);
});

test("enterprise meter fills the balance without treating it as personal credit", async () => {
  globalThis.fetch = (async (input, init) => {
    expect(new Headers(init?.headers).get("x-enterprise-id")).toBe("fixture-team");
    return Response.json({ code: 0, data: String(input).endsWith("summary") ? { Packages: [] } : { limitNum: "1000", credit: "12.5" } });
  }) as typeof fetch;
  const cred = credentials(); cred.codeBuddyAi!.enterpriseId = "fixture-team";
  expect(await fetchCodeBuddyAiQuota("codebuddy-ai", cred)).toMatchObject({ quota: { workbuddyCredits: { total: 1000, used: 12.5, remaining: 987.5 } } });
});

test("the registered quota path is account-isolated, cached, refreshable, and display-only at zero", async () => {
  await saveCredential("codebuddy-ai", credentials()); await saveCredential("codebuddy-ai", credentials("b"));
  let reads = 0;
  globalThis.fetch = (async (_input, init) => {
    reads++;
    const a = new Headers(init?.headers).get("authorization")!.endsWith("a");
    return Response.json({ code: 0, data: { Packages: [amounts(a ? "350" : "500", a ? "350" : "500", "0")] } });
  }) as typeof fetch;
  expect(providerOAuthAccountQuotaMode("codebuddy-ai")).toBe("probe");
  const rows = await fetchProviderAccountQuotas("codebuddy-ai");
  // Each row must carry the balance probed with ITS credential: a swap between accounts fails here.
  expect(rows.map(row => [getAccountCredential("codebuddy-ai", row.accountId)?.access, row.quota?.workbuddyCredits?.total]).sort())
    .toEqual([["fixture-access-a", 350], ["fixture-access-b", 500]]);
  await fetchProviderAccountQuotas("codebuddy-ai"); expect(reads).toBe(2);
  await fetchProviderAccountQuotas("codebuddy-ai", true); expect(reads).toBe(4);
  for (const row of rows) {
    expect(accountHeadroomPercent("codebuddy-ai", row.accountId)).toBeNull();
    expect(cachedProviderQuotaIsExhausted(row.quota, Date.now(), "free-model")).toBe(false);
    expect(providerDecisionWindows(row.quota!)).toEqual([]);
  }
  const id = getAccountSet("codebuddy-ai")!.activeAccountId;
  const cred = getAccountCredential("codebuddy-ai", id)!;
  await mergeAccountCredential("codebuddy-ai", id, { ...cred, codeBuddyAi: { ...cred.codeBuddyAi!, enterpriseId: "fixture-team" } });
  await fetchProviderAccountQuotas("codebuddy-ai"); expect(reads).toBe(5);
  await setAccountPaused("codebuddy-ai", id, true);
  await fetchProviderAccountQuotas("codebuddy-ai", true); expect(reads).toBe(6);
});

test("Overview reports use the selected account and failed refresh preserves stale data until a 401", async () => {
  await saveCredential("codebuddy-ai", credentials());
  await saveCredential("codebuddy-ai", credentials("b"));
  await setActiveAccount("codebuddy-ai", "fixture-user-a");
  stubSummary(summary());
  const config = { port: 10100, defaultProvider: "codebuddy-ai", providers: { "codebuddy-ai": {
    adapter: "codebuddy-ai", baseUrl: "https://www.codebuddy.ai/v2", authMode: "oauth" as const,
  } } };
  const report = await fetchProviderQuotaReports(config, true);
  expect(report.reports[0]?.quota.workbuddyCredits?.remaining).toBe(350);
  await fetchProviderAccountQuotas("codebuddy-ai", true);
  stubSummary({ Packages: [{}] });
  const stale = await fetchProviderAccountQuotas("codebuddy-ai", true);
  expect(stale[0]).toMatchObject({ unavailable: true, quota: { workbuddyCredits: { remaining: 350 } } });
  globalThis.fetch = (async () => new Response("", { status: 401 })) as typeof fetch;
  expect((await fetchProviderAccountQuotas("codebuddy-ai", true))[0]).toMatchObject({ unavailable: true, quota: null });
});
