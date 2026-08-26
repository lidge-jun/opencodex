import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as authApi from "../src/codex/auth-api";
import { clearAccountNeedsReauth, markAccountNeedsReauth } from "../src/codex/account-runtime-state";
import { clearMainAccountInfoCache } from "../src/codex/main-account-cache";
import { clearAccountQuota, updateAccountQuota } from "../src/codex/quota";
import { clearCodexUpstreamHealth } from "../src/codex/routing";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { saveCredential } from "../src/oauth/store";
import {
  clearProviderQuotaCache,
  fetchProviderQuotaReports,
  parseXaiCreditsResponse,
  QUOTA_RESPONSE_MAX_BYTES,
  readProviderQuotaJsonForTests,
  setProviderQuotaBeforePublishForTests,
} from "../src/providers/quota";
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
        codexAccountMode: "pool",
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
        adapter: "cursor",
        authMode: "oauth",
        baseUrl: "https://api2.cursor.sh",
      },
      "google-antigravity": {
        adapter: "google",
        authMode: "oauth",
        baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      },
      kimi: {
        adapter: "openai-chat",
        authMode: "oauth",
        baseUrl: "https://api.kimi.com/coding/v1",
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
  clearCodexUpstreamHealth();
  clearProviderQuotaCache();
  setProviderQuotaBeforePublishForTests(null);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAccountQuota();
  clearProviderQuotaCache();
  setProviderQuotaBeforePublishForTests(null);
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  rmSync(opencodexHome, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
});

describe("fetchProviderQuotaReports", () => {
  test("provider quota probes have no direct Response.json calls", () => {
    const source = readFileSync(join(import.meta.dir, "../src/providers/quota.ts"), "utf8");
    expect(source).not.toMatch(/\.\s*json\s*\(/);
  });

  test("quota JSON reading cancels a body that stalls before its first byte", async () => {
    let cancelCalls = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelCalls += 1; },
    }));

    expect(await readProviderQuotaJsonForTests(response, 10)).toBeNull();
    expect(cancelCalls).toBe(1);
  });

  test("returns active provider quota rows without leaking credentials or raw upstream payloads", async () => {
    await saveCredential("xai", { access: "xai-access-secret", refresh: "xai-refresh-secret", expires: Date.now() + 3600_000 });
    await saveCredential("anthropic", { access: "claude-access-secret", refresh: "claude-refresh-secret", expires: Date.now() + 3600_000 });
    await saveCredential("cursor", { access: "cursor-access-secret", refresh: "cursor-refresh-secret", expires: Date.now() + 3600_000 });
    await saveCredential("google-antigravity", { access: "agy-access-secret", refresh: "agy-refresh-secret", expires: Date.now() + 3600_000, projectId: "agy-project-secret" });
    await saveCredential("kimi", { access: "kimi-access-secret", refresh: "kimi-refresh-secret", expires: Date.now() + 3600_000 });

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
      if (url === "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels") {
        return new Response(JSON.stringify({
          models: {
            "gemini-3.6-flash-medium": {
              displayName: "Gemini 3.6 Flash (Medium)",
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
      if (url === "https://api.kimi.com/coding/v1/usages") {
        return new Response(JSON.stringify({
          user: { userId: "kimi-user-secret", businessId: "kimi-business-secret" },
          usage: { limit: "100", used: "15", remaining: "85", resetTime: "2026-07-24T12:20:50.442060Z" },
          limits: [{
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "100", remaining: "100", resetTime: "2026-07-18T03:20:50.442060Z" },
          }],
          totalQuota: { limit: "100", remaining: "99" },
          subType: "TYPE_PURCHASE",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(testConfig(), true);
    const byProvider = Object.fromEntries(result.reports.map(report => [report.provider, report]));

    expect(Object.keys(byProvider).sort()).toEqual(["anthropic", "cursor", "google-antigravity", "kimi", "openai", "xai"]);
    expect(byProvider.openai?.quota.weeklyPercent).toBe(34);
    expect(byProvider.xai?.quota.monthlyPercent).toBe(25);
    expect(byProvider.anthropic?.quota.weeklyPercent).toBe(72);
    // Claude's 5-hour window is reported in the canonical fields (like the Codex login rows),
    // so only the model-specific windows remain as custom entries.
    expect(byProvider.anthropic?.quota.fiveHourPercent).toBe(41.5);
    expect(byProvider.anthropic?.quota.fiveHourResetAt).toBe(Date.parse("2026-07-05T12:00:00Z"));
    expect(byProvider.anthropic?.quota.customWindows).toEqual([
      { label: "Opus", percent: 88 },
      { label: "Sonnet", percent: 19 },
    ]);
    expect(byProvider["google-antigravity"]?.quota.customWindows).toEqual([
      { label: "Gem", percent: 36, resetAt: Date.parse("2026-07-05T14:00:00Z") },
      { label: "Cla", percent: 79, resetAt: Date.parse("2026-07-05T15:00:00Z") },
    ]);
    expect(byProvider.cursor?.source).toBe("cursor:period-usage");
    expect(byProvider.cursor?.reverseEngineered).toBe(true);
    expect(byProvider.cursor?.quota.monthlyPercent).toBe(30);
    expect(byProvider.cursor?.quota.monthlyResetAt).toBe(Date.parse("2026-08-01T00:00:00.000Z"));
    expect(byProvider.cursor?.quota.customWindows).toEqual([
      { label: "First-party models", percent: 12.5, resetAt: Date.parse("2026-08-01T00:00:00.000Z") },
      { label: "API usage", percent: 58, resetAt: Date.parse("2026-08-01T00:00:00.000Z") },
    ]);
    expect(byProvider.kimi?.source).toBe("kimi:usages");
    expect(byProvider.kimi?.quota).toEqual({
      fiveHourPercent: 0,
      fiveHourResetAt: Date.parse("2026-07-18T03:20:50.442060Z"),
      weeklyPercent: 15,
      weeklyResetAt: Date.parse("2026-07-24T12:20:50.442060Z"),
      customWindows: [{ label: "Total subscription credits", percent: 1 }],
      updatedAt: expect.any(Number),
    });
    expect(byProvider.kimi?.quota.monthlyPercent).toBeUndefined();

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("access-secret");
    expect(serialized).not.toContain("refresh-secret");
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("agy-project-secret");
    expect(serialized).not.toContain("kimi-user-secret");
    expect(serialized).not.toContain("kimi-business-secret");
    expect(serialized).not.toContain("TYPE_PURCHASE");
    expect(seen.find(row => row.url.includes("grok.com"))?.authorization).toBe("Bearer xai-access-secret");
    expect(seen.find(row => row.url.includes("anthropic.com"))?.authorization).toBe("Bearer claude-access-secret");
    expect(seen.find(row => row.url.includes("cloudcode-pa.googleapis.com"))?.authorization).toBe("Bearer agy-access-secret");
    expect(seen.find(row => row.url.includes("cloudcode-pa.googleapis.com"))?.body).toBe(JSON.stringify({ project: "agy-project-secret" }));
    expect(seen.find(row => row.url === "https://api.kimi.com/coding/v1/usages")?.authorization).toBe("Bearer kimi-access-secret");
  });

  function kimiOnlyConfig(baseUrl = "https://api.kimi.com/coding/v1"): OcxConfig {
    return {
      defaultProvider: "kimi",
      providers: { kimi: { adapter: "openai-chat", authMode: "oauth", baseUrl } },
    } as OcxConfig;
  }

  function a6apiOnlyConfig(baseUrl = "https://api.a6api.com/v1"): OcxConfig {
    return {
      defaultProvider: "a6api",
      providers: {
        a6api: { adapter: "openai-chat", authMode: "key", baseUrl, apiKey: "a6api-secret" },
      },
    } as OcxConfig;
  }

  test("A6API quota converts provider units to USD and exposes a displayable credit window", async () => {
    const seen: Array<{ url: string; authorization?: string; redirect?: RequestRedirect }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({ url, authorization: headers?.Authorization, redirect: init?.redirect });
      if (url.endsWith("/dashboard/billing/subscription")) {
        return new Response(JSON.stringify({ data: { hard_limit_usd: "20" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: {
        total_granted: "20000000",
        total_used: "5000000",
        total_available: "15000000",
        expires_at: "2026-08-01T00:00:00Z",
      } }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(a6apiOnlyConfig(), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.source).toBe("a6api:billing");
    expect(result.reports[0]?.quota.customWindows).toEqual([{
      label: "API credits ($15.00 of $20.00 remaining)",
      percent: 25,
    }]);
    expect(result.reports[0]?.quota.creditsUsd).toEqual({
      used: 5,
      limit: 20,
      remaining: 15,
      percent: 25,
      expiresAt: Date.parse("2026-08-01T00:00:00Z"),
    });
    expect(seen.map(row => row.url).sort()).toEqual([
      "https://api.a6api.com/api/usage/token/",
      "https://api.a6api.com/dashboard/billing/subscription",
    ]);
    expect(seen.every(row => row.authorization === "Bearer a6api-secret")).toBe(true);
    expect(seen.every(row => row.redirect === "error")).toBe(true);
  });

  test("A6API unlimited keys remain visible even when all finite credit totals are zero", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes("subscription")
        ? { data: { hard_limit_usd: 100_000_000 } }
        : { data: {
          total_granted: 0,
          total_used: 0,
          total_available: 0,
          unlimited_quota: true,
          expires_at: "2027-01-01T00:00:00Z",
        } },
    ), { status: 200 })) as typeof fetch;

    const result = await fetchProviderQuotaReports(a6apiOnlyConfig(), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.quota.creditsUsd).toEqual({
      used: 0,
      limit: 0,
      remaining: 0,
      percent: 0,
      unlimited: true,
      expiresAt: Date.parse("2027-01-01T00:00:00Z"),
    });
    expect(result.reports[0]?.quota.customWindows).toEqual([{
      label: "Unlimited API credits",
      percent: 0,
    }]);
  });

  test("A6API quota never sends API keys to a non-canonical base URL", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(a6apiOnlyConfig("https://attacker.example/v1"), true);

    expect(result.reports).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("A6API quota drops incomplete or zero-limit billing payloads", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      return new Response(JSON.stringify(url.includes("subscription")
        ? { data: { hard_limit_usd: 0 } }
        : { data: { total_granted: 100, total_used: 20, total_available: 80 } }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(a6apiOnlyConfig(), true);

    expect(result.reports).toEqual([]);
  });

  test.each([
    { total_used: -1, total_available: 101 },
    { total_used: 1, total_available: -1 },
    { total_used: 80, total_available: 80 },
    { total_used: 20, total_available: 70 },
  ])("A6API quota drops malformed usage totals", async usage => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      return new Response(JSON.stringify(url.includes("subscription")
        ? { data: { hard_limit_usd: 10 } }
        : { data: { total_granted: 100, ...usage } }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(a6apiOnlyConfig(), true);

    expect(result.reports).toEqual([]);
  });

  test("A6API quota applies reconciliation tolerance relative to sub-unit grants", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes("subscription")
        ? { data: { hard_limit_usd: 10 } }
        : { data: { total_granted: 0.1, total_used: 0.05, total_available: 0.0500000005 } },
    ), { status: 200 })) as typeof fetch;

    const result = await fetchProviderQuotaReports(a6apiOnlyConfig(), true);

    expect(result.reports).toEqual([]);
  });

  test("A6API quota accepts equivalent canonical HTTPS URLs only", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify(String(input).includes("subscription")
        ? { data: { hard_limit_usd: 10 } }
        : { data: { total_granted: 100, total_used: 25, total_available: 75 } }), { status: 200 });
    }) as typeof fetch;

    const canonicalUrls = [
      "https://api.a6api.com",
      "https://api.a6api.com/v1",
      "https://API.A6API.COM:443/v1/",
    ];
    for (const baseUrl of canonicalUrls) {
      const result = await fetchProviderQuotaReports(a6apiOnlyConfig(baseUrl), true);
      expect(result.reports).toHaveLength(1);
    }
    const credentialedUrl = "https://user" + "@api.a6api.com/v1";
    const credentialed = await fetchProviderQuotaReports(a6apiOnlyConfig(credentialedUrl), true);

    expect(credentialed.reports).toEqual([]);
    expect(seen).toHaveLength(canonicalUrls.length * 2);
  });

  test("malformed API-key fields do not break unrelated quota reports", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes("subscription")
        ? { data: { hard_limit_usd: 10 } }
        : { data: { total_granted: 100, total_used: 25, total_available: 75 } },
    ), { status: 200 })) as typeof fetch;
    const config = a6apiOnlyConfig();
    config.providers.broken = {
      adapter: "openai-chat",
      authMode: "key",
      baseUrl: "https://example.com/v1",
      apiKey: 42,
    } as unknown as OcxConfig["providers"][string];

    const result = await fetchProviderQuotaReports(config, true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.provider).toBe("a6api");
  });

  test("A6API quota is detected by canonical base URL for custom provider names", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes("subscription")
        ? { data: { hard_limit_usd: 10 } }
        : { data: { total_granted: 100, total_used: 25, total_available: 75 } },
    ), { status: 200 })) as typeof fetch;
    const config = a6apiOnlyConfig();
    config.defaultProvider = "my-a6";
    config.providers = { "my-a6": config.providers.a6api! };

    const result = await fetchProviderQuotaReports(config, true);

    expect(result.reports[0]?.provider).toBe("my-a6");
    expect(result.reports[0]?.quota.customWindows?.[0]?.percent).toBe(25);
  });

  test("A6API quota cache follows the active API key", async () => {
    const authorizations: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      authorizations.push(headers?.Authorization ?? "");
      const secondAccount = headers?.Authorization === "Bearer second-account-key";
      return new Response(JSON.stringify(String(input).includes("subscription")
        ? { data: { hard_limit_usd: secondAccount ? 30 : 10 } }
        : { data: { total_granted: 100, total_used: 20, total_available: 80 } }), { status: 200 });
    }) as typeof fetch;
    const config = a6apiOnlyConfig();

    const first = await fetchProviderQuotaReports(config);
    config.providers.a6api!.apiKey = "second-account-key";
    const second = await fetchProviderQuotaReports(config);

    expect(first.reports[0]?.quota.customWindows?.[0]?.label).toContain("of $10.00 remaining");
    expect(second.reports[0]?.quota.customWindows?.[0]?.label).toContain("of $30.00 remaining");
    expect(authorizations).toContain("Bearer second-account-key");
  });

  test("A6API quota drops a last-good row after a terminal-invalid refresh", async () => {
    let malformed = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes("subscription")
        ? { data: { hard_limit_usd: 10 } }
        : { data: malformed
          ? { total_granted: 100, total_used: 20, total_available: 70 }
          : { total_granted: 100, total_used: 20, total_available: 80 } },
    ), { status: 200 })) as typeof fetch;
    const config = a6apiOnlyConfig();

    const valid = await fetchProviderQuotaReports(config, true);
    malformed = true;
    const invalid = await fetchProviderQuotaReports(config, true);

    expect(valid.reports).toHaveLength(1);
    expect(invalid.reports).toEqual([]);
  });

  test("A6API quota preserves a last-good row after a transient server failure", async () => {
    let unavailable = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (unavailable) return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify(String(input).includes("subscription")
        ? { data: { hard_limit_usd: 10 } }
        : { data: { total_granted: 100, total_used: 20, total_available: 80 } }), { status: 200 });
    }) as typeof fetch;
    const config = a6apiOnlyConfig();

    const valid = await fetchProviderQuotaReports(config, true);
    unavailable = true;
    const transientFailure = await fetchProviderQuotaReports(config, true);

    expect(transientFailure.reports).toEqual(valid.reports);
  });

  test("A6API quota preserves a last-good row after an oversized successful response", async () => {
    let oversized = false;
    let cancelCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const subscription = String(input).includes("subscription");
      if (oversized && subscription) {
        return declaredOversizeQuotaResponse(() => { cancelCalls += 1; });
      }
      return Response.json(subscription
        ? { data: { hard_limit_usd: 10 } }
        : { data: { total_granted: 10_000_000, total_used: 2_000_000, total_available: 8_000_000 } });
    }) as typeof fetch;

    const valid = await fetchProviderQuotaReports(a6apiOnlyConfig(), true);
    oversized = true;
    const preserved = await fetchProviderQuotaReports(a6apiOnlyConfig(), true);

    expect(preserved.reports).toEqual(valid.reports);
    expect(cancelCalls).toBe(1);
  });

  test("A6API quota treats a throttled 429 refresh as transient and keeps the last-good row", async () => {
    let throttled = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (throttled) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify(String(input).includes("subscription")
        ? { data: { hard_limit_usd: 10 } }
        : { data: { total_granted: 100, total_used: 20, total_available: 80 } }), { status: 200 });
    }) as typeof fetch;
    const config = a6apiOnlyConfig();

    const valid = await fetchProviderQuotaReports(config, true);
    throttled = true;
    const throttledRefresh = await fetchProviderQuotaReports(config, true);

    expect(throttledRefresh.reports).toEqual(valid.reports);
  });

  test("A6API quota treats a timed-out 408 refresh as transient and keeps the last-good row", async () => {
    let timedOut = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (timedOut) return new Response("request timeout", { status: 408 });
      return new Response(JSON.stringify(String(input).includes("subscription")
        ? { data: { hard_limit_usd: 10 } }
        : { data: { total_granted: 100, total_used: 20, total_available: 80 } }), { status: 200 });
    }) as typeof fetch;
    const config = a6apiOnlyConfig();

    const valid = await fetchProviderQuotaReports(config, true);
    const validUpdatedAt = valid.reports[0]?.quota.updatedAt;
    timedOut = true;
    const timedOutRefresh = await fetchProviderQuotaReports(config, true);

    expect(timedOutRefresh.reports).toEqual(valid.reports);
    expect(timedOutRefresh.reports[0]?.quota.updatedAt).toBe(validUpdatedAt);
  });

  test("A6API quota drops the last-good row after a credential 401 refresh", async () => {
    let rejected = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (rejected) return new Response("unauthorized", { status: 401 });
      return new Response(JSON.stringify(String(input).includes("subscription")
        ? { data: { hard_limit_usd: 10 } }
        : { data: { total_granted: 100, total_used: 20, total_available: 80 } }), { status: 200 });
    }) as typeof fetch;
    const config = a6apiOnlyConfig();

    const valid = await fetchProviderQuotaReports(config, true);
    rejected = true;
    const rejectedRefresh = await fetchProviderQuotaReports(config, true);

    expect(valid.reports).toHaveLength(1);
    expect(rejectedRefresh.reports).toEqual([]);
  });

  function keyQuotaConfig(name: string, baseUrl: string, apiKey = `${name}-secret`): OcxConfig {
    return {
      defaultProvider: name,
      providers: {
        [name]: { adapter: "openai-chat", authMode: "key", baseUrl, apiKey },
      },
    } as OcxConfig;
  }

  test("OpenRouter quota renders a credit window against the per-key cap", async () => {
    const seen: Array<{ url: string; authorization?: string; redirect?: RequestRedirect }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({ url, authorization: headers?.Authorization, redirect: init?.redirect });
      return new Response(JSON.stringify({
        data: { label: "openrouter", usage: 5, limit: 20, limit_remaining: 15, is_free_tier: false },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("openrouter", "https://openrouter.ai/api/v1"), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.source).toBe("openrouter:key-info");
    expect(result.reports[0]?.quota.customWindows).toEqual([{
      label: "API credits ($15.00 of $20.00 remaining)",
      percent: 25,
    }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://openrouter.ai/api/v1/key");
    expect(seen[0]?.authorization).toBe("Bearer openrouter-secret");
    expect(seen[0]?.redirect).toBe("error");
  });

  test("OpenRouter quota never sends the key to a non-canonical base URL", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      keyQuotaConfig("openrouter", "https://attacker.example/api/v1"),
      true,
    );

    expect(result.reports).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("OpenRouter quota drops a key with no spending cap (terminal, not transient)", async () => {
    // A successful no-cap response is a DELIBERATE cap removal — the old
    // capped row must be suppressed, not preserved as a last-good transient.
    let capped = true;
    globalThis.fetch = (async () => new Response(JSON.stringify(
      capped
        ? { data: { usage: 5, limit: 20, limit_remaining: 15 } }
        : { data: { usage: 3, is_free_tier: false } },
    ), { status: 200 })) as typeof fetch;
    const config = keyQuotaConfig("openrouter", "https://openrouter.ai/api/v1");

    const valid = await fetchProviderQuotaReports(config, true);
    capped = false;
    const uncapped = await fetchProviderQuotaReports(config, true);

    expect(valid.reports).toHaveLength(1);
    expect(uncapped.reports).toEqual([]);
  });

  test("OpenRouter quota prefers limit_remaining over accumulated usage for reset keys", async () => {
    // A reset key can report large accumulated `usage` while most of the
    // current cap remains; utilization must come from limit_remaining.
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: { usage: 90, limit: 20, limit_remaining: 18 },
    }), { status: 200 })) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("openrouter", "https://openrouter.ai/api/v1"), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.quota.customWindows?.[0]).toEqual({
      label: "API credits ($18.00 of $20.00 remaining)",
      percent: 10,
    });
  });

  test("OpenRouter quota reports zero consumption for a capped key with usage 0", async () => {
    // A valid capped response with `usage: 0` and no limit_remaining must
    // still render: 0% consumed, full cap remaining.
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: { usage: 0, limit: 20 },
    }), { status: 200 })) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("openrouter", "https://openrouter.ai/api/v1"), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.quota.customWindows?.[0]).toEqual({
      label: "API credits ($20.00 of $20.00 remaining)",
      percent: 0,
    });
  });

  test("OpenRouter quota treats a terminal 401 as invalid (drops last-good)", async () => {
    let rejected = false;
    globalThis.fetch = (async () => {
      if (rejected) return new Response("unauthorized", { status: 401 });
      return new Response(JSON.stringify({
        data: { usage: 5, limit: 20, limit_remaining: 15 },
      }), { status: 200 });
    }) as typeof fetch;
    const config = keyQuotaConfig("openrouter", "https://openrouter.ai/api/v1");

    const valid = await fetchProviderQuotaReports(config, true);
    rejected = true;
    const invalid = await fetchProviderQuotaReports(config, true);

    expect(valid.reports).toHaveLength(1);
    expect(invalid.reports).toEqual([]);
  });

  test("OpenRouter quota keeps the last-good row on a transient 429", async () => {
    let throttled = false;
    globalThis.fetch = (async () => {
      if (throttled) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({
        data: { usage: 5, limit: 20, limit_remaining: 15 },
      }), { status: 200 });
    }) as typeof fetch;
    const config = keyQuotaConfig("openrouter", "https://openrouter.ai/api/v1");

    const valid = await fetchProviderQuotaReports(config, true);
    throttled = true;
    const throttledRefresh = await fetchProviderQuotaReports(config, true);

    expect(throttledRefresh.reports).toEqual(valid.reports);
  });

  test("DeepSeek quota renders a balance-only window from balance_infos", async () => {
    const seen: Array<{ url: string; authorization?: string; redirect?: RequestRedirect }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({ url, authorization: headers?.Authorization, redirect: init?.redirect });
      return new Response(JSON.stringify({
        is_available: true,
        // The real payload nests balances per currency inside balance_infos.
        balance_infos: [{ currency: "CNY", total_balance: "6", granted_balance: "4", topped_up_balance: "2" }],
      }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("deepseek", "https://api.deepseek.com"), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.source).toBe("deepseek:balance");
    expect(result.reports[0]?.quota.customWindows).toEqual([{
      label: "API balance ($6.00 total, $4.00 granted)",
      percent: 0,
    }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.deepseek.com/user/balance");
    expect(seen[0]?.authorization).toBe("Bearer deepseek-secret");
    expect(seen[0]?.redirect).toBe("error");
  });

  test("DeepSeek quota never sends the key to a non-canonical base URL", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      keyQuotaConfig("deepseek", "https://attacker.example"),
      true,
    );

    expect(result.reports).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("DeepSeek quota accepts the canonical /v1 base URL and probes the root endpoint", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: "CNY", total_balance: "6" }],
      }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("deepseek", "https://api.deepseek.com/v1"), true);

    expect(result.reports).toHaveLength(1);
    expect(seen[0]).toBe("https://api.deepseek.com/user/balance");
  });

  test("DeepSeek quota drops a payload with no balance_infos rows", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      is_available: true,
      total_balance: "50",
      granted_balance: "0",
    }), { status: 200 })) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("deepseek", "https://api.deepseek.com"), true);

    expect(result.reports).toEqual([]);
  });

  test("DeepSeek quota treats a terminal 401 as invalid (drops last-good)", async () => {
    let rejected = false;
    globalThis.fetch = (async () => {
      if (rejected) return new Response("unauthorized", { status: 401 });
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: "CNY", total_balance: "6", granted_balance: "4" }],
      }), { status: 200 });
    }) as typeof fetch;
    const config = keyQuotaConfig("deepseek", "https://api.deepseek.com");

    const valid = await fetchProviderQuotaReports(config, true);
    rejected = true;
    const invalid = await fetchProviderQuotaReports(config, true);

    expect(valid.reports).toHaveLength(1);
    expect(invalid.reports).toEqual([]);
  });

  test("ClinePass quota maps five-hour/weekly/monthly utilization windows", async () => {
    const seen: Array<{ url: string; authorization?: string; redirect?: RequestRedirect }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({ url, authorization: headers?.Authorization, redirect: init?.redirect });
      return new Response(JSON.stringify({
        success: true,
        data: { limits: [
          { type: "five_hour", percentUsed: 40.5 },
          { type: "weekly", percentUsed: 52, resetsAt: "2026-08-09T00:00:00Z" },
          { type: "monthly", percentUsed: 12.3 },
        ] },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("cline-pass", "https://api.cline.bot/api/v1"), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.source).toBe("cline:plan-usage-limits");
    expect(result.reports[0]?.quota).toMatchObject({
      fiveHourPercent: 40.5,
      weeklyPercent: 52,
      monthlyPercent: 12.3,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.cline.bot/api/v1/users/me/plan/usage-limits");
    expect(seen[0]?.authorization).toBe("Bearer cline-pass-secret");
    expect(seen[0]?.redirect).toBe("error");
  });

  test("ClinePass quota treats a 404 (no active plan) as a no-report, not terminal", async () => {
    globalThis.fetch = (async () => new Response("no plan", { status: 404 })) as typeof fetch;
    const config = keyQuotaConfig("cline-pass", "https://api.cline.bot/api/v1");

    const result = await fetchProviderQuotaReports(config, true);

    expect(result.reports).toEqual([]);
  });

  test("ClinePass quota never sends the key to a non-canonical base URL", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      keyQuotaConfig("cline-pass", "https://attacker.example/api/v1"),
      true,
    );

    expect(result.reports).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("Z.AI quota sends the key as a Bearer token and maps plan windows", async () => {
    const seen: Array<{ url: string; authorization?: string; redirect?: RequestRedirect }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({ url, authorization: headers?.Authorization, redirect: init?.redirect });
      return new Response(JSON.stringify({
        success: true,
        data: {
          limits: [
            { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 40.5, currentValue: 405, usage: 1000, nextResetTime: 1789000000000 },
            { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 52, nextResetTime: 1789600000000 },
            { type: "TIME_LIMIT", percentage: 12.3, nextResetTime: 1789000000000 },
          ],
        },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("zai", "https://api.z.ai"), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.source).toBe("zai:quota-limit");
    expect(result.reports[0]?.quota).toMatchObject({
      fiveHourPercent: 40.5,
      fiveHourResetAt: 1789000000000,
      weeklyPercent: 52,
      weeklyResetAt: 1789600000000,
      monthlyPercent: 12.3,
      monthlyResetAt: 1789000000000,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
    expect(seen[0]?.authorization).toBe("Bearer zai-secret");
    expect(seen[0]?.redirect).toBe("error");
  });

  test("Z.AI quota probes the BigModel region from the provider's own host", async () => {
    const seen: Array<{ url: string; authorization?: string; redirect?: RequestRedirect }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({ url, authorization: headers?.Authorization, redirect: init?.redirect });
      // Weekly row omits `percentage`: the fallback derives it from currentValue/usage.
      return new Response(JSON.stringify({
        success: true,
        data: {
          limits: [
            { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 20, currentValue: 200, usage: 1000, nextResetTime: 1789000000000 },
            { type: "TOKENS_LIMIT", unit: 6, number: 1, currentValue: 156, usage: 300, nextResetTime: 1789600000000 },
            { type: "TIME_LIMIT", percentage: 7.5, nextResetTime: 1789000000000 },
          ],
        },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      keyQuotaConfig("zhipu-bigmodel-coding", "https://open.bigmodel.cn/api/coding/paas/v4", "zai-secret"),
      true,
    );

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.source).toBe("zai:quota-limit");
    expect(result.reports[0]?.quota).toMatchObject({
      fiveHourPercent: 20,
      weeklyPercent: 52,
      monthlyPercent: 7.5,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
    expect(seen[0]?.authorization).toBe("Bearer zai-secret");
    expect(seen[0]?.redirect).toBe("error");
  });

  test("Z.AI quota falls back to legacy field-name payloads", async () => {
    const seen: Array<{ url: string; authorization?: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({ url, authorization: headers?.Authorization });
      return new Response(JSON.stringify({
        success: true,
        data: { fiveHourPercent: 40.5, weeklyPercent: 52, monthlyMCPUsage: 12.3 },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("zai", "https://api.z.ai/api/coding/paas/v4"), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.source).toBe("zai:quota-limit");
    expect(result.reports[0]?.quota).toMatchObject({
      fiveHourPercent: 40.5,
      weeklyPercent: 52,
      monthlyPercent: 12.3,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
  });

  test("Z.AI quota probes the BigModel Responses endpoint at /api/v1", async () => {
    const seen: Array<{ url: string; authorization?: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({ url, authorization: headers?.Authorization });
      return new Response(JSON.stringify({
        success: true,
        data: {
          limits: [
            { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 30, currentValue: 300, usage: 1000, nextResetTime: 1789000000000 },
            { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 60, nextResetTime: 1789600000000 },
            { type: "TIME_LIMIT", percentage: 9.5, nextResetTime: 1789000000000 },
          ],
        },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      keyQuotaConfig("zhipu-bigmodel-coding", "https://open.bigmodel.cn/api/v1", "zai-secret"),
      true,
    );

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.source).toBe("zai:quota-limit");
    expect(result.reports[0]?.quota).toMatchObject({
      fiveHourPercent: 30,
      weeklyPercent: 60,
      monthlyPercent: 9.5,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
    expect(seen[0]?.authorization).toBe("Bearer zai-secret");
  });

  test("Z.AI quota treats an unsuccessful payload as a no-report", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 1001, success: false, msg: "Authentication parameter not received",
    }), { status: 200 })) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("zai", "https://api.z.ai/api/coding/paas/v4"), true);

    expect(result.reports).toEqual([]);
  });

  test("Z.AI quota never sends the token to a non-canonical base URL", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      keyQuotaConfig("zai", "https://attacker.example/api/coding/paas/v4"),
      true,
    );

    expect(result.reports).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("Z.AI quota never probes the BigModel pay-as-you-go endpoint", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      keyQuotaConfig("zhipu-bigmodel-coding", "https://open.bigmodel.cn/api/paas/v4"),
      true,
    );

    expect(result.reports).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("Z.AI quota ignores token rows whose window length does not match", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      success: true,
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 2, percentage: 40, nextResetTime: 1789000000000 },
          { type: "TOKENS_LIMIT", unit: 6, number: 2, percentage: 52, nextResetTime: 1789600000000 },
          { type: "TIME_LIMIT", percentage: 12.3, nextResetTime: 1789000000000 },
        ],
      },
    }), { status: 200 })) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("zai", "https://api.z.ai/api/coding/paas/v4"), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.quota).toMatchObject({ monthlyPercent: 12.3 });
    expect(result.reports[0]?.quota.fiveHourPercent).toBeUndefined();
    expect(result.reports[0]?.quota.weeklyPercent).toBeUndefined();
  });

  test("Z.AI quota does not fall back to legacy fields when limits is present but empty", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      success: true,
      data: { limits: [], fiveHourPercent: 40.5, weeklyPercent: 52, monthlyMCPUsage: 12.3 },
    }), { status: 200 })) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("zai", "https://api.z.ai/api/coding/paas/v4"), true);

    expect(result.reports).toEqual([]);
  });

  test("Z.AI quota renders a real v2 coding-plan response (monthly MCP TIME_LIMIT)", async () => {
    // Sanitized live response captured from the /api/monitor/usage/quota/limit probe
    // (level=max, v2 protocol): the TIME_LIMIT row is the 30-day MCP tool budget
    // (search-prime / web-reader / zread), independent of the token windows.
    const v2Response = {
      limits: [
        { type: "TIME_LIMIT", unit: 5, number: 1, usage: 4000, currentValue: 0, remaining: 4000, percentage: 0, nextResetTime: 1788073095998,
          usageDetails: [{ modelCode: "search-prime", usage: 0 }, { modelCode: "web-reader", usage: 0 }, { modelCode: "zread", usage: 0 }] },
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 100, nextResetTime: 1787056863927 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 20, nextResetTime: 1787641095989 },
      ],
      level: "max",
    };
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: true, data: v2Response }), { status: 200 })) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("zai", "https://api.z.ai/api/coding/paas/v4"), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.quota).toMatchObject({
      fiveHourPercent: 100,
      fiveHourResetAt: 1787056863927,
      weeklyPercent: 20,
      weeklyResetAt: 1787641095989,
      monthlyPercent: 0,
      monthlyResetAt: 1788073095998,
    });
  });

  test("Z.AI quota renders a real new-protocol response without the monthly MCP row", async () => {
    // Sanitized live response (level=pro, newer protocol): CREDIT_LIMIT rows only,
    // no TIME_LIMIT row — the monthly MCP bar must not render.
    const newProtocolResponse = {
      limits: [
        { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 12000, currentValue: 0, remaining: 12000, percentage: 0 },
        { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 60000, currentValue: 0, remaining: 60000, percentage: 0, nextResetTime: 1787649214999 },
      ],
      level: "pro",
    };
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: true, data: newProtocolResponse }), { status: 200 })) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("zai", "https://api.z.ai/api/coding/paas/v4"), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.quota).toMatchObject({
      fiveHourPercent: 0,
      weeklyPercent: 0,
    });
    expect(result.reports[0]?.quota.monthlyPercent).toBeUndefined();
  });

  test("MiniMax quota drops the row when the API omits the plan total after having it", async () => {
    // A valid row (with total) exists; a later valid response omitting the
    // total is a DELIBERATE contract change — the stale row must be dropped
    // (terminal), not preserved as a transient last-good.
    let withTotal = true;
    const seen: Array<{ url: string; authorization?: string; redirect?: RequestRedirect }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({ url, authorization: headers?.Authorization, redirect: init?.redirect });
      return new Response(JSON.stringify(withTotal
        ? { success: true, data: { remains_time: 750_000_000, total_time: 1_000_000_000 } }
        : { success: true, data: { remains_time: 1_000_000_000 } }), { status: 200 });
    }) as typeof fetch;
    const config = keyQuotaConfig("minimax", "https://api.minimax.io/v1");

    const valid = await fetchProviderQuotaReports(config, true);
    withTotal = false;
    const noTotal = await fetchProviderQuotaReports(config, true);

    expect(valid.reports).toHaveLength(1);
    expect(noTotal.reports).toEqual([]);
    expect(seen[0]?.url).toBe("https://www.minimax.io/v1/token_plan/remains");
    expect(seen[0]?.authorization).toBe("Bearer minimax-secret");
    expect(seen[0]?.redirect).toBe("error");
  });

  test("MiniMax quota derives a consumed share when the API reports the plan total", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      success: true,
      data: { remains_time: 750_000_000, total_time: 1_000_000_000 },
    }), { status: 200 })) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("minimax", "https://api.minimax.io/v1"), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.quota.customWindows?.[0]?.percent).toBe(25);
  });

  test("MiniMax CN quota probes the minimaxi.com host", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({
        success: true,
        data: { remains_time: 750_000_000, total_time: 1_000_000_000 },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("minimax-cn", "https://api.minimaxi.com/v1"), true);

    expect(result.reports).toHaveLength(1);
    expect(seen[0]).toBe("https://api.minimaxi.com/v1/token_plan/remains");
  });

  test("MiniMax quota never sends the key to a non-canonical base URL", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      keyQuotaConfig("minimax", "https://attacker.example/v1"),
      true,
    );

    expect(result.reports).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("Moonshot quota renders a balance-only window from the account balance", async () => {
    const seen: Array<{ url: string; authorization?: string; redirect?: RequestRedirect }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({ url, authorization: headers?.Authorization, redirect: init?.redirect });
      return new Response(JSON.stringify({
        data: { available_balance: 8, voucher_balance: 2, cash_balance: 6 },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("moonshot", "https://api.moonshot.ai/v1"), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.source).toBe("moonshot:balance");
    // Balance-only: no fabricated utilization percentage.
    expect(result.reports[0]?.quota.customWindows?.[0]).toMatchObject({
      label: "Balance ($8.00 USD available, $2.00 voucher)",
      percent: 0,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.moonshot.ai/v1/users/me/balance");
    expect(seen[0]?.authorization).toBe("Bearer moonshot-secret");
    expect(seen[0]?.redirect).toBe("error");
  });

  test("Moonshot quota probes the CN host for a China-region base URL", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({
        data: { available_balance: 5, voucher_balance: 0, cash_balance: 5 },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("moonshot", "https://api.moonshot.cn/v1"), true);

    expect(result.reports).toHaveLength(1);
    expect(seen[0]).toBe("https://api.moonshot.cn/v1/users/me/balance");
    // China platform balance is CNY, not USD — do not mislabel ¥ amounts with $.
    expect(result.reports[0]?.quota.customWindows?.[0]).toMatchObject({
      label: "Balance (¥5.00 CNY available, ¥0.00 voucher)",
      percent: 0,
    });
  });

  test("Moonshot quota never sends the key to a non-canonical base URL", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      keyQuotaConfig("moonshot", "https://attacker.example/v1"),
      true,
    );

    expect(result.reports).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("Venice quota renders a DIEM epoch allocation window when present", async () => {
    const seen: Array<{ url: string; authorization?: string; redirect?: RequestRedirect }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({ url, authorization: headers?.Authorization, redirect: init?.redirect });
      return new Response(JSON.stringify({
        data: { balance: 250, diem_epoch_used: 30, diem_epoch_allocated: 100 },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("venice", "https://api.venice.ai/api/v1"), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.source).toBe("venice:billing-balance");
    expect(result.reports[0]?.quota.customWindows?.[0]?.label).toContain("DIEM balance (250)");
    expect(result.reports[0]?.quota.customWindows?.[0]?.percent).toBe(30);
    expect(seen[0]?.url).toBe("https://api.venice.ai/api/v1/billing/balance");
    expect(seen[0]?.authorization).toBe("Bearer venice-secret");
  });

  test("Synthetic quota maps rolling 5-hour and weekly token lanes", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: { rollingFiveHourLimit: 40.5, weeklyTokenLimit: 52, search: { hourly: 12 } },
    }), { status: 200 })) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("synthetic", "https://api.synthetic.new/v2"), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.source).toBe("synthetic:quotas");
    expect(result.reports[0]?.quota).toMatchObject({
      fiveHourPercent: 40.5,
      weeklyPercent: 52,
    });
    expect(result.reports[0]?.quota.customWindows?.[0]).toMatchObject({ label: "Search hourly", percent: 12 });
  });

  test("Synthetic quota accepts the preset /openai/v1 base URL", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({
        data: { rollingFiveHourLimit: 10, weeklyTokenLimit: 20 },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("synthetic", "https://api.synthetic.new/openai/v1"), true);

    expect(result.reports).toHaveLength(1);
    expect(seen[0]).toBe("https://api.synthetic.new/v2/quotas");
  });

  test("Synthetic quota never sends the key to a non-canonical base URL", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      keyQuotaConfig("synthetic", "https://attacker.example/v2"),
      true,
    );

    expect(result.reports).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("DeepInfra quota renders a billing-cycle spend window when a limit is set", async () => {
    const seen: Array<{ url: string; authorization?: string; redirect?: RequestRedirect }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({ url, authorization: headers?.Authorization, redirect: init?.redirect });
      return new Response(JSON.stringify({
        stripe_balance: -10, spending_limit: 50, total_amount_due: 5,
      }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("deepinfra", "https://api.deepinfra.com/v1/openai"), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.source).toBe("deepinfra:billing-checklist");
    expect(result.reports[0]?.quota.customWindows?.[0]?.label).toContain("$5.00 of $50.00");
    expect(seen[0]?.url).toContain("/payment/checklist");
    expect(seen[0]?.authorization).toBe("Bearer deepinfra-secret");
  });

  test("DeepInfra quota never sends the key to a non-canonical base URL", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      keyQuotaConfig("deepinfra", "https://attacker.example/v1/openai"),
      true,
    );

    expect(result.reports).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("DeepInfra quota accepts the root base URL and probes the payment checklist", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ stripe_balance: -10, spending_limit: 50, total_amount_due: 5 }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("deepinfra", "https://api.deepinfra.com"), true);

    expect(result.reports).toHaveLength(1);
    expect(seen[0]).toBe("https://api.deepinfra.com/payment/checklist?compute_owed=true");
  });

  test("Neuralwatt quota renders subscription kWh + prepaid credits windows", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: {
        subscription: { kwh_used: 5, kwh_included: 20, current_period_end: "2026-08-31T00:00:00Z" },
        balance: { total_credits_usd: 10, credits_remaining_usd: 7 },
      },
    }), { status: 200 })) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("neuralwatt", "https://api.neuralwatt.com/v1"), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.source).toBe("neuralwatt:quota");
    expect(result.reports[0]?.quota.fiveHourPercent).toBe(25);
    // Utilization is CONSUMED credits: (10 − 7) / 10 = 30%, not the 70% remaining.
    expect(result.reports[0]?.quota.customWindows?.[0]).toMatchObject({ label: "Prepaid credits", percent: 30 });
  });

  test("Neuralwatt quota never sends the key to a non-canonical base URL", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      keyQuotaConfig("neuralwatt", "https://attacker.example/v1"),
      true,
    );

    expect(result.reports).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("Kimi quota never sends OAuth credentials to a non-canonical base URL", async () => {
    await saveCredential("kimi", { access: "kimi-access-secret", refresh: "kimi-refresh-secret", expires: Date.now() + 3600_000 });
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(kimiOnlyConfig("https://attacker.example/coding/v1"), true);

    expect(result.reports).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("Kimi quota refreshes an expired OAuth token before calling usages", async () => {
    await saveCredential("kimi", { access: "expired-kimi-access", refresh: "kimi-refresh-secret", expires: Date.now() - 1 });
    const seen: Array<{ url: string; authorization?: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({ url, authorization: headers?.Authorization });
      if (url === "https://auth.kimi.com/api/oauth/token") {
        return new Response(JSON.stringify({
          access_token: "fresh-kimi-access",
          refresh_token: "fresh-kimi-refresh",
          expires_in: 3600,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://api.kimi.com/coding/v1/usages") {
        return new Response(JSON.stringify({ usage: { limit: "100", remaining: "75" } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(kimiOnlyConfig(), true);

    expect(result.reports[0]?.quota.weeklyPercent).toBe(25);
    expect(seen.find(row => row.url.endsWith("/coding/v1/usages"))?.authorization).toBe("Bearer fresh-kimi-access");
  });

  test("Kimi quota skips usages when OAuth refresh fails", async () => {
    await saveCredential("kimi", { access: "expired-kimi-access", refresh: "kimi-refresh-secret", expires: Date.now() - 1 });
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("refresh rejected", { status: 500 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(kimiOnlyConfig(), true);

    expect(result.reports).toEqual([]);
    expect(seen).toContain("https://auth.kimi.com/api/oauth/token");
    expect(seen).not.toContain("https://api.kimi.com/coding/v1/usages");
  });

  test("Kimi quota ignores malformed and zero-limit payloads", async () => {
    await saveCredential("kimi", { access: "kimi-access-secret", refresh: "kimi-refresh-secret", expires: Date.now() + 3600_000 });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      usage: { limit: "0", used: "1" },
      limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "nope", remaining: "1" } }],
      totalQuota: { remaining: "99" },
    }), { status: 200 })) as typeof fetch;

    const result = await fetchProviderQuotaReports(kimiOnlyConfig(), true);

    expect(result.reports).toEqual([]);
  });

  test("Kimi quota recognizes a 5h label when window metadata is absent", async () => {
    await saveCredential("kimi", { access: "kimi-access-secret", refresh: "kimi-refresh-secret", expires: Date.now() + 3600_000 });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      limits: [{ name: "5h quota", detail: { limit: "200", used: "50", resetAt: "2026-07-18T08:00:00Z" } }],
    }), { status: 200 })) as typeof fetch;

    const result = await fetchProviderQuotaReports(kimiOnlyConfig(), true);

    expect(result.reports[0]?.quota.fiveHourPercent).toBe(25);
    expect(result.reports[0]?.quota.fiveHourResetAt).toBe(Date.parse("2026-07-18T08:00:00Z"));
  });

  test("Kimi quota unwraps a data envelope and maps weekly from limits when usage is absent", async () => {
    await saveCredential("kimi", { access: "kimi-access-secret", refresh: "kimi-refresh-secret", expires: Date.now() + 3600_000 });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: {
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "100", remaining: "80", resetTime: "2026-07-18T08:00:00Z" },
          },
          {
            name: "Weekly limit",
            window: { duration: 7, timeUnit: "TIME_UNIT_DAY" },
            detail: { limit: "200", used: "50", resetTime: "2026-07-24T12:00:00Z" },
          },
        ],
        totalQuota: { limit: "100", remaining: "90" },
      },
    }), { status: 200 })) as typeof fetch;

    const result = await fetchProviderQuotaReports(kimiOnlyConfig(), true);

    expect(result.reports[0]?.source).toBe("kimi:usages");
    expect(result.reports[0]?.quota.fiveHourPercent).toBe(20);
    expect(result.reports[0]?.quota.weeklyPercent).toBe(25);
    expect(result.reports[0]?.quota.weeklyResetAt).toBe(Date.parse("2026-07-24T12:00:00Z"));
    expect(result.reports[0]?.quota.customWindows).toEqual([{ label: "Total subscription credits", percent: 10 }]);
  });

  test("Kimi Code API-key providers on the canonical host receive usages probes", async () => {
    const seen: Array<{ url: string; authorization?: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({ url: String(input), authorization: headers?.Authorization });
      return new Response(JSON.stringify({ usage: { limit: "100", used: "40" } }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports({
      defaultProvider: "kimi-code",
      providers: {
        "kimi-code": {
          adapter: "openai-chat",
          authMode: "key",
          baseUrl: "https://api.kimi.com/coding/v1",
          apiKey: "sk-kimi-quota-secret",
        },
      },
    } as OcxConfig, true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.provider).toBe("kimi-code");
    expect(result.reports[0]?.source).toBe("kimi:usages");
    expect(result.reports[0]?.quota.weeklyPercent).toBe(40);
    expect(seen).toEqual([{
      url: "https://api.kimi.com/coding/v1/usages",
      authorization: "Bearer sk-kimi-quota-secret",
    }]);
  });

  test("Kimi key providers never send credentials to a non-canonical base URL", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports({
      defaultProvider: "kimi-code",
      providers: {
        "kimi-code": {
          adapter: "openai-chat",
          authMode: "key",
          baseUrl: "https://attacker.example/coding/v1",
          apiKey: "sk-kimi-quota-secret",
        },
      },
    } as OcxConfig, true);

    expect(result.reports).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("an unresolved active env key never falls back to the pool (wrong-account meter)", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ usage: { limit: "100", used: "40" } }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports({
      defaultProvider: "kimi-code",
      providers: {
        "kimi-code": {
          adapter: "openai-chat",
          authMode: "key",
          baseUrl: "https://api.kimi.com/coding/v1",
          apiKey: "${OCX_TEST_MISSING_KIMI_KEY}",
          apiKeyPool: [{ key: "sk-pool-other-account" }],
        },
      },
    } as OcxConfig, true);

    // No probe at all: attributing the pool key's quota to the active slot would lie.
    expect(result.reports).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("forward/local auth modes on the canonical Kimi host are not probed", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ usage: { limit: "100", used: "40" } }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports({
      defaultProvider: "kimi-fwd",
      providers: {
        "kimi-fwd": {
          adapter: "openai-chat",
          authMode: "forward",
          baseUrl: "https://api.kimi.com/coding/v1",
        },
      },
    } as OcxConfig, true);

    expect(result.reports).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("a null outer usage placeholder still unwraps the data envelope", async () => {
    await saveCredential("kimi", { access: "kimi-access-secret", refresh: "kimi-refresh-secret", expires: Date.now() + 3600_000 });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      usage: null, // placeholder — must not mask the nested payload
      data: { usage: { limit: "200", used: "50" } },
    }), { status: 200 })) as typeof fetch;

    const result = await fetchProviderQuotaReports(kimiOnlyConfig(), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.quota.weeklyPercent).toBe(25);
  });

  test("Kimi quota preserves a last-good row after 401 only within the shared age bound", async () => {
    await saveCredential("kimi", { access: "kimi-access-secret", refresh: "kimi-refresh-secret", expires: Date.now() + 3600_000 });
    let authorized = true;
    globalThis.fetch = (async () => authorized
      ? new Response(JSON.stringify({ usage: { limit: "100", used: "35" } }), { status: 200 })
      : new Response("unauthorized", { status: 401 })) as typeof fetch;

    const good = await fetchProviderQuotaReports(kimiOnlyConfig(), true);
    expect(good.reports[0]?.quota.weeklyPercent).toBe(35);
    const originalUpdatedAt = good.reports[0]!.updatedAt;

    authorized = false;
    const preserved = await fetchProviderQuotaReports(kimiOnlyConfig(), true);
    expect(preserved.reports[0]?.quota.weeklyPercent).toBe(35);
    expect(preserved.reports[0]?.updatedAt).toBe(originalUpdatedAt);

    preserved.reports[0]!.updatedAt = Date.now() - 31 * 60_000;
    preserved.reports[0]!.quota.updatedAt = Date.now() - 31 * 60_000;
    const expired = await fetchProviderQuotaReports(kimiOnlyConfig(), true);
    expect(expired.reports).toEqual([]);
  });

  test("pool mode reports a weighted estimate while preserving the effective account raw quota", async () => {
    saveCodexAccountCredential("added", {
      accessToken: "added-access",
      refreshToken: "added-refresh",
      expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "added-chatgpt-id",
    });
    const config = testConfig();
    config.codexAccounts = [{ id: "added", email: "a@example.test", plan: "prolite", isMain: false }];
    config.activeCodexAccountId = "added";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const percent = headers?.["ChatGPT-Account-Id"] === "added-chatgpt-id" ? 77 : 11;
      return new Response(JSON.stringify({
        plan_type: headers?.["ChatGPT-Account-Id"] === "added-chatgpt-id" ? "prolite" : "plus",
        rate_limit: { secondary_window: { used_percent: percent, reset_at: 1_789_000_000 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(config, true);
    const openai = result.reports.find(row => row.provider === "openai");
    expect(openai?.quota.weeklyPercent).toBe(66);
    expect(openai?.aggregation).toMatchObject({
      includedAccounts: 2,
      excludedAccounts: 0,
      incomplete: false,
      currentAccount: { plan: "prolite", quota: { weeklyPercent: 77 } },
    });
    expect(JSON.stringify(openai?.aggregation)).not.toMatch(/(?:total|consumed|remaining)Weight|projectedUsedPercent/i);
  });

  test("pool reports tolerate a malformed persisted plan through cache and aggregation", async () => {
    saveCodexAccountCredential("added", {
      accessToken: "added-access",
      refreshToken: "added-refresh",
      expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "added-chatgpt-id",
    });
    const config = testConfig();
    config.providers = { openai: config.providers.openai };
    config.codexAccounts = [{
      id: "added",
      email: "a@example.test",
      plan: { tier: "pro" } as never,
      isMain: false,
    }];
    config.activeCodexAccountId = "added";
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const added = (init?.headers as Record<string, string> | undefined)?.["ChatGPT-Account-Id"] === "added-chatgpt-id";
      return new Response(JSON.stringify({
        plan_type: added ? { tier: "pro" } : "plus",
        rate_limit: { secondary_window: { used_percent: added ? 77 : 11, reset_at: 1_999_000_000 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const refreshed = await fetchProviderQuotaReports(config, true);
    const openai = refreshed.reports.find(row => row.provider === "openai");
    expect(openai?.quota.weeklyPercent).toBe(11);
    expect(openai?.aggregation).toMatchObject({
      includedAccounts: 1,
      excludedAccounts: 1,
      unknownPlanAccounts: 1,
      incomplete: true,
      currentAccount: { quota: { weeklyPercent: 77 } },
    });
    expect(openai?.aggregation?.currentAccount).not.toHaveProperty("plan");
    expect(calls).toBe(2);

    const cached = await fetchProviderQuotaReports(config);
    expect(cached.reports[0]?.aggregation?.unknownPlanAccounts).toBe(1);
    expect(calls).toBe(2);
  });

  test("one forced Pool refresh probes each account once", async () => {
    saveCodexAccountCredential("added", {
      accessToken: "added-access", refreshToken: "added-refresh",
      expiresAt: Date.now() + 3600_000, chatgptAccountId: "added-chatgpt-id",
    });
    const config = testConfig();
    config.providers = { openai: config.providers.openai };
    config.codexAccounts = [{ id: "added", email: "a@example.test", plan: "prolite", isMain: false }];
    const calls = new Map<string, number>();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const accountId = (init?.headers as Record<string, string> | undefined)?.["ChatGPT-Account-Id"] ?? "main";
      calls.set(accountId, (calls.get(accountId) ?? 0) + 1);
      return new Response(JSON.stringify({
        plan_type: accountId === "added-chatgpt-id" ? "prolite" : "plus",
        rate_limit: { secondary_window: { used_percent: 25, reset_at: 1_999_000_000 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await fetchProviderQuotaReports(config, true);

    expect(calls).toEqual(new Map([["chatgpt-main-account", 1], ["added-chatgpt-id", 1]]));
  });

  test("one non-forced Pool refresh shares its probe snapshot before the commit recheck", async () => {
    saveCodexAccountCredential("added", {
      accessToken: "added-access", refreshToken: "added-refresh",
      expiresAt: Date.now() + 3600_000, chatgptAccountId: "added-chatgpt-id",
    });
    const config = testConfig();
    config.providers = { openai: config.providers.openai };
    config.codexAccounts = [{ id: "added", email: "a@example.test", plan: "prolite", isMain: false }];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const accountId = (init?.headers as Record<string, string> | undefined)?.["ChatGPT-Account-Id"];
      return new Response(JSON.stringify({
        plan_type: accountId === "added-chatgpt-id" ? "prolite" : "plus",
        rate_limit: { secondary_window: { used_percent: 25, reset_at: 1_999_000_000 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const snapshotSpy = spyOn(authApi, "listCodexAuthAccountsSnapshot");
    try {
      await fetchProviderQuotaReports(config);

      // The cache-key and provider phases share call 1; call 2 is the intentional
      // post-probe commit-key recheck. Before the fix there were 3 calls.
      expect(snapshotSpy).toHaveBeenCalledTimes(2);
      expect(snapshotSpy.mock.calls.map(call => call[1] ?? false)).toEqual([false, false]);
    } finally {
      snapshotSpy.mockRestore();
    }
  });

  test("all-excluded pool still returns a coverage-only OpenAI report", async () => {
    rmSync(join(codexHome, "auth.json"), { force: true });
    clearMainAccountInfoCache();
    const config = testConfig();
    config.providers = { openai: config.providers.openai };
    config.codexAccounts = [{ id: "missing", email: "missing@example.test", plan: "plus", isMain: false }];

    const result = await fetchProviderQuotaReports(config);
    const openai = result.reports.find(row => row.provider === "openai");
    expect(openai).toBeDefined();
    expect(openai?.quota).toEqual({ updatedAt: openai?.updatedAt });
    expect(openai?.aggregation).toMatchObject({
      presentation: "coverage-only",
      includedAccounts: 0,
      excludedAccounts: 2,
      reauthAccounts: 2,
      incomplete: true,
    });
  });

  test("stale effective-account quota becomes coverage-only and is never restamped as numeric fallback", async () => {
    saveCodexAccountCredential("added", {
      accessToken: "added-access", refreshToken: "added-refresh",
      expiresAt: Date.now() + 3600_000, chatgptAccountId: "added-chatgpt-id",
    });
    const config = testConfig();
    config.providers = { openai: config.providers.openai };
    config.codexAccounts = [{ id: "added", email: "a@example.test", plan: "prolite", isMain: false }];
    config.activeCodexAccountId = "added";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const added = (init?.headers as Record<string, string> | undefined)?.["ChatGPT-Account-Id"] === "added-chatgpt-id";
      return new Response(JSON.stringify({
        plan_type: added ? "prolite" : "plus",
        rate_limit: { secondary_window: { used_percent: added ? 77 : 11, reset_at: 1_999_000_000 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    await fetchProviderQuotaReports(config, true);
    clearProviderQuotaCache();

    const realDateNow = Date.now;
    const future = realDateNow() + 31 * 60_000;
    try {
      Date.now = () => future;
      globalThis.fetch = (async () => new Response("unavailable", { status: 500 })) as typeof fetch;
      const expired = await fetchProviderQuotaReports(config);
      const openai = expired.reports.find(row => row.provider === "openai");
      expect(openai?.aggregation).toMatchObject({
        presentation: "coverage-only",
        includedAccounts: 0,
        staleQuotaAccounts: 1,
        missingQuotaAccounts: 1,
        unknownPlanAccounts: 1,
        incomplete: true,
        currentAccount: { plan: "prolite", quota: null },
      });
      expect(openai?.quota).toEqual({ updatedAt: future });
      expect(openai?.quota).not.toHaveProperty("weeklyPercent");
      const cached = await fetchProviderQuotaReports(config);
      expect(cached.reports[0]?.quota).not.toHaveProperty("weeklyPercent");
    } finally {
      Date.now = realDateNow;
    }
  });

  test("ordinary fetch reflects pausing a non-active pool account", async () => {
    saveCodexAccountCredential("added", {
      accessToken: "added-access", refreshToken: "added-refresh",
      expiresAt: Date.now() + 3600_000, chatgptAccountId: "added-chatgpt-id",
    });
    const config = testConfig();
    config.providers = { openai: config.providers.openai };
    config.codexAccounts = [{ id: "added", email: "a@example.test", plan: "prolite", isMain: false }];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const added = (init?.headers as Record<string, string> | undefined)?.["ChatGPT-Account-Id"] === "added-chatgpt-id";
      return new Response(JSON.stringify({
        plan_type: added ? "prolite" : "plus",
        rate_limit: { secondary_window: { used_percent: added ? 77 : 11, reset_at: 1_999_000_000 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    expect((await fetchProviderQuotaReports(config, true)).reports[0]?.quota.weeklyPercent).toBe(66);
    config.pausedCodexAccountIds = ["added"];
    const paused = (await fetchProviderQuotaReports(config)).reports[0];
    expect(paused?.quota.weeklyPercent).toBe(11);
    expect(paused?.aggregation).toMatchObject({ includedAccounts: 1, excludedAccounts: 1, incomplete: true });
  });

  test("ordinary fetch separates plan, quota, and effective-account cache states", async () => {
    saveCodexAccountCredential("added", {
      accessToken: "added-access", refreshToken: "added-refresh",
      expiresAt: Date.now() + 3600_000, chatgptAccountId: "added-chatgpt-id",
    });
    const config = testConfig();
    config.providers = { openai: config.providers.openai };
    config.codexAccounts = [{ id: "added", email: "a@example.test", plan: "prolite", isMain: false }];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const added = (init?.headers as Record<string, string> | undefined)?.["ChatGPT-Account-Id"] === "added-chatgpt-id";
      return new Response(JSON.stringify({
        plan_type: added ? "prolite" : "plus",
        rate_limit: { secondary_window: { used_percent: added ? 77 : 11, reset_at: 1_999_000_000 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await fetchProviderQuotaReports(config, true);
    config.codexAccounts[0]!.plan = "pro";
    expect((await fetchProviderQuotaReports(config)).reports[0]?.aggregation?.weekly?.usedPercent).toBeCloseTo((20 * 77 + 11) / 21, 8);
    config.activeCodexAccountId = "added";
    expect((await fetchProviderQuotaReports(config)).reports[0]?.aggregation?.currentAccount).toMatchObject({ plan: "pro", quota: { weeklyPercent: 77 } });
    updateAccountQuota("added", 20, 1_999_000_000);
    expect((await fetchProviderQuotaReports(config)).reports[0]?.aggregation?.weekly?.usedPercent).toBeCloseTo((20 * 20 + 11) / 21, 8);
  });

  test("ordinary fetch reflects runtime reauthentication state", async () => {
    saveCodexAccountCredential("added", {
      accessToken: "added-access", refreshToken: "added-refresh",
      expiresAt: Date.now() + 3600_000, chatgptAccountId: "added-chatgpt-id",
    });
    const config = testConfig();
    config.providers = { openai: config.providers.openai };
    config.codexAccounts = [{ id: "added", email: "a@example.test", plan: "prolite", isMain: false }];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const added = (init?.headers as Record<string, string> | undefined)?.["ChatGPT-Account-Id"] === "added-chatgpt-id";
      return new Response(JSON.stringify({
        plan_type: added ? "prolite" : "plus",
        rate_limit: { secondary_window: { used_percent: added ? 77 : 11, reset_at: 1_999_000_000 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await fetchProviderQuotaReports(config, true);
    markAccountNeedsReauth("added");
    const reauth = (await fetchProviderQuotaReports(config)).reports[0];
    expect(reauth?.aggregation).toMatchObject({ includedAccounts: 1, reauthAccounts: 1, incomplete: true });
    clearAccountNeedsReauth("added");
  });

  test("ordinary fetch reflects pool account add and remove", async () => {
    saveCodexAccountCredential("added", {
      accessToken: "added-access", refreshToken: "added-refresh",
      expiresAt: Date.now() + 3600_000, chatgptAccountId: "added-chatgpt-id",
    });
    const config = testConfig();
    config.providers = { openai: config.providers.openai };
    config.codexAccounts = [{ id: "added", email: "a@example.test", plan: "prolite", isMain: false }];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const id = (init?.headers as Record<string, string> | undefined)?.["ChatGPT-Account-Id"];
      const plan = id === "added-chatgpt-id" ? "prolite" : id === "second-chatgpt-id" ? "business" : "plus";
      const percent = id === "added-chatgpt-id" ? 77 : id === "second-chatgpt-id" ? 33 : 11;
      return new Response(JSON.stringify({
        plan_type: plan,
        rate_limit: { secondary_window: { used_percent: percent, reset_at: 1_999_000_000 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    expect((await fetchProviderQuotaReports(config, true)).reports[0]?.aggregation?.includedAccounts).toBe(2);
    saveCodexAccountCredential("second", {
      accessToken: "second-access", refreshToken: "second-refresh",
      expiresAt: Date.now() + 3600_000, chatgptAccountId: "second-chatgpt-id",
    });
    config.codexAccounts.push({ id: "second", email: "b@example.test", plan: "business", isMain: false });
    expect((await fetchProviderQuotaReports(config)).reports[0]?.aggregation?.includedAccounts).toBe(3);
    config.codexAccounts = config.codexAccounts.filter(account => account.id !== "second");
    expect((await fetchProviderQuotaReports(config)).reports[0]?.aggregation?.includedAccounts).toBe(2);
  });

  test("direct mode reports main without reading or repairing the added-account store", async () => {
    const accountStore = join(opencodexHome, "codex-accounts.json");
    writeFileSync(accountStore, "invalid-added-account-store");
    const config = testConfig();
    config.providers.openai.codexAccountMode = "direct";
    config.codexAccounts = [{ id: "added", email: "a@example.test", isMain: false }];
    config.activeCodexAccountId = "added";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      rate_limit: { secondary_window: { used_percent: 12, reset_at: 1_789_000_000 } },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    const result = await fetchProviderQuotaReports(config, true);
    expect(result.reports.find(row => row.provider === "openai")?.quota.weeklyPercent).toBe(12);
    expect(readFileSync(accountStore, "utf8")).toBe("invalid-added-account-store");
    expect(existsSync(`${accountStore}.invalid`)).toBe(false);
  });

  test("expired Anthropic token attempts a refresh and never calls the usage endpoint on failure", async () => {
    await saveCredential("anthropic", { access: "expired-claude-access", refresh: "expired-claude-refresh", expires: Date.now() - 1 });
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      // Refresh fails -> quota must bail without touching the usage endpoint.
      return new Response("refresh rejected", { status: 500 });
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
    expect(seen.some(url => url.includes("/v1/oauth/token"))).toBe(true);
    expect(seen.some(url => url.includes("/api/oauth/usage"))).toBe(false);
  });

  function cursorOnlyConfig(): OcxConfig {
    return {
      defaultProvider: "cursor",
      providers: {
        cursor: {
          adapter: "cursor",
          authMode: "oauth",
          baseUrl: "https://api2.cursor.sh",
        },
      },
    } as OcxConfig;
  }

  function declaredOversizeQuotaResponse(onCancel: () => void): Response {
    return new Response(new ReadableStream<Uint8Array>({
      cancel() { onCancel(); },
    }), {
      status: 200,
      headers: { "content-length": String(QUOTA_RESPONSE_MAX_BYTES + 1) },
    });
  }

  function chunkedOversizeQuotaResponse(onCancel: () => void, json = "{}"): Response {
    const encoded = new TextEncoder().encode(json);
    if (encoded.byteLength > QUOTA_RESPONSE_MAX_BYTES) throw new Error("test JSON exceeds quota response cap");
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
        controller.enqueue(new Uint8Array(QUOTA_RESPONSE_MAX_BYTES - encoded.byteLength).fill(0x20));
        controller.enqueue(new Uint8Array([0x20]));
      },
      cancel() { onCancel(); },
    }), { status: 200 });
  }

  test("cursor bounds a declared-oversize period response before falling back to summary", async () => {
    await saveCredential("cursor", { access: "cursor-access-secret", refresh: "cursor-refresh-secret", expires: Date.now() + 3600_000 });
    let cancelCalls = 0;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("GetCurrentPeriodUsage")) {
        return declaredOversizeQuotaResponse(() => { cancelCalls += 1; });
      }
      if (url.endsWith("/api/usage/summary")) {
        return Response.json({ individualUsage: { plan: { totalPercentUsed: 42 } } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(cursorOnlyConfig(), true);
    expect(result.reports[0]?.source).toBe("cursor:usage-summary");
    expect(result.reports[0]?.quota.monthlyPercent).toBe(42);
    expect(seen.map(url => url.split("/").at(-1))).toEqual([
      "GetCurrentPeriodUsage",
      "summary",
    ]);
    expect(cancelCalls).toBe(1);
  });

  test("cursor bounds a chunked summary response after malformed period JSON and falls back to auth usage", async () => {
    await saveCredential("cursor", { access: "cursor-access-secret", refresh: "cursor-refresh-secret", expires: Date.now() + 3600_000 });
    let cancelCalls = 0;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("GetCurrentPeriodUsage")) return new Response("{", { status: 200 });
      if (url.endsWith("/api/usage/summary")) {
        return chunkedOversizeQuotaResponse(
          () => { cancelCalls += 1; },
          JSON.stringify({ individualUsage: { plan: { totalPercentUsed: 91 } } }),
        );
      }
      if (url.endsWith("/auth/usage")) {
        return Response.json({ "gpt-4": { numRequests: 1, maxRequestUsage: 4 } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(cursorOnlyConfig(), true);
    expect(result.reports[0]?.source).toBe("cursor:auth-usage");
    expect(result.reports[0]?.quota.monthlyPercent).toBe(25);
    expect(seen.map(url => url.split("/").at(-1))).toEqual([
      "GetCurrentPeriodUsage",
      "summary",
      "usage",
    ]);
    expect(cancelCalls).toBe(1);
  });

  test("cursor treats malformed under-cap period and summary JSON as fallback conditions", async () => {
    await saveCredential("cursor", { access: "cursor-access-secret", refresh: "cursor-refresh-secret", expires: Date.now() + 3600_000 });
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("GetCurrentPeriodUsage") || url.endsWith("/api/usage/summary")) {
        return new Response("{", { status: 200 });
      }
      if (url.endsWith("/auth/usage")) {
        return Response.json({ "gpt-4": { numRequests: 3, maxRequestUsage: 10 } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(cursorOnlyConfig(), true);
    expect(result.reports[0]?.source).toBe("cursor:auth-usage");
    expect(result.reports[0]?.quota.monthlyPercent).toBe(30);
    expect(seen.map(url => url.split("/").at(-1))).toEqual([
      "GetCurrentPeriodUsage",
      "summary",
      "usage",
    ]);
  });

  test("cursor preserves its last-good row when the final quota response exceeds the JSON budget", async () => {
    await saveCredential("cursor", { access: "cursor-access-secret", refresh: "cursor-refresh-secret", expires: Date.now() + 3600_000 });
    let mode: "good" | "oversize" = "good";
    let cancelCalls = 0;
    let fetchCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls += 1;
      const url = String(input);
      if (mode === "good" && url.endsWith("GetCurrentPeriodUsage")) {
        return Response.json({ planUsage: { totalPercentUsed: 55 } });
      }
      if (url.endsWith("GetCurrentPeriodUsage") || url.endsWith("/api/usage/summary")) {
        return Response.json({});
      }
      if (url.endsWith("/auth/usage")) {
        return chunkedOversizeQuotaResponse(
          () => { cancelCalls += 1; },
          JSON.stringify({ "gpt-4": { numRequests: 91, maxRequestUsage: 100 } }),
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const good = await fetchProviderQuotaReports(cursorOnlyConfig(), true);
    const goodUpdatedAt = good.reports[0]?.updatedAt;
    const goodQuotaUpdatedAt = good.reports[0]?.quota.updatedAt;
    mode = "oversize";
    const preserved = await fetchProviderQuotaReports(cursorOnlyConfig(), true);
    const callsAfterRefresh = fetchCalls;
    const cached = await fetchProviderQuotaReports(cursorOnlyConfig(), false);

    expect(preserved.reports[0]?.quota.monthlyPercent).toBe(55);
    expect(preserved.reports[0]?.updatedAt).toBe(goodUpdatedAt);
    expect(preserved.reports[0]?.quota.updatedAt).toBe(goodQuotaUpdatedAt);
    expect(cached.reports[0]?.quota.monthlyPercent).toBe(55);
    expect(fetchCalls).toBe(callsAfterRefresh);
    expect(cancelCalls).toBe(1);
  });

  test("cursor falls back to usage-summary when period-usage fails", async () => {
    await saveCredential("cursor", { access: "cursor-access-secret", refresh: "cursor-refresh-secret", expires: Date.now() + 3600_000 });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("GetCurrentPeriodUsage")) return new Response("nope", { status: 500 });
      if (url.endsWith("/api/usage/summary")) {
        return new Response(JSON.stringify({
          individualUsage: { plan: { used: 42, limit: 100, totalPercentUsed: 42 } },
          billingCycleEnd: "2026-08-01T00:00:00.000Z",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(cursorOnlyConfig(), true);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.source).toBe("cursor:usage-summary");
    expect(result.reports[0]?.quota.monthlyPercent).toBe(42);
    expect(result.reports[0]?.quota.monthlyResetAt).toBe(Date.parse("2026-08-01T00:00:00.000Z"));
  });

  test("cursor period-usage keeps totalPercentUsed as monthly while retaining auto/API pool windows", async () => {
    await saveCredential("cursor", { access: "cursor-access-secret", refresh: "cursor-refresh-secret", expires: Date.now() + 3600_000 });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("GetCurrentPeriodUsage")) {
        return new Response(JSON.stringify({
          planUsage: {
            includedSpend: 23222,
            remaining: 16778,
            limit: 40000,
            autoPercentUsed: 0,
            apiPercentUsed: 46.444,
            totalPercentUsed: 15.48,
          },
          // Connect RPC shape: unix ms as a decimal string (Date.parse would fail).
          billingCycleEnd: "1771077734000",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(cursorOnlyConfig(), true);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.source).toBe("cursor:period-usage");
    expect(result.reports[0]?.quota.monthlyPercent).toBe(15.48);
    expect(result.reports[0]?.quota.monthlyResetAt).toBe(1_771_077_734_000);
    expect(result.reports[0]?.quota.customWindows).toEqual([
      { label: "First-party models", percent: 0, resetAt: 1_771_077_734_000 },
      { label: "API usage", percent: 46.444, resetAt: 1_771_077_734_000 },
    ]);
  });

  test("cursor falls back to auth-usage with a UTC month rollover when the richer endpoints fail", async () => {
    await saveCredential("cursor", { access: "cursor-access-secret", refresh: "cursor-refresh-secret", expires: Date.now() + 3600_000 });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("GetCurrentPeriodUsage")) return new Response("nope", { status: 500 });
      if (url.endsWith("/api/usage/summary")) return new Response("nope", { status: 404 });
      if (url.endsWith("/auth/usage")) {
        return new Response(JSON.stringify({
          "gpt-4": { numRequests: 150, maxRequestUsage: 500 },
          // Dec 31 pins the UTC year+month rollover: next reset must be Jan 31 UTC, not a
          // local-timezone-shifted date.
          startOfMonth: "2026-12-31T00:00:00.000Z",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(cursorOnlyConfig(), true);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.source).toBe("cursor:auth-usage");
    expect(result.reports[0]?.quota.monthlyPercent).toBe(30);
    expect(result.reports[0]?.quota.monthlyResetAt).toBe(Date.UTC(2027, 0, 31));
  });

  test("main identity invalidation drops the stale report without negative-caching the new identity", async () => {
    const full = testConfig();
    const config = {
      ...full,
      providers: {
        openai: full.providers.openai!,
      },
    } as OcxConfig;
    globalThis.fetch = (async () => Response.json({
      plan_type: "plus",
      rate_limit: { secondary_window: { used_percent: 61 } },
    })) as typeof fetch;
    setProviderQuotaBeforePublishForTests(() => {
      clearMainAccountInfoCache();
      setProviderQuotaBeforePublishForTests(null);
    });

    const response = await fetchProviderQuotaReports(config, true);
    expect(response.reports.some(item => item.provider === "openai")).toBe(false);

    const retried = await fetchProviderQuotaReports(config, false);
    expect(retried.reports.some(item => item.provider === "openai")).toBe(true);
  });

  test("clearing the cache mid-flight revokes commit authority", async () => {
    await saveCredential("cursor", { access: "cursor-access-secret", refresh: "cursor-refresh-secret", expires: Date.now() + 3600_000 });
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("GetCurrentPeriodUsage")) {
        calls += 1;
        await gate;
        return new Response(JSON.stringify({
          planUsage: { totalPercentUsed: 11 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const first = fetchProviderQuotaReports(cursorOnlyConfig(), true);
    // Invalidate while the probe is still in flight.
    clearProviderQuotaCache();
    release!();
    await first;

    // A NON-forced call must hit upstream again: if the revoked probe had committed to the
    // cache, this call would be served from cache and `calls` would stay at 1.
    await fetchProviderQuotaReports(cursorOnlyConfig(), false);
    expect(calls).toBe(2);
  });

  test("a forced call starts its own upstream probe instead of joining a non-forced inflight", async () => {
    await saveCredential("cursor", { access: "cursor-access-secret", refresh: "cursor-refresh-secret", expires: Date.now() + 3600_000 });
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("GetCurrentPeriodUsage")) {
        calls += 1;
        if (calls === 1) await gate;
        return new Response(JSON.stringify({ planUsage: { totalPercentUsed: 20 } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const config = cursorOnlyConfig();
    const nonForced = fetchProviderQuotaReports(config, false);
    await fetchProviderQuotaReports(config, true);
    expect(calls).toBe(2);
    release!();
    await nonForced;
  });


  test("parseXaiCreditsResponse maps weekly credits and rejects non-weekly periods", () => {
    expect(parseXaiCreditsResponse({
      config: {
        creditUsagePercent: 57.4,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-08-15T13:05:52.277209Z" },
      },
    })).toEqual({
      percent: 57.4,
      resetAt: Date.parse("2026-08-15T13:05:52.277209Z"),
    });
    expect(parseXaiCreditsResponse({
      config: {
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-08-15T13:05:52.277209Z" },
      },
    })).toEqual({
      percent: 0,
      resetAt: Date.parse("2026-08-15T13:05:52.277209Z"),
    });
    expect(parseXaiCreditsResponse({
      config: {
        creditUsagePercent: 10,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "2026-08-15T13:05:52.277209Z" },
      },
    })).toBeNull();
  });

  test("xAI OAuth quota prefers weekly credits and falls back to monthly when weekly fails", async () => {
    await saveCredential("xai", {
      access: "xai-access-secret",
      refresh: "xai-refresh-secret",
      expires: Date.now() + 3600_000,
      accountId: "xai-user-1",
    });
    const seen: { url: string; headers: Record<string, string> }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      seen.push({ url, headers });
      if (url === "https://cli-chat-proxy.grok.com/v1/billing?format=credits") {
        return new Response(JSON.stringify({
          config: {
            creditUsagePercent: 31,
            currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-08-15T00:00:00Z" },
            raw_secret_should_not_escape: "xai-access-secret",
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://cli-chat-proxy.grok.com/v1/billing") {
        return new Response(JSON.stringify({
          config: {
            monthlyLimit: { val: 10_000 },
            used: { val: 2_500 },
            billingPeriodEnd: "2026-08-31T00:00:00Z",
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const weekly = await fetchProviderQuotaReports({
      defaultProvider: "xai",
      providers: { xai: { adapter: "openai-chat", authMode: "oauth", baseUrl: "https://api.x.ai/v1" } },
    } as OcxConfig, true);
    expect(weekly.reports).toHaveLength(1);
    expect(weekly.reports[0]?.source).toBe("xai:grok-billing-credits");
    expect(weekly.reports[0]?.quota).toMatchObject({
      weeklyPercent: 31,
      weeklyResetAt: Date.parse("2026-08-15T00:00:00Z"),
    });
    expect(weekly.reports[0]?.quota.monthlyPercent).toBeUndefined();
    const creditsCall = seen.find(row => row.url.endsWith("format=credits"));
    expect(creditsCall?.headers.authorization).toBe("Bearer xai-access-secret");
    expect(creditsCall?.headers["x-userid"]).toBe("xai-user-1");
    expect(creditsCall?.headers["x-xai-token-auth"]).toBe("xai-grok-cli");
    expect(creditsCall?.headers["x-authenticateresponse"]).toBe("authenticate-response");
    expect(creditsCall?.headers["x-grok-client-version"]).toBeTruthy();
    expect(JSON.stringify(weekly)).not.toContain("xai-access-secret");
    expect(JSON.stringify(weekly)).not.toContain("xai-user-1");

    // Weekly non-2xx falls back to monthly.
    seen.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      seen.push({ url, headers });
      if (url.endsWith("format=credits")) {
        return new Response("nope", { status: 503 });
      }
      if (url === "https://cli-chat-proxy.grok.com/v1/billing") {
        return new Response(JSON.stringify({
          config: {
            monthlyLimit: { val: 10_000 },
            used: { val: 2_500 },
            billingPeriodEnd: "2026-08-31T00:00:00Z",
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const monthly = await fetchProviderQuotaReports({
      defaultProvider: "xai",
      providers: { xai: { adapter: "openai-chat", authMode: "oauth", baseUrl: "https://api.x.ai/v1" } },
    } as OcxConfig, true);
    expect(monthly.reports[0]?.source).toBe("xai:grok-billing");
    expect(monthly.reports[0]?.quota.monthlyPercent).toBe(25);
    expect(monthly.reports[0]?.quota.weeklyPercent).toBeUndefined();
    expect(seen.some(row => row.url.endsWith("format=credits"))).toBe(true);
    expect(seen.some(row => row.url === "https://cli-chat-proxy.grok.com/v1/billing")).toBe(true);
  });

  test("xAI OAuth quota skips weekly when identity is absent and keeps monthly", async () => {
    await saveCredential("xai", {
      access: "xai-access-secret",
      refresh: "xai-refresh-secret",
      expires: Date.now() + 3600_000,
    });
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url === "https://cli-chat-proxy.grok.com/v1/billing") {
        return new Response(JSON.stringify({
          config: {
            monthlyLimit: { val: 10_000 },
            used: { val: 2_500 },
            billingPeriodEnd: "2026-08-31T00:00:00Z",
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const result = await fetchProviderQuotaReports({
      defaultProvider: "xai",
      providers: { xai: { adapter: "openai-chat", authMode: "oauth", baseUrl: "https://api.x.ai/v1" } },
    } as OcxConfig, true);
    expect(seen.some(url => url.includes("format=credits"))).toBe(false);
    expect(result.reports[0]?.source).toBe("xai:grok-billing");
    expect(result.reports[0]?.quota.monthlyPercent).toBe(25);
  });

  test("interleaved configs keep independent inflight entries (A → B → A joins the first A)", async () => {
    await saveCredential("cursor", { access: "cursor-access-secret", refresh: "cursor-refresh-secret", expires: Date.now() + 3600_000 });
    await saveCredential("xai", { access: "xai-access-secret", refresh: "xai-refresh-secret", expires: Date.now() + 3600_000 });
    let releaseCursor: (() => void) | undefined;
    const cursorGate = new Promise<void>(resolve => { releaseCursor = resolve; });
    let cursorCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("GetCurrentPeriodUsage")) {
        cursorCalls += 1;
        await cursorGate;
        return new Response(JSON.stringify({ planUsage: { totalPercentUsed: 33 } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("grok.com")) {
        return new Response(JSON.stringify({ config: { monthlyLimit: { val: 100 }, used: { val: 1 } } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const configA = cursorOnlyConfig();
    const configB = {
      defaultProvider: "xai",
      providers: { xai: { adapter: "openai-chat", authMode: "oauth", baseUrl: "https://api.x.ai/v1" } },
    } as OcxConfig;

    const a1 = fetchProviderQuotaReports(configA, false); // A inflight opens
    await fetchProviderQuotaReports(configB, false); // B must not evict A's inflight entry
    const a2 = fetchProviderQuotaReports(configA, false); // must JOIN a1, not re-probe
    releaseCursor!();
    await Promise.all([a1, a2]);
    expect(cursorCalls).toBe(1);
  });

  test("an older non-forced probe cannot overwrite a newer forced result", async () => {
    await saveCredential("cursor", { access: "cursor-access-secret", refresh: "cursor-refresh-secret", expires: Date.now() + 3600_000 });
    let releaseSlow: (() => void) | undefined;
    const slowGate = new Promise<void>(resolve => { releaseSlow = resolve; });
    let call = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("GetCurrentPeriodUsage")) {
        call += 1;
        const mine = call;
        if (mine === 1) await slowGate; // non-forced probe A hangs
        return new Response(JSON.stringify({
          planUsage: { totalPercentUsed: mine === 1 ? 10 : 90 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const config = cursorOnlyConfig();
    const slow = fetchProviderQuotaReports(config, false); // probe A (non-forced)
    const forced = await fetchProviderQuotaReports(config, true); // probe B commits 90
    expect(forced.reports[0]?.quota.monthlyPercent).toBe(90);

    releaseSlow!();
    await slow; // A completes AFTER B — must not overwrite B's cache

    const cached = await fetchProviderQuotaReports(config, false);
    expect(cached.reports[0]?.quota.monthlyPercent).toBe(90);
  });

  test("effective-account change during a pool probe cannot cache under the new signature", async () => {
    saveCodexAccountCredential("added", {
      accessToken: "added-access", refreshToken: "added-refresh",
      expiresAt: Date.now() + 3600_000, chatgptAccountId: "added-chatgpt-id",
    });
    const config = testConfig();
    config.providers = { openai: config.providers.openai };
    config.codexAccounts = [{ id: "added", email: "a@example.test", plan: "prolite", isMain: false }];
    const responseFor = (init?: RequestInit) => {
      const added = (init?.headers as Record<string, string> | undefined)?.["ChatGPT-Account-Id"] === "added-chatgpt-id";
      return new Response(JSON.stringify({
        plan_type: added ? "prolite" : "plus",
        rate_limit: { secondary_window: { used_percent: added ? 77 : 11, reset_at: 1_999_000_000 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => responseFor(init)) as typeof fetch;
    await fetchProviderQuotaReports(config, true);
    clearProviderQuotaCache();

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let startedResolve!: () => void;
    const started = new Promise<void>(resolve => { startedResolve = resolve; });
    let startedProbe = false;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!startedProbe) {
        startedProbe = true;
        startedResolve();
      }
      await gate;
      return responseFor(init);
    }) as typeof fetch;

    const racing = fetchProviderQuotaReports(config, true);
    await started;
    config.activeCodexAccountId = "added";
    release();
    const racedResponse = await racing;
    const next = await fetchProviderQuotaReports(config);
    expect(next).not.toBe(racedResponse);
    expect(next.reports[0]?.aggregation?.currentAccount).toMatchObject({ plan: "prolite", quota: { weeklyPercent: 77 } });
  });

  test("last-good rows survive a transient failure with original timestamps, are replaced by fresh rows, expire past the cap, and a disabled provider yields no rows", async () => {
    await saveCredential("cursor", { access: "cursor-access-secret", refresh: "cursor-refresh-secret", expires: Date.now() + 3600_000 });
    let mode: "ok" | "fail" = "ok";
    let percent = 55;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("GetCurrentPeriodUsage") && mode === "ok") {
        return new Response(JSON.stringify({
          planUsage: { totalPercentUsed: percent },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("down", { status: 500 });
    }) as typeof fetch;

    const config = cursorOnlyConfig();
    const good = await fetchProviderQuotaReports(config, true);
    const goodUpdatedAt = good.reports[0]?.updatedAt;
    const goodQuotaUpdatedAt = good.reports[0]?.quota.updatedAt;
    expect(good.reports[0]?.quota.monthlyPercent).toBe(55);

    // Transient failure: the previous row is preserved with its ORIGINAL timestamp.
    mode = "fail";
    const preserved = await fetchProviderQuotaReports(config, true);
    expect(preserved.reports).toHaveLength(1);
    expect(preserved.reports[0]?.quota.monthlyPercent).toBe(55);
    expect(preserved.reports[0]?.updatedAt).toBe(goodUpdatedAt!);
    expect(preserved.reports[0]?.quota.updatedAt).toBe(goodQuotaUpdatedAt!);

    // A fresh successful probe REPLACES the preserved row (changed percent proves replacement).
    mode = "ok";
    percent = 77;
    const replaced = await fetchProviderQuotaReports(config, true);
    expect(replaced.reports[0]?.quota.monthlyPercent).toBe(77);
    // Same-millisecond runs are possible; the changed percent above proves replacement.
    expect(replaced.reports[0]?.updatedAt).toBeGreaterThanOrEqual(goodUpdatedAt!);

    // Rows older than the last-good cap are dropped.
    mode = "fail";
    replaced.reports[0]!.updatedAt = Date.now() - 31 * 60_000;
    replaced.reports[0]!.quota.updatedAt = Date.now() - 31 * 60_000;
    const expired = await fetchProviderQuotaReports(config, true);
    expect(expired.reports).toEqual([]);

    // Disabling the provider changes the cache key, so no previous rows carry over and the
    // disabled provider is skipped by the probe dispatch: no rows at all.
    mode = "ok";
    const refreshed = await fetchProviderQuotaReports(config, true);
    expect(refreshed.reports).toHaveLength(1);
    const disabledConfig = {
      ...cursorOnlyConfig(),
      providers: { cursor: { ...cursorOnlyConfig().providers.cursor, disabled: true } },
    } as OcxConfig;
    const pruned = await fetchProviderQuotaReports(disabledConfig, true);
    expect(pruned.reports).toEqual([]);
  });
});
