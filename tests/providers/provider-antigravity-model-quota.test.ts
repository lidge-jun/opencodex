import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PROXY_ENV_KEYS } from "../../src/lib/proxy-env";
import { rankAccountsByHeadroom } from "../../src/oauth/account-quota-rank";
import { cachedProviderQuotaIsExhausted } from "../../src/combos/resolve";
import { getCachedProviderAccountQuota, setCachedProviderAccountQuotaForTests } from "../../src/providers/quota";
import { sweepExpiredProviderAccountQuotaRows } from "../../src/providers/quota/account-cache";
import { ACCOUNT_QUOTA_TTL_MS } from "../../src/providers/quota-wire";
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

  test("model-specific rows do not alter family quota account ranking", () => {
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
    expect(rankAccountsByHeadroom("google-antigravity", ["first", "second"], "gemini-3.8-flash-high"))
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
});
