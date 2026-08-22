import { describe, expect, test } from "bun:test";

import { handleObserveCommand } from "../src/cli/observe";

describe("Codex Log Guard CLI", () => {
  test("ocx storage codex-logs status uses the dedicated diagnostics endpoint", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async input => {
      seen.push(String(input));
      return new Response(JSON.stringify({ schema: { state: "compatible" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const originalLog = console.log;
    console.log = () => {};
    try {
      const code = await handleObserveCommand(
        ["storage", "codex-logs", "status", "--json"],
        { baseUrl: "http://runtime", fetchImpl },
      );
      expect(code).toBe(0);
      expect(seen).toEqual(["http://runtime/api/storage/codex-logs"]);
    } finally {
      console.log = originalLog;
    }
  });

  test("ocx storage remains an alias for the existing storage report", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async input => {
      seen.push(String(input));
      return new Response(JSON.stringify({ total: { bytes: 0, fileCount: 0 }, buckets: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const originalLog = console.log;
    console.log = () => {};
    try {
      const code = await handleObserveCommand(["storage", "--json"], { baseUrl: "http://runtime", fetchImpl });
      expect(code).toBe(0);
      expect(seen).toEqual(["http://runtime/api/storage"]);
    } finally {
      console.log = originalLog;
    }
  });
});
