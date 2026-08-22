import { describe, expect, test } from "bun:test";

import { handleObserveCommand } from "../src/cli/observe";

describe("Codex Log Guard compact CLI", () => {
  test("compact POSTs to the dedicated maintenance endpoint", async () => {
    const seen: Array<{ url: string; method: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({
        report: {
          before: { freelistPages: 10, reclaimableBytes: 40960 },
          after: { freelistPages: 2, reclaimableBytes: 8192 },
          pagesReclaimed: 8,
          physicalDatabaseBytesReclaimed: 32768,
          complete: false,
          stopReason: "page_budget",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const originalLog = console.log;
    console.log = () => {};
    try {
      expect(await handleObserveCommand(
        ["storage", "codex-logs", "compact", "--json"],
        { baseUrl: "http://runtime", fetchImpl },
      )).toBe(0);
      expect(seen).toEqual([{
        url: "http://runtime/api/storage/codex-logs/compact",
        method: "POST",
      }]);
    } finally {
      console.log = originalLog;
    }
  });

  test("compact rejects protection-only mode flags before making a request", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      expect(await handleObserveCommand(
        ["storage", "codex-logs", "compact", "--mode", "quiet"],
        { baseUrl: "http://runtime", fetchImpl },
      )).not.toBe(0);
      expect(calls).toBe(0);
    } finally {
      console.error = originalError;
    }
  });
});
