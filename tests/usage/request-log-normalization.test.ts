import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRequestLog, clearRequestLogsForTests, getRequestLogEntries, requestLogEntryFromPersistedUsage } from "../../src/server/request-log";
import { requestLogDto } from "../../src/server/management/shared";
import { normalizeUsageEntryForTest, readUsageEntries, resetUsageReadCacheForTests } from "../../src/usage/log";
import { failureSummary } from "../../gui/src/pages/logs-failure-summary";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { log } from "../helpers/request-log-entry";

describe("request log metadata", () => {
  test("direct ingress retains an already normalized row", () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-valid-normalization-log-"));
    process.env.OPENCODEX_HOME = home;
    clearRequestLogsForTests();
    try {
      const entry = log({ attempts: [{ ordinal: 1, provider: "openai", model: "model", adapter: "openai-chat",
        status: 500, durationMs: 100, sendCount: 3, recoveryKinds: [], usageStatus: "unreported" }] });
      addRequestLog(entry);
      expect(getRequestLogEntries()[0]).toBe(entry);
    } finally {
      clearRequestLogsForTests();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  });

  test("sanitizing a normalized lossy row preserves its loss marker across surfaces", () => {
    const attempt = { ordinal: 1, provider: "openai", model: "model", adapter: "openai-chat",
      status: 500, durationMs: 100, sendCount: 3, recoveryKinds: [], usageStatus: "unreported" } as const;
    const normalized = normalizeUsageEntryForTest(log({ requestId: "lossy-sanitized", status: 500,
      spend: { sends: 3, settled: 3, unresolved: 0 },
      attempts: [attempt, { ...attempt, ordinal: 2, sendCount: 0, adapter: "" }] }));
    expect(normalized.attempts).toHaveLength(1);
    expect(normalized.attemptNormalizationDropped).toBe(true);
    expect(Object.prototype.propertyIsEnumerable.call(normalized, "attemptNormalizationDropped")).toBe(false);
    normalized.shadowCallRewrittenFrom = "model\nunsafe";
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-lossy-sanitized-log-"));
    process.env.OPENCODEX_HOME = home;
    clearRequestLogsForTests();
    resetUsageReadCacheForTests();
    try {
      addRequestLog(normalized);
      const dto = requestLogDto(getRequestLogEntries()[0]!);
      expect(dto.attemptNormalizationDropped).toBe(true);
      expect(readUsageEntries()[0]?.attemptNormalizationDropped).toBe(true);
      expect(failureSummary(dto, null, key => key).retries).toBeUndefined();
    } finally {
      clearRequestLogsForTests();
      resetUsageReadCacheForTests();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  });

  for (const mixed of [false, true]) test(`direct ingress normalizes ${mixed ? "mixed" : "single malformed"} attempts before live retention`, () => {
    const attempt = { ordinal: 1, provider: "openai", model: "model", adapter: "openai-chat",
      status: 500, durationMs: 100, sendCount: 3, recoveryKinds: [], usageStatus: "unreported" } as const;
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-lossy-normalization-log-"));
    process.env.OPENCODEX_HOME = home;
    clearRequestLogsForTests();
    resetUsageReadCacheForTests();
    try {
      const malformed = { ...attempt, ordinal: 2, adapter: "" };
      addRequestLog(log({ requestId: "lossy-normalization", status: 500,
        spend: { sends: 3, settled: 3, unresolved: 0 }, attempts: mixed ? [attempt, malformed] : [malformed] }));
      const liveEntry = getRequestLogEntries()[0]!;
      const persisted = readUsageEntries()[0]!;
      const hydratedEntry = requestLogEntryFromPersistedUsage(persisted);
      for (const row of [liveEntry, persisted, hydratedEntry]) {
        expect(row.attempts).toEqual(mixed ? [attempt] : []);
        expect(row.attemptNormalizationDropped).toBe(true);
      }
      const live = requestLogDto(liveEntry);
      const hydrated = requestLogDto(hydratedEntry);
      expect(live.attempts).toEqual(hydrated.attempts);
      for (const row of [live, hydrated]) {
        expect(row.attemptNormalizationDropped).toBe(true);
        expect(failureSummary(row, null, key => key).retries).toBeUndefined();
      }
    } finally {
      clearRequestLogsForTests();
      resetUsageReadCacheForTests();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  });

});
