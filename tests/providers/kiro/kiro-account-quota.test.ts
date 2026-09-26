import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountSet, saveCredential } from "../../../src/oauth/store";
import {
  clearAccountQuotaCache,
  clearProviderQuotaCache,
  fetchProviderAccountQuotas,
  getCachedProviderAccountQuota,
  supportsPerAccountQuota,
} from "../../../src/providers/quota";
import { getKiroAccountExhaustion } from "../../../src/providers/kiro-usage";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
let opencodexHome: string;

const ARN_A = "arn:aws:codewhisperer:us-east-1:111111111111:profile/AAAA";
const ARN_B = "arn:aws:codewhisperer:eu-central-1:222222222222:profile/BBBB";

/** Two logged-in Kiro accounts, each with its own bearer AND its own routing metadata. */
async function seedTwoKiroAccounts(): Promise<void> {
  const expires = Date.now() + 60 * 60_000;
  await saveCredential("kiro", {
    access: "token-a", refresh: "refresh-a", expires,
    accountId: "kiro-a", email: "a@example.com",
    kiro: { profileArn: ARN_A, apiRegion: "us-east-1", ssoRegion: "us-east-1" },
  });
  await saveCredential("kiro", {
    access: "token-b", refresh: "refresh-b", expires,
    accountId: "kiro-b", email: "b@example.com",
    kiro: { profileArn: ARN_B, apiRegion: "eu-central-1", ssoRegion: "eu-central-1" },
  });
}

function usagePayload(used: number, limit: number, overage = "DISABLED"): string {
  return JSON.stringify({
    usageBreakdownList: [{
      resourceType: "AGENTIC_REQUEST",
      currentUsageWithPrecision: used,
      usageLimitWithPrecision: limit,
      unit: "CREDITS",
    }],
    overageConfiguration: { overageStatus: overage },
    nextDateReset: Math.floor(Date.now() / 1000) + 3 * 24 * 3600,
  });
}

beforeEach(() => {
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-kiro-quota-"));
  process.env.OPENCODEX_HOME = opencodexHome;
  clearAccountQuotaCache();
  clearProviderQuotaCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  removeTreeWithRetry(opencodexHome);
  clearAccountQuotaCache();
  clearProviderQuotaCache();
});

describe("Kiro per-account quota", () => {
  test("the seam is open for kiro", () => {
    expect(supportsPerAccountQuota("kiro")).toBe(true);
  });

  test("each account is probed with its own bearer and reported separately", async () => {
    await seedTwoKiroAccounts();
    const seen: Array<{ token: string; host: string; arn: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input instanceof Request ? input : String(input), init);
      const url = new URL(request.url);
      seen.push({
        token: request.headers.get("authorization") ?? "",
        host: url.host,
        arn: url.searchParams.get("profileArn"),
      });
      const used = request.headers.get("authorization") === "Bearer token-a" ? 100 : 900;
      return new Response(usagePayload(used, 1000), { status: 200 });
    }) as typeof fetch;

    const rows = await fetchProviderAccountQuotas("kiro");
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.quota?.monthlyPercent).sort()).toEqual([10, 90]);
    expect(seen).toHaveLength(2);
  });

  test("a rotated bearer never travels with another account's profile ARN or region", async () => {
    await seedTwoKiroAccounts();
    const pairs: Array<{ token: string; host: string; arn: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input instanceof Request ? input : String(input), init);
      const url = new URL(request.url);
      pairs.push({
        token: request.headers.get("authorization") ?? "",
        host: url.host,
        arn: url.searchParams.get("profileArn"),
      });
      return new Response(usagePayload(100, 1000), { status: 200 });
    }) as typeof fetch;

    await fetchProviderAccountQuotas("kiro");

    // This is the #2841 invariant applied to Kiro: token and routing metadata must come
    // from the SAME account record, so no pair may mix A's bearer with B's ARN.
    for (const pair of pairs) {
      if (pair.token === "Bearer token-a") {
        expect(pair.arn).toBe(ARN_A);
        expect(pair.host).toBe("management.us-east-1.kiro.dev");
      } else {
        expect(pair.token).toBe("Bearer token-b");
        expect(pair.arn).toBe(ARN_B);
        expect(pair.host).toBe("management.eu-central-1.kiro.dev");
      }
    }
    expect(pairs).toHaveLength(2);
  });

  test("one failing account leaves the other's bars intact", async () => {
    await seedTwoKiroAccounts();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input instanceof Request ? input : String(input), init);
      if (request.headers.get("authorization") === "Bearer token-b") {
        return new Response("{}", { status: 401 });
      }
      return new Response(usagePayload(250, 1000), { status: 200 });
    }) as typeof fetch;

    const rows = await fetchProviderAccountQuotas("kiro");
    const healthy = rows.find(r => r.quota?.monthlyPercent === 25);
    const broken = rows.find(r => r.unavailable);
    expect(healthy).toBeDefined();
    expect(broken?.quota).toBeNull();
  });

  test("a second read inside the TTL makes no upstream call", async () => {
    await seedTwoKiroAccounts();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(usagePayload(100, 1000), { status: 200 });
    }) as typeof fetch;

    await fetchProviderAccountQuotas("kiro");
    expect(calls).toBe(2);
    await fetchProviderAccountQuotas("kiro");
    expect(calls).toBe(2);
  });

  test("exhaustion state is recorded next to the quota row and cleared with it", async () => {
    await seedTwoKiroAccounts();
    globalThis.fetch = (async () => new Response(usagePayload(1000, 1000), { status: 200 })) as typeof fetch;

    const rows = await fetchProviderAccountQuotas("kiro");
    // Kiro keys accounts by their stable profile ARN, so read the id the store actually
    // assigned rather than assuming the seed value.
    const accountId = rows[0]!.accountId;
    const key = `kiro\u0000${accountId}`;
    expect(getKiroAccountExhaustion(key, getAccountSet("kiro")!.accounts.find(a => a.id === accountId)!)?.exhausted).toBe(true);
    expect(getCachedProviderAccountQuota("kiro", accountId)?.monthlyPercent).toBe(100);

    clearAccountQuotaCache("kiro");
    expect(getKiroAccountExhaustion(key, getAccountSet("kiro")!.accounts.find(a => a.id === accountId)!)).toBeNull();
    expect(getCachedProviderAccountQuota("kiro", accountId)).toBeNull();
  });

  test("an overage-enabled account past its limit is not marked exhausted", async () => {
    await seedTwoKiroAccounts();
    globalThis.fetch = (async () => new Response(usagePayload(1500, 1000, "ENABLED"), { status: 200 })) as typeof fetch;

    const rows = await fetchProviderAccountQuotas("kiro");
    const key = `kiro\u0000${rows[0]!.accountId}`;
    expect(getKiroAccountExhaustion(key, getAccountSet("kiro")!.accounts.find(a => a.id === rows[0]!.accountId)!)?.exhausted).toBe(false);
  });
});

describe("Kiro Builder ID usage probe", () => {
  const BUILDER_ID_ARN = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";

  function captureProbe(): Array<{ host: string; arn: string | null; bodyArn: unknown }> {
    const seen: Array<{ host: string; arn: string | null; bodyArn: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input instanceof Request ? input : String(input), init);
      const url = new URL(request.url);
      const body = await request.json() as Record<string, unknown>;
      seen.push({ host: url.host, arn: url.searchParams.get("profileArn"), bodyArn: body.profileArn });
      // Builder ID accounts answer with a CREDIT-only breakdown (observed live), so this also pins
      // the parser's fallback past AGENTIC_REQUEST.
      return new Response(JSON.stringify({
        usageBreakdownList: [{
          resourceType: "CREDIT",
          currentUsageWithPrecision: 25.21,
          usageLimitWithPrecision: 5000,
          unit: "CREDITS",
        }],
        overageConfiguration: { overageStatus: "DISABLED" },
        nextDateReset: Math.floor(Date.now() / 1000) + 3 * 24 * 3600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return seen;
  }

  test("a Builder ID account without a stored ARN sends the service profile and reports usage", async () => {
    // Builder ID credentials carry the OIDC client pair and never an account-scoped ARN.
    await saveCredential("kiro", {
      access: "token-bid", refresh: "refresh-bid", expires: Date.now() + 60 * 60_000,
      accountId: "kiro-bid", email: "bid@example.com",
      kiro: { apiRegion: "us-west-2", ssoRegion: "us-west-2", clientId: "client-id", clientSecret: "client-secret" },
    });
    const seen = captureProbe();
    const rows = await fetchProviderAccountQuotas("kiro");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.arn).toBe(BUILDER_ID_ARN);
    expect(seen[0]!.bodyArn).toBe(BUILDER_ID_ARN);
    // The fixed ARN is Amazon's us-east-1 profile; it must not pin the account's own region.
    expect(seen[0]!.host).toBe("management.us-west-2.kiro.dev");
    expect(rows[0]!.quota?.monthlyPercent).toBeCloseTo(0.5042, 4);
  });

  test("a non-Builder-ID account without a stored ARN makes no usage request", async () => {
    await saveCredential("kiro", {
      access: "token-desk", refresh: "refresh-desk", expires: Date.now() + 60 * 60_000,
      accountId: "kiro-desk", email: "desk@example.com",
      kiro: { apiRegion: "us-east-1", ssoRegion: "us-east-1" },
    });
    const seen = captureProbe();
    await fetchProviderAccountQuotas("kiro");
    expect(seen).toHaveLength(0);
  });
});
