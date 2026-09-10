import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { clearProviderQuotaCache, fetchProviderQuotaReports, providerApiKeyQuotaMode } from "../../src/providers/quota";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

// Issue #4201: the BigModel Coding Plan Responses preset is the same domestic subscription as the
// Chat preset on a different wire, but keyQuotaReaderForProvider() admitted provider names
// zai/glm/glm-cn/zhipu-bigmodel-coding only, so providerApiKeyQuotaMode() answered "unsupported"
// and fetchProviderApiKeyQuotas() returned an empty list before any request was made. The
// destination check already accepted https://open.bigmodel.cn/api/v1; only the name list omitted
// the preset. These cases pin the eligibility AND the guards that make it safe: admitting a name
// must not admit that name on a destination BigModel does not serve, because the domestic monitor
// takes the API key in a bare Authorization header with no scheme.
const RESPONSES_ID = "zhipu-bigmodel-responses";
const CANONICAL_BASE_URL = "https://open.bigmodel.cn/api/v1";
const MONITOR_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";

const originalFetch = globalThis.fetch;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
let opencodexHome: string;

function keyProvider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { adapter: "openai-responses", authMode: "key", baseUrl: CANONICAL_BASE_URL, apiKey: "bigmodel-secret", ...overrides };
}

function keyQuotaConfig(name: string, provider: OcxProviderConfig): OcxConfig {
  return { defaultProvider: name, providers: { [name]: provider } } as OcxConfig;
}

function quotaLimitsResponse(): Response {
  return new Response(JSON.stringify({
    success: true,
    data: {
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 30, nextResetTime: 1789000000000 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 60, nextResetTime: 1789600000000 },
      ],
    },
  }), { status: 200 });
}

beforeEach(() => {
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-bigmodel-responses-quota-"));
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

describe("BigModel Responses preset quota eligibility", () => {
  test("the preset is probe-eligible on the destination its own registry entry ships", () => {
    // Anchored to the registry rather than a hand-typed URL: if the preset's destination ever
    // moves, this fails instead of silently proving eligibility for a URL nobody serves.
    expect(getProviderRegistryEntry(RESPONSES_ID)?.baseUrl).toBe(CANONICAL_BASE_URL);
    expect(providerApiKeyQuotaMode(RESPONSES_ID, keyProvider())).toBe("probe");
    // The Chat preset keeps its existing eligibility; this is an addition, not a swap.
    expect(providerApiKeyQuotaMode("zhipu-bigmodel-coding", keyProvider({
      adapter: "openai-chat", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    }))).toBe("probe");
  });

  test("eligibility still requires a canonical destination and a key auth mode", () => {
    for (const provider of [
      // A same-named custom provider pointed somewhere else.
      keyProvider({ baseUrl: "https://custom.example.test/api/v1" }),
      // The pay-as-you-go endpoint, which is not the Coding Plan subscription.
      keyProvider({ baseUrl: "https://open.bigmodel.cn/api/paas/v4" }),
      keyProvider({ disabled: true }),
      keyProvider({ authMode: "forward" }),
      keyProvider({ authMode: "oauth" }),
    ]) {
      expect(providerApiKeyQuotaMode(RESPONSES_ID, provider)).toBe("unsupported");
    }
  });

  test("the preset probes the domestic monitor endpoint with the bare-key Authorization", async () => {
    const seen: Array<{ url: string; authorization?: string; redirect?: RequestRedirect }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({ url: String(input), authorization: headers?.Authorization, redirect: init?.redirect });
      return quotaLimitsResponse();
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig(RESPONSES_ID, keyProvider()), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.provider).toBe(RESPONSES_ID);
    expect(result.reports[0]?.source).toBe("zai:quota-limit");
    expect(result.reports[0]?.quota).toMatchObject({ fiveHourPercent: 30, weeklyPercent: 60 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(MONITOR_URL);
    // No "Bearer " prefix: open.bigmodel.cn answers a Bearer header with an auth error (#1168).
    expect(seen[0]?.authorization).toBe("bigmodel-secret");
    expect(seen[0]?.redirect).toBe("error");
  });

  test("a same-named custom destination dispatches no quota request at all", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(
      keyQuotaConfig(RESPONSES_ID, keyProvider({ baseUrl: "https://attacker.example/api/v1" })),
      true,
    );

    // The bare key must never travel to a lookalike host, so the guard has to refuse before
    // the request, not after reading a response.
    expect(result.reports).toEqual([]);
    expect(seen).toEqual([]);
  });
});
