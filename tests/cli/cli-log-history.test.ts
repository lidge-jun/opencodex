/**
 * `ocx logs history` pages GET /api/request-history; `ocx logs get` reads one canonical row.
 */
import { describe, expect, test } from "bun:test";
import { handleObserveCommand } from "../../src/cli/observe";

function page(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entries: [
      {
        requestId: "req/1",
        timestamp: 1_700_000_000_000,
        status: 200,
        provider: "xai",
        model: "grok-4.6",
        durationMs: 42,
        totalTokens: 120,
        displayMetrics: { cost: { kind: "value", estimate: { cost: { total: 0.0123 } } } },
      },
    ],
    hasMore: true,
    nextCursor: "cursor-2",
    index: { indexedRows: 9, schemaVersion: 1 },
    ...overrides,
  };
}

async function run(
  argv: string[],
  body: unknown,
  status = 200,
): Promise<{ code: number; out: string; err: string; urls: string[] }> {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async input => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  const lines: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalErr = console.error;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    const code = await handleObserveCommand(argv, { baseUrl: "http://cli.test", fetchImpl });
    return { code, out: lines.join("\n"), err: errors.join("\n"), urls };
  } finally {
    console.log = originalLog;
    console.error = originalErr;
  }
}

describe("ocx logs history", () => {
  test("forwards filters, default limit, and prints cost plus a resumable cursor", async () => {
    const result = await run([
      "logs", "history",
      "--provider", "xai",
      "--model", "grok-4.6",
      "--requested-model", "grok",
      "--status", "200",
      "--conversation", "c/1",
      "--surface", "codex",
      "--protocol", "responses",
      "--api-key-id", "key-1",
      "--profile", "p1",
      "--fallback", "true",
      "--from", "1000",
      "--to", "2000",
    ], page());
    expect(result.code).toBe(0);
    const url = new URL(result.urls[0]!);
    expect(url.pathname).toBe("/api/request-history");
    expect(url.searchParams.get("provider")).toBe("xai");
    expect(url.searchParams.get("model")).toBe("grok-4.6");
    expect(url.searchParams.get("requestedModel")).toBe("grok");
    expect(url.searchParams.get("status")).toBe("200");
    expect(url.searchParams.get("conversationId")).toBe("c/1");
    expect(url.searchParams.get("surface")).toBe("codex");
    expect(url.searchParams.get("inboundProtocol")).toBe("responses");
    expect(url.searchParams.get("apiKeyId")).toBe("key-1");
    expect(url.searchParams.get("profileId")).toBe("p1");
    expect(url.searchParams.get("fallback")).toBe("true");
    expect(url.searchParams.get("from")).toBe("1000");
    expect(url.searchParams.get("to")).toBe("2000");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(result.out).toContain("id=req/1");
    expect(result.out).toContain("120tok");
    expect(result.out).toContain("~$0.0123");
    expect(result.out).toContain("nextCursor=cursor-2");
    expect(result.out).toContain("indexedRows=9");
  });

  test("JSON keeps the management payload and JSONL sends the cursor to stderr", async () => {
    const json = await run(["logs", "history", "--json", "--cursor", "abc", "--limit", "2"], page());
    expect(json.code).toBe(0);
    expect(new URL(json.urls[0]!).searchParams.get("cursor")).toBe("abc");
    expect(new URL(json.urls[0]!).searchParams.get("limit")).toBe("2");
    const parsed = JSON.parse(json.out) as { nextCursor: string; entries: unknown[] };
    expect(parsed.nextCursor).toBe("cursor-2");
    expect(parsed.entries).toHaveLength(1);

    const jsonl = await run(["logs", "history", "--jsonl"], page());
    expect(jsonl.code).toBe(0);
    expect(jsonl.out).toContain("\"requestId\":\"req/1\"");
    expect(jsonl.out).not.toContain("nextCursor");
    expect(jsonl.err).toBe("nextCursor=cursor-2");
  });

  test("empty matches succeed and ISO bounds are forwarded as epoch milliseconds", async () => {
    const result = await run([
      "logs", "history",
      "--from", "2026-10-01T00:00:00Z",
      "--to", "2026-10-01T00:00:00.000Z",
    ], page({ entries: [], hasMore: false, nextCursor: undefined }));
    expect(result.code).toBe(0);
    expect(result.out).toContain("No request-history row matched the filters.");
    const epoch = String(Date.parse("2026-10-01T00:00:00Z"));
    expect(new URL(result.urls[0]!).searchParams.get("from")).toBe(epoch);
    expect(new URL(result.urls[0]!).searchParams.get("to")).toBe(epoch);
  });

  test("rejects conflicting output flags, inverted bounds, and an out-of-range status", async () => {
    expect((await run(["logs", "history", "--json", "--jsonl"], page())).code).toBe(2);
    expect((await run(["logs", "history", "--from", "2000", "--to", "1000"], page())).code).toBe(2);
    expect((await run(["logs", "history", "--status", "99"], page())).code).toBe(2);
    expect((await run(["logs", "history", "--limit", "101"], page())).code).toBe(2);
    expect((await run(["logs", "history", "--protocol", "smtp"], page())).code).toBe(2);
    expect((await run(["logs", "history", "--fallback", "maybe"], page())).code).toBe(2);
  });
});

describe("ocx logs get", () => {
  test("URI-encodes the request id and prints the canonical row", async () => {
    const row = (page().entries as Record<string, unknown>[])[0]!;
    const result = await run(["logs", "get", "req/1", "--json"], row);
    expect(result.code).toBe(0);
    expect(result.urls[0]).toBe("http://cli.test/api/request-history/req%2F1");
    expect(JSON.parse(result.out).requestId).toBe("req/1");
  });

  test("missing request id is usage, and a 404 is exit 4", async () => {
    expect((await run(["logs", "get"], {})).code).toBe(2);
    const missing = await run(["logs", "get", "missing"], { error: "not found" }, 404);
    expect(missing.code).toBe(4);
  });
});
