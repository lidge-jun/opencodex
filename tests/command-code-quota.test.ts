import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredential } from "../src/oauth/store";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../src/providers/quota";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
let opencodexHome: string;

function commandCodeConfig(baseUrl = "https://api.commandcode.ai/provider/v1"): OcxConfig {
  return {
    defaultProvider: "commandcode",
    providers: {
      commandcode: {
        adapter: "openai-chat",
        authMode: "key",
        baseUrl,
        apiKey: "commandcode-secret",
      },
    },
  } as OcxConfig;
}

function commandCodeOAuthConfig(baseUrl = "https://api.commandcode.ai"): OcxConfig {
  return {
    defaultProvider: "command-code",
    providers: {
      "command-code": {
        adapter: "command-code",
        authMode: "oauth",
        baseUrl,
      },
    },
  } as OcxConfig;
}

beforeEach(() => {
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-command-code-quota-"));
  process.env.OPENCODEX_HOME = opencodexHome;
  clearProviderQuotaCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearProviderQuotaCache();
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  rmSync(opencodexHome, { recursive: true, force: true });
});

describe("Command Code provider quota", () => {
  test("maps billing credits windows plus subscription-scoped spend into quota", async () => {
    const seen: Array<{ url: string; authorization?: string; redirect?: RequestRedirect }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({
        url: String(input),
        authorization: headers?.Authorization,
        redirect: init?.redirect,
      });
      const url = String(input);
      const body = url.includes("/alpha/whoami")
        ? { org: { id: "team-org-7" } }
        : url.includes("/alpha/billing/subscriptions")
          ? { data: { planId: "individual-pro", currentPeriodStart: "2026-08-01T00:00:00.000Z", currentPeriodEnd: "2026-09-01T00:00:00.000Z" } }
          : url.includes("/alpha/usage/summary")
            ? { totalCost: 15 }
            : {
        credits: { monthlyCredits: 20, purchasedCredits: 5, freeCredits: 1 },
        windowLimits: {
          fiveHour: { cap: 100, used: 40, resetAt: "2026-08-15T20:00:00.000Z" },
          weekly: { cap: 500, used: 25, resetAt: "2026-08-18T00:00:00.000Z" },
          exceeded: null,
          limited: false,
        },
        };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(commandCodeConfig(), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.provider).toBe("commandcode");
    expect(result.reports[0]?.source).toBe("command-code:credits");
    expect(result.reports[0]?.quota).toEqual({
      fiveHourPercent: 40,
      fiveHourResetAt: Date.parse("2026-08-15T20:00:00.000Z"),
      weeklyPercent: 5,
      weeklyResetAt: Date.parse("2026-08-18T00:00:00.000Z"),
      creditsUsd: {
        used: 15,
        limit: 41,
        remaining: 26,
        percent: 36.585365853658534,
      },
      updatedAt: expect.any(Number),
    });
    expect(seen).toEqual([{
      url: "https://api.commandcode.ai/alpha/whoami",
      authorization: "Bearer commandcode-secret",
      redirect: "error",
    }, {
      url: "https://api.commandcode.ai/alpha/billing/credits?orgId=team-org-7",
      authorization: "Bearer commandcode-secret",
      redirect: "error",
    }, {
      url: "https://api.commandcode.ai/alpha/billing/subscriptions?orgId=team-org-7",
      authorization: "Bearer commandcode-secret",
      redirect: "error",
    }, {
      url: "https://api.commandcode.ai/alpha/usage/summary?orgId=team-org-7&since=2026-08-01T00%3A00%3A00.000Z",
      authorization: "Bearer commandcode-secret",
      redirect: "error",
    }]);
    expect(JSON.stringify(result)).not.toContain("commandcode-secret");
  });

  test("omits a zero Command Code window reset instead of treating it as the Unix epoch", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.commandcode.ai/alpha/whoami"
        || url === "https://api.commandcode.ai/alpha/billing/subscriptions"
        || url === "https://api.commandcode.ai/alpha/usage/summary") {
        return new Response("down", { status: 500 });
      }
      if (url !== "https://api.commandcode.ai/alpha/billing/credits") {
        throw new Error(`unexpected Command Code quota probe: ${url}`);
      }
      return new Response(JSON.stringify({
        windowLimits: {
          fiveHour: { cap: 14, used: 0, resetAt: 0 },
          weekly: { cap: 35, used: 34.9522404823, resetAt: 1_787_184_801_319 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(commandCodeConfig(), true);

    expect(result.reports[0]?.quota).toEqual({
      fiveHourPercent: 0,
      weeklyPercent: 99.86354423514285,
      weeklyResetAt: 1_787_184_801_319,
      updatedAt: expect.any(Number),
    });
    expect(result.reports[0]?.quota).not.toHaveProperty("fiveHourResetAt");
  });

  test("omits a signed numeric Command Code window reset instead of Date.parse-ing it", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.commandcode.ai/alpha/whoami"
        || url === "https://api.commandcode.ai/alpha/billing/subscriptions"
        || url === "https://api.commandcode.ai/alpha/usage/summary") {
        return new Response("down", { status: 500 });
      }
      if (url !== "https://api.commandcode.ai/alpha/billing/credits") {
        throw new Error(`unexpected Command Code quota probe: ${url}`);
      }
      return new Response(JSON.stringify({
        windowLimits: {
          fiveHour: { cap: 14, used: 0, resetAt: "-1" },
          weekly: { cap: 35, used: 34.9522404823, resetAt: 1_787_184_801_319 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(commandCodeConfig(), true);

    expect(result.reports[0]?.quota).toEqual({
      fiveHourPercent: 0,
      weeklyPercent: 99.86354423514285,
      weeklyResetAt: 1_787_184_801_319,
      updatedAt: expect.any(Number),
    });
    expect(result.reports[0]?.quota).not.toHaveProperty("fiveHourResetAt");
  });

  test("keeps rolling windows when whoami and usage summary fail", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("/alpha/whoami")) return new Response("down", { status: 500 });
      if (url.includes("/alpha/billing/subscriptions")) {
        return new Response(JSON.stringify({
          data: { currentPeriodStart: "2026-08-01T00:00:00.000Z" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/alpha/usage/summary")) return new Response("down", { status: 500 });
      return new Response(JSON.stringify({
        credits: { monthlyCredits: 20 },
        windowLimits: { fiveHour: { cap: 100, used: 40 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(commandCodeConfig(), true);

    expect(result.reports[0]?.quota).toEqual({
      fiveHourPercent: 40,
      updatedAt: expect.any(Number),
    });
    expect(seen[1]).toBe("https://api.commandcode.ai/alpha/billing/credits");
    expect(seen.some(url => url.includes("/alpha/usage/summary"))).toBe(true);
  });

  test("omits creditsUsd when the billing period cannot be established", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("/alpha/whoami")) return new Response("{}", { status: 200 });
      if (url.includes("/alpha/billing/subscriptions")) return new Response("down", { status: 500 });
      if (url.includes("/alpha/usage/summary")) {
        return new Response(JSON.stringify({ totalCost: 999 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        credits: { monthlyCredits: 20, purchasedCredits: 5, freeCredits: 1 },
        windowLimits: { fiveHour: { cap: 100, used: 40 }, weekly: { cap: 500, used: 25 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(commandCodeConfig(), true);

    expect(result.reports[0]?.quota).toEqual({
      fiveHourPercent: 40,
      weeklyPercent: 5,
      updatedAt: expect.any(Number),
    });
    expect(result.reports[0]?.quota?.creditsUsd).toBeUndefined();
    expect(seen.some(url => url.includes("/alpha/usage/summary"))).toBe(false);
  });

  test("unwraps a data envelope on credits and spend payloads", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/alpha/whoami")
        ? { data: { org: { id: "team-org-7" } } }
        : url.includes("/alpha/billing/subscriptions")
          ? { data: { currentPeriodStart: "2026-08-01T00:00:00.000Z", currentPeriodEnd: "2026-09-01T00:00:00.000Z" } }
          : url.includes("/alpha/usage/summary")
            ? { data: { totalCost: 10 } }
            : {
              data: {
                credits: { monthlyCredits: 20 },
                windowLimits: { fiveHour: { cap: 100, used: 25 } },
              },
            };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(commandCodeConfig(), true);

    expect(result.reports[0]?.quota).toEqual({
      fiveHourPercent: 25,
      creditsUsd: {
        used: 10,
        limit: 30,
        remaining: 20,
        percent: 33.33333333333333,
        expiresAt: Date.parse("2026-09-01T00:00:00.000Z"),
      },
      updatedAt: expect.any(Number),
    });
  });

  test("treats a terminal 401 as invalid", async () => {
    let rejected = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/alpha/whoami")) return new Response("{}", { status: 200 });
      if (rejected) return new Response("unauthorized", { status: 401 });
      return new Response(JSON.stringify({
        windowLimits: { fiveHour: { cap: 100, used: 40 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const valid = await fetchProviderQuotaReports(commandCodeConfig(), true);
    rejected = true;
    const invalid = await fetchProviderQuotaReports(commandCodeConfig(), true);

    expect(valid.reports).toHaveLength(1);
    expect(invalid.reports).toEqual([]);
  });

  test("does not probe quota for forward or local Command Code auth", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports({
      defaultProvider: "commandcode",
      providers: {
        commandcode: {
          adapter: "openai-chat",
          authMode: "forward",
          baseUrl: "https://api.commandcode.ai/provider/v1",
          apiKey: "commandcode-secret",
        },
      },
    } as OcxConfig, true);

    expect(fetchCalls).toBe(0);
    expect(result.reports).toEqual([]);
  });

  test("does not probe quota for local Command Code auth", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports({
      defaultProvider: "command-code",
      providers: {
        "command-code": {
          adapter: "command-code",
          authMode: "local",
          baseUrl: "https://api.commandcode.ai",
        },
      },
    } as OcxConfig, true);

    expect(fetchCalls).toBe(0);
    expect(result.reports).toEqual([]);
  });

  test("a fully exhausted account still reports a zero-remaining credit window", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/alpha/whoami")
        ? {}
        : url.includes("/alpha/billing/subscriptions")
          ? { data: { currentPeriodStart: "2026-08-01T00:00:00.000Z", currentPeriodEnd: "2026-09-01T00:00:00.000Z" } }
          : url.includes("/alpha/usage/summary")
            ? { totalCost: 12 }
            : {
              credits: { monthlyCredits: 0, purchasedCredits: 0, freeCredits: 0 },
              windowLimits: { fiveHour: { cap: 100, used: 40 } },
            };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(commandCodeConfig(), true);

    expect(result.reports[0]?.quota).toEqual({
      fiveHourPercent: 40,
      creditsUsd: {
        used: 12,
        limit: 12,
        remaining: 0,
        percent: 100,
        expiresAt: Date.parse("2026-09-01T00:00:00.000Z"),
      },
      updatedAt: expect.any(Number),
    });
  });

  // An out-of-range period end is not merely a wrong date: every consumer that formats it
  // through Intl throws a RangeError. Drop the field and keep the usable credit figures.
  test("an out-of-range subscription period end is dropped, not carried into the report", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/alpha/whoami")
        ? {}
        : url.includes("/alpha/billing/subscriptions")
          ? { data: { currentPeriodStart: "2026-08-01T00:00:00.000Z", currentPeriodEnd: 1e20 } }
          : url.includes("/alpha/usage/summary")
            ? { totalCost: 12 }
            : {
              credits: { monthlyCredits: 0, purchasedCredits: 0, freeCredits: 0 },
              windowLimits: { fiveHour: { cap: 100, used: 40 } },
            };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(commandCodeConfig(), true);

    expect(result.reports[0]?.quota).toEqual({
      fiveHourPercent: 40,
      creditsUsd: {
        used: 12,
        limit: 12,
        remaining: 0,
        percent: 100,
      },
      updatedAt: expect.any(Number),
    });
  });

  test("a mixed balance with roll-over purchased credits carries no subscription expiry", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/alpha/whoami")
        ? {}
        : url.includes("/alpha/billing/subscriptions")
          ? { data: { currentPeriodStart: "2026-08-01T00:00:00.000Z", currentPeriodEnd: "2026-08-31T00:00:00.000Z" } }
          : url.includes("/alpha/usage/summary")
            ? { totalCost: 4 }
            : {
              credits: { monthlyCredits: 0, purchasedCredits: 10, freeCredits: 0 },
              windowLimits: { fiveHour: { cap: 100, used: 10 } },
            };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(commandCodeConfig(), true);

    expect(result.reports[0]?.quota?.creditsUsd).toEqual({
      used: 4,
      limit: 14,
      remaining: 10,
      percent: 28.57142857142857,
    });
  });

  test("OAuth Command Code probes the canonical API root with the stored bearer", async () => {
    await saveCredential("command-code", {
      access: "command-code-access",
      refresh: "command-code-access",
      expires: Date.now() + 3600_000,
    });
    const seen: Array<{ url: string; authorization?: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({ url: String(input), authorization: headers?.Authorization });
      const url = String(input);
      if (url.includes("/alpha/whoami") || url.includes("/alpha/billing/subscriptions") || url.includes("/alpha/usage/summary")) {
        return new Response("down", { status: 500 });
      }
      return new Response(JSON.stringify({
        windowLimits: { weekly: { cap: 200, used: 50 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(commandCodeOAuthConfig(), true);

    expect(result.reports[0]?.provider).toBe("command-code");
    expect(result.reports[0]?.quota).toEqual({
      weeklyPercent: 25,
      updatedAt: expect.any(Number),
    });
    expect(seen[0]).toEqual({
      url: "https://api.commandcode.ai/alpha/whoami",
      authorization: "Bearer command-code-access",
    });
    expect(JSON.stringify(result)).not.toContain("command-code-access");
  });

  test("does not probe quota for a noncanonical Command Code destination", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      commandCodeConfig("https://example.invalid/provider/v1"),
      true,
    );

    expect(fetchCalls).toBe(0);
    expect(result.reports).toEqual([]);
  });
});
