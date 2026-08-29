import { afterEach, describe, expect, test } from "bun:test";
import {
  clearKiroAccountUsageState,
  commitKiroAccountUsageState,
  fetchKiroUsageSnapshot,
  getKiroAccountExhaustion,
  kiroUsageManagementUrl,
  reconcileKiroAccountUsageState,
} from "../src/providers/kiro-usage";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  clearKiroAccountUsageState();
});

/** Capture the outbound request so region/host/parameter assertions read the real call. */
function stubUsageResponse(payload: unknown, status = 200): { calls: Request[] } {
  const calls: Request[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input instanceof Request ? input : String(input), init));
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls };
}

const baseContext = { accountId: "acct-1", access: "tok-1" };

function breakdown(extra: Record<string, unknown> = {}) {
  return {
    resourceType: "AGENTIC_REQUEST",
    currentUsageWithPrecision: 147.82,
    currentUsage: 147,
    usageLimitWithPrecision: 1000,
    usageLimit: 1000,
    unit: "CREDITS",
    ...extra,
  };
}

describe("Kiro usage limits", () => {
  test("maps an agentic-request breakdown onto the monthly window", async () => {
    stubUsageResponse({
      usageBreakdownList: [breakdown()],
      nextDateReset: 1785542400,
      subscriptionInfo: { subscriptionTitle: "KIRO PRO" },
    });
    const snapshot = await fetchKiroUsageSnapshot(baseContext);
    expect(snapshot?.quota.monthlyPercent).toBeCloseTo(14.782, 3);
    expect(snapshot?.quota.monthlyResetAt).toBe(1785542400 * 1000);
    expect(snapshot?.exhausted).toBe(false);
  });

  test("selects CREDIT by resource type rather than falling back to the first row", async () => {
    stubUsageResponse({
      usageBreakdownList: [
        { resourceType: "SOMETHING_ELSE", currentUsage: 900, usageLimit: 1000 },
        { resourceType: "CREDIT", currentUsage: 100, usageLimit: 1000 },
      ],
    });
    const snapshot = await fetchKiroUsageSnapshot(baseContext);
    // Index 0 would report 90%; selecting by resourceType reports the credit pool.
    expect(snapshot?.quota.monthlyPercent).toBe(10);
  });

  test("reports unknown when no recognised resource type is present", async () => {
    stubUsageResponse({
      usageBreakdownList: [{ resourceType: "FUTURE_POOL", currentUsage: 5, usageLimit: 10 }],
    });
    expect(await fetchKiroUsageSnapshot(baseContext)).toBeNull();
  });

  test("prefers the precise fields over their rounded twins", async () => {
    stubUsageResponse({
      usageBreakdownList: [breakdown({
        currentUsageWithPrecision: 695.17,
        currentUsage: 695,
        usageLimitWithPrecision: 1000,
        usageLimit: 1000,
      })],
    });
    const snapshot = await fetchKiroUsageSnapshot(baseContext);
    expect(snapshot?.quota.monthlyPercent).toBeCloseTo(69.517, 3);
  });

  test("an overage-enabled account past its limit is not exhausted", async () => {
    stubUsageResponse({
      usageBreakdownList: [breakdown({ currentUsageWithPrecision: 1200, usageLimitWithPrecision: 1000 })],
      overageConfiguration: { overageStatus: "ENABLED" },
    });
    const snapshot = await fetchKiroUsageSnapshot(baseContext);
    expect(snapshot?.exhausted).toBe(false);
    expect(snapshot?.quota.monthlyPercent).toBe(100);
  });

  test("a spent account without overage is exhausted", async () => {
    stubUsageResponse({
      usageBreakdownList: [breakdown({ currentUsageWithPrecision: 1000, usageLimitWithPrecision: 1000 })],
      overageConfiguration: { overageStatus: "DISABLED" },
    });
    expect((await fetchKiroUsageSnapshot(baseContext))?.exhausted).toBe(true);
  });

  test("a free-trial allowance is reported as its own window", async () => {
    stubUsageResponse({
      usageBreakdownList: [breakdown({
        freeTrialInfo: { freeTrialStatus: "ACTIVE", currentUsageWithPrecision: 250, usageLimitWithPrecision: 500 },
      })],
    });
    const snapshot = await fetchKiroUsageSnapshot(baseContext);
    expect(snapshot?.quota.customWindows).toEqual([{ label: "Free trial", percent: 50 }]);
  });

  test("the operator's email never leaves the module", async () => {
    stubUsageResponse({
      usageBreakdownList: [breakdown()],
      userInfo: { email: "operator@example.com", userId: "user-123" },
    });
    const snapshot = await fetchKiroUsageSnapshot(baseContext);
    expect(JSON.stringify(snapshot)).not.toContain("operator@example.com");
    expect(JSON.stringify(snapshot)).not.toContain("user-123");
  });

  test("the profile ARN region wins over the stored api region", async () => {
    const stub = stubUsageResponse({ usageBreakdownList: [breakdown()] });
    await fetchKiroUsageSnapshot({
      ...baseContext,
      profileArn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABCD",
      apiRegion: "us-east-1",
    });
    expect(new URL(stub.calls[0]!.url).host).toBe("management.eu-central-1.kiro.dev");
  });

  test("a crafted ARN region falls through instead of reaching the hostname", async () => {
    const stub = stubUsageResponse({ usageBreakdownList: [breakdown()] });
    await fetchKiroUsageSnapshot({
      ...baseContext,
      profileArn: "arn:aws:codewhisperer:evil.example.com:123456789012:profile/ABCD",
      apiRegion: "us-west-2",
    });
    const host = new URL(stub.calls[0]!.url).host;
    expect(host).toBe("management.us-west-2.kiro.dev");
    expect(host).not.toContain("evil.example.com");
  });

  test("hostile stored regions fall back to the default region", async () => {
    const stub = stubUsageResponse({ usageBreakdownList: [breakdown()] });
    await fetchKiroUsageSnapshot({
      ...baseContext,
      apiRegion: "../../evil",
      ssoRegion: "attacker.example.com",
    });
    const host = new URL(stub.calls[0]!.url).host;
    expect(host).toBe("management.us-east-1.kiro.dev");
    expect(host).not.toContain("evil");
    expect(host).not.toContain("attacker");
  });

  test("the modeled arguments are sent in both the query and the body", async () => {
    const stub = stubUsageResponse({ usageBreakdownList: [breakdown()] });
    const arn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/ABCD";
    await fetchKiroUsageSnapshot({ ...baseContext, profileArn: arn });
    const request = stub.calls[0]!;
    const url = new URL(request.url);
    expect(url.searchParams.get("origin")).toBe("AI_EDITOR");
    expect(url.searchParams.get("isEmailRequired")).toBe("true");
    expect(url.searchParams.get("profileArn")).toBe(arn);
    expect(request.headers.get("x-amz-target")).toBe("AmazonCodeWhispererService.GetUsageLimits");
    expect(await request.json()).toEqual({ origin: "AI_EDITOR", isEmailRequired: true, profileArn: arn });
  });

  test("an upstream failure resolves unknown instead of throwing", async () => {
    for (const status of [401, 429, 500]) {
      stubUsageResponse({ message: "nope" }, status);
      expect(await fetchKiroUsageSnapshot(baseContext)).toBeNull();
    }
  });

  test("a transport failure resolves unknown", async () => {
    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    expect(await fetchKiroUsageSnapshot(baseContext)).toBeNull();
  });

  test("management host construction is region-scoped", () => {
    expect(kiroUsageManagementUrl("us-east-1")).toBe("https://management.us-east-1.kiro.dev/");
  });
});

describe("Kiro exhaustion state", () => {
  const key = "kiro\u0000acct-1";

  test("a fresh exhausted verdict is readable", () => {
    commitKiroAccountUsageState(key, { quota: { updatedAt: Date.now() }, exhausted: true, nextResetAt: Date.now() + 60_000 });
    expect(getKiroAccountExhaustion(key)?.exhausted).toBe(true);
  });

  test("a verdict older than the account TTL degrades to unknown", () => {
    const now = Date.now();
    commitKiroAccountUsageState(key, { quota: { updatedAt: now }, exhausted: true, nextResetAt: now + 60 * 60_000 });
    expect(getKiroAccountExhaustion(key, now + 11 * 60_000)).toBeNull();
  });

  test("a verdict whose reset has passed degrades to unknown", () => {
    const now = Date.now();
    commitKiroAccountUsageState(key, { quota: { updatedAt: now }, exhausted: true, nextResetAt: now + 1_000 });
    expect(getKiroAccountExhaustion(key, now + 2_000)).toBeNull();
  });

  test("a null snapshot clears any previous verdict", () => {
    commitKiroAccountUsageState(key, { quota: { updatedAt: Date.now() }, exhausted: true });
    commitKiroAccountUsageState(key, null);
    expect(getKiroAccountExhaustion(key)).toBeNull();
  });

  test("clearing by provider prefix drops that provider's rows", () => {
    commitKiroAccountUsageState(key, { quota: { updatedAt: Date.now() }, exhausted: true });
    clearKiroAccountUsageState("kiro\u0000");
    expect(getKiroAccountExhaustion(key)).toBeNull();
  });

  test("reconciliation drops rows for accounts that no longer exist", () => {
    commitKiroAccountUsageState(key, { quota: { updatedAt: Date.now() }, exhausted: true });
    expect(reconcileKiroAccountUsageState(new Set())).toBe(1);
    expect(getKiroAccountExhaustion(key)).toBeNull();
  });

  test("reconciliation keeps rows for live accounts", () => {
    commitKiroAccountUsageState(key, { quota: { updatedAt: Date.now() }, exhausted: true });
    expect(reconcileKiroAccountUsageState(new Set([key]))).toBe(0);
    expect(getKiroAccountExhaustion(key)?.exhausted).toBe(true);
  });
});
