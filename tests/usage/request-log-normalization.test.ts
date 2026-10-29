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
      const attempt = { ordinal: 1, provider: "openai", model: "model", adapter: "openai-chat",
        status: 500, durationMs: 100, sendCount: 3, recoveryKinds: [], usageStatus: "unreported" as const,
        liveOnlyMetadata: "retained" };
      const attempts = [attempt];
      const entry = log({ attempts });
      addRequestLog(entry);
      expect(getRequestLogEntries()[0]).toBe(entry);
      expect(getRequestLogEntries()[0]!.attempts).toBe(attempts);
      expect(getRequestLogEntries()[0]!.attempts![0]).toBe(attempt);
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

  for (const mixed of [false, true]) test(`direct ingress marks ${mixed ? "mixed" : "single partial"} attempts without changing the live roster`, () => {
    const attempt = { ordinal: 1, provider: "openai", model: "model", adapter: "openai-chat",
      status: 500, durationMs: 100, sendCount: 3, recoveryKinds: [], usageStatus: "unreported",
      liveOnlyMetadata: "retained" } as const;
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-lossy-normalization-log-"));
    process.env.OPENCODEX_HOME = home;
    clearRequestLogsForTests();
    resetUsageReadCacheForTests();
    try {
      const partial = { ordinal: 2, provider: "openai", model: "model", durationMs: 100,
        usageStatus: "unreported", liveOnlyMetadata: "partial" };
      const attempts = mixed ? [attempt, partial] : [partial];
      addRequestLog(log({ requestId: "lossy-normalization", status: 500,
        spend: { sends: 3, settled: 3, unresolved: 0 }, attempts: attempts as unknown as typeof attempt[] }));
      const liveEntry = getRequestLogEntries()[0]!;
      const persisted = readUsageEntries()[0]!;
      const hydratedEntry = requestLogEntryFromPersistedUsage(persisted);
      expect(liveEntry.attempts).toBe(attempts);
      attempts.forEach((item, index) => expect(liveEntry.attempts![index]).toBe(item));
      expect(liveEntry.attempts).toEqual(attempts);
      const { liveOnlyMetadata: _, ...persistedAttempt } = attempt;
      for (const row of [persisted, hydratedEntry]) {
        expect(row.attempts).toEqual(mixed ? [persistedAttempt] : []);
        expect(row.attemptNormalizationDropped).toBe(true);
      }
      const live = requestLogDto(liveEntry);
      const hydrated = requestLogDto(hydratedEntry);
      expect(live.attempts).toHaveLength(attempts.length);
      expect(hydrated.attempts).toHaveLength(mixed ? 1 : 0);
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
