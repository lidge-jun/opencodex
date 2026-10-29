import { describe, expect, test } from "bun:test";
import { formatWebSearchResult } from "../../src/web-search/format-result";

describe("single search result Unicode boundaries", () => {
  test.each([false, true])("never splits query or answer surrogate pairs (structured=%s)", structured => {
    const query = "q".repeat(199) + "😀tail";
    const text = "a".repeat(3999) + "😀tail";
    const result = formatWebSearchResult(query, { text, sources: [] }, structured);
    const shown = structured ? JSON.parse(result.split("\n")[1]!) : { query: result, answer: result };
    expect(shown.query).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    expect(shown.answer).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    expect(shown.answer).toContain("…[truncated]");
  });
  test("preserves complete pairs exactly at the limit", () => {
    const text = "a".repeat(3998) + "😀";
    const result = formatWebSearchResult("q".repeat(198) + "😀", { text, sources: [] }, true);
    const data = JSON.parse(result.split("\n")[1]!);
    expect(data.answer).toBe(text);
    expect(data.query).toEndWith("😀");
  });
  test("keeps a pair that ends exactly at the limit when truncation occurs", () => {
    const result = formatWebSearchResult("q".repeat(198) + "😀tail", { text: "a".repeat(3998) + "😀tail", sources: [] }, true);
    const data = JSON.parse(result.split("\n")[1]!);
    expect(data.answer).toBe("a".repeat(3998) + "😀\n…[truncated]");
    expect(data.query).toBe("q".repeat(198) + "😀…");
  });
});
