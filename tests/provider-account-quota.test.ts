import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredential } from "../src/oauth/store";
import { clearAccountQuotaCache, fetchProviderAccountQuotas, supportsPerAccountQuota } from "../src/providers/quota";

const originalFetch = globalThis.fetch;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
let opencodexHome: string;

const FIRST = { accountId: "acct-first", email: "first@example.com" };
const SECOND = { accountId: "acct-second", email: "second@example.com" };

/** Two logged-in Claude accounts, each with its own (non-expired) bearer token. */
async function seedTwoAccounts(): Promise<void> {
  const expires = Date.now() + 60 * 60_000;
  await saveCredential("anthropic", { access: "token-first", refresh: "refresh-first", expires, ...FIRST });
  await saveCredential("anthropic", { access: "token-second", refresh: "refresh-second", expires, ...SECOND });
}

function usageBody(fiveHour: number, sevenDay: number): string {
  return JSON.stringify({
    five_hour: { utilization: fiveHour, resets_at: "2026-07-05T12:00:00Z" },
    seven_day: { utilization: sevenDay, resets_at: "2026-07-08T12:00:00Z" },
  });
}

beforeEach(() => {
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-account-quota-"));
  process.env.OPENCODEX_HOME = opencodexHome;
  clearAccountQuotaCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  rmSync(opencodexHome, { recursive: true, force: true });
  clearAccountQuotaCache();
});

describe("fetchProviderAccountQuotas", () => {
  test("reports each account's own rate limits, keyed by the account's bearer token", async () => {
    await seedTwoAccounts();
    const seenTokens: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.anthropic.com/api/oauth/usage");
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      seenTokens.push(auth);
      // Distinct upstream numbers per credential — the whole point of a per-account probe.
      const body = auth.endsWith("token-first") ? usageBody(70, 15) : usageBody(3, 21);
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const rows = await fetchProviderAccountQuotas("anthropic");
    const byId = Object.fromEntries(rows.map(row => [row.accountId, row]));
    const ids = Object.keys(byId);
    expect(ids.length).toBe(2);

    const values = rows.map(row => `${row.quota?.fiveHourPercent}/${row.quota?.weeklyPercent}`).sort();
    expect(values).toEqual(["3/21", "70/15"]);
    expect(seenTokens.sort()).toEqual(["Bearer token-first", "Bearer token-second"]);
    // The 5-hour window lands in the canonical fields, not in customWindows.
    for (const row of rows) expect(row.quota?.customWindows).toBeUndefined();
  });

  test("a cached row is reused instead of re-probing upstream", async () => {
    await seedTwoAccounts();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(usageBody(50, 10), { status: 200 });
    }) as typeof fetch;

    await fetchProviderAccountQuotas("anthropic");
    expect(calls).toBe(2);
    await fetchProviderAccountQuotas("anthropic");
    expect(calls).toBe(2);

    // A forced refresh bypasses the TTL.
    await fetchProviderAccountQuotas("anthropic", true);
    expect(calls).toBe(4);
  });

  test("a failing probe is flagged unavailable without dropping the other account", async () => {
    await seedTwoAccounts();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      // Anthropic rate-limits this endpoint; one 429 must not blank the sibling account.
      if (auth.endsWith("token-first")) return new Response("rate limited", { status: 429 });
      return new Response(usageBody(3, 21), { status: 200 });
    }) as typeof fetch;

    const rows = await fetchProviderAccountQuotas("anthropic");
    const failed = rows.find(row => row.quota === null);
    const ok = rows.find(row => row.quota !== null);
    expect(failed?.unavailable).toBe(true);
    expect(ok?.quota?.fiveHourPercent).toBe(3);
  });

  test("providers without a per-account usage API are skipped", async () => {
    expect(supportsPerAccountQuota("anthropic")).toBe(true);
    expect(supportsPerAccountQuota("kiro")).toBe(false);
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}", { status: 200 }); }) as typeof fetch;
    expect(await fetchProviderAccountQuotas("kiro")).toEqual([]);
    expect(called).toBe(false);
  });

  test("a provider with no logged-in accounts yields no rows and no upstream calls", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}", { status: 200 }); }) as typeof fetch;
    expect(await fetchProviderAccountQuotas("anthropic")).toEqual([]);
    expect(called).toBe(false);
  });
});
