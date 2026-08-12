import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../src/providers/quota";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;

function openCodeGoConfig(): OcxConfig {
  return {
    defaultProvider: "opencode-go",
    providers: {
      "opencode-go": {
        adapter: "openai-chat",
        authMode: "key",
        baseUrl: "https://opencode.ai/zen/v1",
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
  test("maps rolling, weekly, and monthly usage from the Go usage endpoint", async () => {
    const seen: Array<{ url: string; authorization: string | null; redirect?: RequestRedirect }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, authorization: headers.get("authorization"), redirect: init?.redirect });
      if (url !== "https://opencode.ai/zen/go/v1/usage") {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify({
        usage: {
          rolling: { percent: 12, resetsAt: "2026-08-12T18:00:00Z" },
          weekly: { percent: 8, resetsAt: "2026-08-17T00:00:00Z" },
          monthly: { percent: 35, resetsAt: "2026-09-01T00:00:00Z" },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(openCodeGoConfig(), true);

    expect(seen).toEqual([{
      url: "https://opencode.ai/zen/go/v1/usage",
      authorization: "Bearer opencode-go-secret",
      redirect: "error",
    }]);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.provider).toBe("opencode-go");
    expect(result.reports[0]?.source).toBe("opencode-go:usage");
    expect(result.reports[0]?.quota).toEqual({
      fiveHourPercent: 12,
      fiveHourResetAt: Date.parse("2026-08-12T18:00:00Z"),
      weeklyPercent: 8,
      weeklyResetAt: Date.parse("2026-08-17T00:00:00Z"),
      monthlyPercent: 35,
      monthlyResetAt: Date.parse("2026-09-01T00:00:00Z"),
      updatedAt: expect.any(Number),
    });
    expect(JSON.stringify(result)).not.toContain("opencode-go-secret");
  });
});
