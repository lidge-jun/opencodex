import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRequestLog, clearRequestLogsForTests, requestLogEntryFromPersistedUsage } from "../../src/server/request-log";
import { readUsageEntries, resetUsageReadCacheForTests } from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { log } from "../helpers/request-log-entry";

describe("request log metadata", () => {
  test("persistence keeps the attempt normalization loss flag", () => {
    const attempt = { ordinal: 1, provider: "openai", model: "model", adapter: "openai-chat",
      status: 500, durationMs: 100, sendCount: 3, recoveryKinds: [], usageStatus: "unreported" } as const;
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-lossy-normalization-log-"));
    process.env.OPENCODEX_HOME = home;
    clearRequestLogsForTests();
    resetUsageReadCacheForTests();
    try {
      addRequestLog(log({ requestId: "lossy-normalization", attempts: [attempt, { ...attempt, ordinal: 2, sendCount: 0, adapter: "" }] }));
      expect(readUsageEntries()[0]?.attemptNormalizationDropped).toBe(true);
      expect(requestLogEntryFromPersistedUsage(readUsageEntries()[0]!).attemptNormalizationDropped).toBe(true);
    } finally {
      clearRequestLogsForTests();
      resetUsageReadCacheForTests();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  });

});
