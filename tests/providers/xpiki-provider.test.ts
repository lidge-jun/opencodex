import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../../src/providers/quota";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
let opencodexHome: string;

function xpikiConfig(baseUrl = "https://api.xpiki.com/v1", apiKey = "xpiki-test-key-123"): OcxConfig {
  return {
    defaultProvider: "xpiki",
    providers: {
      xpiki: {
        adapter: "openai-chat",
        authMode: "key",
        baseUrl,
        apiKey,
      },
    },
  } as OcxConfig;
}

beforeEach(() => {
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-xpiki-provider-"));
  process.env.OPENCODEX_HOME = opencodexHome;
  clearProviderQuotaCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearProviderQuotaCache();
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  removeTreeWithRetry(opencodexHome);
});

describe("Xpiki API provider", () => {
  test("registry entry has correct attributes", () => {
    const entry = PROVIDER_REGISTRY.find(p => p.id === "xpiki");
    expect(entry).toBeDefined();
    expect(entry?.label).toBe("Xpiki API");
    expect(entry?.authKind).toBe("key");
    expect(entry?.adapter).toBe("openai-chat");
    expect(entry?.baseUrl).toBe("https://api.xpiki.com/v1");
    expect(entry?.dashboardUrl).toBe("https://api.xpiki.com/key");
    expect(entry?.defaultModel).toBe("claude-opus-5-5");
    expect(entry?.models).toContain("claude-opus-5-5");
    expect(entry?.models).toContain("claude-opus-5");
  });

  test("quota probe renders shared key balance as model token-capacity bars", async () => {
    let seenAuth = "";
    let seenMethod = "";
    let seenUrl = "";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenMethod = init?.method ?? "GET";
      seenAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      return new Response(JSON.stringify({
        code: 0,
        message: "ok",
        data: {
          allowed_models: [
            { slug: "claude-sonnet-5", display_name: "claude-sonnet-5" },
            { slug: "claude-opus-5-5", display_name: "claude-opus-5-5" },
          ],
          quota_limit: 15_000_000,
          quota_used: 1_500_000,
          remaining: 13_500_000,
          conversion: {
            models: [
              { slug: "claude-sonnet-5", input_price_per_1m: 90_000, output_price_per_1m: 450_000 },
              { slug: "claude-opus-5-5", input_price_per_1m: 150_000, output_price_per_1m: 750_000 },
              { slug: "not-allowed", input_price_per_1m: 1, output_price_per_1m: 1 },
            ],
          },
        },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(xpikiConfig(), true);
    expect(seenUrl).toBe("https://api.xpiki.com/api/public/key-status");
    expect(seenMethod).toBe("POST");
    expect(seenAuth).toBe("Bearer xpiki-test-key-123");
    expect(result.reports).toHaveLength(1);
    const report = result.reports[0]!;
    expect(report.source).toBe("xpiki:key-status");

    const customWindows = report.quota.customWindows;
    expect(customWindows).toHaveLength(2);
    expect(customWindows![0]?.label).toContain("claude-sonnet-5");
    expect(customWindows![0]?.label).toContain("shared balance");
    expect(customWindows![0]?.label).toContain("166.7M input / 33.3M output tokens capacity");
    expect(customWindows![0]?.label).toContain("150M / 30M remaining");
    expect(customWindows![0]?.percent).toBe(10);
    expect(customWindows![1]?.label).toContain("claude-opus-5-5");
    expect(customWindows![1]?.label).toContain("100M input / 20M output tokens capacity");
    expect(customWindows![1]?.label).toContain("90M / 18M remaining");
    expect(customWindows![1]?.percent).toBe(10);
  });

  test("quota probe flags terminal failure on 401 bad API key", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url) === "https://api.xpiki.com/api/public/key-status") {
        return new Response(JSON.stringify({ code: 401, message: "unauthorized" }), { status: 401 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(xpikiConfig(), true);
    // TERMINAL_QUOTA_FAILURE suppresses report publication on bad key
    expect(result.reports).toHaveLength(0);
  });

  test("quota probe stays silent on non-canonical destinations", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(xpikiConfig("https://proxy.example.com/v1"), true);
    expect(called).toBe(false);
    expect(result.reports).toHaveLength(0);
  });
});
