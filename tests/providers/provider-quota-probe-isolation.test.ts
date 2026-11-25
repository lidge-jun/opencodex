import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearProviderQuotaCache,
  fetchProviderApiKeyQuotas,
  fetchProviderQuotaReports,
} from "../../src/providers/quota";
import { clearProviderApiKeyQuotaCache } from "../../src/providers/quota-key-accounts";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
let opencodexHome: string;

function multiKeyProviderConfig(): OcxConfig {
  return {
    defaultProvider: "openrouter",
    providers: {
      openrouter: {
        adapter: "openai-chat",
        authMode: "key",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "or-secret-key",
      },
      deepseek: {
        adapter: "openai-chat",
        authMode: "key",
        baseUrl: "https://api.deepseek.com",
        apiKey: "ds-secret-key",
      },
    },
  } as OcxConfig;
}

function deepSeekOkResponse(totalBalance = "6.00"): Response {
  return new Response(JSON.stringify({
    is_available: true,
    balance_infos: [{ currency: "USD", total_balance: totalBalance }],
  }), { status: 200 });
}

function openRouterOkResponse(limit = 10, limitRemaining = 7.5): Response {
  return new Response(JSON.stringify({
    data: { limit, limit_remaining: limitRemaining },
  }), { status: 200 });
}

beforeEach(() => {
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-quota-isolation-"));
  process.env.OPENCODEX_HOME = opencodexHome;
  clearProviderQuotaCache();
  clearProviderApiKeyQuotaCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearProviderQuotaCache();
  clearProviderApiKeyQuotaCache();
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  removeTreeWithRetry(opencodexHome);
});

describe("provider quota probe error isolation", () => {
  test("OpenRouter ECONNRESET does not fail /api/provider-quotas for healthy providers", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://openrouter.ai/")) {
        throw new TypeError("ECONNRESET: The socket connection was closed unexpectedly.");
      }
      if (url.startsWith("https://api.deepseek.com/")) {
        return deepSeekOkResponse("6.00");
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(multiKeyProviderConfig(), true);

    expect(result.reports.map(r => r.provider)).toEqual(["deepseek"]);
    expect(result.reports[0]?.source).toBe("deepseek:balance");
  });

  test("DeepSeek ENOTFOUND does not fail /api/provider-quotas for healthy providers", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://api.deepseek.com/")) {
        throw new TypeError("getaddrinfo ENOTFOUND api.deepseek.com");
      }
      if (url.startsWith("https://openrouter.ai/")) {
        return openRouterOkResponse(10, 7.5);
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(multiKeyProviderConfig(), true);

    expect(result.reports.map(r => r.provider)).toEqual(["openrouter"]);
    expect(result.reports[0]?.source).toBe("openrouter:key-info");
  });

  test("transient thrown network error preserves the failing provider's last-good cached report", async () => {
    const config = multiKeyProviderConfig();
    let failOpenRouter = false;

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://openrouter.ai/")) {
        if (failOpenRouter) throw new TypeError("ECONNRESET: The socket connection was closed unexpectedly.");
        return openRouterOkResponse(10, 7.5);
      }
      if (url.startsWith("https://api.deepseek.com/")) {
        return deepSeekOkResponse(failOpenRouter ? "5.00" : "6.00");
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }) as typeof fetch;

    const initial = await fetchProviderQuotaReports(config, true);
    expect(initial.reports.map(r => r.provider).sort()).toEqual(["deepseek", "openrouter"]);

    failOpenRouter = true;
    const degraded = await fetchProviderQuotaReports(config, true);

    expect(degraded.reports.map(r => r.provider).sort()).toEqual(["deepseek", "openrouter"]);
    const deepseek = degraded.reports.find(r => r.provider === "deepseek");
    const openrouter = degraded.reports.find(r => r.provider === "openrouter");
    expect(deepseek?.quota.customWindows?.[0]?.label).toBe("API balance ($5.00)");
    expect(openrouter?.quota.customWindows?.[0]?.label).toContain("$7.50 of $10.00 remaining");
  });

  test("all vendor probes throwing resolves with an empty report list", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("getaddrinfo ENOTFOUND upstream");
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(multiKeyProviderConfig(), true);

    expect(result.reports).toEqual([]);
  });

  test("fetchProviderApiKeyQuotas isolates thrown network errors as unavailable", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("ECONNRESET: The socket connection was closed unexpectedly.");
    }) as typeof fetch;

    const rows = await fetchProviderApiKeyQuotas(multiKeyProviderConfig(), "openrouter", true);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.unavailable).toBe(true);
    expect(rows[0]?.quota).toBeNull();
  });
});
