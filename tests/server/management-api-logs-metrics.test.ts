import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import { usageLogPath } from "../../src/usage/log";
import {
  addRequestLog,
  clearRequestLogsForTests,
  evictOldestRequestLogForBudget,
  getRequestLogEntries,
  type RequestLogEntry,
} from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { buildRouteDecisionTrace } from "../../src/routing/trace";
import { summarizeUsage } from "../../src/usage/summary";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { refreshUserCostOverlays } from "../../src/usage/user-cost-overlays";

interface LogPollEnvelope {
  logs: Array<Record<string, unknown>>;
  cursor: string;
  reset: boolean;
  generatedAt: number;
  timeZone: string;
  total: number;
}

async function readLogPoll(query = "", cursor?: string): Promise<LogPollEnvelope> {
  const url = new URL(`http://localhost/api/logs?${query}`);
  if (cursor) url.searchParams.set("cursor", cursor);
  const before = Date.now();
  const response = await handleManagementAPI(new Request(url), url, config);
  expect(response?.status).toBe(200);
  const body = await response!.json() as LogPollEnvelope;
  expect(body.generatedAt).toBeGreaterThanOrEqual(before);
  expect(body.generatedAt).toBeLessThanOrEqual(Date.now());
  expect(body.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  expect(typeof body.cursor).toBe("string");
  return body;
}

const config = { providers: [] } as unknown as OcxConfig;

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  // addRequestLog persists to usage.jsonl; without a scratch OPENCODEX_HOME a bare
  // `bun test <file>` run from outside the repo (no bunfig preload) writes these
  // fixture rows into the real ~/.opencodex log and poisons the GUI Usage page.
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-logs-metrics-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  clearRequestLogsForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

async function readLogs(): Promise<Array<Record<string, any>>> {
  const url = new URL("http://localhost/api/logs");
  const response = await handleManagementAPI(new Request(url), url, config);
  expect(response?.status).toBe(200);
  const body = await response!.json() as { logs?: Array<Record<string, any>>; timeZone?: string };
  expect(typeof body.timeZone).toBe("string");
  expect(body.timeZone!.length).toBeGreaterThan(0);
  return body.logs ?? [];
}

function baseEntry(overrides: Partial<RequestLogEntry>): RequestLogEntry {
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    model: "claude-3-haiku-20240307",
    provider: "anthropic",
    status: 200,
    durationMs: 2000,
    usageStatus: "reported",
    ...overrides,
  };
}

describe("GET /api/logs display metrics", () => {
  test("parent, individual attempt DTO and summary agree on unresolved slash cost without rewriting history", async () => {
    const model = "anthropic/claude-3-haiku-20240307";
    const row = baseEntry({
      requestId: "unresolved", provider: "kimi", model,
      usage: { inputTokens: 100, outputTokens: 10 }, totalTokens: 110,
      routeDecision: buildRouteDecisionTrace({ requestedModel: model, routeKind: "default-provider", selected: { provider: "kimi", model, reason: "default-provider" } }),
      attempts: [{
        ordinal: 1, provider: "kimi", model, adapter: "openai-chat", status: 200, durationMs: 1000,
        sendCount: 1, recoveryKinds: [], usageStatus: "reported", usage: { inputTokens: 100, outputTokens: 10 }, totalTokens: 110,
      }],
    });
    addRequestLog(row);
    const ledgerBefore = readFileSync(usageLogPath(), "utf8");
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.cost).toEqual({ kind: "unavailable", reason: "combo_attempt_unavailable" });
    expect(dto!.attempts[0].displayMetrics.cost).toEqual({ kind: "unavailable", reason: "price_unmatched" });
    expect(dto!.attempts[0].displayMetrics.tokPerSecond.kind).toBe("value");
    const summary = summarizeUsage([{ ...row, accountLogLabel: undefined }], "all", Date.now());
    expect(summary.models[0]).toMatchObject({ provider: "kimi", model, totalTokens: 110, hasUnresolvedRequestedModel: true, unpricedRequests: 1 });
    expect(summary.models[0]?.estimatedCostUsd).toBeUndefined();
    expect(readFileSync(usageLogPath(), "utf8")).toBe(ledgerBefore);
    expect(getRequestLogEntries()[0]?.attempts?.[0]).not.toHaveProperty("allowModelLevelFallback");
    expect(getRequestLogEntries()[0]?.attempts?.[0]).not.toHaveProperty("displayMetrics");
  });

  test("bare fallback annotation keeps parent and attempt pricing; another attempt is not restricted by parent trace", async () => {
    const model = "claude-3-haiku-20240307";
    const row = baseEntry({
      requestId: "bare-fallback", provider: "kimi", model,
      usage: { inputTokens: 100, outputTokens: 10 },
      routeDecision: buildRouteDecisionTrace({ requestedModel: model, routeKind: "default-provider", selected: { provider: "kimi", model, reason: "default-provider" } }),
      attempts: [{
        ordinal: 1, provider: "kimi", model, adapter: "openai-chat", status: 200, durationMs: 1000,
        sendCount: 1, recoveryKinds: [], usageStatus: "reported", usage: { inputTokens: 100, outputTokens: 10 },
      }],
    });
    addRequestLog(row);
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.cost.kind).toBe("value");
    expect(dto!.attempts[0].displayMetrics.cost.kind).toBe("value");
    expect(summarizeUsage([{ ...row, accountLogLabel: undefined }], "all", Date.now()).models[0]).toMatchObject({ hasUnresolvedRequestedModel: true, pricedRequests: 1 });
    clearRequestLogsForTests();
    const selector = `anthropic/${model}`;
    addRequestLog({ ...row, requestId: "retargeted", routeDecision: buildRouteDecisionTrace({
      requestedModel: selector, routeKind: "default-provider", selected: { provider: "kimi", model: selector, reason: "default-provider" },
    }), attempts: row.attempts!.map(attempt => ({ ...attempt, provider: "fixture-aggregator", model: selector })) });
    const [retargeted] = await readLogs();
    expect(retargeted!.displayMetrics.cost.kind).toBe("value");
    expect(retargeted!.attempts[0].displayMetrics.cost.kind).toBe("value");
  });

  test("parent-only unresolved slash cost agrees with summary", async () => {
    const model = "anthropic/claude-3-haiku-20240307";
    const row = baseEntry({ provider: "kimi", model, usage: { inputTokens: 100, outputTokens: 10 },
      routeDecision: buildRouteDecisionTrace({ requestedModel: model, routeKind: "default-provider", selected: { provider: "kimi", model, reason: "default-provider" } }),
    });
    addRequestLog(row);
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.cost).toEqual({ kind: "unavailable", reason: "price_unmatched" });
    expect(summarizeUsage([{ ...row, accountLogLabel: undefined }], "all", Date.now()).summary.unpricedRequests).toBe(1);
  });
  test("reports filtered total before limit pagination", async () => {
    addRequestLog(baseEntry({ requestId: "ok-a", provider: "anthropic", status: 200 }));
    addRequestLog(baseEntry({ requestId: "ok-b", provider: "anthropic", status: 200 }));
    addRequestLog(baseEntry({ requestId: "fail", provider: "openai", status: 500 }));
    const url = new URL("http://localhost/api/logs?provider=anthropic&limit=1");
    const response = await handleManagementAPI(new Request(url), url, config);
    expect(response?.status).toBe(200);
    const body = await response!.json() as { total?: number; logs?: Array<{ requestId?: string }> };
    expect(body.total).toBe(2);
    expect(body.logs?.map(row => row.requestId)).toEqual(["ok-b"]);
  });

  test("adds tok/s and cost without mutating the stored log", async () => {
    addRequestLog(baseEntry({
      usage: { inputTokens: 1000, outputTokens: 240 },
    }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.tokPerSecond).toEqual({ kind: "value", value: 120, estimated: false });
    expect(dto!.displayMetrics.cost.kind).toBe("value");
    expect(dto!.displayMetrics.cost.estimate.cost.total).toBeGreaterThan(0);
    expect(dto!.displayMetrics.cost.estimate.price.source).toBe("jawcode");
    // stored entry stays clean
    expect(Object.hasOwn(getRequestLogEntries()[0]!, "displayMetrics")).toBe(false);
  });

  test("estimated positive output marks tok/s estimated and keeps cost value", async () => {
    addRequestLog(baseEntry({
      usageStatus: "estimated",
      usage: { inputTokens: 500, outputTokens: 25, estimated: true },
    }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.tokPerSecond).toEqual({ kind: "value", value: 12.5, estimated: true });
    expect(dto!.displayMetrics.cost.kind).toBe("value");
    expect(dto!.displayMetrics.cost.estimate.estimated).toBe(true);
    expect(dto!.displayMetrics.cost.estimateReasons).toContain("usage_estimated");
    expect(dto!.displayMetrics.cost.estimateReasons).toContain("cache_detail_missing");
  });

  test("confirmed xAI priority plus long context is exposed as a cost lower bound", async () => {
    addRequestLog(baseEntry({
      provider: "xai",
      model: "grok-4.6",
      usage: {
        inputTokens: 200_000,
        outputTokens: 10_000,
        cacheReadInputTokens: 50_000,
      },
      tierOutcome: {
        canonical: "priority",
        wireKind: "service-tier",
        wireValue: "priority",
        fastOutcome: "applied",
        confirmation: "confirmed",
        responseServiceTier: "priority",
      },
    }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.cost.kind).toBe("value");
    expect(dto!.displayMetrics.cost.estimate.priorityLowerBound).toBe(true);
    expect(dto!.displayMetrics.cost.estimate.cost.total).toBeCloseTo(0.77, 9);
    expect(dto!.displayMetrics.cost.estimateReasons).toContain("priority_lower_bound");
  });

  test("unmatched price is unavailable instead of zero", async () => {
    addRequestLog(baseEntry({
      provider: "no-such-provider",
      model: "no-such-model",
      usage: { inputTokens: 100, outputTokens: 10 },
    }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.tokPerSecond.kind).toBe("value");
    expect(dto!.displayMetrics.cost).toEqual({ kind: "unavailable", reason: "price_unmatched" });
  });

  test("usage-missing rows are unavailable for both metrics", async () => {
    addRequestLog(baseEntry({ usageStatus: "unreported", usage: undefined }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.tokPerSecond).toEqual({ kind: "unavailable", reason: "usage_missing" });
    expect(dto!.displayMetrics.cost).toEqual({ kind: "unavailable", reason: "usage_missing" });
  });

  test("zero output is output_missing, not 0 tok/s", async () => {
    addRequestLog(baseEntry({ usage: { inputTokens: 100, outputTokens: 0 } }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.tokPerSecond).toEqual({ kind: "unavailable", reason: "output_missing" });
  });

  test("enriches combo attempts and fails top-level cost closed on unmatched attempt", async () => {
    addRequestLog(baseEntry({
      model: "combo/my-combo",
      provider: "combo",
      usage: { inputTokens: 200, outputTokens: 20 },
      attempts: [
        {
          ordinal: 1,
          provider: "anthropic",
          model: "claude-3-haiku-20240307",
          adapter: "anthropic",
          status: 200,
          durationMs: 900,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
          usage: { inputTokens: 100, outputTokens: 10 },
        },
        {
          ordinal: 2,
          provider: "unpriced-provider",
          model: "unpriced-model",
          adapter: "openai-chat",
          status: 200,
          durationMs: 1100,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
          usage: { inputTokens: 100, outputTokens: 10 },
        },
      ],
    }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.cost).toEqual({ kind: "unavailable", reason: "combo_attempt_unavailable" });
    expect(dto!.attempts).toHaveLength(2);
    expect(dto!.attempts[0].displayMetrics.cost.kind).toBe("value");
    expect(dto!.attempts[0].displayMetrics.tokPerSecond.kind).toBe("value");
    expect(dto!.attempts[1].displayMetrics.cost).toEqual({ kind: "unavailable", reason: "price_unmatched" });
  });

  test("legacy recoverable cache row is priced, not invalid_cache_breakdown", async () => {
    // canonical reading R=60,W=20 contradicts I=70; legacy retry recovers R=40,W=20.
    addRequestLog(baseEntry({
      usage: { inputTokens: 70, outputTokens: 10, cachedInputTokens: 60, cacheCreationInputTokens: 20 },
    }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.cost.kind).toBe("value");
  });

  test("doubly-contradictory cache row is invalid_cache_breakdown", async () => {
    addRequestLog(baseEntry({
      usage: { inputTokens: 50, outputTokens: 10, cachedInputTokens: 60, cacheCreationInputTokens: 20 },
    }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.cost).toEqual({ kind: "unavailable", reason: "invalid_cache_breakdown" });
  });

  test("fixture usage rows land in the scratch home, never the default location", () => {
    // Pins the safety property this file's isolation exists for: addRequestLog
    // persists to usage.jsonl, so if the scratch-home hook is ever dropped (or a
    // future test logs before it runs), a bare `bun test <file>` from outside the
    // repo writes fixture rows into the developer's real ~/.opencodex log.
    const requestId = "safety-pin-usage-log-target";
    addRequestLog(baseEntry({ requestId }));

    const resolvedTarget = usageLogPath();
    expect(resolvedTarget).toBe(join(testDir, "usage.jsonl"));
    expect(readFileSync(resolvedTarget, "utf-8")).toContain(requestId);

    // The default location (what the resolver returns with no OPENCODEX_HOME
    // override) must never be the write target for this suite.
    const previousHome = process.env.OPENCODEX_HOME;
    delete process.env.OPENCODEX_HOME;
    try {
      const defaultTarget = usageLogPath();
      expect(defaultTarget).not.toBe(resolvedTarget);
      if (existsSync(defaultTarget)) {
        expect(readFileSync(defaultTarget, "utf-8")).not.toContain(requestId);
      }
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
    }
  });
});
import { ManagementRequest as Request } from "../helpers/management-auth";


describe("GET /api/logs snapshot polling", () => {
  beforeEach(() => clearRequestLogsForTests());

  test("poll application equals full reads across append, nested live mutation, eviction and clear", async () => {
    let accepted: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    const check = async (reset: boolean, deltaLength: number) => {
      const poll = await readLogPoll("limit=2000", cursor);
      expect(poll.reset).toBe(reset);
      expect(poll.logs).toHaveLength(deltaLength);
      accepted = !cursor || poll.reset ? poll.logs : [...accepted, ...poll.logs];
      const snapshot = await readLogPoll("limit=2000");
      expect(accepted).toEqual(snapshot.logs);
      expect(poll.total).toBe(snapshot.total);
      cursor = poll.cursor;
    };
    await check(false, 0);
    addRequestLog(baseEntry({ requestId: "older", usage: { inputTokens: 10, outputTokens: 5 } }));
    await check(false, 1);
    await check(false, 0);
    addRequestLog(baseEntry({ requestId: "newest", firstOutputMs: 4 }));
    await check(false, 1);
    getRequestLogEntries()[0]!.usage!.outputTokens = 15;
    await check(true, 2);
    getRequestLogEntries()[1]!.status = 500;
    delete getRequestLogEntries()[1]!.firstOutputMs;
    await check(true, 2);
    getRequestLogEntries()[0]!.attempts = [{
      ordinal: 1, provider: "anthropic", model: "claude-3-haiku-20240307", adapter: "anthropic",
      status: 200, durationMs: 50, sendCount: 1, recoveryKinds: [], usageStatus: "reported",
      usage: { inputTokens: 10, outputTokens: 5 },
    }];
    await check(true, 2);
    getRequestLogEntries()[0]!.attempts![0]!.usage!.outputTokens = 20;
    await check(true, 2);
    // The newest cursor anchor survives this real memory-budget eviction.
    evictOldestRequestLogForBudget();
    await check(true, 1);
    clearRequestLogsForTests();
    await check(true, 0);
    await check(false, 0);
  });

  test("pagination/filter changes and shifted windows reset against the full filtered snapshot", async () => {
    for (const [requestId, provider] of [["a", "anthropic"], ["b", "openai"], ["c", "anthropic"]] as const) {
      addRequestLog(baseEntry({ requestId, provider }));
    }
    let query = "provider=anthropic&limit=1&offset=1";
    const initial = await readLogPoll(query);
    expect(initial.logs.map(row => row.requestId)).toEqual(["a"]);
    expect(initial.total).toBe(2);
    addRequestLog(baseEntry({ requestId: "d", provider: "anthropic" }));
    let poll = await readLogPoll(query, initial.cursor);
    expect(poll.reset).toBe(true);
    expect(poll.logs).toEqual((await readLogPoll(query)).logs);
    expect(poll.logs.map(row => row.requestId)).toEqual(["c"]);
    expect(poll.total).toBe(3);
    for (const changed of ["provider=openai&limit=1", "tail=2&limit=1", "model=absent", "status=5xx", "conversation=absent"]) {
      query = changed;
      poll = await readLogPoll(query, poll.cursor);
      const full = await readLogPoll(query);
      expect(poll.reset).toBe(true);
      expect(poll.logs).toEqual(full.logs);
      expect(poll.total).toBe(full.total);
    }
    const filtered = await readLogPoll("provider=openai");
    addRequestLog(baseEntry({ requestId: "not-in-filter", provider: "anthropic" }));
    expect(await readLogPoll("provider=openai", filtered.cursor))
      .toMatchObject({ logs: [], reset: false, cursor: filtered.cursor, total: 1 });
  });

  test("display-time cost changes reset even when raw entries are unchanged", async () => {
    const priceConfig: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: {
      adapter: "openai-chat", baseUrl: "https://example.test/v1", models: ["fixture-model"],
      modelCosts: { "fixture-model": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
    } } };
    try {
      refreshUserCostOverlays(priceConfig);
      addRequestLog(baseEntry({ provider: "fixture", model: "fixture-model", usage: { inputTokens: 100, outputTokens: 10 } }));
      const initial = await readLogPoll();
      const rawBefore = structuredClone(getRequestLogEntries());
      priceConfig.providers.fixture!.modelCosts!["fixture-model"]!.output = 20;
      refreshUserCostOverlays(priceConfig);
      const changed = await readLogPoll("", initial.cursor);
      expect(changed.reset).toBe(true);
      expect(changed.logs[0]!.displayMetrics).not.toEqual(initial.logs[0]!.displayMetrics);
      expect(changed.logs).toEqual((await readLogPoll()).logs);
      expect(getRequestLogEntries()).toEqual(rawBefore);
    } finally {
      refreshUserCostOverlays(config);
    }
  });

  test("legacy cursors reset; invalid cursors return generic errors without reflecting input", async () => {
    addRequestLog(baseEntry({ requestId: "private-row" }));
    const legacy = Buffer.from(JSON.stringify({ v: 1, t: 1, id: "private-row" })).toString("base64url");
    const poll = await readLogPoll("provider=anthropic", legacy);
    expect(poll.reset).toBe(true);
    const payload = Buffer.from(poll.cursor, "base64url").toString();
    expect(payload).not.toContain("private-row");
    expect(payload).not.toContain("anthropic");
    for (const cursor of ["", "private-invalid-cursor", "x".repeat(513)]) {
      const url = new URL("http://localhost/api/logs");
      url.searchParams.set("cursor", cursor);
      const response = await handleManagementAPI(new Request(url), url, config);
      expect(response?.status).toBe(400);
      expect(await response!.json()).toEqual({ error: { code: "invalid_cursor", message: "invalid cursor" } });
    }
  });
});

/**
 * #4057: the account label was persisted on the row and on every attempt long before anything
 * could read it back. `requestLogDto` carries it only because it spreads the entry — the sibling
 * projection `requestLogEntryFromPersistedUsage` rebuilds field by field and warns in its own
 * comment that a field missing there never reaches usage.jsonl. These assertions pin the served
 * contract so a future field-by-field rewrite of the DTO cannot drop the label silently.
 */
describe("GET /api/logs account identity", () => {
  beforeEach(() => clearRequestLogsForTests());

  test("serves the account label on the row and on each attempt, and filters on it", async () => {
    addRequestLog(baseEntry({ requestId: "main-row", provider: "openai", accountLogLabel: "main" }));
    addRequestLog(baseEntry({
      requestId: "pool-row",
      provider: "openai",
      accountLogLabel: "p3f9a1",
      attempts: [
        { ordinal: 1, provider: "openai", model: "gpt-test", adapter: "openai-responses", status: 429, durationMs: 4, sendCount: 1, recoveryKinds: [], usageStatus: "unreported", accountLogLabel: "main" },
        { ordinal: 2, provider: "openai", model: "gpt-test", adapter: "openai-responses", status: 200, durationMs: 6, sendCount: 1, recoveryKinds: [], usageStatus: "reported", accountLogLabel: "p3f9a1" },
      ],
    }));
    addRequestLog(baseEntry({ requestId: "unlabelled-row", provider: "xai" }));

    const all = await readLogPoll("limit=2000");
    const pool = all.logs.find(row => row.requestId === "pool-row")!;
    expect(pool.accountLogLabel).toBe("p3f9a1");
    expect((pool.attempts as Array<Record<string, unknown>>).map(attempt => attempt.accountLogLabel))
      .toEqual(["main", "p3f9a1"]);
    expect(all.logs.find(row => row.requestId === "unlabelled-row")!.accountLogLabel).toBeUndefined();

    // The pool row is reachable through the account that REFUSED it as well as the one that
    // served it, which is what makes the filter usable for quota debugging.
    expect((await readLogPoll("account=main")).logs.map(row => row.requestId)).toEqual(["main-row", "pool-row"]);
    expect((await readLogPoll("account=p3f9a1")).logs.map(row => row.requestId)).toEqual(["pool-row"]);
    expect((await readLogPoll("account=p000000")).logs).toEqual([]);
  });
});

/**
 * #4038 — Logs showed one rate that conflates first-token latency with delivery speed.
 * `tokensPerSecond` never subtracted TTFT, and the MetricSource Pick did not even include
 * `firstOutputMs`, so a decode-rate metric could not be computed at all.
 *
 * The history matters more than the arithmetic here. Contributor PR #4040 implemented this exact
 * metric and was closed unmerged as an unreliable estimate: proxy TTFT is not the provider's
 * generation window, and a small post-TTFT remainder makes the number explode. The issue stayed
 * open, so the repository held both an acceptance criterion and a rejection of the same feature.
 *
 * MIN_DECODE_WINDOW_MS is what answers that rejection, and
 * "a decode window under the floor yields no value" is the assertion that proves it. Everything
 * else here is scaffolding around that one case.
 */
describe("estimated decode rate (#4038)", () => {
  test("subtracts TTFT, and leaves the end-to-end rate exactly as it was", async () => {
    addRequestLog(baseEntry({
      durationMs: 10_000,
      firstOutputMs: 2_000,
      usage: { inputTokens: 1000, outputTokens: 240 },
    }));
    const [dto] = await readLogs();
    // 240 tokens over the 8s AFTER the first token.
    expect(dto!.displayMetrics.decodeTokPerSecond).toEqual({ kind: "value", value: 30, estimated: true });
    // The e2e rate still divides by the whole 10s: 24. This metric is additive, not a correction.
    expect(dto!.displayMetrics.tokPerSecond).toEqual({ kind: "value", value: 24, estimated: false });
    // Derived at response time only, exactly like the metrics beside it.
    expect(Object.hasOwn(getRequestLogEntries()[0]!, "displayMetrics")).toBe(false);
  });

  test("is always marked estimated, even on a long, clean window", async () => {
    // Proxy TTFT is when the first byte reached the PROXY, never the provider's generation
    // start, so no window length makes this an exact measurement.
    addRequestLog(baseEntry({
      durationMs: 60_000,
      firstOutputMs: 1_000,
      usage: { inputTokens: 10, outputTokens: 5900, estimated: false },
    }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.decodeTokPerSecond.kind).toBe("value");
    expect(dto!.displayMetrics.decodeTokPerSecond.estimated).toBe(true);
  });

  test("a decode window under the floor yields no value rather than an absurd rate", async () => {
    // THE #4040 case. 240 tokens over a 50 ms remainder is 4800 tok/s, which is not a fact about
    // the model; it is a fact about clock granularity and proxy buffering. Refusing to print it
    // is the whole point of the guard.
    addRequestLog(baseEntry({
      durationMs: 10_000,
      firstOutputMs: 9_950,
      usage: { inputTokens: 1000, outputTokens: 240 },
    }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.decodeTokPerSecond).toEqual({
      kind: "unavailable",
      reason: "decode_window_too_short",
    });
    expect(JSON.stringify(dto!.displayMetrics.decodeTokPerSecond)).not.toContain("4800");
    // The end-to-end rate is unaffected and still reported.
    expect(dto!.displayMetrics.tokPerSecond.kind).toBe("value");
  });

  test("a missing TTFT is its own reason, not a bad duration", async () => {
    addRequestLog(baseEntry({
      durationMs: 10_000,
      usage: { inputTokens: 1000, outputTokens: 240 },
    }));
    const [dto] = await readLogs();
    expect(dto!.displayMetrics.decodeTokPerSecond).toEqual({ kind: "unavailable", reason: "ttft_missing" });
  });

  test("a TTFT at or past the total duration is an invalid duration", async () => {
    for (const firstOutputMs of [10_000, 12_000]) {
      clearRequestLogsForTests();
      addRequestLog(baseEntry({
        durationMs: 10_000,
        firstOutputMs,
        usage: { inputTokens: 1000, outputTokens: 240 },
      }));
      const [dto] = await readLogs();
      expect(dto!.displayMetrics.decodeTokPerSecond).toEqual({ kind: "unavailable", reason: "invalid_duration" });
    }
  });

  test("no output tokens is output_missing, and unsupported usage stays unsupported", async () => {
    clearRequestLogsForTests();
    addRequestLog(baseEntry({
      durationMs: 10_000,
      firstOutputMs: 1_000,
      usage: { inputTokens: 1000, outputTokens: 0 },
    }));
    expect((await readLogs())[0]!.displayMetrics.decodeTokPerSecond)
      .toEqual({ kind: "unavailable", reason: "output_missing" });

    clearRequestLogsForTests();
    addRequestLog(baseEntry({
      durationMs: 10_000,
      firstOutputMs: 1_000,
      usageStatus: "unsupported",
      usage: { inputTokens: 1000, outputTokens: 240 },
    }));
    expect((await readLogs())[0]!.displayMetrics.decodeTokPerSecond)
      .toEqual({ kind: "unavailable", reason: "usage_unsupported" });
  });

  test("each attempt measures its own window; the parent never borrows one", async () => {
    // requestLogDto maps attempts separately on purpose. Copying a child's firstOutputMs onto the
    // parent would report a window the parent never had.
    clearRequestLogsForTests();
    addRequestLog(baseEntry({
      durationMs: 20_000,
      usage: { inputTokens: 10, outputTokens: 400 },
      attempts: [{
        provider: "anthropic",
        model: "claude-3-haiku-20240307",
        durationMs: 10_000,
        firstOutputMs: 2_000,
        usageStatus: "reported",
        usage: { inputTokens: 10, outputTokens: 240 },
      }],
    } as Partial<RequestLogEntry>));
    const [dto] = await readLogs();
    // The parent has no TTFT of its own, so it reports none rather than the attempt's.
    expect(dto!.displayMetrics.decodeTokPerSecond).toEqual({ kind: "unavailable", reason: "ttft_missing" });
    expect(dto!.attempts[0].displayMetrics.decodeTokPerSecond)
      .toEqual({ kind: "value", value: 30, estimated: true });
  });

  test("request history opts out of the decode rate, parent and attempts alike", async () => {
    // /api/request-history shares this DTO but not its contract. The value would be meaningful
    // there — firstOutputMs does survive into a persisted-usage row — so the exclusion is a
    // scope decision rather than a correctness one, and it has to be asserted or it silently
    // reverses the first time someone touches the DTO.
    const { requestLogDto } = await import("../../src/server/management/shared");
    const entry = baseEntry({
      durationMs: 10_000,
      firstOutputMs: 2_000,
      usage: { inputTokens: 10, outputTokens: 240 },
      attempts: [{
        provider: "anthropic",
        model: "claude-3-haiku-20240307",
        durationMs: 10_000,
        firstOutputMs: 2_000,
        usageStatus: "reported",
        usage: { inputTokens: 10, outputTokens: 240 },
      }],
    } as Partial<RequestLogEntry>);

    const history = requestLogDto(entry, { includeDecodeRate: false }) as Record<string, any>;
    expect(Object.hasOwn(history.displayMetrics, "decodeTokPerSecond")).toBe(false);
    expect(Object.hasOwn(history.attempts[0].displayMetrics, "decodeTokPerSecond")).toBe(false);
    // Everything else the endpoint already returned is untouched.
    expect(history.displayMetrics.tokPerSecond.kind).toBe("value");
    expect(history.displayMetrics.cost).toBeDefined();

    // The default is still to include it, so /api/logs is unaffected by the opt-out existing.
    const logs = requestLogDto(entry) as Record<string, any>;
    expect(logs.displayMetrics.decodeTokPerSecond).toEqual({ kind: "value", value: 30, estimated: true });
  });

  test("the request-history route actually passes the opt-out", async () => {
    // The DTO assertion above proves the flag works; this proves the endpoint uses it. Without
    // it, a correct flag and a route that never sets it would both look fine.
    const source = await Bun.file("src/server/management/request-history-routes.ts").text();
    const calls = [...source.matchAll(/requestLogDto\(/g)];
    expect(calls.length).toBeGreaterThan(0);
    expect([...source.matchAll(/includeDecodeRate: false/g)]).toHaveLength(calls.length);
  });
});
