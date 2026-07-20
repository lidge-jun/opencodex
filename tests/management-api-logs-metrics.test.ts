import { afterEach, describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import {
  addRequestLog,
  clearRequestLogsForTests,
  getRequestLogEntries,
  type RequestLogEntry,
} from "../src/server/request-log";
import type { OcxConfig } from "../src/types";

const config = { providers: [] } as unknown as OcxConfig;

afterEach(() => clearRequestLogsForTests());

async function readLogs(): Promise<Array<Record<string, any>>> {
  const url = new URL("http://localhost/api/logs");
  const response = await handleManagementAPI(new Request(url), url, config);
  expect(response?.status).toBe(200);
  return await response!.json() as Array<Record<string, any>>;
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
});
