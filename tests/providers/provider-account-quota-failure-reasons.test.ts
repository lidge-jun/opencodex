/**
 * #7380: a per-account quota probe that yields no quota names a closed, redacted reason
 * (`quotaFailure`) so an operator can tell re-sign-in from retry. Credential health is never
 * touched here. Every upstream answer is a synthetic fetch stub; no live provider call is made.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountSet, markAccountNeedsReauth, saveCredential } from "../../src/oauth/store";
import { clearAccountQuotaCache, clearProviderQuotaCache, fetchProviderAccountQuotas, resetProviderQuotaReconcileStateForTests } from "../../src/providers/quota";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
let home = "";
const ACCESS = "diagnostic-access-token-DO-NOT-LEAK";
const UPSTREAM_TEXT = "upstream-body-text-DO-NOT-LEAK";

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-quota-failure-"));
  process.env.OPENCODEX_HOME = home;
  clearAccountQuotaCache();
  clearProviderQuotaCache();
  await saveCredential("anthropic", { access: ACCESS, refresh: "diagnostic-refresh", expires: Date.now() + 3_600_000, accountId: "acct-diag", email: "diag@example.com" });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
  clearAccountQuotaCache();
  clearProviderQuotaCache();
  resetProviderQuotaReconcileStateForTests();
});

async function probeWith(reply: () => Promise<Response>) {
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return reply(); }) as unknown as typeof fetch;
  const rows = await fetchProviderAccountQuotas("anthropic", true);
  expect(rows).toHaveLength(1);
  const serialized = JSON.stringify(rows);
  for (const secret of [ACCESS, "diagnostic-refresh", UPSTREAM_TEXT, "quotaFailureIsCurrent"]) expect(serialized).not.toContain(secret);
  return { row: rows[0]!, calls };
}

describe("Anthropic per-account quota failure reasons", () => {
  for (const [status, failure] of [[401, "access_denied"], [403, "access_denied"], [429, "rate_limited"], [500, "upstream_error"], [503, "upstream_error"]] as const) {
    test(`HTTP ${status} reports ${failure} without upstream text`, async () => {
      const { row } = await probeWith(async () => new Response(UPSTREAM_TEXT, { status }));
      expect(row).toMatchObject({ unavailable: true, quotaFailure: failure });
    });
  }

  test("an unusable or empty usage body reports response_unusable", async () => {
    for (const body of ["not json", "{}", JSON.stringify({ five_hour: { note: UPSTREAM_TEXT } })]) {
      clearAccountQuotaCache();
      const { row } = await probeWith(async () => new Response(body, { status: 200 }));
      expect(row).toMatchObject({ unavailable: true, quotaFailure: "response_unusable" });
    }
  });

  test("a request deadline reports timeout and any other thrown dispatch reports transport_error", async () => {
    const timedOut = await probeWith(async () => { throw new DOMException(UPSTREAM_TEXT, "TimeoutError"); });
    expect(timedOut.row).toMatchObject({ unavailable: true, quotaFailure: "timeout" });
    clearAccountQuotaCache();
    const refused = await probeWith(async () => { throw new TypeError(`connect refused ${UPSTREAM_TEXT}`); });
    expect(refused.row).toMatchObject({ unavailable: true, quotaFailure: "transport_error" });
  });

  test("a signed-out account reports account_unavailable without dispatching, and health is left alone", async () => {
    const account = getAccountSet("anthropic")!.accounts[0]!;
    await markAccountNeedsReauth("anthropic", account.id, true);
    const { row, calls } = await probeWith(async () => new Response("{}", { status: 200 }));
    expect(calls).toBe(0);
    expect(row).toMatchObject({ unavailable: true, quotaFailure: "account_unavailable" });
  });

  test("a usable answer carries no failure reason, and a transient failure never marks the account for sign-in", async () => {
    const failed = await probeWith(async () => new Response(UPSTREAM_TEXT, { status: 503 }));
    expect(failed.row.quotaFailure).toBe("upstream_error");
    expect(getAccountSet("anthropic")!.accounts[0]!.needsReauth).toBeFalsy();
    const ok = await probeWith(async () => new Response(JSON.stringify({ five_hour: { utilization: 12 } }), { status: 200 }));
    expect(ok.row.unavailable).toBeUndefined();
    expect(ok.row).not.toHaveProperty("quotaFailure");
    expect(ok.row.quota?.fiveHourPercent).toBe(12);
  });
});
