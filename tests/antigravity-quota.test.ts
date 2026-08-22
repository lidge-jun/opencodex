import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchAntigravityLiveQuota } from "../src/providers/antigravity-quota";
import {
  clearProviderQuotaCache,
  fetchProviderQuotaReports,
  QUOTA_RESPONSE_MAX_BYTES,
} from "../src/providers/quota";
import { saveCredential } from "../src/oauth/store";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
let opencodexHome: string;

const DAILY_HOST = "https://daily-cloudcode-pa.googleapis.com";
const PROD_HOST = "https://cloudcode-pa.googleapis.com";
const TOKEN = "antigravity-access-token";
const PROJECT = "antigravity-project";

function liveGeminiQuota(): Response {
  return jsonResponse({
    buckets: [
      { modelId: "gemini-3.6-pro", remainingFraction: 0.4, resetTime: "2026-08-19T12:00:00Z" },
    ],
  });
}

function liveWeeklySummary(): Response {
  return jsonResponse({
    weekly: { remainingPercentage: 75, resetTime: "2026-08-25T00:00:00Z" },
  });
}

function config(baseUrl = DAILY_HOST): OcxConfig {
  return {
    defaultProvider: "google-antigravity",
    providers: {
      "google-antigravity": { adapter: "google", authMode: "oauth", baseUrl },
    },
  } as OcxConfig;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function catalogResponse(): Response {
  return jsonResponse({
    models: {
      "gemini-3.6-flash-medium": {
        displayName: "Gemini 3.6 Flash (Medium)",
        quotaInfo: { remainingFraction: 0.64, resetTime: "2026-08-20T14:00:00Z" },
      },
      "claude-sonnet-4.6": {
        displayName: "Claude Sonnet",
        quotaInfo: { remainingFraction: 0.21, resetTime: "2026-08-21T15:00:00Z" },
      },
    },
  });
}

function oversizedJsonResponse(value: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    ...value,
    padding: "x".repeat(QUOTA_RESPONSE_MAX_BYTES),
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-antigravity-quota-"));
  process.env.OPENCODEX_HOME = opencodexHome;
  await saveCredential("google-antigravity", {
    access: TOKEN,
    refresh: "antigravity-refresh-token",
    expires: Date.now() + 3_600_000,
    projectId: PROJECT,
  });
  clearProviderQuotaCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearProviderQuotaCache();
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  rmSync(opencodexHome, { recursive: true, force: true });
});

test("does not classify a daily bucket nested under a weekly ancestor as weekly", async () => {
  const result = await fetchAntigravityLiveQuota({
    accessToken: TOKEN,
    projectId: PROJECT,
    baseUrl: DAILY_HOST,
    timeoutMs: 1_000,
    fetchImpl: async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(":retrieveUserQuota")) {
        return jsonResponse({
          buckets: [
            { modelId: "gemini-test", remainingFraction: 0.5 },
          ],
        });
      }
      if (url.endsWith(":retrieveUserQuotaSummary")) {
        return jsonResponse({
          weekly: { daily: { remainingPercentage: 90 } },
        });
      }
      return jsonResponse({}, 404);
    },
  });

  expect(result?.weeklyPercent).toBeUndefined();
});

test("does not classify an unlabelled daily summary window as weekly", async () => {
  const requestOptions: Array<{ url: string; init?: RequestInit }> = [];
  const result = await fetchAntigravityLiveQuota({
    accessToken: "agy-access-secret",
    projectId: "agy-project-secret",
    baseUrl: DAILY_HOST,
    timeoutMs: 1_000,
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requestOptions.push({ url, init });
      if (url.endsWith(":retrieveUserQuota")) {
        return jsonResponse({
          buckets: [
            { modelId: "gemini-test", remainingFraction: 0.5 },
          ],
        });
      }
      if (url.endsWith(":retrieveUserQuotaSummary")) {
        return jsonResponse({
          daily: { remainingFraction: 0.75 },
        });
      }
      return jsonResponse({}, 404);
    },
  });

  expect(result?.customWindows?.[0]?.label).toBe("Gem");
  expect(result?.weeklyPercent).toBeUndefined();
  expect(
    requestOptions
      .filter(({ url }) => url.includes(":retrieveUserQuota"))
      .map(({ init }) => init?.redirect),
  ).toEqual(["error", "error"]);
});

test("keeps the daily quota when the summary RPC fails", async () => {
  const result = await fetchAntigravityLiveQuota({
    accessToken: "agy-access-secret",
    projectId: "agy-project-secret",
    baseUrl: DAILY_HOST,
    timeoutMs: 1_000,
    fetchImpl: async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(":retrieveUserQuota")) {
        return jsonResponse({
          buckets: [
            { modelId: "gemini-test", remainingFraction: 0.5 },
          ],
        });
      }
      if (url.endsWith(":retrieveUserQuotaSummary")) return jsonResponse({}, 503);
      return jsonResponse({}, 404);
    },
  });

  expect(result?.customWindows).toEqual([{ label: "Gem", percent: 50 }]);
  expect(result?.weeklyPercent).toBeUndefined();
});

test("treats a daily quota JSON read failure as an RPC failure", async () => {
  const result = await fetchAntigravityLiveQuota({
    accessToken: "agy-access-secret",
    projectId: "agy-project-secret",
    baseUrl: DAILY_HOST,
    timeoutMs: 1_000,
    fetchImpl: async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(":retrieveUserQuota")) {
        return oversizedJsonResponse({
          buckets: [
            { modelId: "gemini-3.6-pro", remainingFraction: 0.01 },
          ],
        });
      }
      if (url.endsWith(":retrieveUserQuotaSummary")) {
        return jsonResponse({
          weekly: { remainingPercentage: 75 },
        });
      }
      return jsonResponse({}, 404);
    },
  });

  expect(result).toBeNull();
});

test("does not parse gemini from ancestor JSON path keys", async () => {
  const result = await fetchAntigravityLiveQuota({
    accessToken: TOKEN,
    projectId: PROJECT,
    baseUrl: DAILY_HOST,
    timeoutMs: 1_000,
    fetchImpl: async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(":retrieveUserQuota")) {
        return jsonResponse({
          "gemini-quotas": {
            items: [{ remainingFraction: 0.5 }],
          },
        });
      }
      if (url.endsWith(":retrieveUserQuotaSummary")) return jsonResponse({}, 404);
      return jsonResponse({}, 404);
    },
  });

  expect(result?.customWindows).toBeUndefined();
});

describe("Antigravity live quota", () => {
  test("merges live Gemini and weekly quota with catalog-only Claude windows", async () => {
    const requestOptions: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requestOptions.push({ url, init });
      if (url.endsWith(":retrieveUserQuota")) {
        return jsonResponse({
          buckets: [
            { modelId: "gemini-3.6-pro", remainingFraction: 0.4, resetTime: "2026-08-19T12:00:00Z" },
          ],
        });
      }
      if (url.endsWith(":retrieveUserQuotaSummary")) {
        return jsonResponse({
          weekly: { remainingPercentage: 75, resetTime: "2026-08-25T00:00:00Z" },
        });
      }
      if (url.endsWith(":fetchAvailableModels")) return catalogResponse();
      return jsonResponse({}, 404);
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(config(), true);
    const report = result.reports[0];

    expect(report?.source).toBe("google-antigravity:retrieveUserQuota");
    expect(report?.quota.customWindows).toEqual([
      { label: "Gem", percent: 60, resetAt: Date.parse("2026-08-19T12:00:00Z") },
      { label: "Cla", percent: 79, resetAt: Date.parse("2026-08-21T15:00:00Z") },
    ]);
    expect(report?.quota.weeklyPercent).toBe(25);
    expect(report?.quota.weeklyResetAt).toBe(Date.parse("2026-08-25T00:00:00Z"));
    expect(requestOptions.every(({ init }) => init?.redirect === "error")).toBe(true);
  });

  test("retries the production host after daily retrieveUserQuota returns 404", async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.startsWith(DAILY_HOST) && url.includes(":retrieveUserQuota")) return jsonResponse({}, 404);
      if (url.endsWith(":retrieveUserQuota")) return liveGeminiQuota();
      if (url.endsWith(":retrieveUserQuotaSummary")) return liveWeeklySummary();
      if (url.endsWith(":fetchAvailableModels")) return catalogResponse();
      return jsonResponse({}, 404);
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(config(), true);

    expect(requested).toContain(`${DAILY_HOST}/v1internal:retrieveUserQuota`);
    expect(requested).toContain(`${PROD_HOST}/v1internal:retrieveUserQuota`);
    expect(result.reports[0]?.source).toBe("google-antigravity:retrieveUserQuota");
  });

  test("falls back to the catalog when both live RPCs return 404", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(":retrieveUserQuota")) return jsonResponse({}, 404);
      if (url.endsWith(":fetchAvailableModels")) return catalogResponse();
      return jsonResponse({}, 404);
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(config(), true);
    const report = result.reports[0];

    expect(report?.source).toBe("google-antigravity:fetchAvailableModels");
    expect(report?.quota.customWindows).toEqual([
      { label: "Gem", percent: 36, resetAt: Date.parse("2026-08-20T14:00:00Z") },
      { label: "Cla", percent: 79, resetAt: Date.parse("2026-08-21T15:00:00Z") },
    ]);
    expect(report?.quota.weeklyPercent).toBeUndefined();
  });

  test("falls back to the catalog when live RPC fetch throws", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(":retrieveUserQuota")) throw new Error("simulated timeout");
      if (url.endsWith(":fetchAvailableModels")) return catalogResponse();
      return jsonResponse({}, 404);
    }) as typeof fetch;

    await expect(fetchProviderQuotaReports(config(), true)).resolves.toMatchObject({
      reports: [{
        source: "google-antigravity:fetchAvailableModels",
        quota: { customWindows: expect.any(Array) },
      }],
    });
  });

  test("fails open to the catalog when live RPC bodies exceed the quota JSON limit", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(":retrieveUserQuota")) {
        return oversizedJsonResponse({
          buckets: [
            { modelId: "gemini-3.6-pro", remainingFraction: 0.01 },
          ],
        });
      }
      if (url.endsWith(":retrieveUserQuotaSummary")) {
        return oversizedJsonResponse({
          weekly: { remainingPercentage: 1 },
        });
      }
      if (url.endsWith(":fetchAvailableModels")) return catalogResponse();
      return jsonResponse({}, 404);
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(config(), true);
    const report = result.reports[0];

    expect(report?.source).toBe("google-antigravity:fetchAvailableModels");
    expect(report?.quota.customWindows).toEqual([
      { label: "Gem", percent: 36, resetAt: Date.parse("2026-08-20T14:00:00Z") },
      { label: "Cla", percent: 79, resetAt: Date.parse("2026-08-21T15:00:00Z") },
    ]);
    expect(report?.quota.weeklyPercent).toBeUndefined();
  });

  test("does not fetch production or catalog after daily retrieveUserQuota returns 401", async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === `${DAILY_HOST}/v1internal:retrieveUserQuota`) return jsonResponse({}, 401);
      if (url.endsWith(":retrieveUserQuota")) return liveGeminiQuota();
      if (url.endsWith(":retrieveUserQuotaSummary")) return liveWeeklySummary();
      if (url.endsWith(":fetchAvailableModels")) return jsonResponse({}, 404);
      return jsonResponse({}, 404);
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(config(), true);

    expect(requested).toContain(`${DAILY_HOST}/v1internal:retrieveUserQuota`);
    expect(requested.filter(url => url.startsWith(PROD_HOST))).toEqual([]);
    expect(requested.filter(url => url.endsWith(":fetchAvailableModels"))).toEqual([]);
    expect(result.reports).toEqual([]);
  });

  test("drops last-good Antigravity quota after a terminal 401 refresh", async () => {
    let rejected = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (rejected && url.includes(":retrieveUserQuota") && !url.includes("Summary")) {
        return jsonResponse({}, 401);
      }
      if (url.endsWith(":retrieveUserQuota") && !url.includes("Summary")) return liveGeminiQuota();
      if (url.endsWith(":retrieveUserQuotaSummary")) return liveWeeklySummary();
      if (url.endsWith(":fetchAvailableModels")) return catalogResponse();
      return jsonResponse({}, 404);
    }) as typeof fetch;

    const valid = await fetchProviderQuotaReports(config(), true);
    rejected = true;
    const rejectedRefresh = await fetchProviderQuotaReports(config(), true);

    expect(valid.reports).toHaveLength(1);
    expect(rejectedRefresh.reports).toEqual([]);
  });

  test("does not fetch production or catalog when daily retrieveUserQuota 401 races a 404 summary", async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === `${DAILY_HOST}/v1internal:retrieveUserQuota`) {
        await Bun.sleep(20);
        return jsonResponse({}, 401);
      }
      if (url === `${DAILY_HOST}/v1internal:retrieveUserQuotaSummary`) return jsonResponse({}, 404);
      if (url.endsWith(":retrieveUserQuota")) return liveGeminiQuota();
      if (url.endsWith(":retrieveUserQuotaSummary")) return liveWeeklySummary();
      if (url.endsWith(":fetchAvailableModels")) return jsonResponse({}, 404);
      return jsonResponse({}, 404);
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(config(), true);

    expect(requested).toContain(`${DAILY_HOST}/v1internal:retrieveUserQuota`);
    expect(requested.filter(url => url.startsWith(PROD_HOST))).toEqual([]);
    expect(requested.filter(url => url.endsWith(":fetchAvailableModels"))).toEqual([]);
    expect(result.reports).toEqual([]);
  });

  test("does not fetch production or catalog after daily retrieveUserQuota returns 429", async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === `${DAILY_HOST}/v1internal:retrieveUserQuota`) return jsonResponse({}, 429);
      if (url.endsWith(":retrieveUserQuota")) return liveGeminiQuota();
      if (url.endsWith(":retrieveUserQuotaSummary")) return liveWeeklySummary();
      if (url.endsWith(":fetchAvailableModels")) return jsonResponse({}, 503);
      return jsonResponse({}, 404);
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(config(), true);

    expect(requested).toContain(`${DAILY_HOST}/v1internal:retrieveUserQuota`);
    expect(requested.filter(url => url.startsWith(PROD_HOST))).toEqual([]);
    expect(requested.filter(url => url.endsWith(":fetchAvailableModels"))).toEqual([]);
    expect(result.reports).toEqual([]);
  });

  test("does not fetch production or catalog after daily retrieveUserQuota returns 403", async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === `${DAILY_HOST}/v1internal:retrieveUserQuota`) return jsonResponse({}, 403);
      if (url.endsWith(":retrieveUserQuota")) return liveGeminiQuota();
      if (url.endsWith(":retrieveUserQuotaSummary")) return liveWeeklySummary();
      if (url.endsWith(":fetchAvailableModels")) return catalogResponse();
      return jsonResponse({}, 404);
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(config(), true);

    expect(requested).toContain(`${DAILY_HOST}/v1internal:retrieveUserQuota`);
    expect(requested.filter(url => url.startsWith(PROD_HOST))).toEqual([]);
    expect(requested.filter(url => url.endsWith(":fetchAvailableModels"))).toEqual([]);
    expect(result.reports).toEqual([]);
  });

  test("does not fail over to daily or prod for a custom baseUrl on 404/503", async () => {
    const customHost = "https://custom-proxy.example.com";
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.startsWith(customHost) && url.includes(":retrieveUserQuota")) return jsonResponse({}, 404);
      if (url.startsWith(customHost) && url.includes(":retrieveUserQuotaSummary")) return jsonResponse({}, 503);
      if (url.endsWith(":fetchAvailableModels")) return catalogResponse();
      return jsonResponse({}, 404);
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(config(customHost), true);

    expect(requested.filter(url => url.startsWith(DAILY_HOST) || url.startsWith(PROD_HOST))).toEqual([]);
    expect(requested.filter(url => url.startsWith(customHost))).toEqual([
      `${customHost}/v1internal:retrieveUserQuota`,
      `${customHost}/v1internal:retrieveUserQuotaSummary`,
      `${customHost}/v1internal:fetchAvailableModels`,
    ]);
    expect(result.reports[0]?.source).toBe("google-antigravity:fetchAvailableModels");
  });

  test("rewrites known Google http host to HTTPS for live quota RPCs", async () => {
    const httpHost = "http://daily-cloudcode-pa.googleapis.com";
    const requested: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith(":retrieveUserQuota")) return liveGeminiQuota();
      if (url.endsWith(":retrieveUserQuotaSummary")) return liveWeeklySummary();
      return jsonResponse({}, 404);
    }) as typeof fetch;

    const quota = await fetchAntigravityLiveQuota({
      accessToken: TOKEN,
      projectId: PROJECT,
      baseUrl: httpHost,
      timeoutMs: 8_000,
      fetchImpl,
    });

    expect(requested.filter(url => url.startsWith("http://"))).toEqual([]);
    expect(requested).not.toContain(`${httpHost}/v1internal:retrieveUserQuota`);
    expect(requested).not.toContain(`${httpHost}/v1internal:retrieveUserQuotaSummary`);
    expect(requested).toContain(`${DAILY_HOST}/v1internal:retrieveUserQuota`);
    expect(requested).toContain(`${DAILY_HOST}/v1internal:retrieveUserQuotaSummary`);
    expect(quota).not.toBeNull();
    expect(quota?.customWindows?.[0]?.label).toBe("Gem");
  });

  test("returns null for a custom http host without POSTing live quota RPCs", async () => {
    const httpHost = "http://custom.proxy";
    const requested: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith(":retrieveUserQuota")) return liveGeminiQuota();
      if (url.endsWith(":retrieveUserQuotaSummary")) return liveWeeklySummary();
      return jsonResponse({}, 404);
    }) as typeof fetch;

    const quota = await fetchAntigravityLiveQuota({
      accessToken: TOKEN,
      projectId: PROJECT,
      baseUrl: httpHost,
      timeoutMs: 8_000,
      fetchImpl,
    });

    expect(requested.filter(url => url.startsWith("http://"))).toEqual([]);
    expect(requested).toEqual([]);
    expect(quota).toBeNull();
  });

  test("does not POST fetchAvailableModels to an http host", async () => {
    const httpHost = "http://daily-cloudcode-pa.googleapis.com";
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith(":retrieveUserQuota")) return liveGeminiQuota();
      if (url.endsWith(":retrieveUserQuotaSummary")) return liveWeeklySummary();
      if (url.endsWith(":fetchAvailableModels")) return catalogResponse();
      return jsonResponse({}, 404);
    }) as typeof fetch;

    await fetchProviderQuotaReports(config(httpHost), true);

    expect(requested.filter(url => url.startsWith("http://"))).toEqual([]);
    expect(requested).not.toContain(`${httpHost}/v1internal:fetchAvailableModels`);
  });
});
