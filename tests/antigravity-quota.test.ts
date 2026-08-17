import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../src/providers/quota";
import { saveCredential } from "../src/oauth/store";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
let opencodexHome: string;

const DAILY_HOST = "https://daily-cloudcode-pa.googleapis.com";
const TOKEN = "antigravity-access-token";
const PROJECT = "antigravity-project";

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

describe("Antigravity live quota", () => {
  test("merges live Gemini and weekly quota with catalog-only Claude windows", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
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
});
