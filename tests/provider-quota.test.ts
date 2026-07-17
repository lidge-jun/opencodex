import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAccountQuota } from "../src/codex/quota";
import { saveCredential } from "../src/oauth/store";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../src/providers/quota";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;

let opencodexHome: string;
let codexHome: string;

function testConfig(): OcxConfig {
  return {
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        authMode: "forward",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
      xai: {
        adapter: "openai-chat",
        authMode: "oauth",
        baseUrl: "https://api.x.ai/v1",
      },
      anthropic: {
        adapter: "anthropic",
        authMode: "oauth",
        baseUrl: "https://api.anthropic.com/v1",
      },
      cursor: {
        adapter: "openai-chat",
        authMode: "oauth",
        baseUrl: "https://api2.cursor.sh",
      },
      "google-antigravity": {
        adapter: "google",
        authMode: "oauth",
        baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      },
      disabled_xai: {
        adapter: "openai-chat",
        authMode: "oauth",
        baseUrl: "https://api.x.ai/v1",
        disabled: true,
      },
    },
  } as OcxConfig;
}

beforeEach(() => {
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-quota-"));
  codexHome = mkdtempSync(join(tmpdir(), "codex-quota-"));
  process.env.OPENCODEX_HOME = opencodexHome;
  process.env.CODEX_HOME = codexHome;
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
    tokens: { access_token: "chatgpt-main-access", account_id: "chatgpt-main-account" },
  }));
  clearAccountQuota();
  clearProviderQuotaCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAccountQuota();
  clearProviderQuotaCache();
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  rmSync(opencodexHome, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
});

describe("fetchProviderQuotaReports", () => {
  test("returns active provider quota rows without leaking credentials or raw upstream payloads", async () => {
    await saveCredential("xai", { access: "xai-access-secret", refresh: "xai-refresh-secret", expires: Date.now() + 3600_000 });
    await saveCredential("anthropic", { access: "claude-access-secret", refresh: "claude-refresh-secret", expires: Date.now() + 3600_000 });
    await saveCredential("cursor", { access: "cursor-access-secret", refresh: "cursor-refresh-secret", expires: Date.now() + 3600_000 });
    await saveCredential("google-antigravity", { access: "agy-access-secret", refresh: "agy-refresh-secret", expires: Date.now() + 3600_000, projectId: "agy-project-secret" });

    const seen: { url: string; authorization?: string; body?: string }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({ url, authorization: headers?.Authorization, body: typeof init?.body === "string" ? init.body : undefined });
      if (url === "https://chatgpt.com/backend-api/wham/usage") {
        return new Response(JSON.stringify({
          email: "person@example.com",
          plan_type: "plus",
          rate_limit: {
            secondary_window: { used_percent: 34, reset_at: 1_789_000_000 },
            tertiary_window: { used_percent: 56, reset_at: 1_790_000_000 },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://cli-chat-proxy.grok.com/v1/billing") {
        return new Response(JSON.stringify({
          config: {
            monthlyLimit: { val: 10_000 },
            used: { val: 2_500 },
            billingPeriodEnd: "2026-07-31T00:00:00Z",
            raw_secret_should_not_escape: "xai-access-secret",
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://api.anthropic.com/api/oauth/usage") {
        return new Response(JSON.stringify({
          five_hour: { utilization: 41.5, resets_at: "2026-07-05T12:00:00Z" },
          seven_day: { utilization: 72, resets_at: "2026-07-11T12:00:00Z" },
          seven_day_opus: { utilization: 88 },
          seven_day_sonnet: { utilization: 19 },
          access_token: "claude-access-secret",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage") {
        return new Response(JSON.stringify({
          planUsage: {
            limit: 10000,
            remaining: 7000,
            includedSpend: 3000,
            autoPercentUsed: 12.5,
            apiPercentUsed: 58,
            totalPercentUsed: 30,
          },
          billingCycleEnd: "2026-08-01T00:00:00.000Z",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://api2.cursor.sh/api/usage/summary") {
        return new Response("{}", { status: 404 });
      }
      if (url === "https://api2.cursor.sh/auth/usage") {
        return new Response(JSON.stringify({
          "gpt-4": { numRequests: 150, maxRequestUsage: 500 },
          startOfMonth: "2026-07-01T00:00:00.000Z",
          access_token: "cursor-access-secret",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels") {
        return new Response(JSON.stringify({
          models: {
            "gemini-3.5-flash-low": {
              displayName: "Gemini 3.5 Flash Low",
              quotaInfo: { remainingFraction: 0.64, resetTime: "2026-07-05T14:00:00Z" },
            },
            "claude-sonnet-4.6": {
              displayName: "Claude Sonnet",
              quotaInfoByTier: {
                sonnet: { remainingFraction: 0.21, resetTime: "2026-07-05T15:00:00Z" },
              },
            },
            autocomplete: {
              displayName: "Autocomplete",
              quotaInfo: { remainingFraction: 0.01, resetTime: "2026-07-05T16:00:00Z" },
            },
          },
          rawProject: "agy-project-secret",
          rawToken: "agy-access-secret",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(testConfig(), true);
    const byProvider = Object.fromEntries(result.reports.map(report => [report.provider, report]));

    expect(Object.keys(byProvider).sort()).toEqual(["anthropic", "cursor", "google-antigravity", "openai", "xai"]);
    expect(byProvider.openai?.quota.weeklyPercent).toBe(34);
    expect(byProvider.xai?.quota.monthlyPercent).toBe(25);
    expect(byProvider.anthropic?.quota.weeklyPercent).toBe(72);
    expect(byProvider.anthropic?.quota.customWindows).toEqual([
      { label: "5h", percent: 41.5, resetAt: Date.parse("2026-07-05T12:00:00Z") },
      { label: "Opus", percent: 88 },
      { label: "Sonnet", percent: 19 },
    ]);
    expect(byProvider.cursor?.quota.customWindows).toEqual([
      { label: "First-party models", percent: 12.5, resetAt: Date.parse("2026-08-01T00:00:00.000Z") },
      { label: "API usage", percent: 58, resetAt: Date.parse("2026-08-01T00:00:00.000Z") },
    ]);
    expect(byProvider.cursor?.quota.monthlyPercent).toBeUndefined();
    expect(byProvider.cursor?.source).toBe("cursor:period-usage");
    expect(byProvider.cursor?.reverseEngineered).toBe(true);
    expect(byProvider["google-antigravity"]?.quota.customWindows).toEqual([
      { label: "Gem", percent: 36, resetAt: Date.parse("2026-07-05T14:00:00Z") },
      { label: "Cla", percent: 79, resetAt: Date.parse("2026-07-05T15:00:00Z") },
    ]);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("access-secret");
    expect(serialized).not.toContain("refresh-secret");
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("agy-project-secret");
    expect(seen.find(row => row.url.includes("grok.com"))?.authorization).toBe("Bearer xai-access-secret");
    expect(seen.find(row => row.url.includes("anthropic.com"))?.authorization).toBe("Bearer claude-access-secret");
    expect(seen.find(row => row.url.includes("GetCurrentPeriodUsage"))?.authorization).toBe("Bearer cursor-access-secret");
    expect(seen.find(row => row.url.includes("cloudcode-pa.googleapis.com"))?.authorization).toBe("Bearer agy-access-secret");
    expect(seen.find(row => row.url.includes("cloudcode-pa.googleapis.com"))?.body).toBe(JSON.stringify({ project: "agy-project-secret" }));
  });

  test("preserves prior Anthropic quota when a later refresh probe fails", async () => {
    await saveCredential("anthropic", { access: "claude-access-secret", refresh: "claude-refresh-secret", expires: Date.now() + 3600_000 });
    let anthropicCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.anthropic.com/api/oauth/usage") {
        anthropicCalls += 1;
        if (anthropicCalls === 1) {
          return new Response(JSON.stringify({
            five_hour: { utilization: 10 },
            seven_day: { utilization: 20 },
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("boom", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const cfg = {
      defaultProvider: "anthropic",
      providers: {
        anthropic: {
          adapter: "anthropic",
          authMode: "oauth",
          baseUrl: "https://api.anthropic.com/v1",
        },
      },
    } as OcxConfig;

    const first = await fetchProviderQuotaReports(cfg, true);
    expect(first.reports).toHaveLength(1);
    expect(first.reports[0]?.quota.weeklyPercent).toBe(20);

    const second = await fetchProviderQuotaReports(cfg, true);
    expect(second.reports).toHaveLength(1);
    expect(second.reports[0]?.quota.weeklyPercent).toBe(20);
    expect(anthropicCalls).toBe(2);
  });

  test("skips Anthropic quota when no refreshable credential is available", async () => {
    await saveCredential("anthropic", { access: "expired-claude-access", refresh: "expired-claude-refresh", expires: Date.now() - 1 });
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports({
      defaultProvider: "anthropic",
      providers: {
        anthropic: {
          adapter: "anthropic",
          authMode: "oauth",
          baseUrl: "https://api.anthropic.com/v1",
        },
      },
    } as OcxConfig, true);

    expect(result.reports).toEqual([]);
    // May attempt a refresh; must not call the usage endpoint with a dead token path that succeeds.
    expect(seen.every(url => !url.includes("/api/oauth/usage") || url.includes("anthropic.com"))).toBe(true);
  });
});
