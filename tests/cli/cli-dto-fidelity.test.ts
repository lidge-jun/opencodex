import { describe, expect, test } from "bun:test";
import { formatUsageReport } from "../../src/cli/usage-report";

/** formatUsageReport returns lines; assertions here are about rendered text. */
const joinReport = (input: Parameters<typeof formatUsageReport>[0]): string => formatUsageReport(input).join("\n");
import { formatAccountTable, type AccountRowForTest } from "../../src/cli/account";
import { fetchRows, type AccountDeps } from "../../src/cli/account-api";

/**
 * #2700, #2703: the CLI discarded fields the API already returned.
 *
 * Each case here is a field that existed on the wire, was declared in a type, and never
 * reached the operator -- the failure mode where the code typechecks, the renderer reads
 * correctly, and only the output is wrong.
 */
describe("#2700 usage report renders per-account totals", () => {
  const base = {
    range: "7d",
    summary: { requests: 10, totalTokens: 1000, estimatedCostUsd: 1.5 },
  };

  test("renders an ACCOUNT table with requests, tokens, and cost", () => {
    const out = joinReport({
      ...base,
      accounts: [
        { accountLogLabel: "work", requests: 7, totalTokens: 700, estimatedCostUsd: 1.25 },
      ],
    });
    expect(out).toContain("ACCOUNT");
    expect(out).toContain("work");
    expect(out).toContain("700");
  });

  test("marks an ambiguous row instead of presenting it as one account", () => {
    // A legacy-ambiguous row aggregates several accounts. An operator who reads it as a
    // single identity draws the wrong conclusion about who spent what.
    const out = joinReport({
      ...base,
      accounts: [{ accountLogLabel: "legacy-ambiguous", ambiguous: true, requests: 3, totalTokens: 300 }],
    });
    expect(out).toContain("legacy-ambiguous (ambiguous)");
  });

  test("drops rows with no requests rather than printing empty ones", () => {
    const out = joinReport({
      ...base,
      accounts: [
        { accountLogLabel: "busy", requests: 4, totalTokens: 400 },
        { accountLogLabel: "idle", requests: 0, totalTokens: 0 },
      ],
    });
    expect(out).toContain("busy");
    expect(out).not.toContain("idle");
  });

  test("states that account rows are WITHHELD under a provider filter", () => {
    // The server sends `accounts: []` under any filter because the rows cannot be honestly
    // re-partitioned. Printing nothing would look like "no accounts used this provider",
    // which is a different and wrong answer -- the same silently-wrong-output class of defect
    // this phase exists to remove.
    const out = joinReport({
      ...base,
      accounts: [],
      filter: { provider: "xai", model: null, matched: true, comboOverlap: false },
    });
    expect(out).toContain("not reported under a provider or model filter");
  });

  test("states the same under a model filter", () => {
    const out = joinReport({
      ...base,
      accounts: [],
      filter: { provider: null, model: "grok-4", matched: true, comboOverlap: false },
    });
    expect(out).toContain("not reported under a provider or model filter");
  });

  test("the withheld note wins even if rows are somehow present under a filter", () => {
    // Defensive on purpose: if a future server sends filtered account rows, the honest
    // statement is better than a table whose partitioning nobody has justified.
    const out = joinReport({
      ...base,
      accounts: [{ accountLogLabel: "work", requests: 5, totalTokens: 500 }],
      filter: { provider: "xai", model: null, matched: true, comboOverlap: false },
    });
    expect(out).toContain("not reported under a provider or model filter");
  });

  test("prints no ACCOUNT section at all when unfiltered with no rows", () => {
    const out = joinReport({ ...base, accounts: [] });
    expect(out).not.toContain("ACCOUNT");
  });
});

describe("#2703 paused state and the 5h window reach the operator", () => {
  const row = (over: Partial<AccountRowForTest> = {}): AccountRowForTest => ({
    provider: "openai",
    type: "codex",
    id: "acct_1",
    active: false,
    ...over,
  }) as AccountRowForTest;

  test("a paused account is named as paused", () => {
    expect(formatAccountTable([row({ paused: true })])).toContain("paused");
  });

  test("paused and selected are BOTH shown, not one or the other", () => {
    // A paused-but-selected account is the state most worth naming: requests route to it
    // while the pool believes it is held out of rotation. Showing only one hides that.
    const out = formatAccountTable([row({ paused: true, active: true })]);
    expect(out).toContain("paused");
    expect(out).toContain("selected");
  });

  test("an unpaused account says nothing about pausing", () => {
    expect(formatAccountTable([row({ paused: false })])).not.toContain("paused");
  });

  test("a 5h-only quota renders instead of collapsing to a dash", () => {
    const out = formatAccountTable([row({ quota: { fiveHourPercent: 42 } })], true);
    expect(out).toContain("5h 42%");
  });
});

describe("#2703 the projection does not strip the 5h window", () => {
  /**
   * Renderer tests alone were VACUOUS for this bug.
   *
   * `formatAccountTable` reads a row directly, so it passed with the defect still present --
   * the field was dropped one layer earlier, in `projectQuota`'s whitelist inside
   * `fetchCodexRows`. Verified by reverting the fix and watching the renderer test stay green.
   * So this drives the real path: a server payload in, a projected row out.
   */
  async function rowsFromServer(quota: Record<string, number>): Promise<{ quota?: unknown }[]> {
    const { fetchCodexRows } = await import("../../src/cli/account-api");
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/api/codex-auth/active")) {
        return new Response(JSON.stringify({ activeCodexAccountId: "acct_1" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        accounts: [{ id: "acct_1", email: "a@example.com", plan: "pro", quota, paused: true }],
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchCodexRows({ baseUrl: "http://127.0.0.1:10100", fetchImpl }, "http://127.0.0.1:10100", true);
    return result.rows as { quota?: unknown }[];
  }

  test("account list --quota attaches cached quota without ?refresh=1", async () => {
    const { fetchRows } = await import("../../src/cli/account-api");
    const hrefs: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      hrefs.push(href);
      if (href.includes("/api/codex-auth/active")) {
        return new Response(JSON.stringify({ activeCodexAccountId: "acct_1" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        accounts: [{ id: "acct_1", email: "a@example.com", plan: "pro", quota: { fiveHourPercent: 42 } }],
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchRows(
      { baseUrl: "http://127.0.0.1:10100", fetchImpl },
      "http://127.0.0.1:10100",
      "openai",
      "codex",
      { refresh: false },
    );
    expect(hrefs.some(h => h.includes("refresh=1"))).toBe(false);
    expect((result.rows[0]?.quota as { fiveHourPercent?: number } | undefined)?.fiveHourPercent).toBe(42);
  });

  test("fiveHourPercent and fiveHourResetAt survive the projection", async () => {
    const rows = await rowsFromServer({ fiveHourPercent: 42, fiveHourResetAt: 1_800_000_000 });
    const quota = rows[0]?.quota as Record<string, number> | undefined;
    expect(quota?.fiveHourPercent).toBe(42);
    expect(quota?.fiveHourResetAt).toBe(1_800_000_000);
  });

  test("paused survives the projection", async () => {
    const rows = await rowsFromServer({ fiveHourPercent: 10 }) as { paused?: boolean }[];
    expect(rows[0]?.paused).toBe(true);
  });

  test("the existing windows still survive", async () => {
    // Guards against a whitelist edit that adds the 5h keys and drops another.
    const rows = await rowsFromServer({ weeklyPercent: 7, monthlyPercent: 3, shortPercent: 1 });
    const quota = rows[0]?.quota as Record<string, number> | undefined;
    expect(quota?.weeklyPercent).toBe(7);
    expect(quota?.monthlyPercent).toBe(3);
    expect(quota?.shortPercent).toBe(1);
  });
});

describe("#2705 access key usage columns", () => {
  async function listOutput(payload: Record<string, unknown>): Promise<string> {
    const { handleAccessCommand } = await import("../../src/cli/access");
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      await handleAccessCommand(["key", "list"], {
        baseUrl: "http://127.0.0.1:10100",
        fetchImpl: (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch,
      });
    } finally {
      console.log = original;
    }
    return lines.join("\n");
  }

  test("prints request counts and last-used instead of only id/name/prefix", async () => {
    const out = await listOutput({
      keys: [{
        id: "k_9f2a", name: "ci-runner", prefix: "ocx_data_abc...",
        usage: { requests7d: 1204, totalRequests: 18330, lastUsedAt: "2026-08-27T04:11:00Z" },
      }],
      attributionSince: "2026-07-29T00:00:00Z",
    });
    expect(out).toContain("REQ 7D");
    expect(out).toContain("1,204");
    expect(out).toContain("18,330");
    expect(out).toContain("2026-08-27T04:11:00Z");
  });

  test("an ambiguous key prints the marker and NEVER a fabricated 0", async () => {
    // The server models usage as a discriminated union precisely so a consumer cannot show a
    // number beside an ambiguity marker. Reporting 0 requests for a key that may be in heavy
    // use is the dangerous answer for someone deciding what to delete.
    const out = await listOutput({
      keys: [{ id: "k_11bd", name: "laptop", prefix: "ocx_data_def...", usage: { ambiguous: true } }],
      attributionSince: "2026-07-29T00:00:00Z",
    });
    expect(out).toContain("ambiguous");
    expect(out).not.toMatch(/\b0\b/);
  });

  test("a never-used key says never rather than showing an empty cell", async () => {
    const out = await listOutput({
      keys: [{ id: "k_new", name: "fresh", prefix: "ocx_data_ghi...", usage: { requests7d: 0, totalRequests: 0 } }],
      attributionSince: "2026-08-29T00:00:00Z",
    });
    expect(out).toContain("never");
  });

  test("unavailable attribution does not report zero usage or never used", async () => {
    const out = await listOutput({
      keys: [{ id: "k_unknown", name: "unknown", prefix: "ocx_data_jkl...", usage: { requests7d: 0, totalRequests: 0 } }],
    });
    expect(out).toContain("unavailable");
    expect(out).not.toMatch(/\b0\b/);
    expect(out).not.toContain("never");
  });

  // "0" parses with Date.parse; an impossible calendar date parses by rolling over. Neither is
  // the ISO instant the server emits, so both must read as unavailable.
  test.each(["not-a-timestamp", "0", "2026-02-30T00:00:00Z"])(
    "a malformed attributionSince string stays unavailable: %p",
    async attributionSince => {
      const out = await listOutput({
        keys: [{ id: "k_bad", name: "bad", prefix: "ocx_data_mno...", usage: { requests7d: 0, totalRequests: 0 } }],
        attributionSince,
      });
      expect(out).toContain("unavailable");
      expect(out).not.toContain("attribution since");
      expect(out).not.toMatch(/\b0\b/);
    },
  );

  test("the server's toISOString attributionSince stays available", async () => {
    const out = await listOutput({
      keys: [{ id: "k_ms", name: "ms", prefix: "ocx_data_pqr...", usage: { requests7d: 3, totalRequests: 3 } }],
      attributionSince: new Date(Date.UTC(2026, 6, 29)).toISOString(),
    });
    expect(out).toContain("attribution since 2026-07-29T00:00:00.000Z");
    expect(out).not.toContain("unavailable");
  });

  test("dataset-level attribution and truncation print ONCE as a footer", async () => {
    // They describe the usage log, not a key. Without attributionSince an absent lastUsedAt is
    // unreadable: "never used" and "nothing attributable yet" look identical.
    const out = await listOutput({
      keys: [
        { id: "k_a", name: "a", prefix: "p", usage: { requests7d: 1, totalRequests: 1 } },
        { id: "k_b", name: "b", prefix: "p", usage: { requests7d: 2, totalRequests: 2 } },
      ],
      attributionSince: "2026-07-29T00:00:00Z",
      historyTruncated: true,
    });
    expect(out.match(/attribution since/g)).toHaveLength(1);
    expect(out).toContain("older history truncated");
  });

  test("no keys still reports the empty state", async () => {
    expect(await listOutput({ keys: [] })).toContain("No API access keys configured.");
  });
});

/**
 * The OAuth account DTO declares `plan` optional because older proxies never sent it.
 * An absent key means the proxy predates tier reporting while `plan: null` means the
 * proxy checked and found no tier -- the same silently-wrong-output class of defect as
 * the fields above, one layer earlier: the wire value was fine and the projection
 * rewrote it.
 */
describe("OAuth plan field preserves the wire presence signal", () => {
  const deps = (accounts: Array<Record<string, unknown>>): AccountDeps => ({
    baseUrl: "http://127.0.0.1:10100",
    fetchImpl: (async () =>
      Response.json({ activeAccountId: null, accounts })) as unknown as typeof fetch,
  });

  test("an absent plan key stays absent instead of being synthesized as null", async () => {
    const { rows } = await fetchRows(
      deps([{ id: "legacy" }]),
      "http://127.0.0.1:10100",
      "anthropic",
      "oauth",
    );
    expect(rows[0]).not.toHaveProperty("plan");
  });

  test("an explicit null and a reported tier both reach the row verbatim", async () => {
    const { rows } = await fetchRows(
      deps([
        { id: "unknown", plan: null },
        { id: "known", plan: "max" },
      ]),
      "http://127.0.0.1:10100",
      "anthropic",
      "oauth",
    );
    expect(rows[0]).toHaveProperty("plan", null);
    expect(rows[1]).toHaveProperty("plan", "max");
  });
});
