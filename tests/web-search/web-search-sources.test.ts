import { describe, expect, test } from "bun:test";
import { parseSidecarSSE } from "../../src/web-search/parse";
import {
  MAX_WEB_SEARCH_SOURCE_BYTES,
  MAX_WEB_SEARCH_SOURCES,
  MAX_WEB_SEARCH_TITLE_BYTES,
  MAX_WEB_SEARCH_URL_BYTES,
  appendSafeWebSearchSource,
  safeWebSearchSources,
} from "../../src/web-search/sources";

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

/** Build a synthetic Responses stream without contacting a provider. */
function sourceResponse(events: readonly unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
}

/** Make the final output array authoritative for both answer text and annotations. */
function completedSources(annotations: readonly unknown[], type = "response.completed"): unknown {
  return { type, response: { output: [{ type: "message", content: [
    { type: "output_text", text: "Answer", annotations },
  ] }] } };
}

describe("sidecar final citation metadata", () => {
  for (const type of ["response.completed", "response.done"]) {
    for (const title of [undefined, "Early title"]) {
      test(`${type} keeps the final title after a ${title ? "titled" : "titleless"} streaming copy`, async () => {
        const url = "https://example.test/result";
        const result = await parseSidecarSSE(sourceResponse([
          { type: "response.output_text.annotation.added", annotation: { type: "url_citation", url, title } },
          completedSources([{ type: "url_citation", url, title: "Final title" }], type),
        ]));
        expect(result).toEqual({ text: "Answer", sources: [{ url, title: "Final title" }] });
      });
    }
  }

  test("keeps streaming-only sources after the final output's sources", async () => {
    const result = await parseSidecarSSE(sourceResponse([
      { type: "response.output_text.annotation.added", annotation: {
        type: "url_citation", url: "https://example.test/stream", title: "Streaming only",
      } },
      completedSources([{ type: "url_citation", url: "https://example.test/final", title: "Final only" }]),
    ]));
    expect(result.sources).toEqual([
      { url: "https://example.test/final", title: "Final only" },
      { url: "https://example.test/stream", title: "Streaming only" },
    ]);
  });

  for (const [label, title] of [["missing", undefined], ["empty", ""],
    ["blank", "   "], ["invalid", "bad\u0001title"]] as const) {
    test(`keeps a valid streaming title when the final title is ${label}`, async () => {
      const url = "https://example.test/result";
      const result = await parseSidecarSSE(sourceResponse([
        { type: "response.output_text.annotation.added", annotation: {
          type: "url_citation", url, title: "Streaming title",
        } },
        completedSources([{ type: "url_citation", url, title }]),
      ]));
      expect(result.sources).toEqual([{ url, title: "Streaming title" }]);
    });
  }

  test("deduplicates repeated URLs within completed output", async () => {
    const url = "https://example.test/result";
    const result = await parseSidecarSSE(sourceResponse([completedSources([
      { type: "url_citation", url, title: "First final title" },
      { type: "url_citation", url, title: "Repeated final title" },
    ])]));
    expect(result.sources).toEqual([{ url, title: "First final title" }]);
  });

  test("final citations retain their order without exceeding the source cap", async () => {
    const final = Array.from({ length: MAX_WEB_SEARCH_SOURCES }, (_, index) => ({
      type: "url_citation", url: `https://example.test/${index}`, title: `Final ${index}`,
    }));
    const result = await parseSidecarSSE(sourceResponse([
      { type: "response.output_text.annotation.added", annotation: { ...final[0], title: "Early" } },
      { type: "response.output_text.annotation.added", annotation: {
        type: "url_citation", url: "https://example.test/extra", title: "Extra",
      } },
      completedSources(final),
    ]));
    expect(result.sources).toEqual(final.map(({ url, title }) => ({ url, title })));
    expect(byteLength(JSON.stringify(result.sources))).toBeLessThan(MAX_WEB_SEARCH_SOURCE_BYTES);
  });

  test("final annotations still obey URL and title sanitization", async () => {
    const result = await parseSidecarSSE(sourceResponse([completedSources([
      { type: "url_citation", url: "javascript:alert(1)", title: "Unsafe" },
      { type: "url_citation", url: "https://user:pass@example.test/private", title: "Credentials" },
      { type: "url_citation", url: "https://example.test/safe", title: "bad\u0001title" },
    ])]));
    expect(result.sources).toEqual([{ url: "https://example.test/safe" }]);
  });
});

describe("web-search citation source sanitization", () => {
  test("preserves ordinary HTTP(S) citations verbatim and deduplicates exact URLs", () => {
    const sources = safeWebSearchSources([
      { url: "https://docs.example.test/a?q=one#two", title: "Docs" },
      { url: "http://example.test/plain" },
      { url: "https://docs.example.test/a?q=one#two", title: "Duplicate" },
    ]);

    expect(sources).toEqual([
      { url: "https://docs.example.test/a?q=one#two", title: "Docs" },
      { url: "http://example.test/plain" },
    ]);
  });

  test("rejects malformed, credential-bearing, non-HTTP, control, and padded URLs", () => {
    expect(safeWebSearchSources([
      null,
      { url: 42 },
      { url: "javascript:alert(1)" },
      { url: "data:text/html,unsafe" },
      { url: "https://user:pass@example.test/private" },
      { url: "https://control.test/path\u0000" },
      { url: " https://padded.test" },
      { url: "https://safe.test" },
    ])).toEqual([{ url: "https://safe.test" }]);
    expect(safeWebSearchSources({ url: "https://not-an-array.test" })).toEqual([]);
  });

  test("keeps a safe URL but omits an invalid optional title", () => {
    const exactUnicodeTitle = "😀".repeat(MAX_WEB_SEARCH_TITLE_BYTES / 4);
    expect(byteLength(exactUnicodeTitle)).toBe(MAX_WEB_SEARCH_TITLE_BYTES);
    expect(safeWebSearchSources([
      { url: "https://empty-title.test", title: "" },
      { url: "https://blank-title.test", title: "   " },
      { url: "https://control-title.test", title: "bad\u0001title" },
      { url: "https://typed-title.test", title: 42 },
      { url: "https://large-title.test", title: `${exactUnicodeTitle}😀` },
      { url: "https://exact-title.test", title: exactUnicodeTitle },
    ])).toEqual([
      { url: "https://empty-title.test" },
      { url: "https://blank-title.test" },
      { url: "https://control-title.test" },
      { url: "https://typed-title.test" },
      { url: "https://large-title.test" },
      { url: "https://exact-title.test", title: exactUnicodeTitle },
    ]);
  });

  test("enforces the URL byte cap exactly", () => {
    const prefix = "https://bytes.test/";
    const exact = `${prefix}${"a".repeat(MAX_WEB_SEARCH_URL_BYTES - byteLength(prefix))}`;
    const sources: { url: string }[] = [];
    expect(byteLength(exact)).toBe(MAX_WEB_SEARCH_URL_BYTES);
    expect(appendSafeWebSearchSource(sources, { url: exact })).toBe(true);
    expect(appendSafeWebSearchSource([], { url: `${exact}a` })).toBe(false);
  });

  test("enforces count and aggregate serialized-byte budgets", () => {
    const countBounded = safeWebSearchSources(
      Array.from({ length: MAX_WEB_SEARCH_SOURCES + 5 }, (_, index) => ({
        url: `https://count.test/${index}`,
      })),
    );
    expect(countBounded).toHaveLength(MAX_WEB_SEARCH_SOURCES);

    const aggregateBounded = safeWebSearchSources(
      Array.from({ length: MAX_WEB_SEARCH_SOURCES }, (_, index) => ({
        url: `https://aggregate.test/${index}/${"a".repeat(1_000)}`,
      })),
    );
    const serializedBytes = aggregateBounded.reduce(
      (sum, source) => sum + byteLength(JSON.stringify(source)),
      0,
    );
    expect(aggregateBounded.length).toBeLessThan(MAX_WEB_SEARCH_SOURCES);
    expect(serializedBytes).toBeLessThanOrEqual(MAX_WEB_SEARCH_SOURCE_BYTES);
  });
});
