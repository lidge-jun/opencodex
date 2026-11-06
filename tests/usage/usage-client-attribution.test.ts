import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyUsageClient, normalizeRecordedClient } from "../../src/usage/client";
import { normalizePersistedUsageRow, readUsageEntries, resetUsageReadCacheForTests, usageLogPath } from "../../src/usage/log";
import { addFinalRequestLog, addRequestLog, clearRequestLogsForTests, getRequestLogEntries, requestLogEntryFromPersistedUsage, type RequestLogEntry } from "../../src/server/request-log";
import { log } from "../helpers/request-log-entry";
import { removeTreeWithRetry } from "../helpers/remove-tree";

describe("usage client attribution", () => {
  test("classifies supported clients from bounded request headers", () => {
    expect(classifyUsageClient(new Headers({ originator: "codex_cli_rs" }))).toBe("codex_cli");
    expect(classifyUsageClient(new Headers({ originator: "codex-tui" }))).toBe("codex_cli");
    expect(classifyUsageClient(new Headers({ originator: "Codex Desktop" }))).toBe("codex_desktop");
    expect(classifyUsageClient(new Headers({ originator: "codex_vscode" }))).toBe("codex_ide");
    expect(classifyUsageClient(new Headers({ "user-agent": "claude-code/2.1.207" }))).toBe("claude_code");
  });

  test("does not infer an app from unknown, malformed, conflicting or oversized headers", () => {
    expect(classifyUsageClient(new Headers())).toBe("unknown");
    expect(classifyUsageClient(new Headers({ "user-agent": "claude-code/" }))).toBe("unknown");
    expect(classifyUsageClient(new Headers({ originator: "codex_cli_rs", "user-agent": "claude-code/1.0" }))).toBe("unknown");
    expect(classifyUsageClient(new Headers({ originator: "x".repeat(1025) }))).toBe("unknown");
    expect(classifyUsageClient(new Headers({ "user-agent": "private-header-marker" }))).toBe("unknown");
  });

  test("preserves missing old attribution while bounding present persisted values", () => {
    expect(normalizeRecordedClient(undefined)).toBeUndefined();
    expect(normalizeRecordedClient("codex_cli")).toBe("codex_cli");
    expect(normalizeRecordedClient("unknown")).toBe("unknown");
    expect(normalizeRecordedClient("private-header-marker")).toBe("unknown");
    expect(normalizeRecordedClient(null)).toBe("unknown");
  });

  test("ledger normalization distinguishes legacy rows from new and invalid client values", () => {
    const base = { requestId: "fixture", timestamp: 1, provider: "openai", model: "gpt-test",
      status: 200, durationMs: 1, usageStatus: "unreported" };
    expect(normalizePersistedUsageRow(base)).not.toHaveProperty("client");
    expect(normalizePersistedUsageRow({ ...base, client: "codex_cli" })).toHaveProperty("client", "codex_cli");
    expect(normalizePersistedUsageRow({ ...base, client: "private-header-marker" })).toHaveProperty("client", "unknown");
  });

  test("live, disk and rehydrated logs retain only closed client labels", () => {
    const previous = process.env.OPENCODEX_HOME;
    const testDir = mkdtempSync(join(tmpdir(), "ocx-client-attribution-"));
    process.env.OPENCODEX_HOME = testDir;
    clearRequestLogsForTests();
    try {
      const raw = Object.assign(log({ requestId: "invalid-client" }), { client: "private-header-marker" });
      addRequestLog(raw as unknown as RequestLogEntry);
      const finalized: RequestLogEntry[] = [];
      addFinalRequestLog("valid-client", 1, { model: "gpt-test", provider: "openai", client: "codex_cli" },
        200, { closeReason: "non_stream" }, row => finalized.push(row));
      expect(getRequestLogEntries()[0]?.client).toBe("unknown");
      expect(readUsageEntries()[0]?.client).toBe("unknown");
      expect(requestLogEntryFromPersistedUsage(readUsageEntries()[0]!)?.client).toBe("unknown");
      expect(finalized[0]?.client).toBe("codex_cli");
      expect(readFileSync(usageLogPath(), "utf8")).not.toContain("private-header-marker");
    } finally {
      clearRequestLogsForTests();
      resetUsageReadCacheForTests();
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(testDir);
    }
  });
});
