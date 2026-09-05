import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import { usageLogPath } from "../../src/usage/log";
import {
  addRequestLog,
  clearRequestLogsForTests,
  getRequestLogEntries,
  type RequestLogEntry,
} from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { buildRouteDecisionTrace } from "../../src/routing/trace";
import { summarizeUsage } from "../../src/usage/summary";
import { removeTreeWithRetry } from "../helpers/remove-tree";

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
