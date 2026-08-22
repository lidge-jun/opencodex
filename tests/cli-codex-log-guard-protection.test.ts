import { describe, expect, test } from "bun:test";

import { handleObserveCommand } from "../src/cli/observe";

function responseBody() {
  return {
    schema: { state: "compatible" },
    protection: { desiredMode: "compat", observedMode: "compat", state: "active" },
  };
}

describe("Codex Log Guard protection CLI", () => {
  test("protect defaults to compat and POSTs through the management API", async () => {
    const seen: Array<{ url: string; method: string; body: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify(responseBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const originalLog = console.log;
    console.log = () => {};
    try {
      const code = await handleObserveCommand(
        ["storage", "codex-logs", "protect", "--json"],
        { baseUrl: "http://runtime", fetchImpl },
      );
      expect(code).toBe(0);
      expect(seen).toEqual([{
        url: "http://runtime/api/storage/codex-logs/protect",
        method: "POST",
        body: JSON.stringify({ mode: "compat" }),
      }]);
    } finally {
      console.log = originalLog;
    }
  });

  test("protect accepts quiet explicitly", async () => {
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify(responseBody()), { status: 200 });
    };
    const originalLog = console.log;
    console.log = () => {};
    try {
      expect(await handleObserveCommand(
        ["storage", "codex-logs", "protect", "--mode", "quiet", "--json"],
        { baseUrl: "http://runtime", fetchImpl },
      )).toBe(0);
      expect(bodies).toEqual([JSON.stringify({ mode: "quiet" })]);
    } finally {
      console.log = originalLog;
    }
  });

  test("unprotect and repair use dedicated POST endpoints", async () => {
    const seen: Array<{ url: string; method: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response(JSON.stringify(responseBody()), { status: 200 });
    };
    const originalLog = console.log;
    console.log = () => {};
    try {
      expect(await handleObserveCommand(
        ["storage", "codex-logs", "unprotect", "--json"],
        { baseUrl: "http://runtime", fetchImpl },
      )).toBe(0);
      expect(await handleObserveCommand(
        ["storage", "codex-logs", "repair", "--json"],
        { baseUrl: "http://runtime", fetchImpl },
      )).toBe(0);
      expect(seen).toEqual([
        { url: "http://runtime/api/storage/codex-logs/unprotect", method: "POST" },
        { url: "http://runtime/api/storage/codex-logs/repair", method: "POST" },
      ]);
    } finally {
      console.log = originalLog;
    }
  });

  test("rejects unknown protection modes before making a request", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      const code = await handleObserveCommand(
        ["storage", "codex-logs", "protect", "--mode", "maximum"],
        { baseUrl: "http://runtime", fetchImpl },
      );
      expect(code).not.toBe(0);
      expect(calls).toBe(0);
    } finally {
      console.error = originalError;
    }
  });
});
