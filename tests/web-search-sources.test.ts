import { describe, expect, test } from "bun:test";
import {
  MAX_WEB_SEARCH_SOURCE_BYTES,
  MAX_WEB_SEARCH_SOURCES,
  MAX_WEB_SEARCH_TITLE_BYTES,
  MAX_WEB_SEARCH_URL_BYTES,
  appendSafeWebSearchSource,
  safeWebSearchSources,
} from "../src/web-search/sources";

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

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
