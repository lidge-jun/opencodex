import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAccountQuota } from "../src/codex/quota";
import { saveCodexAccountCredential } from "../src/codex/account-store";
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
    expect(byProvider.anthropic?.quota.customWindows).toEqual([
      { label: "5h", percent: 41.5, resetAt: Date.parse("2026-07-05T12:00:00Z") },
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

  test("pool mode reports the active added account", async () => {
    saveCodexAccountCredential("added", {
      accessToken: "added-access",
      refreshToken: "added-refresh",
      expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "added-chatgpt-id",
    });
    const config = testConfig();
    config.codexAccounts = [{ id: "added", email: "a@example.test", isMain: false }];
    config.activeCodexAccountId = "added";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const percent = headers?.["ChatGPT-Account-Id"] === "added-chatgpt-id" ? 77 : 11;
      return new Response(JSON.stringify({
        rate_limit: { secondary_window: { used_percent: percent, reset_at: 1_789_000_000 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(config, true);
    expect(result.reports.find(row => row.provider === "openai")?.quota.weeklyPercent).toBe(77);
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
