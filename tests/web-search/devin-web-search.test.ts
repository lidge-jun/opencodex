import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeMessage, encodeString } from "../../src/adapters/devin/cloud-direct/wire";
import { mapDevinWebSearchResponse, resolveDevinWebSearchSnapshot, runDevinWebSearch } from "../../src/web-search/devin-executor";
import { MAX_SIDECAR_RESPONSE_BYTES } from "../../src/web-search/parse";
import { saveCredential } from "../../src/oauth/store";
import type { OAuthAccessSnapshot } from "../../src/oauth";

const originalFetch = globalThis.fetch;
const snapshot: OAuthAccessSnapshot = {
  provider: "devin",
  accountId: "account",
  generation: "generation",
  accessToken: "devin-session-token$canary9876543210",
  apiBaseUrl: "https://server.codeium.com",
};

afterEach(() => { globalThis.fetch = originalFetch; });

function result(fields: { url: string; title: string; summary?: string; chunk?: string }): Buffer {
  const chunks = fields.chunk
    ? [encodeMessage(6, encodeMessage(3, encodeString(2, fields.chunk)))]
    : [];
  return Buffer.concat([
    encodeString(1, "document-id"),
    encodeString(3, fields.url),
    encodeString(4, fields.title),
    ...chunks,
    ...(fields.summary ? [encodeString(7, fields.summary)] : []),
  ]);
}

describe("Devin native web search response", () => {
  test("maps summary, excerpts, and safe citations without model inference", () => {
    const response = Buffer.concat([
      encodeMessage(1, result({
        url: "https://docs.example/search",
        title: "Search docs",
        summary: "Authoritative result excerpt.",
      })),
      encodeMessage(1, result({
        url: "https://blog.example/update",
        title: "Update",
        chunk: "Fallback markdown chunk.",
      })),
      encodeMessage(1, result({
        url: "javascript:alert(1)",
        title: "Unsafe",
        summary: "must be dropped",
      })),
      encodeString(3, "Provider summary."),
    ]);

    expect(mapDevinWebSearchResponse(response)).toEqual({
      text: "Provider summary.\n\nSearch results:\n"
        + "- Search docs: Authoritative result excerpt. [https://docs.example/search]\n"
        + "- Update: Fallback markdown chunk. [https://blog.example/update]",
      sources: [
        { url: "https://docs.example/search", title: "Search docs" },
        { url: "https://blog.example/update", title: "Update" },
      ],
    });
  });

  test("rejects redirects, oversized bodies, malformed protobuf, and secret-bearing failures", async () => {
    const cases: Array<{ response?: Response; rejection?: Error; error: string }> = [
      { response: new Response(null, { status: 302 }), error: "HTTP 302" },
      { response: new Response(new Uint8Array(MAX_SIDECAR_RESPONSE_BYTES + 1)), error: "exceeded byte bound" },
      { response: new Response(Uint8Array.from([0x0a, 0x80])), error: "malformed protobuf" },
      { rejection: new Error(`failed with ${snapshot.accessToken}`), error: "connect_error" },
    ];
    for (const fixture of cases) {
      globalThis.fetch = (async (_input, init) => {
        expect(init?.redirect).toBe("error");
        if (fixture.rejection) throw fixture.rejection;
        return fixture.response!;
      }) as typeof fetch;
      const outcome = await runDevinWebSearch("query", snapshot, AbortSignal.timeout(5_000));
      expect(outcome.error).toContain(fixture.error);
      expect(JSON.stringify(outcome)).not.toContain(snapshot.accessToken);
    }
  });

  test("fails safely when no Devin account is signed in or its tenant is untrusted", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-devin-search-auth-"));
    process.env.OPENCODEX_HOME = home;
    try {
      expect(await resolveDevinWebSearchSnapshot("devin")).toEqual({
        error: "devin web search auth failed: no signed-in account",
      });
      await saveCredential("devin", {
        access: snapshot.accessToken,
        refresh: snapshot.accessToken,
        expires: Number.MAX_SAFE_INTEGER,
        accountId: "account",
        apiBaseUrl: "https://attacker.example",
      });
      const resolved = await resolveDevinWebSearchSnapshot("devin");
      expect("snapshot" in resolved && resolved.snapshot.apiBaseUrl).toBeUndefined();
      globalThis.fetch = (async (input) => {
        expect(String(input).startsWith("https://server.codeium.com/")).toBe(true);
        return new Response(encodeMessage(1, result({
          url: "https://docs.example/search",
          title: "Search docs",
          summary: "Excerpt.",
        })));
      }) as typeof fetch;
      if ("snapshot" in resolved) {
        expect((await runDevinWebSearch("query", resolved.snapshot, AbortSignal.timeout(5_000))).error).toBeUndefined();
      }
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("honors timeout and caller abort", async () => {
    for (const fixture of [
      { reason: new DOMException("timeout", "TimeoutError"), expected: "timeout" },
      { reason: new DOMException("left", "AbortError"), expected: "connect_error" },
    ]) {
      const caller = new AbortController();
      globalThis.fetch = ((_input, init) => new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) return reject(init.signal.reason);
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })) as typeof fetch;
      caller.abort(fixture.reason);
      const outcome = await runDevinWebSearch("query", snapshot, caller.signal);
      expect(outcome.error).toContain(fixture.expected);
    }
  });
});
