import { expect, test } from "bun:test";
import { fetchAllSubjects } from "../src/pages/compatibility-matrix-api";

const API_BASE = "http://127.0.0.1:4096";

test("advancing pagination at the safety cap is truncated, not a contract error", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests += 1;
    const url = new URL(String(input));
    const cursor = Number(url.searchParams.get("cursor") ?? "0");
    return Response.json({
      subjects: [{ subjectId: `subject-${cursor}`, subjectKind: "protocol" }],
      hasMore: true,
      nextCursor: String(cursor + 1),
    });
  }) as typeof fetch;

  try {
    const result = await fetchAllSubjects(API_BASE, new AbortController().signal);
    expect(result.rows).toHaveLength(200);
    expect(result.rows.map(row => row.subjectId)).toEqual(
      Array.from({ length: 200 }, (_, cursor) => `subject-${cursor}`),
    );
    expect(result.truncated).toBe(true);
    expect(requests).toBe(200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});