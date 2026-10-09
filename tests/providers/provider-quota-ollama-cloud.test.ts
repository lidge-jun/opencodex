import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Ollama Cloud quota probes. Split out of provider-quota.test.ts so the grandfathered
 * file-size cap in tests/fixtures/file-size-baseline.json stays untouched for a
 * single vendor's probe coverage.
 */
import {
  QUOTA_RESPONSE_MAX_BYTES,
  clearProviderQuotaCache,
  fetchProviderQuotaReports,
  parseOllamaCloudBalance,
  parseOllamaCloudQuota,
  setProviderQuotaBeforePublishForTests,
} from "../../src/providers/quota";
import type { OcxConfig } from "../../src/types";
import { clearComboTargetCooldowns, pickComboTarget } from "../../src/combos";

const originalFetch = globalThis.fetch;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
let opencodexHome = "";

beforeEach(() => {
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-quota-ollama-"));
  process.env.OPENCODEX_HOME = opencodexHome;
  clearProviderQuotaCache();
  setProviderQuotaBeforePublishForTests(null);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearProviderQuotaCache();
  setProviderQuotaBeforePublishForTests(null);
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  rmSync(opencodexHome, { recursive: true, force: true });
});

describe("ollama cloud quota probe", () => {
  function keyQuotaConfig(name: string, baseUrl: string, apiKey = `${name}-secret`): OcxConfig {
    return {
      defaultProvider: name,
      providers: {
        [name]: { adapter: "openai-chat", authMode: "key", baseUrl, apiKey },
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

  test("Ollama Cloud reads /api/balance first and falls back to /api/usage (legacy plan)", async () => {
    const seen: Array<{ url: string; authorization?: string; redirect?: RequestRedirect }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({ url, authorization: headers?.Authorization, redirect: init?.redirect });
      if (url.endsWith("/api/balance")) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({
        activity: { cost: "0.00000", period: { type: "last_4_weeks" }, models: [] },
        limits: {
          session: { usage: 0.091, models: [{ name: "glm-5.3-flash", request_count: 228 }] },
          weekly: { usage: 0.592, models: [{ name: "glm-5.3", request_count: 2572 }] },
        },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      keyQuotaConfig("ollama-cloud", "https://ollama.com/v1"),
      true,
    );

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.source).toBe("ollama-cloud:usage");
    expect(result.reports[0]?.quota).toMatchObject({
      fiveHourPercent: 9.1,
      weeklyPercent: 59.2,
    });
    expect(seen.map((entry) => entry.url)).toEqual([
      "https://ollama.com/api/balance",
      "https://ollama.com/api/usage",
    ]);
    expect(seen[1]?.authorization).toBe("Bearer ollama-cloud-secret");
    expect(seen[1]?.redirect).toBe("error");
  });

  test("Ollama Cloud maps 5-hour session and weekly windows from /api/balance remaining_percent", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({
        included: {
          session: { remaining_percent: 91, resets_at: "2026-10-08T04:00:00Z" },
          weekly: { remaining_percent: 56.48, resets_at: "2026-10-12T00:00:00Z" },
        },
        purchased: { balance_usd: 0 },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      keyQuotaConfig("ollama-cloud", "https://ollama.com/v1"),
      true,
    );

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.source).toBe("ollama-cloud:balance");
    expect(result.reports[0]?.quota).toMatchObject({
      fiveHourPercent: 9,
      weeklyPercent: 43.52,
      fiveHourResetAt: Date.parse("2026-10-08T04:00:00Z"),
      weeklyResetAt: Date.parse("2026-10-12T00:00:00Z"),
    });
    expect(seen).toEqual(["https://ollama.com/api/balance"]);
  });

  test("Ollama Cloud stops at a declared-oversize /api/balance response without a usage fallback", async () => {
    const seen: string[] = [];
    let cancelCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return declaredOversizeQuotaResponse(() => { cancelCalls += 1; });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      keyQuotaConfig("ollama-cloud", "https://ollama.com/v1"),
      true,
    );

    expect(result.reports).toEqual([]);
    expect(seen).toEqual(["https://ollama.com/api/balance"]);
    expect(cancelCalls).toBe(1);
  });

  test("Ollama Cloud maps the included allowance/balance of a credit plan", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      included: {
        balance_usd: 3.5,
        allowance_usd: 10,
        period: { from: "2026-10-01T00:00:00Z", until: "2026-11-01T00:00:00Z" },
      },
      purchased: { balance_usd: 99 },
    }), { status: 200 })) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      keyQuotaConfig("ollama-cloud", "https://ollama.com/v1"),
      true,
    );

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.source).toBe("ollama-cloud:balance");
    expect(result.reports[0]?.quota).toMatchObject({ updatedAt: expect.any(Number) });
    expect(result.reports[0]?.quota.creditsUsd).toMatchObject({
      used: 6.5,
      limit: 10,
      remaining: 3.5,
      percent: 65,
      expiresAt: Date.parse("2026-11-01T00:00:00Z"),
    });
  });

  test("Ollama Cloud reports nothing for the request-count /api/usage payload", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/balance")) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({
        range: "7d",
        scope: "self",
        granularity: "day",
        totals: { request_count: 26267 },
        buckets: [{ from: "2026-10-01T00:00:00Z", until: "2026-10-02T00:00:00Z", request_count: 1234 }],
      }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      keyQuotaConfig("ollama-cloud", "https://ollama.com/v1"),
      true,
    );

    expect(result.reports).toEqual([]);
  });

  test("Ollama Cloud maps monthly window from /api/usage (migrated plan)", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url === "https://ollama.com/api/balance") return new Response("not found", { status: 404 });
      if (url !== "https://ollama.com/api/usage") throw new Error(`Unexpected quota URL: ${url}`);
      return new Response(JSON.stringify({
        activity: { cost: "1.68054", period: { type: "last_4_weeks" } },
        limits: {
          monthly: { usage: 0.004, models: [{ name: "glm-5.3-flash", request_count: 147 }] },
        },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      keyQuotaConfig("ollama-cloud", "https://ollama.com/v1"),
      true,
    );

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.source).toBe("ollama-cloud:usage");
    expect(result.reports[0]?.quota).toMatchObject({
      monthlyPercent: 0.4,
    });
    expect(seen).toEqual(["https://ollama.com/api/balance", "https://ollama.com/api/usage"]);
    expect(result.reports[0]?.quota.fiveHourPercent).toBeUndefined();
    expect(result.reports[0]?.quota.weeklyPercent).toBeUndefined();
  });

  test("Ollama Cloud maps combined windows when both legacy and migrated limits exist", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      if (String(input).endsWith("/api/balance")) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({
        limits: {
          session: { usage: 0.1 },
          weekly: { usage: 0.2 },
          monthly: { usage: 0.3 },
        },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      keyQuotaConfig("ollama-cloud", "https://ollama.com/v1"),
      true,
    );

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.source).toBe("ollama-cloud:usage");
    expect(seen).toEqual(["https://ollama.com/api/balance", "https://ollama.com/api/usage"]);
    expect(result.reports[0]?.quota).toMatchObject({
      fiveHourPercent: 10,
      weeklyPercent: 20,
      monthlyPercent: 30,
    });
  });

  function ollamaCombo(): OcxConfig {
    const config = keyQuotaConfig("ollama-cloud", "https://ollama.com/v1");
    return {
      ...config,
      providers: {
        ...config.providers,
        fallback: { adapter: "openai-chat", baseUrl: "https://fallback.example/v1", apiKey: "fallback-key" },
      },
      combos: { "quota-scope": { strategy: "failover", targets: [
        { provider: "ollama-cloud", model: "primary-model" }, { provider: "fallback", model: "fallback-model" },
      ] } },
    };
  }

  test.each([
    ["positive purchased credit keeps routing", { balance_usd: 99 }, "ollama-cloud"],
    ["unknown purchased credit keeps routing", undefined, "ollama-cloud"],
    ["empty purchased credit vetoes routing", { balance_usd: 0 }, "fallback"],
  ] as const)("exhausted included allowance: %s", async (_label, purchased, expected) => {
    clearComboTargetCooldowns();
    globalThis.fetch = (async () => Response.json({
      included: { allowance_usd: 10, balance_usd: 0 },
      ...(purchased ? { purchased } : {}),
    })) as typeof fetch;
    const config = ollamaCombo();
    const result = await fetchProviderQuotaReports(config, true);
    expect(result.reports[0]?.quota.creditsUsd).toMatchObject({ percent: 100, remaining: 0 });
    expect(pickComboTarget(config, "quota-scope")?.target.provider).toBe(expected);
  });

  test("Ollama Cloud treats 404 as a no-report and keeps the last-good row", async () => {
    let missing = false;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      if (missing) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({
        included: {
          session: { remaining_percent: 91, resets_at: "2026-10-08T04:00:00Z" },
          weekly: { remaining_percent: 40.8, resets_at: "2026-10-12T00:00:00Z" },
        },
      }), { status: 200 });
    }) as typeof fetch;
    const config = keyQuotaConfig("ollama-cloud", "https://ollama.com/v1");

    const seeded = await fetchProviderQuotaReports(config, true);
    expect(seeded.reports).toHaveLength(1);

    missing = true;
    seen.length = 0;
    const result = await fetchProviderQuotaReports(config, true);

    // A missing endpoint is not a rejected credential, so the last-good row survives.
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.quota).toMatchObject({ weeklyPercent: 59.2 });
    // Both endpoints are still attempted before the probe reports nothing.
    expect(seen).toEqual(["https://ollama.com/api/balance", "https://ollama.com/api/usage"]);
  });

  test("Ollama Cloud treats 401 as terminal failure (invalid key) and drops the last-good row", async () => {
    let rejected = false;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      if (rejected) return new Response(JSON.stringify({ error: "invalid credentials" }), { status: 401 });
      return new Response(JSON.stringify({
        included: {
          session: { remaining_percent: 91, resets_at: "2026-10-08T04:00:00Z" },
          weekly: { remaining_percent: 40.8, resets_at: "2026-10-12T00:00:00Z" },
        },
      }), { status: 200 });
    }) as typeof fetch;
    const config = keyQuotaConfig("ollama-cloud", "https://ollama.com/v1");

    const seeded = await fetchProviderQuotaReports(config, true);
    expect(seeded.reports).toHaveLength(1);

    rejected = true;
    seen.length = 0;
    const result = await fetchProviderQuotaReports(config, true);

    // A rejected credential is terminal, so the previously published row is cleared.
    expect(result.reports).toEqual([]);
    // Both endpoints are still attempted before the probe gives up.
    expect(seen).toEqual(["https://ollama.com/api/balance", "https://ollama.com/api/usage"]);
  });

  test("Ollama Cloud never sends the key to a non-canonical base URL", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      keyQuotaConfig("ollama-cloud", "https://attacker.example/v1"),
      true,
    );

    expect(result.reports).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("balance transport rejection falls back to usage and resolves the provider-quota promise", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer ollama-cloud-secret");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (url === "https://ollama.com/api/balance") throw new TypeError("transport unavailable");
      expect(url).toBe("https://ollama.com/api/usage");
      return Response.json({ limits: { weekly: { usage: 0.25 } } });
    }) as typeof fetch;

    const promise = fetchProviderQuotaReports(keyQuotaConfig("ollama-cloud", "https://ollama.com/v1"), true);
    await expect(promise).resolves.toMatchObject({
      reports: [{ source: "ollama-cloud:usage", quota: { weeklyPercent: 25 } }],
    });
    expect(seen).toEqual(["https://ollama.com/api/balance", "https://ollama.com/api/usage"]);
  });

  test.each([408, 429, 500, 503, 599])("balance %i cancels its unread body and falls back to usage", async (status) => {
    const seen: string[] = [];
    let cancelCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url === "https://ollama.com/api/balance") {
        return new Response(new ReadableStream({ cancel() { cancelCalls += 1; } }), { status });
      }
      expect(url).toBe("https://ollama.com/api/usage");
      return Response.json({ limits: { weekly: { usage: 0.25 } } });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("ollama-cloud", "https://ollama.com/v1"), true);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({ source: "ollama-cloud:usage", quota: { weeklyPercent: 25 } });
    expect(seen).toEqual(["https://ollama.com/api/balance", "https://ollama.com/api/usage"]);
    expect(cancelCalls).toBe(1);
  });

  test.each(["oversized", "transport"])("balance 401 then usage %s clears the last-good row", async (failure) => {
    const config = keyQuotaConfig("ollama-cloud", "https://ollama.com/v1");
    globalThis.fetch = (async () => Response.json({ included: { weekly: { remaining_percent: 75 } } })) as typeof fetch;
    expect((await fetchProviderQuotaReports(config, true)).reports).toHaveLength(1);

    const seen: string[] = [];
    let cancelCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url === "https://ollama.com/api/balance") {
        return new Response(new ReadableStream({
          cancel() { cancelCalls += 1; throw new Error("cancel unavailable"); },
        }), { status: 401 });
      }
      expect(url).toBe("https://ollama.com/api/usage");
      if (failure === "transport") throw new TypeError("transport unavailable");
      return declaredOversizeQuotaResponse(() => { cancelCalls += 1; });
    }) as typeof fetch;

    expect((await fetchProviderQuotaReports(config, true)).reports).toEqual([]);
    expect(seen).toEqual(["https://ollama.com/api/balance", "https://ollama.com/api/usage"]);
    expect(cancelCalls).toBe(failure === "oversized" ? 2 : 1);
  });

  test.each([400, 401, 403, 422, 499])("balance %i then usage 200 publishes the successful fallback", async (status) => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url === "https://ollama.com/api/balance") return new Response("rejected", { status });
      expect(url).toBe("https://ollama.com/api/usage");
      return Response.json({ limits: { weekly: { usage: 0.25 } } });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("ollama-cloud", "https://ollama.com/v1"), true);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({ source: "ollama-cloud:usage", quota: { weeklyPercent: 25 } });
    expect(seen).toEqual(["https://ollama.com/api/balance", "https://ollama.com/api/usage"]);
  });

  test.each([400, 403, 422, 499])("usage %i after unparseable balance clears the last-good row", async (status) => {
    const config = keyQuotaConfig("ollama-cloud", "https://ollama.com/v1");
    globalThis.fetch = (async () => Response.json({ included: { weekly: { remaining_percent: 75 } } })) as typeof fetch;
    expect((await fetchProviderQuotaReports(config, true)).reports).toHaveLength(1);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === "https://ollama.com/api/balance") return Response.json({ included: {} });
      expect(String(input)).toBe("https://ollama.com/api/usage");
      return new Response("rejected", { status });
    }) as typeof fetch;
    expect((await fetchProviderQuotaReports(config, true)).reports).toEqual([]);
  });

  test.each(["unavailable", "unparseable"])("unparseable balance then usage %s keeps the last-good row", async (fallback) => {
    const config = keyQuotaConfig("ollama-cloud", "https://ollama.com/v1");
    globalThis.fetch = (async () => Response.json({ included: { weekly: { remaining_percent: 75 } } })) as typeof fetch;
    const seeded = await fetchProviderQuotaReports(config, true);
    expect(seeded.reports).toHaveLength(1);
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url === "https://ollama.com/api/balance") return Response.json({ included: {}, purchased: { balance_usd: 99 } });
      expect(url).toBe("https://ollama.com/api/usage");
      return fallback === "unavailable" ? new Response("unavailable", { status: 503 }) : Response.json({ totals: { request_count: 123 } });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(config, true);
    expect(result.reports).toEqual(seeded.reports);
    expect(seen).toEqual(["https://ollama.com/api/balance", "https://ollama.com/api/usage"]);
  });

  test("balance windows without resets_at are still published", async () => {
    globalThis.fetch = (async () => Response.json({ included: { weekly: { remaining_percent: 56.48 } } })) as typeof fetch;
    const result = await fetchProviderQuotaReports(keyQuotaConfig("ollama-cloud", "https://ollama.com/v1"), true);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({ source: "ollama-cloud:balance", quota: { weeklyPercent: 43.52 } });
    expect(result.reports[0]?.quota.weeklyResetAt).toBeUndefined();
  });

  test("balance publishes mixed windows and included credits while ignoring purchased credits", async () => {
    globalThis.fetch = (async () => Response.json({
      included: {
        session: { remaining_percent: 90 },
        weekly: { remaining_percent: 56.48 },
        monthly: { remaining_percent: 60 },
        allowance_usd: 10,
        balance_usd: 3.5,
      },
      purchased: { balance_usd: 99 },
    })) as typeof fetch;
    const result = await fetchProviderQuotaReports(keyQuotaConfig("ollama-cloud", "https://ollama.com/v1"), true);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({
      source: "ollama-cloud:balance",
      quota: {
        fiveHourPercent: 10, weeklyPercent: 43.52, monthlyPercent: 40,
        creditsUsd: { used: 6.5, limit: 10, remaining: 3.5, percent: 65 },
      },
    });
  });

  test("balance invalid reset date omits the reset while keeping the window", () => {
    const quota = parseOllamaCloudBalance({ included: { weekly: { remaining_percent: 56.48, resets_at: "not-a-date" } } });
    expect(quota).toMatchObject({ weeklyPercent: 43.52 });
    expect(quota?.weeklyResetAt).toBeUndefined();
  });

  test.each([[150, 0], [-25, 100]])("balance remaining_percent %i clamps consumed percent to %i", (remaining, used) => {
    expect(parseOllamaCloudBalance({ included: { weekly: { remaining_percent: remaining } } })).toMatchObject({ weeklyPercent: used });
  });

  test("Ollama Cloud missing-key guard makes no fetch and publishes no row", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => { fetchCalls += 1; return Response.json({ included: { weekly: { remaining_percent: 75 } } }); }) as typeof fetch;
    const result = await fetchProviderQuotaReports(keyQuotaConfig("ollama-cloud", "https://ollama.com/v1", ""), true);
    expect(result.reports).toEqual([]);
    expect(fetchCalls).toBe(0);
  });

  test.each([{ disabled: true }, { authMode: "none" as const }])("Ollama Cloud ineligible %j makes no fetch and publishes no row", async (override) => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => { fetchCalls += 1; return Response.json({ included: { weekly: { remaining_percent: 75 } } }); }) as typeof fetch;
    const config = keyQuotaConfig("ollama-cloud", "https://ollama.com/v1");
    Object.assign(config.providers["ollama-cloud"]!, override);
    expect((await fetchProviderQuotaReports(config, true)).reports).toEqual([]);
    expect(fetchCalls).toBe(0);
  });

  test("parseOllamaCloudQuota handles edge cases", () => {
    expect(parseOllamaCloudQuota(null)).toBeNull();
    expect(parseOllamaCloudQuota({})).toBeNull();
    expect(parseOllamaCloudQuota({ limits: {} })).toBeNull();
    expect(parseOllamaCloudQuota({ limits: { session: { usage: 0 } } })).toMatchObject({
      fiveHourPercent: 0,
    });
    expect(parseOllamaCloudQuota({ limits: { session: { usage: 1 } } })).toMatchObject({
      fiveHourPercent: 100,
    });
    expect(parseOllamaCloudQuota({ limits: { session: { usage: 1.25 } } })).toMatchObject({
      fiveHourPercent: 100,
    });
  });

  test("parseOllamaCloudBalance handles edge cases", () => {
    expect(parseOllamaCloudBalance(null)).toBeNull();
    expect(parseOllamaCloudBalance({})).toBeNull();
    expect(parseOllamaCloudBalance({ included: {} })).toBeNull();
    expect(parseOllamaCloudBalance({ purchased: { balance_usd: 12 } })).toBeNull();
    // remaining_percent is the remaining share, so the reported percent is used.
    expect(parseOllamaCloudBalance({ included: { session: { remaining_percent: 0 } } })).toMatchObject({
      fiveHourPercent: 100,
    });
    expect(parseOllamaCloudBalance({ included: { session: { remaining_percent: 100 } } })).toMatchObject({
      fiveHourPercent: 0,
    });
    // Older deployments report usage fractions instead of remaining shares.
    expect(parseOllamaCloudBalance({ included: { weekly: { usage: 0.25 } } })).toMatchObject({
      weeklyPercent: 25,
    });
    expect(parseOllamaCloudBalance({ included: { monthly: { remaining_percent: 60 } } })).toMatchObject({
      monthlyPercent: 40,
    });
    expect(parseOllamaCloudBalance({ included: { session: { remaining_percent: "n/a" } } })).toBeNull();
    // A credit plan reports the included allowance as dollars, not as windows.
    expect(parseOllamaCloudBalance({
      included: { balance_usd: 0, allowance_usd: 0 },
    })).toBeNull();
    expect(parseOllamaCloudBalance({
      included: { balance_usd: 7.25, allowance_usd: 10 },
    })?.creditsUsd).toMatchObject({ used: 2.75, limit: 10, remaining: 7.25, percent: 27.5 });
  });
});
