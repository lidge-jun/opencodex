import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../src/providers/quota";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;

function openCodeGoConfig(baseUrl = "https://opencode.ai/zen/go/v1"): OcxConfig {
  return {
    defaultProvider: "opencode-go",
    providers: {
      "opencode-go": {
        adapter: "openai-chat",
        authMode: "key",
        baseUrl,
        apiKey: "opencode-go-secret",
      },
    },
  } as OcxConfig;
}

beforeEach(() => {
  clearProviderQuotaCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearProviderQuotaCache();
});

describe("OpenCode Go provider quota", () => {
  test("maps the official usage endpoint into canonical quota windows", async () => {
    const seen: Array<{ url: string; authorization?: string; redirect?: RequestRedirect }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({
        url: String(input),
        authorization: headers?.Authorization,
        redirect: init?.redirect,
      });
      return new Response(JSON.stringify({
        usage: {
          rolling: { status: "ok", percent: 12, resetsAt: "2026-08-12T20:00:00.000Z" },
          weekly: { status: "ok", percent: 8, resetsAt: "2026-08-17T00:00:00.000Z" },
          monthly: { status: "ok", percent: 35, resetsAt: "2026-09-01T00:00:00.000Z" },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(openCodeGoConfig(), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.provider).toBe("opencode-go");
    expect(result.reports[0]?.source).toBe("opencode-go:usage");
    expect(result.reports[0]?.quota).toEqual({
      fiveHourPercent: 12,
      fiveHourResetAt: Date.parse("2026-08-12T20:00:00.000Z"),
      weeklyPercent: 8,
      weeklyResetAt: Date.parse("2026-08-17T00:00:00.000Z"),
      monthlyPercent: 35,
      monthlyResetAt: Date.parse("2026-09-01T00:00:00.000Z"),
      updatedAt: expect.any(Number),
    });
    expect(seen).toEqual([{
      url: "https://opencode.ai/zen/go/v1/usage",
      authorization: "Bearer opencode-go-secret",
      redirect: "error",
    }]);
    expect(JSON.stringify(result)).not.toContain("opencode-go-secret");
  });

  test("does not probe quota for a noncanonical OpenCode Go destination", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        usage: {
          rolling: { percent: 1, resetsAt: "2026-08-12T20:00:00.000Z" },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      openCodeGoConfig("https://example.invalid/zen/go/v1"),
      true,
    );

    expect(fetchCalls).toBe(0);
    expect(result.reports).toEqual([]);
  });
});

describe("OpenCode Go provider quota (canonical base URL gating, #1924)", () => {
  test("reports quota for every key-auth provider on the canonical Go base URL, not just the literal name", async () => {
    const seen: Array<{ url: string; authorization?: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({ url: String(input), authorization: headers?.Authorization });
      return new Response(
        JSON.stringify({
          usage: {
            rolling: { status: "ok", percent: 10, resetsAt: "2026-08-12T20:00:00.000Z" },
            weekly: { status: "ok", percent: 20, resetsAt: "2026-08-17T00:00:00.000Z" },
            monthly: { status: "ok", percent: 30, resetsAt: "2026-09-01T00:00:00.000Z" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const config = openCodeGoConfig();
    config.providers = {
      ...config.providers,
      "opencode-go-2": {
        adapter: "openai-chat",
        authMode: "key",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "opencode-go-secret-2",
      },
    };

    const result = await fetchProviderQuotaReports(config, true);

    // Before #1924's fix only the provider literally named "opencode-go"
    // produced a report; the sibling on the same canonical base URL was silent.
    expect(result.reports.map((r: { provider: string }) => r.provider).sort()).toEqual([
      "opencode-go",
      "opencode-go-2",
    ]);
    expect(seen).toHaveLength(2);
  });

  test("does not probe the Go usage endpoint for providers on other base URLs", async () => {
    const seen: Array<string> = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ usage: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const config = openCodeGoConfig("https://api.example.com/v1");
    const result = await fetchProviderQuotaReports(config, true);

    // The bearer key must never leave for a non-canonical host just because
    // the provider is named opencode-go.
    expect(result.reports).toHaveLength(0);
    expect(seen.filter((u) => u.includes("opencode.ai"))).toHaveLength(0);
  });
});
