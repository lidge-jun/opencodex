/**
 * `ocx usage` human rendering and query construction.
 *
 * The command used to print its payload through the shared depth-1 flattener,
 * which renders arrays as "N item(s)" — so every per-model and per-provider
 * cost the server computes was discarded before reaching the terminal. These
 * tests pin the cost down where a user can see it.
 */
import { describe, expect, test } from "bun:test";

import { handleObserveCommand } from "../src/cli/observe";
import { formatUsageReport } from "../src/cli/usage-report";

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    range: "today",
    surface: "all",
    since: Date.now(),
    summary: {
      requests: 1_447,
      totalTokens: 178_521_375,
      inputTokens: 4_489_102,
      outputTokens: 1_283_441,
      cachedInputTokens: 172_748_832,
      estimatedCostUsd: 12.3456,
      unpricedRequests: 0,
      unmeteredRequests: 0,
    },
    providers: [{ provider: "xai", requests: 1_447, totalTokens: 178_521_375, estimatedCostUsd: 12.3456 }],
    models: [{ provider: "xai", model: "grok-4.6", requests: 1_447, totalTokens: 178_521_375, estimatedCostUsd: 12.3456 }],
    days: [{ date: "2026-08-22", requests: 1_447, totalTokens: 178_521_375, estimatedCostUsd: 12.3456 }],
    accounts: [],
    ...overrides,
  };
}

async function run(argv: string[], body: unknown): Promise<{ code: number; out: string; urls: string[] }> {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async input => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    const code = await handleObserveCommand(argv, { baseUrl: "http://cli.test", fetchImpl });
    return { code, out: lines.join("\n"), urls };
  } finally {
    console.log = originalLog;
  }
}

describe("formatUsageReport", () => {
  test("prints per-provider and per-model cost, not an item count", () => {
    const out = formatUsageReport(payload() as never).join("\n");
    expect(out).toContain("~$12.3456");
    expect(out).toMatch(/PROVIDER\s+REQUESTS\s+TOKENS\s+EST\. COST/);
    expect(out).toMatch(/MODEL\s+PROVIDER\s+REQUESTS\s+TOKENS\s+EST\. COST/);
    expect(out).toContain("grok-4.6");
    // The old rendering produced exactly this shape and nothing else.
    expect(out).not.toContain("item(s)");
  });

  test("a zero total is distinguishable from an unpriced one", () => {
    const priced = formatUsageReport(payload({
      summary: { requests: 5, totalTokens: 100, estimatedCostUsd: 0, unpricedRequests: 0, unmeteredRequests: 0 },
    }) as never).join("\n");
    expect(priced).toContain("~$0.0000");
    expect(priced).not.toContain("excluded from ~$");

    const unpriced = formatUsageReport(payload({
      summary: { requests: 5, totalTokens: 100, estimatedCostUsd: 0, unpricedRequests: 3, unmeteredRequests: 2 },
    }) as never).join("\n");
    expect(unpriced).toContain("3 unpriced, 2 unmetered excluded from ~$");
  });

  test("always carries the not-a-bill disclaimer", () => {
    // Most traffic through this proxy is subscription or OAuth-plan based,
    // where no per-request charge exists at all.
    expect(formatUsageReport(payload() as never).join("\n"))
      .toContain("Not a billing receipt.");
  });

  test("an empty filter match explains itself instead of printing zeros", () => {
    const out = formatUsageReport(payload({
      summary: { requests: 0, totalTokens: 0, estimatedCostUsd: 0 },
      providers: [], models: [], days: [],
      filter: { provider: "nope", model: null, matched: false, comboOverlap: false },
    }) as never).join("\n");
    expect(out).toContain('No usage recorded for provider "nope"');
    expect(out).not.toContain("EST. COST");
  });

  test("combo overlap is disclosed rather than left silent", () => {
    const out = formatUsageReport(payload({
      filter: { provider: "xai", model: null, matched: true, comboOverlap: true },
    }) as never).join("\n");
    expect(out).toContain("per-model request counts can overlap");
  });

  test("the model table truncates and says how much it hid", () => {
    const models = Array.from({ length: 14 }, (_, i) => ({
      provider: "openai", model: `m-${i}`, requests: 100 - i, totalTokens: 1_000, estimatedCostUsd: 0.5,
    }));
    const out = formatUsageReport(payload({ models }) as never).join("\n");
    expect(out).toContain("... 4 more (use --json)");
    expect(out).toContain("m-9");
    expect(out).not.toContain("m-10");
  });
});

describe("ocx usage command", () => {
  test("forwards range and provider to the API", async () => {
    const { code, urls } = await run(["usage", "--range", "today", "--provider", "xai"], payload());
    expect(code).toBe(0);
    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe("/api/usage");
    expect(url.searchParams.get("range")).toBe("today");
    expect(url.searchParams.get("provider")).toBe("xai");
  });

  test("omits filters that were not supplied", async () => {
    const { urls } = await run(["usage", "--range", "7d"], payload());
    const url = new URL(urls[0]!);
    expect(url.searchParams.get("provider")).toBeNull();
    expect(url.searchParams.get("model")).toBeNull();
  });

  test("accepts the 1d alias", async () => {
    const { code, urls } = await run(["usage", "--range", "1d"], payload());
    expect(code).toBe(0);
    expect(new URL(urls[0]!).searchParams.get("range")).toBe("1d");
  });

  test("rejects an unknown range and names today as valid", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
    try {
      const code = await handleObserveCommand(
        ["usage", "--range", "bogus"],
        { baseUrl: "http://cli.test", fetchImpl: async () => new Response("{}", { status: 200 }) },
      );
      expect(code).toBe(2);
      expect(errors.join("\n")).toContain("today");
    } finally {
      console.error = originalError;
    }
  });

  test("--json returns the server payload untouched", async () => {
    const body = payload();
    const { out } = await run(["usage", "--json"], body);
    expect(JSON.parse(out)).toEqual(body);
  });

  test("the default view renders cost for a real-shaped payload", async () => {
    const { out } = await run(["usage", "--range", "today", "--provider", "xai"], payload());
    expect(out).toContain("~$12.3456");
    expect(out).toContain("grok-4.6");
  });
});
