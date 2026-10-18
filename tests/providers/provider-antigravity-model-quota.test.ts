import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PROXY_ENV_KEYS } from "../../src/lib/proxy-env";
import {
  accountHeadroomPercent,
  accountResetTimestamp,
  rankAccountsByHeadroom,
  rankAccountsByResetFirst,
} from "../../src/oauth/account-quota-rank";
import { cachedProviderQuotaIsExhausted } from "../../src/combos/resolve";
import { getCachedProviderAccountQuota, setCachedProviderAccountQuotaForTests } from "../../src/providers/quota";
import { sweepExpiredProviderAccountQuotaRows } from "../../src/providers/quota/account-cache";
import { ACCOUNT_QUOTA_TTL_MS } from "../../src/providers/quota-wire";
import { providerWindowObservations } from "../../src/quota/window-mapping";
import {
  probeAntigravityUsageQuota,
  setAntigravityAccountQuotaTransportForTests,
} from "../../src/providers/quota/antigravity";

const proxyEnv = PROXY_ENV_KEYS.flatMap(key => [key, key.toLowerCase()]);
const originalProxyEnv = Object.fromEntries(proxyEnv.map(key => [key, process.env[key]]));

beforeEach(() => {
  for (const key of proxyEnv) delete process.env[key];
});

afterEach(() => {
  setAntigravityAccountQuotaTransportForTests(null);
  setCachedProviderAccountQuotaForTests("google-antigravity", "first", null);
  setCachedProviderAccountQuotaForTests("google-antigravity", "second", null);
  for (const key of proxyEnv) {
    if (originalProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalProxyEnv[key];
  }
});

function setModelsResponse(models: unknown): void {
  setAntigravityAccountQuotaTransportForTests({
    resolveAddresses: async () => ({
      hostname: "daily-cloudcode-pa.googleapis.com",
      addresses: [{ address: "142.250.0.1", family: 4 }],
      privateNetwork: false,
    }),
    pinnedPost: async url => url.endsWith("retrieveUserQuotaSummary")
      ? new Response(null, { status: 404 })
      : new Response(JSON.stringify({ models }), { status: 200, headers: { "content-type": "application/json" } }),
  });
}

describe("Antigravity model quota evidence", () => {
  test("keeps bounded exact wire-model readings alongside unchanged first-seen family bars", async () => {
    setModelsResponse({
      "gemini-3.8-flash-high": {
        displayName: "Gemini Flash High",
        quotaInfo: { remainingFraction: 0.64, resetTime: "2026-11-01T12:00:00Z" },
      },
      "claude-sonnet-4-6": {
        quotaInfoByTier: { sonnet: { remainingFraction: 0.21, resetTime: "2026-11-02T12:00:00Z" } },
      },
      autocomplete: { quotaInfo: { remainingFraction: 0.01 } },
      malformed: { quotaInfo: { remainingFraction: "unknown" } },
      ["x".repeat(129)]: { quotaInfo: { remainingFraction: 0 } },
    });

    const result = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;

    expect(result.quota.customWindows?.slice(0, 2)).toEqual([
      { label: "Gem", percent: 36, resetAt: Date.parse("2026-11-01T12:00:00Z") },
      { label: "Cla", percent: 79, resetAt: Date.parse("2026-11-02T12:00:00Z") },
    ]);
    expect(result.quota.customWindows).toContainEqual({
      label: "gemini-3.8-flash-high", modelId: "gemini-3.8-flash-high", percent: 36,
      resetAt: Date.parse("2026-11-01T12:00:00Z"),
    });
    expect(result.quota.customWindows).toContainEqual({
      label: "claude-sonnet-4-6 · sonnet", modelId: "claude-sonnet-4-6", percent: 79,
      resetAt: Date.parse("2026-11-02T12:00:00Z"),
    });
    expect(result.quota.customWindows).toContainEqual({
      label: "autocomplete", modelId: "autocomplete", percent: 99,
    });
    expect(result.quota.customWindows?.some(window => window.modelId === "malformed" || window.label.length > 128)).toBe(false);
  });

  test("multiple readings retain distinct bounded labels even when tiers truncate", async () => {
    const longModel = "gemini-" + "x".repeat(115);
    setModelsResponse({
      autocomplete: { quotaInfos: [{ remainingFraction: 0.8 }, { remainingFraction: 0.2 }] },
      [longModel]: { quotaInfoByTier: {
        "shared-prefix-one": { remainingFraction: 0.7 },
        "shared-prefix-two": { remainingFraction: 0.1 },
      } },
    });
    const result = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    const rows = result.quota.customWindows!.filter(window => window.modelId !== undefined);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map(window => window.label)).size).toBe(4);
    expect(rows.every(window => window.label.length <= 128)).toBe(true);
    expect(rows.map(window => window.percent)).toEqual([20, 80, 30, 90]);
    expect(rows.map(window => window.modelId)).toEqual(["autocomplete", "autocomplete", longModel, longModel]);
  });

  test("bounds diagnostic rows without truncating later family evidence", async () => {
    setModelsResponse(Object.fromEntries([
      ...Array.from({ length: 300 }, (_, i) => [`aux-${i}`, { quotaInfo: { remainingFraction: 0.5 } }]),
      ["gemini-" + "x".repeat(129), { quotaInfo: { remainingFraction: 0.8 } }],
      ["claude-final", { quotaInfo: { remainingFraction: 0.6 } }],
    ]));
    const result = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.quota.customWindows?.filter(window => window.modelId !== undefined)).toHaveLength(256);
    expect(result.quota.customWindows?.filter(window => window.modelId === undefined)).toEqual([
      { label: "Gem", percent: 20 }, { label: "Cla", percent: 40 },
    ]);
  });

  test("a missing model listing remains unavailable rather than producing zero-usage evidence", async () => {
    setModelsResponse(null);
    expect(await probeAntigravityUsageQuota("synthetic-token", "synthetic-project"))
      .toMatchObject({ kind: "unavailable", failure: "response_unusable" });
  });

  test("a summary 403 remains an account-probe failure and does not fall through to model discovery", async () => {
    let modelRequests = 0;
    setAntigravityAccountQuotaTransportForTests({
      resolveAddresses: async () => ({
        hostname: "daily-cloudcode-pa.googleapis.com",
        addresses: [{ address: "142.250.0.1", family: 4 }],
        privateNetwork: false,
      }),
      pinnedPost: async url => {
        if (url.endsWith("fetchAvailableModels")) modelRequests += 1;
        return new Response(null, { status: 403 });
      },
    });
    expect(await probeAntigravityUsageQuota("synthetic-token", "synthetic-project"))
      .toMatchObject({ kind: "unavailable", failure: "access_denied" });
    expect(modelRequests).toBe(0);
  });

  test.each([undefined, "gemini-3.8-flash-high"])("model-specific rows do not alter quota account ranking (%s)", requestedModel => {
    setCachedProviderAccountQuotaForTests("google-antigravity", "first", {
      updatedAt: Date.now(),
      customWindows: [
        { label: "Gem", percent: 20 },
        { label: "gemini-3.8-flash-high", modelId: "gemini-3.8-flash-high", percent: 100 },
      ],
    });
    setCachedProviderAccountQuotaForTests("google-antigravity", "second", {
      updatedAt: Date.now(),
      customWindows: [
        { label: "Gem", percent: 40 },
        { label: "gemini-3.8-flash-high", modelId: "gemini-3.8-flash-high", percent: 0 },
      ],
    });
    expect(rankAccountsByHeadroom("google-antigravity", ["first", "second"], requestedModel))
      .toEqual(["first", "second"]);
  });

  test("model quota cache rows expire at the existing account quota TTL", () => {
    setCachedProviderAccountQuotaForTests("google-antigravity", "first", {
      updatedAt: Date.now(),
      customWindows: [{ label: "gemini-3.8-flash-high", modelId: "gemini-3.8-flash-high", percent: 24 }],
    });
    expect(sweepExpiredProviderAccountQuotaRows(Date.now() + ACCOUNT_QUOTA_TTL_MS)).toBeGreaterThan(0);
    expect(getCachedProviderAccountQuota("google-antigravity", "first")).toBeNull();
    expect(sweepExpiredProviderAccountQuotaRows(Date.now() + ACCOUNT_QUOTA_TTL_MS)).toBe(0);
  });

  test("model-specific diagnostic rows never prove combo target exhaustion", () => {
    expect(cachedProviderQuotaIsExhausted({
      updatedAt: Date.now(),
      customWindows: [{ label: "gemini-3.8-flash-high", modelId: "gemini-3.8-flash-high", percent: 100 }],
    }, Date.now(), "gemini-3.8-flash-high")).toBe(false);
  });

  test("model-specific diagnostic rows are not observed as quota-reset windows", async () => {
    const resetTime = "2026-11-01T12:00:00Z";
    setModelsResponse(Object.fromEntries([
      ["gemini-3.8-flash-high", { quotaInfo: { remainingFraction: 0.5, resetTime } }],
      ...Array.from({ length: 300 }, (_, i) => [`gemini-aux-${i}`, { quotaInfo: { remainingFraction: 0.5, resetTime } }]),
    ]));
    const result = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.quota.customWindows?.filter(window => window.modelId !== undefined)).toHaveLength(256);
    // One pool reset must notify once for its family, not once per diagnostic model row.
    expect(providerWindowObservations(result.quota).map(observation => observation.window)).toEqual(["custom:Gem"]);
  });
});

describe("Antigravity Argon quota summary (#7272)", () => {
  const argonReset = "2026-10-24T04:34:17Z";
  const geminiGroup = {
    displayName: "Gemini Models",
    // A description that mentions Argon must not move the whole Gemini group.
    description: "Models within this group: Gemini Flash, Gemini Pro, Gemini 4 Argon",
    buckets: [
      { bucketId: "gemini-weekly", displayName: "Weekly Limit Remaining", window: "weekly", resetTime: "2026-10-25T00:00:00Z", remainingFraction: 0.88 },
      { bucketId: "gemini-5h", displayName: "Five Hour Limit Remaining", window: "5h", resetTime: "2026-10-18T05:00:00Z", remainingFraction: 0.75 },
    ],
  };
  const claudeGroup = {
    displayName: "Claude and GPT models",
    buckets: [{ bucketId: "3p-weekly", displayName: "Weekly Limit Remaining", window: "weekly", resetTime: "2026-10-26T00:00:00Z", remainingFraction: 0.95 }],
  };
  const argonGroup = {
    displayName: "Gemini 4 Argon",
    description: "For paid Pro plans, Argon quota is separate.",
    buckets: [{ bucketId: "gemini-argon-wtu-weekly", displayName: "Gemini 4 Argon Weekly Limit", window: "weekly", resetTime: argonReset, remainingFraction: 0.75 }],
  };

  let modelRequests = 0;
  function setSummaryResponse(groups: unknown[], models: unknown = {}): void {
    modelRequests = 0;
    setAntigravityAccountQuotaTransportForTests({
      resolveAddresses: async () => ({
        hostname: "daily-cloudcode-pa.googleapis.com",
        addresses: [{ address: "142.250.0.1", family: 4 }],
        privateNetwork: false,
      }),
      pinnedPost: async url => {
        if (url.endsWith("retrieveUserQuotaSummary")) {
          return new Response(JSON.stringify({ groups }), { status: 200, headers: { "content-type": "application/json" } });
        }
        modelRequests += 1;
        return new Response(JSON.stringify({ models }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
  }

  async function summaryWindows(groups: unknown[]) {
    setSummaryResponse(groups);
    const result = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(result).toMatchObject({ kind: "available", source: "google-antigravity:retrieveUserQuotaSummary" });
    return result.kind === "available" ? result.quota.customWindows ?? [] : [];
  }

  const label = (windows: Array<{ label: string; percent: number; modelId?: string }>) =>
    windows.map(window => `${window.label}=${window.percent}${window.modelId ? `@${window.modelId}` : ""}`);

  test.each([
    ["Gemini group first", [geminiGroup, claudeGroup, argonGroup]],
    ["Argon group first", [argonGroup, geminiGroup, claudeGroup]],
  ])("keeps Gem (Weekly) and a separate Argon window: %s", async (_name, groups) => {
    const windows = await summaryWindows(groups);
    expect(label(windows)).toEqual(["Gem=25", "Gem (Weekly)=12", "Cla (Weekly)=5", "Argon (Weekly)=25@gemini-4-argon"]);
    expect(windows.at(-1)).toEqual({ label: "Argon (Weekly)", modelId: "gemini-4-argon", percent: 25, resetAt: Date.parse(argonReset) });
    // The summary already carries Argon; no model-list request is needed.
    expect(modelRequests).toBe(0);
  });

  test("Argon buckets map 5h and weekly, skip other cadences and malformed readings, and stay first-seen", async () => {
    const windows = await summaryWindows([
      { displayName: "Gemini 4 Argon", buckets: [
        { bucketId: "gemini-argon-daily", window: "daily", remainingFraction: 0.1 },
        { bucketId: "gemini-argon-5h", window: "5h", remainingFraction: "unknown" },
        { bucketId: "gemini-argon-5h", window: "5h", remainingFraction: 0.6 },
        { bucketId: "gemini-argon-weekly", window: "weekly", remainingFraction: 0.9 },
      ] },
      { displayName: "Gemini 4 Argon", buckets: [{ bucketId: "gemini-argon-weekly", window: "weekly", remainingFraction: 0.1 }] },
    ]);
    expect(label(windows)).toEqual(["Argon=40@gemini-4-argon", "Argon (Weekly)=10@gemini-4-argon"]);
  });

  test("a bucket's own identity decides its family; the group decides only an inconclusive bucket", async () => {
    expect(label(await summaryWindows([
      { displayName: "Gemini Models", buckets: [
        { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.5 },
        { bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction: 0.2 },
      ] },
    ]))).toEqual(["Gem (Weekly)=50", "Argon (Weekly)=80@gemini-4-argon"]);

    expect(label(await summaryWindows([
      { displayName: "Gemini 4 Argon", buckets: [
        { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.5 },
        { bucketId: "claude-weekly", window: "weekly", remainingFraction: 0.4 },
        { bucketId: "weekly-1", window: "weekly", remainingFraction: 0.3 },
      ] },
      { displayName: "Claude and GPT models", buckets: [{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.9 }] },
    ]))).toEqual(["Gem=10", "Gem (Weekly)=50", "Cla (Weekly)=60", "Argon (Weekly)=70@gemini-4-argon"]);

    // Token boundaries: an unknown group with an "argonaut" bucket keeps its own label.
    expect(label(await summaryWindows([
      { displayName: "Experimental", buckets: [{ bucketId: "argonaut-weekly", window: "weekly", remainingFraction: 0.5 }] },
    ]))).toEqual(["Experimental (Weekly)=50"]);
  });

  test("model-list fallback never lets an Argon model seed the Gem family", async () => {
    setModelsResponse({
      "gemini-4-argon-high": { displayName: "Gemini 4 Argon High", quotaInfo: { remainingFraction: 0.2 } },
      "gemini-3.8-flash-high": { quotaInfo: { remainingFraction: 0.9 } },
    });
    const first = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(first.kind).toBe("available");
    if (first.kind !== "available") return;
    expect(first.quota.customWindows?.filter(window => window.modelId === undefined)).toEqual([{ label: "Gem", percent: 10 }]);
    expect(first.quota.customWindows).toContainEqual({ label: "gemini-4-argon-high", modelId: "gemini-4-argon-high", percent: 80 });

    // An Argon-only listing keeps its exact row (even one labelled like the pool) and invents no Gem evidence.
    setModelsResponse({ "gemini-4-argon": { quotaInfo: { remainingFraction: 0.2 } } });
    const only = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(only.kind).toBe("available");
    if (only.kind !== "available") return;
    expect(only.quota.customWindows).toEqual([{ label: "gemini-4-argon", modelId: "gemini-4-argon", percent: 80 }]);
  });

  test("an exhausted Argon pool changes no routing, exhaustion, notification or reset decision", async () => {
    const windows = await summaryWindows([
      geminiGroup,
      claudeGroup,
      { ...argonGroup, buckets: [{ ...argonGroup.buckets[0], resetTime: "2026-10-19T00:00:00Z", remainingFraction: 0 }] },
    ]);
    const quota = { updatedAt: Date.now(), customWindows: windows };
    const withoutArgon = { updatedAt: Date.now(), customWindows: windows.filter(window => window.modelId === undefined) };
    expect(windows.some(window => window.modelId === "gemini-4-argon" && window.percent === 100)).toBe(true);

    for (const model of [undefined, "gemini-4-argon-high", "gemini-3.8-flash-high", "claude-sonnet-4-6"]) {
      expect(cachedProviderQuotaIsExhausted(quota, Date.now(), model)).toBe(false);
      setCachedProviderAccountQuotaForTests("google-antigravity", "first", quota);
      setCachedProviderAccountQuotaForTests("google-antigravity", "second", withoutArgon);
      expect(accountHeadroomPercent("google-antigravity", "first", model))
        .toBe(accountHeadroomPercent("google-antigravity", "second", model));
      expect(accountResetTimestamp("google-antigravity", "first", model, Date.parse("2026-10-17T00:00:00Z")))
        .toBe(accountResetTimestamp("google-antigravity", "second", model, Date.parse("2026-10-17T00:00:00Z")));
    }
    expect(providerWindowObservations(quota).map(observation => observation.window))
      .toEqual(["custom:Gem", "custom:Gem (Weekly)", "custom:Cla (Weekly)"]);

    // Family-less reset time: with no Gem weekly window, an Argon weekly row must not stand in for it.
    setCachedProviderAccountQuotaForTests("google-antigravity", "first", {
      updatedAt: Date.now(),
      customWindows: [
        { label: "Gem", percent: 10, resetAt: Date.parse("2026-10-18T05:00:00Z") },
        { label: "Argon (Weekly)", modelId: "gemini-4-argon", percent: 10, resetAt: Date.parse("2026-10-19T00:00:00Z") },
      ],
    });
    expect(accountResetTimestamp("google-antigravity", "first", undefined, Date.parse("2026-10-17T00:00:00Z")))
      .toBe(Date.parse("2026-10-18T05:00:00Z"));
  });

  test("an Argon-only summary is an available display report that carries no routing evidence", async () => {
    const windows = await summaryWindows([argonGroup]);
    expect(label(windows)).toEqual(["Argon (Weekly)=25@gemini-4-argon"]);
    // A usable summary suppresses the model-list fallback, as for any other summary.
    expect(modelRequests).toBe(0);
    setCachedProviderAccountQuotaForTests("google-antigravity", "first", { updatedAt: Date.now(), customWindows: windows });
    for (const model of [undefined, "gemini-4-argon-high", "claude-sonnet-4-6"]) {
      expect(accountHeadroomPercent("google-antigravity", "first", model)).toBeNull();
      expect(accountResetTimestamp("google-antigravity", "first", model, Date.parse("2026-10-17T00:00:00Z"))).toBeNull();
    }
    expect(rankAccountsByResetFirst("google-antigravity", ["first", "second"])).toEqual(["first", "second"]);
    expect(rankAccountsByResetFirst("google-antigravity", ["second", "first"])).toEqual(["second", "first"]);
  });
});
