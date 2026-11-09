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
  test.each(["unknown", "codex_cli", "claude_code"] as const)("direct ingress retains an immutable normalized %s row", client => {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-valid-normalization-log-"));
    process.env.OPENCODEX_HOME = home;
    clearRequestLogsForTests();
    try {
      const attempt = { ordinal: 1, provider: "openai", model: "model", adapter: "openai-chat",
        status: 500, durationMs: 100, sendCount: 3, recoveryKinds: [], usageStatus: "unreported" as const,
        liveOnlyMetadata: "retained" };
      const attempts = [attempt];
      const entry = Object.freeze(log({ client, attempts }));
      addRequestLog(entry);
      expect(getRequestLogEntries()[0]).toBe(entry);
      expect(getRequestLogEntries()[0]!.client).toBe(client);
      expect(getRequestLogEntries()[0]!.attempts).toBe(attempts);
      expect(getRequestLogEntries()[0]!.attempts![0]).toBe(attempt);
    } finally {
      clearRequestLogsForTests();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  });

  test("new direct rows receive unknown client without changing the caller", () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-new-client-log-"));
    process.env.OPENCODEX_HOME = home;
    clearRequestLogsForTests();
    resetUsageReadCacheForTests();
    try {
      const entry = log({});
      expect(entry).not.toHaveProperty("client");
      addRequestLog(entry);
      expect(entry).not.toHaveProperty("client");
      expect(getRequestLogEntries()[0]).toMatchObject({ client: "unknown" });
      expect(readUsageEntries()[0]).toHaveProperty("client", "unknown");
      expect(normalizeUsageEntryForTest(log({}))).not.toHaveProperty("client");
    } finally {
      clearRequestLogsForTests();
      resetUsageReadCacheForTests();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  });

  for (const shape of ["enumerable", "non-enumerable", "inherited"] as const) test(`direct ${shape} client cannot change after recording`, () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-client-isolation-log-"));
    process.env.OPENCODEX_HOME = home;
    clearRequestLogsForTests();
    resetUsageReadCacheForTests();
    try {
      const entry = log({});
      if (shape === "inherited") Object.setPrototypeOf(entry, { client: "codex_cli" });
      else Object.defineProperty(entry, "client", { value: "codex_cli", enumerable: shape === "enumerable", writable: true, configurable: true });
      addRequestLog(entry);
      Object.defineProperty(entry, "client", { value: "private-header-marker", enumerable: true, writable: true, configurable: true });
      const live = getRequestLogEntries()[0]!;
      expect(live.client).toBe("codex_cli");
      expect(requestLogDto(live)).toHaveProperty("client", "codex_cli");
      expect(readUsageEntries()[0]).toHaveProperty("client", "codex_cli");
      expect(JSON.stringify(requestLogDto(live))).not.toContain("private-header-marker");
    } finally {
      clearRequestLogsForTests();
      resetUsageReadCacheForTests();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  });

  for (const shape of ["non-enumerable", "inherited"] as const) test(`projection preserves ${shape} client and loss marker`, () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-projected-client-log-"));
    process.env.OPENCODEX_HOME = home;
    clearRequestLogsForTests();
    resetUsageReadCacheForTests();
    try {
      const entry = log({});
      if (shape === "inherited") Object.setPrototypeOf(entry, { client: "codex_cli" });
      else Object.defineProperty(entry, "client", { value: "codex_cli", enumerable: false });
      Object.defineProperty(entry, "attemptNormalizationDropped", { value: true, enumerable: false });
      Object.assign(entry, { upstreamError: "private-upstream-marker" });
      addRequestLog(entry);
      const live = getRequestLogEntries()[0]!;
      expect(live.client).toBe("codex_cli");
      expect(requestLogDto(live)).toHaveProperty("attemptNormalizationDropped", true);
      expect(readUsageEntries()[0]).toMatchObject({ client: "codex_cli", attemptNormalizationDropped: true });
      expect(JSON.stringify(requestLogDto(live))).not.toContain("private-upstream-marker");
    } finally {
      clearRequestLogsForTests();
      resetUsageReadCacheForTests();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  });

  test("frozen rows with changing getters cannot expose later upstream text", () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-accessor-log-"));
    process.env.OPENCODEX_HOME = home;
    clearRequestLogsForTests();
    try {
      let expose = false;
      const entry = log({ client: "codex_cli" });
      Object.defineProperty(entry, "upstreamError", { enumerable: true, get: () => expose ? "private-upstream-marker" : undefined });
      Object.freeze(entry);
      addRequestLog(entry);
      expose = true;
      expect(JSON.stringify(requestLogDto(getRequestLogEntries()[0]!))).not.toContain("private-upstream-marker");
    } finally {
      clearRequestLogsForTests();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  });

  for (const shape of ["non-enumerable", "inherited"] as const) test(`projection classifies ${shape} upstream evidence without storing it`, () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-upstream-evidence-log-"));
    process.env.OPENCODEX_HOME = home;
    clearRequestLogsForTests();
    resetUsageReadCacheForTests();
    try {
      const entry = log({ status: 500, client: "codex_cli" });
      const message = "Provider connect timeout after 1000ms";
      if (shape === "inherited") Object.setPrototypeOf(entry, { upstreamError: message });
      else Object.defineProperty(entry, "upstreamError", { value: message, enumerable: false });
      addRequestLog(entry);
      const live = getRequestLogEntries()[0]!;
      expect(live.failureDetail).toEqual({ code: "connect_timeout", value: 1000 });
      expect(readUsageEntries()[0]?.failureDetail).toEqual({ code: "connect_timeout", value: 1000 });
      expect(JSON.stringify(requestLogDto(live))).not.toContain(message);
    } finally {
      clearRequestLogsForTests();
      resetUsageReadCacheForTests();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  });

  for (const shape of ["non-enumerable", "inherited"] as const) test(`projection classifies ${shape} quota reset evidence`, () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-quota-evidence-log-"));
    process.env.OPENCODEX_HOME = home;
    clearRequestLogsForTests();
    resetUsageReadCacheForTests();
    try {
      const entry = log({ provider: "meta-muse", status: 429, timestamp: Date.parse("2026-11-01T00:00:00Z"), errorCode: "rate_limit_exceeded" });
      const message = "Subscription quota exhausted. Your usage window resets at 2026-11-02T00:00:00Z.";
      if (shape === "inherited") Object.setPrototypeOf(entry, { upstreamError: message });
      else Object.defineProperty(entry, "upstreamError", { value: message, enumerable: false });
      addRequestLog(entry);
      const live = getRequestLogEntries()[0]!;
      expect(live.rateLimitResetAt).toBe(Date.parse("2026-11-02T00:00:00Z"));
      expect(readUsageEntries()[0]?.rateLimitResetAt).toBe(live.rateLimitResetAt);
      expect(JSON.stringify(requestLogDto(live))).not.toContain(message);
    } finally {
      clearRequestLogsForTests();
      resetUsageReadCacheForTests();
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
