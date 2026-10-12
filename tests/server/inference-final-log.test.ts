import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFinalRequestLog } from "../../src/server/inference/final-log";
import {
  clearRequestLogsForTests,
  getRequestLogEntries,
  type RequestLogContext,
} from "../../src/server/request-log";
import { resetUsageReadCacheForTests } from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function withIsolatedLogs(run: () => void): void {
  const previousHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-final-log-"));
  process.env.OPENCODEX_HOME = home;
  clearRequestLogsForTests();
  try {
    run();
  } finally {
    clearRequestLogsForTests();
    resetUsageReadCacheForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  }
}

describe("createFinalRequestLog", () => {
  test("the first finish writes the row and every later finish is a no-op", () => {
    withIsolatedLogs(() => {
      const logCtx: RequestLogContext = { model: "m", provider: "p" };
      const finalLog = createFinalRequestLog({ requestId: "final-once", start: Date.now() - 5 }, logCtx);
      expect(finalLog.finished()).toBe(false);

      finalLog.finish(200, { closeReason: "terminal", terminalStatus: "completed" });
      finalLog.finish(499, { closeReason: "client_cancel" });
      finalLog.finish(502);

      expect(finalLog.finished()).toBe(true);
      const rows = getRequestLogEntries().filter(row => row.requestId === "final-once");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe(200);
      expect(rows[0]?.closeReason).toBe("terminal");
    });
  });

  test("a destructured finish keeps the once-claim", () => {
    withIsolatedLogs(() => {
      const finish = createFinalRequestLog({ requestId: "final-bound", start: Date.now() }, { model: "m", provider: "p" }).finish;
      finish(499, { closeReason: "client_cancel" });
      finish(200, { closeReason: "non_stream" });
      const rows = getRequestLogEntries().filter(row => row.requestId === "final-bound");
      expect(rows.map(row => row.status)).toEqual([499]);
    });
  });

  test("without log ids nothing is written but the claim still settles", () => {
    withIsolatedLogs(() => {
      const finalLog = createFinalRequestLog(undefined, { model: "m", provider: "p" });
      finalLog.finish(200);
      expect(finalLog.finished()).toBe(true);
      expect(getRequestLogEntries()).toHaveLength(0);
    });
  });
});
