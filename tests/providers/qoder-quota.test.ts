import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearProviderQuotaCache, fetchProviderApiKeyQuotas, fetchProviderQuotaReports } from "../../src/providers/quota";
import {
  fetchQoderQuota,
  isCanonicalQoderBaseUrl,
  keyQuotaReaderForProvider,
  providerApiKeyQuotaMode,
} from "../../src/providers/quota/vendor-probes-key";
import { TERMINAL_QUOTA_FAILURE } from "../../src/providers/quota/report-cache";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const EXCHANGE = "https://openapi.qoder.sh/api/v1/jobToken/exchange";
const USAGE = "https://openapi.qoder.sh/api/v2/quota/usage";
const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
let home: string;

type Call = { url: string; method: string; auth?: string; body?: unknown; signal?: AbortSignal | null };
type Reply = Response | Error;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function qoderConfig(overrides?: Partial<OcxProviderConfig>): OcxConfig {
  return {
    defaultProvider: "qoder",
    providers: {
      qoder: {
        adapter: "qoder", authMode: "key", baseUrl: "https://qoder.com",
        apiKey: "pat_test_secret_123", ...overrides,
      },
    },
  } as unknown as OcxConfig;
}

/** Fresh response clones let the same mock cover direct and cached-report reads. */
function mockHttp(exchange: Reply, usage: Reply = json({})): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ url, method: init?.method ?? "GET", auth, body, signal: init?.signal });
    const result = url === EXCHANGE ? exchange : url === USAGE ? usage : new Response("Not found", { status: 404 });
    if (result instanceof Error) throw result;
    return result.clone();
  }) as typeof fetch;
  return calls;
}

const probe = () => fetchQoderQuota("qoder", qoderConfig().providers.qoder!);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-qoder-quota-"));
  process.env.OPENCODEX_HOME = home;
  clearProviderQuotaCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearProviderQuotaCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

describe("Qoder provider quota probe", () => {
  test("canonical URL guards restrict the probe to Qoder Global", () => {
    for (const url of ["https://qoder.com", "https://qoder.com/"]) {
      expect(isCanonicalQoderBaseUrl(url)).toBe(true);
    }
    for (const url of ["https://qoder.cn", "https://evil.qoder.com", "https://qoder.com.fake.org"]) {
      expect(isCanonicalQoderBaseUrl(url)).toBe(false);
    }
    expect(isCanonicalQoderBaseUrl(undefined)).toBe(false);
    const global = qoderConfig().providers.qoder!;
    expect(keyQuotaReaderForProvider("qoder", global)).toBe(fetchQoderQuota);
    expect(providerApiKeyQuotaMode("qoder", global)).toBe("probe");
    const cn: OcxProviderConfig = { adapter: "qoder", authMode: "key", baseUrl: "https://qoder.cn", apiKey: "pat_cn" };
    expect(keyQuotaReaderForProvider("qoder-cn", cn)).toBeNull();
    expect(providerApiKeyQuotaMode("qoder-cn", cn)).toBe("unsupported");
  });

  test("PAT exchange, bearer-only usage request, and both credit buckets", async () => {
    const calls = mockHttp(json({ code: 0, data: { token: "temp_job_token_xyz" } }), json({
      userQuota: { total: 1000, used: 200, remaining: 800, percentage: "20%", unit: "credits" },
      addOnQuota: { total: 1800, used: 323, remaining: 1477, percentage: 0.24, unit: "credits" },
    }));
    const result = await probe();
    expect(result).not.toBeNull();
    expect(result).not.toBe(TERMINAL_QUOTA_FAILURE);
    expect(calls.map(({ url, method, auth, body }) => ({ url, method, auth, body }))).toEqual([
      { url: EXCHANGE, method: "POST", auth: undefined, body: { personal_token: "pat_test_secret_123" } },
      { url: USAGE, method: "GET", auth: "Bearer temp_job_token_xyz", body: undefined },
    ]);
    expect((result as { quota: { creditBuckets: unknown[] } }).quota.creditBuckets).toEqual([
      { kind: "userQuota", used: 200, limit: 1000, remaining: 800, percent: 20 },
      { kind: "addOnQuota", used: 323, limit: 1800, remaining: 1477, percent: 17.94 },
    ]);
  });

  test("0/0 remains real zero; omitted upstream percentage is computed", async () => {
    mockHttp(json({ token: "t1" }), json({ data: {
      userQuota: { total: 0, used: 0, remaining: 0, percentage: 0 },
      addOnQuota: { total: 500, used: 100, remaining: 400 },
    } }));
    const result = await probe();
    expect((result as { quota: { creditBuckets: unknown[] } }).quota.creditBuckets).toEqual([
      { kind: "userQuota", used: 0, limit: 0, remaining: 0, percent: 0 },
      { kind: "addOnQuota", used: 100, limit: 500, remaining: 400, percent: 20 },
    ]);
  });

  test("missing fields derive only defensible totals; invalid buckets do not forge zero", async () => {
    const cases: Array<{ body: unknown; expected: unknown[] | null }> = [
      {
        body: { userQuota: { total: 1000, remaining: 750 }, addOnQuota: { used: 300, remaining: 700 } },
        expected: [
          { kind: "userQuota", used: 250, limit: 1000, remaining: 750, percent: 25 },
          { kind: "addOnQuota", used: 300, limit: 1000, remaining: 700, percent: 30 },
        ],
      },
      { body: { userQuota: { used: 500 }, addOnQuota: { total: 1000 } }, expected: null },
      { body: { userQuota: { total: 500, remaining: 600 } }, expected: null },
      {
        body: { userQuota: { total: 500, remaining: 500 }, addOnQuota: { remaining: 200 } },
        expected: [{ kind: "userQuota", used: 0, limit: 500, remaining: 500, percent: 0 }],
      },
    ];
    for (const { body, expected } of cases) {
      mockHttp(json({ token: "t1" }), json({ data: body }));
      const result = await probe();
      if (expected === null) expect(result).toBeNull();
      else expect((result as { quota: { creditBuckets: unknown[] } }).quota.creditBuckets).toEqual(expected);
    }
  });

  test("per-stage 401 is terminal; 429, 500 and malformed JSON degrade safely", async () => {
    const cases: Array<{ exchange: Reply; usage?: Reply; expected: unknown; calls: number }> = [
      { exchange: new Response("Unauthorized", { status: 401 }), expected: TERMINAL_QUOTA_FAILURE, calls: 1 },
      { exchange: json({ token: "t1" }), usage: new Response("Unauthorized", { status: 401 }), expected: TERMINAL_QUOTA_FAILURE, calls: 2 },
      { exchange: new Response("Too Many Requests", { status: 429 }), expected: null, calls: 1 },
      { exchange: json({ token: "t1" }), usage: new Response("Server error", { status: 500 }), expected: null, calls: 2 },
      { exchange: new Response("not-json", { status: 200 }), expected: null, calls: 1 },
    ];
    for (const item of cases) {
      const calls = mockHttp(item.exchange, item.usage);
      expect(await probe()).toBe(item.expected);
      expect(calls).toHaveLength(item.calls);
    }
  });

  test("multi-PAT pool reads each key independently", async () => {
    const exchangeCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === EXCHANGE) {
        const pat = (JSON.parse(init?.body as string) as { personal_token: string }).personal_token;
        exchangeCalls.push(pat);
        return json({ token: pat === "pat_A" ? "token_A" : "token_B" });
      }
      const bearer = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (url === USAGE && (bearer === "Bearer token_A" || bearer === "Bearer token_B")) {
        return json({ userQuota: bearer === "Bearer token_A"
          ? { total: 1000, used: 100, remaining: 900 }
          : { total: 2000, used: 800, remaining: 1200 } });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const config = qoderConfig({ apiKey: undefined, apiKeyPool: [
      { id: "key-1", key: "pat_A" }, { id: "key-2", key: "pat_B" },
    ] } as Partial<OcxProviderConfig>);
    const rows = await fetchProviderApiKeyQuotas(config, "qoder", true);
    expect(rows).toHaveLength(2);
    expect(rows.map(row => [row.keyId, row.quota?.creditBuckets?.[0]?.used, row.quota?.creditBuckets?.[0]?.remaining])).toEqual([
      ["key-1", 100, 900], ["key-2", 800, 1200],
    ]);
    expect(exchangeCalls).toEqual(["pat_A", "pat_B"]);
  });

  test("exhausted Qoder credits publish display-only data, never routing evidence", async () => {
    mockHttp(json({ token: "tok" }), json({
      userQuota: { total: 1000, used: 1000, remaining: 0, percentage: 100, isQuotaExceeded: true },
    }));
    const result = await fetchProviderQuotaReports(qoderConfig(), true);
    expect(result.reports).toHaveLength(1);
    const report = result.reports[0]!;
    expect([report.provider, report.source, report.quota.creditBuckets?.[0]?.percent]).toEqual(["qoder", "qoder:quota", 100]);
    const { routingEvidence } = await import("../../src/providers/quota/report-cache");
    expect(routingEvidence.has(report)).toBe(false);
  });

  for (const phase of ["exchange", "usage"] as const) {
    test(phase + " timeout returns null without routing credentials to a later stage", async () => {
      const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
      const calls = mockHttp(phase === "exchange" ? timeout : json({ token: "tok" }), phase === "usage" ? timeout : json({}));
      const result = await probe();
      expect(result).toBeNull();
      expect(calls).toHaveLength(phase === "exchange" ? 1 : 2);
      expect(calls[0]?.method).toBe("POST");
      expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
      if (phase === "usage") {
        expect(calls[1]?.auth).toBe("Bearer tok");
        expect(calls[1]?.signal).toBeInstanceOf(AbortSignal);
      }
      const reports = await fetchProviderQuotaReports(qoderConfig(), true);
      expect(reports.reports).toHaveLength(0);
    });
  }
});
