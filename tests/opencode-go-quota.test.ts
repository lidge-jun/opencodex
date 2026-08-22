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

  // #1924: a multi-account setup points several rows at the same OpenCode Go endpoint under
  // names the registry has never heard of. Gating dispatch on the literal name `opencode-go`
  // meant those rows had no dashboard quota panel and no `ocx provider quota --json` report,
  // even though each one holds a working key for the same upstream.
  test("a canonical sibling row under any name is probed and reported", async () => {
    const bearers: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers?.Authorization) bearers.push(headers.Authorization);
      return new Response(JSON.stringify({
        usage: { rolling: { status: "ok", percent: 12, resetsAt: "2026-08-12T20:00:00.000Z" } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const config = openCodeGoConfig();
    config.providers["opencode-go-2"] = {
      adapter: "openai-chat",
      authMode: "key",
      baseUrl: "https://opencode.ai/zen/go/v1",
      // Kept under the privacy scanner's bearer-token length floor: a longer fixture reads as
      // a real credential to `privacy:scan` even inside a test.
      apiKey: "sibling-secret",
    };

    const result = await fetchProviderQuotaReports(config, true);

    expect(result.reports.map(report => report.provider).sort()).toEqual(["opencode-go", "opencode-go-2"]);
    expect(bearers.sort()).toEqual(["Bearer opencode-go-secret", "Bearer sibling-secret"]);
    expect(JSON.stringify(result)).not.toContain("sibling-secret");
  });

  // The distinction between "routes to the OpenCode Go endpoint" and "is the OpenCode Go
  // provider": a bare URL match would probe this row, but a different adapter speaks a
  // different protocol to that host and is not the provider whose quota shape we parse.
  test("a canonical URL behind a different adapter is not OpenCode Go", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports({
      defaultProvider: "not-really-go",
      providers: {
        "not-really-go": {
          adapter: "anthropic",
          authMode: "key",
          baseUrl: "https://opencode.ai/zen/go/v1",
          apiKey: "unrelated-secret",
        },
      },
    } as OcxConfig, true);

    expect(fetchCalls).toBe(0);
    expect(result.reports).toEqual([]);
  });
});
