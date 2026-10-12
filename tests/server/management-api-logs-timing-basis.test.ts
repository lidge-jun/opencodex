import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeTokPerSecondResult, requestLogDto, tokPerSecondResult } from "../../src/server/management/shared";
import { handleManagementAPI } from "../../src/server/management-api";
import { addRequestLog, clearRequestLogsForTests, hydrateRequestLogsFromDisk, type RequestLogEntry } from "../../src/server/request-log";
import { usageLogPath } from "../../src/usage/log";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { ManagementRequest } from "../helpers/management-auth";

const scalar: RequestLogEntry = {
  requestId: "timing-fixture", timestamp: 1_700_000_000_000,
  provider: "openai", model: "gpt-test", status: 200, usageStatus: "reported",
  durationMs: 36871, firstOutputMs: 35175,
  usage: { inputTokens: 10, outputTokens: 227, reasoningOutputTokens: 168 },
};
const generation = { ...scalar, genStartMs: 26115, lastOutputMs: 36526 };

describe("decode timing basis is additive display data", () => {
  test("the issue's mixed-history fixture keeps all three rates and the full output numerator", () => {
    const old = decodeTokPerSecondResult(scalar);
    const current = decodeTokPerSecondResult(generation);
    const e2e = tokPerSecondResult(scalar);
    expect(old).toEqual({ kind: "value", value: 227 / 1.696, estimated: true, timingBasis: "legacy-post-visible-output" });
    expect(current).toEqual({ kind: "value", value: 227 / 10.411, estimated: true, timingBasis: "generation-window" });
    expect(e2e).toEqual({ kind: "value", value: 227 / 36.871, estimated: false });
    expect(tokPerSecondResult(generation)).toEqual(e2e);
    if (old.kind === "value" && current.kind === "value" && e2e.kind === "value") {
      expect(old.value).toBeCloseTo(133.844, 3);
      expect(current.value).toBeCloseTo(21.804, 3);
      expect(e2e.value).toBeCloseTo(6.157, 3);
    }
  });

  for (const [name, fields] of [
    ["missing pair", {}], ["only start", { genStartMs: 26115 }],
    ["only end", { lastOutputMs: 36526 }], ["NaN start", { genStartMs: NaN, lastOutputMs: 36526 }],
    ["infinite end", { genStartMs: 26115, lastOutputMs: Infinity }],
  ] as const) {
    test(`${name} preserves the existing legacy fallback`, () => {
      expect(decodeTokPerSecondResult({ ...scalar, ...fields })).toEqual(decodeTokPerSecondResult(scalar));
      expect(decodeTokPerSecondResult({ ...scalar, ...fields, firstOutputMs: undefined }))
        .toEqual({ kind: "unavailable", reason: "ttft_missing" });
    });
  }

  for (const [name, fields, reason] of [
    ["no visible timestamp", { firstOutputMs: undefined }, "ttft_missing"],
    ["negative visible timestamp", { firstOutputMs: -1 }, "invalid_duration"],
    ["nonfinite visible timestamp", { firstOutputMs: NaN }, "invalid_duration"],
    ["nonfinite duration", { durationMs: Infinity }, "invalid_duration"],
    ["reversed visible window", { firstOutputMs: 36872 }, "invalid_duration"],
    ["zero visible window", { firstOutputMs: 36871 }, "invalid_duration"],
    ["short visible window", { firstOutputMs: 35872 }, "decode_window_too_short"],
    ["reversed generation window", { genStartMs: 36526, lastOutputMs: 26115 }, "invalid_duration"],
    ["zero generation window", { genStartMs: 26115, lastOutputMs: 26115 }, "invalid_duration"],
    ["short generation window", { genStartMs: 26115, lastOutputMs: 27114 }, "decode_window_too_short"],
    ["no usage", { usage: undefined }, "usage_missing"],
    ["unsupported usage", { usageStatus: "unsupported" }, "usage_unsupported"],
    ["no output", { usage: { inputTokens: 10, outputTokens: 0 } }, "output_missing"],
    ["nonfinite output", { usage: { inputTokens: 10, outputTokens: NaN } }, "invalid_duration"],
  ] as const) {
    test(`${name} stays unavailable without a claimed basis`, () => {
      expect(decodeTokPerSecondResult({ ...scalar, ...fields }))
        .toEqual({ kind: "unavailable", reason });
    });
  }

  test("exactly one second remains available for both bases", () => {
    expect(decodeTokPerSecondResult({ ...scalar, firstOutputMs: 35871 }))
      .toEqual({ kind: "value", value: 227, estimated: true, timingBasis: "legacy-post-visible-output" });
    expect(decodeTokPerSecondResult({ ...generation, lastOutputMs: 27115 }))
      .toEqual({ kind: "value", value: 227, estimated: true, timingBasis: "generation-window" });
  });

  test("attempts use their own legacy windows; history opts out and the source stays untouched", () => {
    const entry = {
      ...generation,
      attempts: [
        { ordinal: 1, provider: "openai", model: "gpt-test", adapter: "openai-chat", status: 200,
          durationMs: 10000, firstOutputMs: 2000, sendCount: 1, recoveryKinds: [],
          usageStatus: "reported", usage: { inputTokens: 10, outputTokens: 240 } },
        { ordinal: 2, provider: "openai", model: "gpt-test", adapter: "openai-chat", status: 200,
          durationMs: 10000, sendCount: 1, recoveryKinds: [],
          usageStatus: "reported", usage: { inputTokens: 10, outputTokens: 240 } },
      ],
    } satisfies RequestLogEntry;
    const before = JSON.stringify(entry);
    const dto = requestLogDto(entry) as Record<string, any>;
    expect(dto.displayMetrics.decodeTokPerSecond.timingBasis).toBe("generation-window");
    expect(dto.attempts[0].displayMetrics.decodeTokPerSecond)
      .toEqual({ kind: "value", value: 30, estimated: true, timingBasis: "legacy-post-visible-output" });
    expect(dto.attempts[1].displayMetrics.decodeTokPerSecond).toEqual({ kind: "unavailable", reason: "ttft_missing" });
    const history = requestLogDto(entry, { includeDecodeRate: false }) as Record<string, any>;
    expect(history.displayMetrics).not.toHaveProperty("decodeTokPerSecond");
    for (const attempt of history.attempts) expect(attempt.displayMetrics).not.toHaveProperty("decodeTokPerSecond");
    expect(history.displayMetrics.tokPerSecond).toEqual(dto.displayMetrics.tokPerSecond);
    expect(JSON.stringify(entry)).toBe(before);
  });
});

describe("mixed persisted Logs history", () => {
  let testDir: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    testDir = mkdtempSync(join(tmpdir(), "ocx-logs-timing-"));
    process.env.OPENCODEX_HOME = testDir;
    clearRequestLogsForTests();
  });
  afterEach(() => {
    clearRequestLogsForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(testDir);
  });

  test("GET /api/logs after hydration labels both bases without rewriting JSONL", async () => {
    addRequestLog({ ...scalar, requestId: "legacy-row" });
    addRequestLog({ ...generation, requestId: "generation-row" });
    const path = usageLogPath();
    const before = readFileSync(path, "utf8");
    clearRequestLogsForTests();
    expect(hydrateRequestLogsFromDisk()).toBe(2);
    const url = new URL("http://localhost/api/logs");
    const response = await handleManagementAPI(new ManagementRequest(url), url, { providers: [] } as unknown as OcxConfig);
    expect(response?.status).toBe(200);
    const { logs } = await response!.json() as { logs: Array<Record<string, any>> };
    const byId = new Map(logs.map(row => [row.requestId, row]));
    expect(byId.get("legacy-row")!.displayMetrics.decodeTokPerSecond).toEqual(decodeTokPerSecondResult(scalar));
    expect(byId.get("generation-row")!.displayMetrics.decodeTokPerSecond).toEqual(decodeTokPerSecondResult(generation));
    expect(byId.get("legacy-row")).not.toHaveProperty("genStartMs");
    expect(byId.get("legacy-row")).not.toHaveProperty("lastOutputMs");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(before).not.toContain("timingBasis");
    expect(before).not.toContain("displayMetrics");
  });
});
