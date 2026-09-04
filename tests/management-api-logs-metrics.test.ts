import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import { usageLogPath } from "../src/usage/log";
import {
  addRequestLog,
  clearRequestLogsForTests,
  getRequestLogEntries,
  type RequestLogEntry,
} from "../src/server/request-log";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

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
  test("supports cursor delta polling, empty delta, eviction reset, and invalid cursor rejection", async () => {
    addRequestLog(baseEntry({ requestId: "req-1", timestamp: 1000, provider: "anthropic" }));
    addRequestLog(baseEntry({ requestId: "req-2", timestamp: 2000, provider: "anthropic" }));

    // Initial request returns the full window, an opaque cursor, and reset: false
    const initUrl = new URL("http://localhost/api/logs");
    const initRes = await handleManagementAPI(new Request(initUrl), initUrl, config);
    expect(initRes?.status).toBe(200);
    const initBody = await initRes!.json() as { logs: Array<{ requestId: string }>; cursor?: string; reset?: boolean; total: number };
    expect(initBody.logs.map(r => r.requestId)).toEqual(["req-1", "req-2"]);
    expect(typeof initBody.cursor).toBe("string");
    expect(initBody.reset).toBe(false);
    expect(initBody.total).toBe(2);

    const cursor1 = initBody.cursor!;

    // Empty delta when no new logs have been added
    const pollUrl = new URL(`http://localhost/api/logs?cursor=${encodeURIComponent(cursor1)}`);
    const pollRes = await handleManagementAPI(new Request(pollUrl), pollUrl, config);
    expect(pollRes?.status).toBe(200);
    const pollBody = await pollRes!.json() as { logs: Array<{ requestId: string }>; cursor?: string; reset?: boolean; total: number };
    expect(pollBody.logs).toEqual([]);
    expect(pollBody.cursor).toBe(cursor1);
    expect(pollBody.reset).toBe(false);
    expect(pollBody.total).toBe(2);

    // Live cursor returns only new entries
    addRequestLog(baseEntry({ requestId: "req-3", timestamp: 3000, provider: "anthropic" }));
    const pollRes2 = await handleManagementAPI(new Request(pollUrl), pollUrl, config);
    expect(pollRes2?.status).toBe(200);
    const pollBody2 = await pollRes2!.json() as { logs: Array<{ requestId: string }>; cursor?: string; reset?: boolean; total: number };
    expect(pollBody2.logs.map(r => r.requestId)).toEqual(["req-3"]);
    expect(pollBody2.cursor).not.toBe(cursor1);
    expect(pollBody2.reset).toBe(false);
    expect(pollBody2.total).toBe(3);

    // Filtered delta advances the raw cursor even if 0 matching rows in delta
    const filterUrl = new URL(`http://localhost/api/logs?provider=openai&cursor=${encodeURIComponent(cursor1)}`);
    const filterRes = await handleManagementAPI(new Request(filterUrl), filterUrl, config);
    expect(filterRes?.status).toBe(200);
    const filterBody = await filterRes!.json() as { logs: Array<{ requestId: string }>; cursor?: string; reset?: boolean; total: number };
    expect(filterBody.logs).toEqual([]);
    expect(filterBody.cursor).toBe(pollBody2.cursor);
    expect(filterBody.total).toBe(0);

    // Stale/evicted cursor returns full window with reset: true
    const fakeCursor = Buffer.from(JSON.stringify({ v: 1, t: 999, id: "evicted-req" })).toString("base64url");
    const staleUrl = new URL(`http://localhost/api/logs?cursor=${fakeCursor}`);
    const staleRes = await handleManagementAPI(new Request(staleUrl), staleUrl, config);
    expect(staleRes?.status).toBe(200);
    const staleBody = await staleRes!.json() as { logs: Array<{ requestId: string }>; cursor?: string; reset?: boolean; total: number };
    expect(staleBody.logs.map(r => r.requestId)).toEqual(["req-1", "req-2", "req-3"]);
    expect(staleBody.reset).toBe(true);

    // Malformed cursor fails closed with 400
    const badUrl = new URL("http://localhost/api/logs?cursor=not-valid-cursor");
    const badRes = await handleManagementAPI(new Request(badUrl), badUrl, config);
    expect(badRes?.status).toBe(400);
    const badBody = await badRes!.json();
    expect(badBody).toEqual({ error: { code: "invalid_cursor", message: "invalid cursor" } });
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
import { ManagementRequest as Request } from "./helpers/management-auth";
