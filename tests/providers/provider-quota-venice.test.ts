import { afterEach, beforeEach, expect, test } from "bun:test";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../../src/providers/quota";
import type { OcxConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
const config = (baseUrl: string): OcxConfig => ({
  defaultProvider: "venice",
  providers: { venice: { adapter: "openai-chat", authMode: "key", baseUrl, apiKey: "test-secret" } },
}) as OcxConfig;

beforeEach(() => clearProviderQuotaCache());
afterEach(() => { globalThis.fetch = originalFetch; clearProviderQuotaCache(); });

test("Venice falls back when billing rejects", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    if (seen.length === 1) throw new Error("billing unavailable");
    return Response.json({ data: { balances: { DIEM: 90.5, USD: 25.25 } } });
  }) as typeof fetch;
  const result = await fetchProviderQuotaReports(config("https://api.venice.ai/api/v1"), true);
  expect(seen).toEqual([
    "https://api.venice.ai/api/v1/billing/balance",
    "https://api.venice.ai/api/v1/api_keys/rate_limits",
  ]);
  expect(result.reports[0]?.quota.customWindows).toEqual([
    { label: "DIEM balance (90.50)", percent: 0 },
    { label: "USD balance ($25.25)", percent: 0 },
  ]);
});

test("Venice rejects noncanonical and lookalike hosts without sending credentials", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  for (const url of ["https://api.venice.ai.attacker.example/api/v1", "https://attacker.example/api/v1", "http://api.venice.ai/api/v1", "https://api.venice.ai:444/api/v1"]) {
    const result = await fetchProviderQuotaReports(config(url), true);
    expect(result.reports).toEqual([]);
  }
  expect(seen).toEqual([]);
});
