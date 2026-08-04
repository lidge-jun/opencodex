import { afterEach, expect, spyOn, test } from "bun:test";
import {
  assertCodexCatalogRefreshComplete,
  refreshCodexCatalogWithRetry,
} from "../src/codex/catalog-refresh-status";
import { getDebugLogEntries, resetDebugLogBufferForTests } from "../src/lib/debug-log-buffer";
import { resetDebugSettingsForTests, setDebugSettings } from "../src/lib/debug-settings";

afterEach(() => {
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
});

test.each([
  ["missing", { catalogExists: false }],
  ["unwritten", { catalogExists: true, catalogWritten: false }],
  ["cache_unsynced", { catalogExists: true, catalogWritten: true, cacheSynced: false }],
] as const)("catalog refresh records only the internal %s classification", async (reason, result) => {
  setDebugSettings({ debug: true });
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const pending = await refreshCodexCatalogWithRetry(async () => {
      assertCodexCatalogRefreshComplete(result);
    });

    expect(pending).toBe(true);
    const lines = getDebugLogEntries().map(entry => entry.line);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`"attempt":1`);
    expect(lines[1]).toContain(`"attempt":2`);
    expect(lines.every(line => line.includes(`"reason":"${reason}"`))).toBe(true);
  } finally {
    warning.mockRestore();
    errorLog.mockRestore();
  }
});

test("catalog refresh diagnostics never retain raw exception details", async () => {
  setDebugSettings({ debug: true });
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const privateDetail = "https://alice:horse-battery@example.test/home/example/acct-123456";
  try {
    const pending = await refreshCodexCatalogWithRetry(async () => {
      throw new Error(privateDetail);
    });

    expect(pending).toBe(true);
    const lines = getDebugLogEntries().map(entry => entry.line).join("\n");
    expect(lines).toContain(`"reason":"exception"`);
    expect(lines).not.toContain(privateDetail);
    expect(lines).not.toContain("horse-battery");
    expect(lines).not.toContain("alice");
    expect(lines).not.toContain("acct-123456");
  } finally {
    warning.mockRestore();
    errorLog.mockRestore();
  }
});
